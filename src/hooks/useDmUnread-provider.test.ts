import { afterEach, describe, expect, it, vi } from 'vitest';
import * as conversations from '../object-layer/conversations';
import { createDmEvents } from '../object-layer/dm-events';
import type { Contact } from '../types';
import type { DistributedObject, ObjectCriteria, ObjectStore } from '../object-layer/types';
import type { ConversationMessage } from '../object-layer/conversations';

interface Slot {
  kind: 'state' | 'ref' | 'memo' | 'effect';
  value?: unknown;
  deps?: readonly unknown[];
  cleanup?: void | (() => void);
}

interface Fiber {
  slots: Slot[];
  cursor: number;
  effects: Array<{ index: number; callback: () => void | (() => void); deps?: readonly unknown[] }>;
}

interface HookRuntime {
  fiber: Fiber | null;
  contextValues: Map<object, unknown>;
  scheduleRender(): void;
}

const runtime = vi.hoisted(() => ({ current: null as HookRuntime | null }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    createContext: (defaultValue: unknown) => {
      const token = {};
      return { defaultValue, Provider: { token }, token };
    },
    createElement: (type: { token?: object }, props: Record<string, unknown>, children: unknown) => ({
      token: type.token,
      value: props.value,
      children
    }),
    useContext: (context: { token: object; defaultValue: unknown }) => (
      runtime.current?.contextValues.get(context.token) ?? context.defaultValue
    ),
    useState: <T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] => {
      const fiber = runtime.current!.fiber!;
      const index = fiber.cursor++;
      if (!fiber.slots[index]) {
        fiber.slots[index] = { kind: 'state', value: typeof initial === 'function' ? (initial as () => T)() : initial };
      }
      const slot = fiber.slots[index]!;
      return [slot.value as T, (next) => {
        const updated = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next;
        if (!Object.is(updated, slot.value)) {
          slot.value = updated;
          runtime.current?.scheduleRender();
        }
      }];
    },
    useRef: <T>(initial: T) => {
      const fiber = runtime.current!.fiber!;
      const index = fiber.cursor++;
      if (!fiber.slots[index]) fiber.slots[index] = { kind: 'ref', value: { current: initial } };
      return fiber.slots[index]!.value as { current: T };
    },
    useMemo: <T>(factory: () => T, deps: readonly unknown[]) => {
      const fiber = runtime.current!.fiber!;
      const index = fiber.cursor++;
      const previous = fiber.slots[index];
      if (!previous || !equalDeps(previous.deps, deps)) {
        fiber.slots[index] = { kind: 'memo', value: factory(), deps };
      }
      return fiber.slots[index]!.value as T;
    },
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => {
      const fiber = runtime.current!.fiber!;
      const index = fiber.cursor++;
      const previous = fiber.slots[index];
      if (!previous || deps === undefined || !equalDeps(previous.deps, deps)) {
        fiber.effects.push({ index, callback, deps });
        if (!previous) fiber.slots[index] = { kind: 'effect', deps };
      }
    },
    useSyncExternalStore: (subscribe: (notify: () => void) => () => void, getSnapshot: () => unknown) => {
      const fiber = runtime.current!.fiber!;
      const index = fiber.cursor++;
      if (!fiber.slots[index]) {
        fiber.slots[index] = { kind: 'effect', deps: [subscribe] };
        fiber.effects.push({
          index,
          deps: [subscribe],
          callback: () => subscribe(() => runtime.current?.scheduleRender())
        });
      }
      return getSnapshot();
    }
  };
});

import { useDmConversation } from './useDmConversation';
import { DmUnreadProvider, useDmUnread, type DmUnreadState } from './useDmUnread';

function equalDeps(left: readonly unknown[] | undefined, right: readonly unknown[]): boolean {
  return Boolean(left && left.length === right.length && left.every((item, index) => Object.is(item, right[index])));
}

function createFiber(): Fiber {
  return { slots: [], cursor: 0, effects: [] };
}

function flushEffects(fiber: Fiber): void {
  for (const effect of fiber.effects) {
    const slot = fiber.slots[effect.index]!;
    if (typeof slot.cleanup === 'function') slot.cleanup();
    slot.deps = effect.deps;
    slot.cleanup = effect.callback();
  }
  fiber.effects = [];
}

function makeDm(id: string, author: string, createdAt: string): DistributedObject {
  return {
    object_id: id,
    object_type: 'mycelium.dm',
    author,
    recipient: 'me-key',
    created_at: createdAt,
    expires_at: '2099-01-01T00:00:00.000Z',
    payload: { ciphertext: `PRIVATE-CIPHERTEXT-${id}`, text: `PRIVATE-TEXT-${id}` },
    signature: `signature-${id}`,
    replication_policy: {}
  };
}

function makeMessage(id: string): ConversationMessage {
  return { objectId: id, direction: 'in', createdAt: '2026-10-01T00:00:00.000Z', status: 'ok', text: id };
}

function makeContact(publicKey: string, encryptionPublicKey: string | undefined, lastReadAt?: string): Contact {
  return {
    publicKey,
    fingerprint: publicKey,
    addedAt: '2026-10-01T00:00:00.000Z',
    followed: false,
    encryptionPublicKey,
    lastReadAt
  };
}

function createHarness({
  initialObjects = [],
  initialContacts = [makeContact('peer-key', 'trusted-key')],
  initialCounterparty = 'peer-key'
}: {
  initialObjects?: DistributedObject[];
  initialContacts?: Contact[];
  initialCounterparty?: string;
} = {}) {
  let objects = [...initialObjects];
  let contacts = initialContacts;
  let counterparty = initialCounterparty;
  let scheduleRender = false;
  let renders = 0;
  let currentResult: ReturnType<typeof useDmConversation> | null = null;
  let currentUnread: DmUnreadState | null = null;
  const values: DmUnreadState[] = [];
  const events = createDmEvents();
  const providerFiber = createFiber();
  const chatFiber = createFiber();
  const store: ObjectStore = {
    async put(object) {
      objects.push(object);
      return true;
    },
    async get(objectId) {
      return objects.find((object) => object.object_id === objectId) ?? null;
    },
    async delete(objectId) {
      objects = objects.filter((object) => object.object_id !== objectId);
    },
    async query(criteria: ObjectCriteria = {}) {
      return objects.filter((object) => Object.entries(criteria).every(
        ([key, value]) => object[key as keyof DistributedObject] === value
      ));
    }
  };
  const load = vi.spyOn(conversations, 'loadConversation')
    .mockImplementation(async ({ counterparty: id }) => [makeMessage(id)]);
  const markRead = vi.spyOn(conversations, 'newestIncomingDmAt');
  const saveContact = vi.fn(async (_contact: Contact) => {});
  const updateContact = vi.fn((updated: Contact) => {
    contacts = contacts.map((contact) => contact.publicKey === updated.publicKey ? updated : contact);
    scheduleRender = true;
  });
  const identity = { id: 'me', publicKey: 'me-key', privateKey: '', encryptionPublicKey: '', encryptionPrivateKey: '' };
  const getIdentity = () => identity;
  const outbox = { get: async () => null };

  runtime.current = {
    fiber: null,
    contextValues: new Map(),
    scheduleRender() {
      scheduleRender = true;
    }
  };

  const render = () => {
    renders += 1;
    scheduleRender = false;
    providerFiber.cursor = 0;
    providerFiber.effects = [];
    runtime.current!.fiber = providerFiber;
    const element = DmUnreadProvider({
      store,
      myPublicKey: 'me-key',
      contacts,
      events,
      updateContact,
      saveContact,
      children: null
    }) as unknown as { token: object; value: DmUnreadState };
    currentUnread = element.value;
    values.push(element.value);
    runtime.current!.contextValues.set(element.token, element.value);

    chatFiber.cursor = 0;
    chatFiber.effects = [];
    runtime.current!.fiber = chatFiber;
    const resolveSenderEncryptionKey = (publicKey: string) => (
      contacts.find((contact) => contact.publicKey === publicKey)?.encryptionPublicKey ?? null
    );
    currentResult = useDmConversation({
      counterparty,
      getIdentity,
      store,
      outbox,
      resolveSenderEncryptionKey,
      dmService: null,
      events,
      isContactKnown: (publicKey) => contacts.some((contact) => contact.publicKey === publicKey),
      refreshIntervalMs: 5000
    });
    flushEffects(providerFiber);
    flushEffects(chatFiber);
  };

  const tick = async (limit = 20) => {
    for (let index = 0; index < limit; index += 1) {
      for (let microtask = 0; microtask < 8; microtask += 1) await Promise.resolve();
      if (scheduleRender) render();
    }
  };

  return {
    get contacts() { return contacts; },
    get currentResult() { return currentResult; },
    get currentUnread() { return currentUnread; },
    get renders() { return renders; },
    get values() { return values; },
    events,
    load,
    markRead,
    render,
    saveContact,
    setContacts(next: Contact[]) { contacts = next; scheduleRender = true; },
    setCounterparty(next: string) { counterparty = next; scheduleRender = true; },
    setObjects(next: DistributedObject[]) { objects = next; },
    tick,
    updateContact
  };
}

describe('useDmUnread provider with open DM conversation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    runtime.current = null;
  });

  it('opening a conversation loads once, marks read once, and stays under ten renders across two seconds', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.render();
    await harness.tick();
    await vi.advanceTimersByTimeAsync(2000);
    await harness.tick();

    expect(harness.currentResult?.loading).toBe(false);
    expect(harness.load).toHaveBeenCalledTimes(1);
    expect(harness.markRead).toHaveBeenCalledTimes(1);
    expect(harness.saveContact).toHaveBeenCalledTimes(1);
    expect(harness.updateContact).toHaveBeenCalledTimes(1);
    expect(harness.renders).toBeLessThan(10);
  });

  it('does not update contacts or save when markRead finds an unchanged timestamp', async () => {
    const latestAt = '2026-10-03T00:00:00.000Z';
    const harness = createHarness({
      initialContacts: [makeContact('peer-key', 'trusted-key', latestAt)],
      initialObjects: [makeDm('already-read', 'peer-key', latestAt)]
    });
    harness.render();
    await harness.tick();

    expect(harness.markRead).toHaveBeenCalledTimes(1);
    expect(harness.updateContact).not.toHaveBeenCalled();
    expect(harness.saveContact).not.toHaveBeenCalled();
  });

  it('keeps the provider value referentially stable across unrelated renders', async () => {
    const harness = createHarness();
    harness.render();
    await harness.tick();
    const settledValue = harness.currentUnread;

    harness.render();
    expect(harness.currentUnread).toBe(settledValue);
  });

  it('reloads once and marks once for an incoming DM while the conversation is open', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.render();
    await harness.tick();
    const loadsBeforeArrival = harness.load.mock.calls.length;
    const marksBeforeArrival = harness.markRead.mock.calls.length;
    const arrivingAt = new Date(Date.now() + 1000).toISOString();
    const arriving = makeDm('arriving', 'peer-key', arrivingAt);
    harness.setObjects([arriving]);
    harness.events.emitDmArrived(arriving);
    await vi.advanceTimersByTimeAsync(0);
    await harness.tick();

    expect(harness.load).toHaveBeenCalledTimes(loadsBeforeArrival + 1);
    expect(harness.markRead).toHaveBeenCalledTimes(marksBeforeArrival + 1);
    expect(harness.currentUnread?.byContact['peer-key']).toBe(0);
  });

  it('keeps noKey false when the trusted contact record refreshes', async () => {
    const harness = createHarness();
    harness.render();
    await harness.tick();
    expect(harness.currentResult?.noKey).toBe(false);
    const loadsBeforeRefresh = harness.load.mock.calls.length;

    harness.setContacts(harness.contacts.map((contact) => ({ ...contact })));
    harness.render();
    await harness.tick();

    expect(harness.currentResult?.noKey).toBe(false);
    expect(harness.load).toHaveBeenCalledTimes(loadsBeforeRefresh);
  });

  it('loads the newly selected counterparty thread exactly once', async () => {
    const harness = createHarness({
      initialContacts: [
        makeContact('peer-key', 'trusted-key'),
        makeContact('other-key', 'other-trusted-key')
      ]
    });
    harness.render();
    await harness.tick();
    const loadsBeforeSwitch = harness.load.mock.calls.length;

    harness.setCounterparty('other-key');
    harness.render();
    await harness.tick();

    expect(harness.load).toHaveBeenCalledTimes(loadsBeforeSwitch + 1);
    const latestLoad = harness.load.mock.calls[harness.load.mock.calls.length - 1];
    expect(latestLoad?.[0].counterparty).toBe('other-key');
  });

  it('returns only count fields and never exposes message text or ciphertext', async () => {
    const harness = createHarness({
      initialObjects: [makeDm('private', 'peer-key', '2026-10-03T00:00:00.000Z')]
    });
    harness.render();
    await harness.tick();
    const state: DmUnreadState = harness.currentUnread!;

    expect(Object.keys(state).sort()).toEqual(['byContact', 'markRead', 'total']);
    expect(JSON.stringify(state)).not.toContain('PRIVATE-TEXT');
    expect(JSON.stringify(state)).not.toContain('PRIVATE-CIPHERTEXT');
  });
});
