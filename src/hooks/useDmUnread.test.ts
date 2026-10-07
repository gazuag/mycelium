import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createDmEvents } from '../object-layer/dm-events';
import type { DistributedObject, ObjectCriteria, ObjectStore } from '../object-layer/types';
import type { Contact } from '../types';
import { createDmUnreadController, type DmUnreadState } from './useDmUnread';

function dm(objectId: string, author: string, createdAt: string): DistributedObject {
  return {
    object_id: objectId,
    object_type: 'mycelium.dm',
    author,
    recipient: 'me-key',
    created_at: createdAt,
    expires_at: '2099-01-01T00:00:00.000Z',
    payload: { ciphertext: `PRIVATE-CIPHERTEXT-${objectId}`, text: `PRIVATE-TEXT-${objectId}` },
    signature: `signature-${objectId}`,
    replication_policy: {}
  };
}

function makeContact(publicKey: string, lastReadAt?: string): Contact {
  return {
    publicKey,
    fingerprint: publicKey,
    addedAt: '2026-10-01T00:00:00.000Z',
    followed: false,
    lastReadAt
  };
}

function setup(objects: DistributedObject[]) {
  let contacts = [
    makeContact('alice-key', '2026-10-01T00:00:00.000Z'),
    makeContact('bob-key', '2026-10-02T00:00:00.000Z')
  ];
  const events = createDmEvents();
  const listeners = vi.fn();
  const updateContact = vi.fn((updated: Contact) => {
    contacts = contacts.map((contact) => contact.publicKey === updated.publicKey ? updated : contact);
  });
  const saveContact = vi.fn(async (updated: Contact) => {
    contacts = contacts.map((contact) => contact.publicKey === updated.publicKey ? updated : contact);
  });
  const store: ObjectStore = {
    async put(object) {
      objects.push(object);
      return true;
    },
    async get(objectId) {
      return objects.find((object) => object.object_id === objectId) ?? null;
    },
    async delete(objectId) {
      const index = objects.findIndex((object) => object.object_id === objectId);
      if (index >= 0) objects.splice(index, 1);
    },
    async query(criteria: ObjectCriteria = {}) {
      return objects.filter((object) => Object.entries(criteria).every(
        ([key, value]) => object[key as keyof DistributedObject] === value
      ));
    }
  };
  const controller = createDmUnreadController({
    store,
    myPublicKey: 'me-key',
    events,
    getContacts: () => contacts,
    updateContact,
    saveContact
  });
  controller.subscribe(listeners);
  return { contacts: () => contacts, controller, events, listeners, saveContact, store, updateContact };
}

describe('useDmUnread shared state', () => {
  it('reflects counts for two counterparties and total equals their sum', async () => {
    const harness = setup([
      dm('alice-1', 'alice-key', '2026-10-02T00:00:00.000Z'),
      dm('alice-2', 'alice-key', '2026-10-03T00:00:00.000Z'),
      dm('bob-1', 'bob-key', '2026-10-03T00:00:00.000Z')
    ]);
    harness.controller.start();

    await vi.waitFor(() => {
      const { total, byContact } = harness.controller.getSnapshot();
      expect(byContact).toEqual({ 'alice-key': 2, 'bob-key': 1 });
      expect(total).toBe(3);
    });
    harness.controller.stop();
  });

  it('refreshes from envelope metadata on a coalesced dm-arrived event', async () => {
    const objects: DistributedObject[] = [];
    const harness = setup(objects);
    const query = vi.spyOn(harness.store, 'query');
    harness.controller.start();
    await vi.waitFor(() => expect(harness.controller.getSnapshot().total).toBe(0));
    query.mockClear();

    const first = dm('arrived-a', 'alice-key', '2026-10-04T00:00:00.000Z');
    const second = dm('arrived-b', 'bob-key', '2026-10-04T00:00:01.000Z');
    objects.push(first, second);
    harness.events.emitDmArrived(first);
    harness.events.emitDmArrived(second);

    await vi.waitFor(() => expect(harness.controller.getSnapshot().total).toBe(2));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith({ object_type: 'mycelium.dm', recipient: 'me-key' });
    harness.controller.stop();
  });

  it('markRead zeroes only that counterparty and persists the newest incoming DM time', async () => {
    const harness = setup([
      dm('alice-1', 'alice-key', '2026-10-03T00:00:00.000Z'),
      dm('bob-1', 'bob-key', '2026-10-03T00:00:00.000Z')
    ]);
    harness.controller.start();
    await vi.waitFor(() => expect(harness.controller.getSnapshot().total).toBe(2));

    await harness.controller.markRead('alice-key');

    const state: DmUnreadState = harness.controller.getSnapshot();
    expect(state.byContact).toEqual({ 'alice-key': 0, 'bob-key': 1 });
    expect(state.total).toBe(1);
    expect(harness.contacts()[0].lastReadAt).toBe('2026-10-03T00:00:00.000Z');
    expect(harness.saveContact).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: 'alice-key',
      lastReadAt: '2026-10-03T00:00:00.000Z'
    }));
    harness.controller.stop();
  });

  it('stops listening when the provider lifecycle ends and returns no message text', async () => {
    const harness = setup([dm('alice-1', 'alice-key', '2026-10-03T00:00:00.000Z')]);
    harness.controller.start();
    await vi.waitFor(() => expect(harness.controller.getSnapshot().total).toBe(1));
    harness.controller.stop();
    const publishedCount = harness.listeners.mock.calls.length;

    harness.events.emitDmArrived(dm('late', 'alice-key', '2026-10-04T00:00:00.000Z'));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const serializedState = JSON.stringify(harness.controller.getSnapshot());
    expect(harness.listeners).toHaveBeenCalledTimes(publishedCount);
    expect(serializedState).not.toContain('PRIVATE-CIPHERTEXT');
    expect(serializedState).not.toContain('PRIVATE-TEXT');
    expect(Object.keys(harness.controller.getSnapshot())).toEqual(['byContact', 'total', 'markRead']);
  });
});
