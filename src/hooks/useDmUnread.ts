import { createContext, createElement, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type PropsWithChildren } from 'react';
import type { Contact } from '../types';
import { countUnreadByCounterparty, newestIncomingDmAt } from '../object-layer/conversations';
import type { DmEvents } from '../object-layer/dm-events';
import type { ObjectStore } from '../object-layer/types';

export interface DmUnreadState {
  total: number;
  byContact: Record<string, number>;
  markRead(counterpartyPublicKey: string): Promise<void>;
}

interface DmUnreadProviderProps extends PropsWithChildren {
  store: ObjectStore;
  myPublicKey: string;
  contacts: Contact[];
  events: DmEvents;
  updateContact(contact: Contact): void;
  saveContact(contact: Contact): Promise<void>;
}

export interface DmUnreadController {
  getSnapshot(): DmUnreadState;
  subscribe(listener: () => void): () => void;
  setContacts(contacts: Contact[]): void;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
  markRead(counterpartyPublicKey: string): Promise<void>;
}

const emptyState: DmUnreadState = {
  total: 0,
  byContact: {},
  markRead: async () => {}
};

const DmUnreadContext = createContext<DmUnreadState>(emptyState);

export function createDmUnreadController({
  store,
  myPublicKey,
  events,
  getContacts,
  updateContact,
  saveContact
}: {
  store: ObjectStore;
  myPublicKey: string;
  events: DmEvents;
  getContacts: () => Contact[];
  updateContact(contact: Contact): void;
  saveContact(contact: Contact): Promise<void>;
}): DmUnreadController {
  const listeners = new Set<() => void>();
  let snapshot: DmUnreadState;
  let unsubscribe: (() => void) | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let revision = 0;

  const publish = (byContact: Record<string, number>) => {
    const currentKeys = Object.keys(snapshot.byContact);
    const nextKeys = Object.keys(byContact);
    if (currentKeys.length === nextKeys.length
      && nextKeys.every((key) => snapshot.byContact[key] === byContact[key])) return;
    snapshot = {
      byContact,
      total: Object.values(byContact).reduce((sum, count) => sum + count, 0),
      markRead
    };
    for (const listener of listeners) listener();
  };

  const refresh = async (contacts = getContacts()): Promise<void> => {
    const currentRevision = ++revision;
    const counts = await countUnreadByCounterparty({
      store,
      myPublicKey,
      sinceByCounterparty: new Map(contacts.map((contact) => [contact.publicKey, contact.lastReadAt ?? null]))
    });
    if (currentRevision !== revision) return;
    publish(Object.fromEntries(counts));
  };

  const markRead = async (counterpartyPublicKey: string): Promise<void> => {
    const contact = getContacts().find((candidate) => candidate.publicKey === counterpartyPublicKey);
    if (!contact) return;
    const lastReadAt = await newestIncomingDmAt({
      store,
      myPublicKey,
      counterparty: counterpartyPublicKey
    }) ?? new Date().toISOString();
    if (lastReadAt === contact.lastReadAt) return;
    const updatedContact = { ...contact, lastReadAt };
    const contacts = getContacts().map((candidate) => (
      candidate.publicKey === counterpartyPublicKey ? updatedContact : candidate
    ));

    revision += 1;
    publish({ ...snapshot.byContact, [counterpartyPublicKey]: 0 });
    updateContact(updatedContact);
    await saveContact(updatedContact);
    await refresh(contacts);
  };

  snapshot = { ...emptyState, markRead };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setContacts(contacts) {
      void refresh(contacts);
    },
    start() {
      if (unsubscribe) return;
      unsubscribe = events.onDmArrived((object) => {
        if (object.recipient !== myPublicKey || refreshTimer !== null) return;
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void refresh();
        }, 0);
      });
      void refresh();
    },
    stop() {
      revision += 1;
      unsubscribe?.();
      unsubscribe = null;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = null;
    },
    refresh,
    markRead
  };
}

export function DmUnreadProvider({
  store,
  myPublicKey,
  contacts,
  events,
  updateContact,
  saveContact,
  children
}: DmUnreadProviderProps) {
  const contactsRef = useRef(contacts);
  const updateContactRef = useRef(updateContact);
  const saveContactRef = useRef(saveContact);
  contactsRef.current = contacts;
  updateContactRef.current = updateContact;
  saveContactRef.current = saveContact;

  const controller = useMemo(() => createDmUnreadController({
    store,
    myPublicKey,
    events,
    getContacts: () => contactsRef.current,
    updateContact: (contact) => updateContactRef.current(contact),
    saveContact: (contact) => saveContactRef.current(contact)
  }), [store, myPublicKey, events]);

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  useEffect(() => {
    controller.setContacts(contacts);
  }, [controller, contacts]);

  const value = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return createElement(DmUnreadContext.Provider, { value }, children);
}

export function useDmUnread(): DmUnreadState {
  return useContext(DmUnreadContext);
}
