import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '../object-layer/conversations';
import * as conversations from '../object-layer/conversations';
import { createDmEvents, type DmEvents } from '../object-layer/dm-events';
import type { DmObjectIdentity } from '../object-layer/dm-object';
import type { SendMessageResult } from '../object-layer/dm-service';
import type { ObjectStore } from '../object-layer/types';

interface HookSlot {
  kind: 'state' | 'ref' | 'effect';
  value?: unknown;
  deps?: readonly unknown[];
  cleanup?: (() => void) | void;
}

interface HookRunnerRuntime {
  useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void];
  useRef<T>(initial: T): { current: T };
  useEffect(callback: () => void | (() => void), deps?: readonly unknown[]): void;
}

const hookRuntime = vi.hoisted(() => ({ current: null as HookRunnerRuntime | null }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: <T>(initial: T | (() => T)) => hookRuntime.current!.useState(initial),
    useRef: <T>(initial: T) => hookRuntime.current!.useRef(initial),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) =>
      hookRuntime.current!.useEffect(callback, deps),
    useContext: () => ({ total: 0, byContact: {}, markRead: async () => {} })
  };
});

import { useDmConversation } from './useDmConversation';

const identity: DmObjectIdentity = {
  id: 'me-id',
  publicKey: 'me-key',
  privateKey: 'private-signing',
  encryptionPublicKey: 'my-encryption-key',
  encryptionPrivateKey: 'private-encryption'
};

function message(objectId: string, overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    objectId,
    direction: 'in',
    createdAt: '2026-10-01T00:00:00.000Z',
    status: 'ok',
    text: objectId,
    ...overrides
  };
}

function createRunner<T>(renderHook: () => T) {
  const slots: HookSlot[] = [];
  let cursor = 0;
  let pending: Array<{ index: number; callback: () => void | (() => void); deps?: readonly unknown[] }> = [];
  let current!: T;

  const runtime: HookRunnerRuntime = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = { kind: 'state', value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
      }
      const slot = slots[index]!;
      return [
        slot.value as never,
        (update) => {
          slot.value = typeof update === 'function'
            ? (update as (previous: unknown) => unknown)(slot.value)
            : update;
        }
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { kind: 'ref', value: { current: initial } };
      return slots[index]!.value as never;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = slots[index];
      const changed = !previous || deps === undefined || !sameDeps(previous.deps, deps);
      if (changed) pending.push({ index, callback, deps });
      if (!previous) slots[index] = { kind: 'effect', deps };
    }
  };
  hookRuntime.current = runtime;

  const render = () => {
    cursor = 0;
    pending = [];
    current = renderHook();
    return current;
  };
  const commit = () => {
    for (const effect of pending) {
      const slot = slots[effect.index]!;
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.deps = effect.deps;
      slot.cleanup = effect.callback();
    }
    pending = [];
  };
  const unmount = () => {
    for (const slot of slots) {
      if (slot.kind === 'effect' && typeof slot.cleanup === 'function') slot.cleanup();
    }
  };
  return { render, commit, unmount, slots, get current() { return current; } };
}

function sameDeps(left: readonly unknown[] | undefined, right: readonly unknown[]): boolean {
  return left !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function createHarness(options: {
  counterparty?: string | null;
  trustedKey?: string | null;
  loader?: (counterparty: string) => Promise<ConversationMessage[]>;
  sender?: (recipient: string, text: string) => Promise<SendMessageResult>;
  refreshIntervalMs?: number;
  events?: DmEvents;
} = {}) {
  let counterparty: string | null = options.counterparty ?? 'peer-key';
  let currentIdentity: DmObjectIdentity | null = identity;
  const events = options.events ?? createDmEvents();
  const getIdentity = () => currentIdentity;
  const loader = vi.spyOn(conversations, 'loadConversation')
    .mockImplementation(async (input) => options.loader
      ? await options.loader(input.counterparty)
      : [message(`${input.counterparty}-message`)]);
  const sendMessage = vi.fn(async (recipientPublicKey: string, text: string) => {
    if (options.sender) return await options.sender(recipientPublicKey, text) as never;
    return { status: 'invalid', replicatedTo: [], queued: false, keyChanged: false } as never;
  });
  const store: ObjectStore = {
    put: async () => true,
    get: async () => null,
    delete: async () => {},
    query: async () => []
  };
  const outbox = { get: async () => null };
  const resolveSenderEncryptionKey = vi.fn((_: string): string | null => (
    options.trustedKey === undefined ? 'trusted-key' : options.trustedKey
  ));
  const dmService = { sendMessage };
  const runner = createRunner(() => useDmConversation({
    counterparty,
    getIdentity,
    store,
    outbox,
    resolveSenderEncryptionKey,
    dmService,
    events,
    refreshIntervalMs: options.refreshIntervalMs ?? 100
  }));
  const mount = () => {
    runner.render();
    runner.commit();
  };
  return {
    runner,
    mount,
    events,
    loader,
    sendMessage,
    resolveSenderEncryptionKey,
    store,
    outbox,
    get counterparty() { return counterparty; },
    set counterparty(value: string | null) { counterparty = value; },
    set identity(value: DmObjectIdentity | null) { currentIdentity = value; }
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  hookRuntime.current = null;
});

describe('useDmConversation', () => {
  it('loads messages in the ordered shape provided by the conversation model', async () => {
    const harness = createHarness({
      loader: async () => [message('old'), message('new', { createdAt: '2026-10-02T00:00:00.000Z' })]
    });
    harness.mount();
    await settle();
    harness.runner.render();

    expect(harness.runner.current.messages.map((item) => item.objectId)).toEqual(['old', 'new']);
  });

  it('reloads on a dm-arrived event and coalesces an event burst', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.mount();
    await settle();
    const callsAfterMount = harness.loader.mock.calls.length;
    harness.events.emitDmArrived({
      object_id: 'one', object_type: 'mycelium.dm', author: 'peer-key', recipient: 'me-key',
      created_at: '2026-10-01T00:00:00.000Z', payload: {}, signature: '', replication_policy: {}
    });
    harness.events.emitDmArrived({
      object_id: 'two', object_type: 'mycelium.dm', author: 'peer-key', recipient: 'me-key',
      created_at: '2026-10-01T00:00:01.000Z', payload: {}, signature: '', replication_policy: {}
    });
    await vi.advanceTimersByTimeAsync(0);
    await settle();

    expect(harness.loader).toHaveBeenCalledTimes(callsAfterMount + 1);
  });

  it('reloads after sending and returns send status fields', async () => {
    const sentObject = {
      object_id: 'sent-object',
      object_type: 'mycelium.dm',
      author: identity.publicKey,
      recipient: 'peer-key',
      created_at: '2026-10-06T00:00:00.000Z',
      payload: {},
      signature: 'signature',
      replication_policy: {}
    };
    const harness = createHarness({
      sender: async () => ({ status: 'sent', object: sentObject, replicatedTo: [], queued: false, keyChanged: false })
    });
    harness.mount();
    await settle();
    harness.runner.render();
    const outcome = await harness.runner.current.send('hello');
    harness.runner.render();

    expect(outcome).toEqual({ status: 'sent', queued: false, keyChanged: false });
    expect(harness.sendMessage).toHaveBeenCalledWith('peer-key', 'hello');
    expect(harness.loader).toHaveBeenCalledTimes(2);
  });

  it('updates pending delivery on the next poll', async () => {
    vi.useFakeTimers();
    let loadCount = 0;
    const harness = createHarness({
      refreshIntervalMs: 50,
      loader: async () => {
        loadCount += 1;
        return [message('delivery', { direction: 'out', delivery: loadCount === 1 ? 'pending' : 'sent' })];
      }
    });
    harness.mount();
    await settle();
    harness.runner.render();
    expect(harness.runner.current.messages[0]?.delivery).toBe('pending');
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    harness.runner.render();
    expect(harness.runner.current.messages[0]?.delivery).toBe('sent');
  });

  it('ignores a stale load that finishes after the counterparty changes', async () => {
    let resolveOld!: (messages: ConversationMessage[]) => void;
    const harness = createHarness({
      loader: async (counterparty) => counterparty === 'peer-key'
        ? await new Promise<ConversationMessage[]>((resolve) => { resolveOld = resolve; })
        : [message('new-peer-message')]
    });
    harness.mount();
    await settle();
    harness.counterparty = 'new-peer';
    harness.runner.render();
    harness.runner.commit();
    await settle();
    resolveOld([message('stale-peer-message')]);
    await settle();
    harness.runner.render();

    expect(harness.runner.current.messages.map((item) => item.objectId)).toEqual(['new-peer-message']);
  });

  it('unsubscribes from events and clears polling and debounce timers on unmount', async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const events: DmEvents = {
      onDmArrived: () => unsubscribe,
      emitDmArrived: () => {}
    };
    const harness = createHarness({ events });
    harness.mount();
    harness.runner.unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears decrypted messages when the counterparty changes and on unmount', async () => {
    const harness = createHarness();
    harness.mount();
    await settle();
    harness.runner.render();
    expect(harness.runner.current.messages).toHaveLength(1);
    harness.counterparty = 'other-peer';
    harness.runner.render();
    expect(harness.runner.current.messages).toEqual([]);
    harness.runner.commit();
    await settle();
    harness.runner.render();
    harness.identity = null;
    harness.runner.render();
    expect(harness.runner.current.messages).toEqual([]);
    harness.runner.commit();
    harness.runner.unmount();

    expect(harness.runner.slots.some((slot) => (
      slot.kind === 'state'
      && Array.isArray((slot.value as { messages?: unknown[] }).messages)
      && (slot.value as { messages: unknown[] }).messages.length === 0
    ))).toBe(true);
  });

  it('disables sending and refuses to call the DM service when no trusted key exists', async () => {
    const harness = createHarness({ trustedKey: null });
    harness.mount();
    await settle();
    harness.runner.render();

    expect(harness.runner.current.noKey).toBe(true);
    expect(harness.runner.current.canSend).toBe(false);
    await expect(harness.runner.current.send('blocked')).resolves.toEqual({
      status: 'no_key',
      queued: false,
      keyChanged: false
    });
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });
});
