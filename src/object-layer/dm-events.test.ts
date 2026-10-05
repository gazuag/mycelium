import { describe, expect, it, vi } from 'vitest';
import { createDmEvents } from './dm-events';
import type { DistributedObject } from './types';

const object: DistributedObject = {
  object_id: 'dm-event-object',
  object_type: 'mycelium.dm',
  author: 'sender',
  recipient: 'recipient',
  created_at: '2026-10-05T12:00:00.000Z',
  payload: {},
  signature: 'signature',
  replication_policy: {}
};

describe('DM events', () => {
  it('delivers to all subscribers, unsubscribes handlers, and isolates throwing handlers', () => {
    const events = createDmEvents();
    const first = vi.fn();
    const throwing = vi.fn(() => { throw new Error('subscriber failed'); });
    const last = vi.fn();
    events.onDmArrived(first);
    const unsubscribe = events.onDmArrived(throwing);
    events.onDmArrived(last);

    events.emitDmArrived(object);
    expect(first).toHaveBeenCalledWith(object);
    expect(throwing).toHaveBeenCalledWith(object);
    expect(last).toHaveBeenCalledWith(object);

    unsubscribe();
    events.emitDmArrived(object);
    expect(first).toHaveBeenCalledTimes(2);
    expect(throwing).toHaveBeenCalledOnce();
    expect(last).toHaveBeenCalledTimes(2);
  });
});
