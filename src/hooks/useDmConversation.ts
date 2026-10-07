import { useEffect, useRef, useState } from 'react';
import { getContactEncryptionKey } from '../crypto/dm-crypto';
import { loadConversation, type ConversationMessage } from '../object-layer/conversations';
import type { DmEvents } from '../object-layer/dm-events';
import type { DmObjectIdentity } from '../object-layer/dm-object';
import type { SenderEncryptionKeyResolver } from '../object-layer/dm-inbox';
import type { SendMessageResult } from '../object-layer/dm-service';
import type { DistributedObject, ObjectStore } from '../object-layer/types';
import { useDmUnread } from './useDmUnread';

export interface DmConversationOutbox {
  get(objectId: string): Promise<{ delivered_direct: boolean; replicated_to: string[] } | null>;
}

export interface DmConversationService {
  sendMessage(recipientPublicKey: string, plaintext: string): Promise<SendMessageResult>;
}

export interface UseDmConversationOptions {
  counterparty: string | null;
  getIdentity: () => DmObjectIdentity | null;
  store: ObjectStore;
  outbox: DmConversationOutbox;
  resolveSenderEncryptionKey: SenderEncryptionKeyResolver;
  dmService: DmConversationService | null;
  events: DmEvents;
  isContactKnown?: (publicKey: string) => boolean;
  refreshIntervalMs?: number;
}

export interface DmSendOutcome {
  status: SendMessageResult['status'];
  queued: boolean;
  keyChanged: boolean;
}

export function useDmConversation({
  counterparty,
  getIdentity,
  store,
  outbox,
  resolveSenderEncryptionKey,
  dmService,
  events,
  isContactKnown,
  refreshIntervalMs = 5000
}: UseDmConversationOptions): {
  messages: ConversationMessage[];
  loading: boolean;
  send(text: string): Promise<DmSendOutcome>;
  sending: boolean;
  canSend: boolean;
  noKey: boolean;
} {
  const identity = getIdentity();
  const { markRead } = useDmUnread();
  const markReadRef = useRef(markRead);
  const resolveSenderEncryptionKeyRef = useRef(resolveSenderEncryptionKey);
  const isContactKnownRef = useRef(isContactKnown);
  markReadRef.current = markRead;
  resolveSenderEncryptionKeyRef.current = resolveSenderEncryptionKey;
  isContactKnownRef.current = isContactKnown;
  const conversationKey = `${identity?.publicKey ?? ''}\u0000${counterparty ?? ''}`;
  const currentKeyRef = useRef(conversationKey);
  currentKeyRef.current = conversationKey;
  const [messageState, setMessageState] = useState<{ key: string; messages: ConversationMessage[] }>({
    key: conversationKey,
    messages: []
  });
  const [loadingState, setLoadingState] = useState<{ key: string; loading: boolean }>({
    key: conversationKey,
    loading: Boolean(identity && counterparty)
  });
  const [noKeyState, setNoKeyState] = useState<{ key: string; noKey: boolean }>({
    key: conversationKey,
    noKey: true
  });
  const [sending, setSending] = useState(false);
  const generationRef = useRef(0);
  const noKeyConversationRef = useRef(conversationKey);

  useEffect(() => {
    if (counterparty) void markReadRef.current(counterparty);
  }, [counterparty, identity?.publicKey]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const identityForConversation = getIdentity();
    const key = `${identityForConversation?.publicKey ?? ''}\u0000${counterparty ?? ''}`;
    let active = true;
    let eventTimer: ReturnType<typeof setTimeout> | null = null;
    setMessageState({ key, messages: [] });
    setLoadingState({ key, loading: Boolean(identityForConversation && counterparty) });
    if (noKeyConversationRef.current !== key) {
      noKeyConversationRef.current = key;
      setNoKeyState({ key, noKey: true });
    }
    setSending(false);

    if (!identityForConversation || !counterparty) {
      setLoadingState({ key, loading: false });
      return () => {
        active = false;
      };
    }

    const isCurrent = () => active
      && generationRef.current === generation
      && currentKeyRef.current === key;

    const load = async (initial = false) => {
      if (initial) setLoadingState({ key, loading: true });
      try {
        const trustedEncryptionKey = await getContactEncryptionKey({
          encryptionPublicKey: (await resolveSenderEncryptionKeyRef.current(counterparty)) ?? undefined
        });
        if (!isCurrent()) return;
        if (trustedEncryptionKey !== null) {
          setNoKeyState({ key, noKey: false });
        } else if (isContactKnownRef.current?.(counterparty) ?? true) {
          setNoKeyState({ key, noKey: true });
        }
        const messages = await loadConversation({
          store,
          identity: identityForConversation,
          counterparty,
          resolveSenderEncryptionKey: (publicKey) => resolveSenderEncryptionKeyRef.current(publicKey),
          getOutboxEntry: (objectId) => outbox.get(objectId)
        });
        if (isCurrent()) setMessageState({ key, messages });
      } catch {
        if (isCurrent()) setMessageState({ key, messages: [] });
      } finally {
        if (initial && isCurrent()) setLoadingState({ key, loading: false });
      }
    };

    void load(true);
    const unsubscribe = events.onDmArrived((object: DistributedObject) => {
      if (object.author !== counterparty && object.recipient !== counterparty) return;
      if (object.author === counterparty && object.recipient === identityForConversation.publicKey) {
        void markReadRef.current(counterparty);
      }
      if (eventTimer !== null) clearTimeout(eventTimer);
      eventTimer = setTimeout(() => {
        eventTimer = null;
        void load();
      }, 0);
    });
    const interval = setInterval(() => {
      void load();
    }, Math.max(1, refreshIntervalMs));

    return () => {
      active = false;
      unsubscribe();
      if (eventTimer !== null) clearTimeout(eventTimer);
      clearInterval(interval);
      setMessageState({ key, messages: [] });
      setLoadingState({ key, loading: false });
    };
  }, [
    counterparty,
    identity?.publicKey,
    identity?.encryptionPublicKey,
    store,
    outbox,
    dmService,
    events,
    refreshIntervalMs,
    getIdentity,
  ]);

  const currentMessages = messageState.key === conversationKey ? messageState.messages : [];
  const noKey = noKeyState.key !== conversationKey || noKeyState.noKey;
  const loading = loadingState.key === conversationKey && loadingState.loading;

  const send = async (text: string): Promise<DmSendOutcome> => {
    const sendIdentity = getIdentity();
    if (!sendIdentity || !counterparty || !dmService) {
      return { status: 'invalid', queued: false, keyChanged: false };
    }
    let trustedEncryptionKey: string | null;
    try {
      trustedEncryptionKey = await resolveSenderEncryptionKey(counterparty);
    } catch {
      trustedEncryptionKey = null;
    }
    if (noKey || !getContactEncryptionKey({ encryptionPublicKey: trustedEncryptionKey ?? undefined })) {
      return { status: 'no_key', queued: false, keyChanged: false };
    }

    setSending(true);
    try {
      const result = await dmService.sendMessage(counterparty, text);
      await reloadLatest({
        key: conversationKey,
        counterparty,
        identity: sendIdentity,
        store,
        outbox,
        resolveSenderEncryptionKey,
        currentKeyRef,
        generationRef,
        setMessageState
      });
      return {
        status: result.status,
        queued: result.queued,
        keyChanged: result.keyChanged
      };
    } catch {
      return { status: 'invalid', queued: false, keyChanged: false };
    } finally {
      if (currentKeyRef.current === conversationKey) setSending(false);
    }
  };

  return {
    messages: identity && counterparty ? currentMessages : [],
    loading,
    send,
    sending,
    canSend: Boolean(identity && counterparty && dmService && !noKey && !sending),
    noKey
  };
}

async function reloadLatest({
  key,
  counterparty,
  identity,
  store,
  outbox,
  resolveSenderEncryptionKey,
  currentKeyRef,
  generationRef,
  setMessageState
}: {
  key: string;
  counterparty: string;
  identity: DmObjectIdentity;
  store: ObjectStore;
  outbox: DmConversationOutbox;
  resolveSenderEncryptionKey: SenderEncryptionKeyResolver;
  currentKeyRef: { current: string };
  generationRef: { current: number };
  setMessageState: (value: { key: string; messages: ConversationMessage[] }) => void;
}): Promise<void> {
  const generation = generationRef.current;
  try {
    const messages = await loadConversation({
      store,
      identity,
      counterparty,
      resolveSenderEncryptionKey,
      getOutboxEntry: (objectId) => outbox.get(objectId)
    });
    if (currentKeyRef.current === key && generationRef.current === generation) {
      setMessageState({ key, messages });
    }
  } catch {
    if (currentKeyRef.current === key && generationRef.current === generation) {
      setMessageState({ key, messages: [] });
    }
  }
}
