import { createInboxController, type InboxControllerConfig } from './inbox-controller';
import { createDmEvents, type DmEvents } from './dm-events';
import { createInboxRunner } from './inbox-runner';
import type { FindClientTransport } from './find-client';
import type { DistributedObject, ObjectStore } from './types';

export interface InboxServiceOptions {
  myPublicKey: string;
  store: ObjectStore;
  transport: FindClientTransport;
  loadCursor: (identityKey: string) => Promise<string | null>;
  saveCursor: (identityKey: string, cursor: string) => Promise<unknown>;
  events: DmEvents;
  controllerConfig?: Partial<InboxControllerConfig>;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export function createInboxService({
  myPublicKey,
  store,
  transport,
  loadCursor,
  saveCursor,
  events,
  controllerConfig,
  now,
  setTimer,
  clearTimer
}: InboxServiceOptions) {
  let stopped = false;
  let started = false;
  const recentIds = new Set<string>();
  const recentOrder: string[] = [];

  const notifyObjectStored = (object: DistributedObject) => {
    if (stopped || object.object_type !== 'mycelium.dm' || object.recipient !== myPublicKey) return;
    if (recentIds.has(object.object_id)) return;

    recentIds.add(object.object_id);
    recentOrder.push(object.object_id);
    if (recentOrder.length > 500) {
      const oldestId = recentOrder.shift();
      if (oldestId !== undefined) recentIds.delete(oldestId);
    }
    events.emitDmArrived(object);
  };

  const { syncOnce } = createInboxRunner({
    myPublicKey,
    store,
    transport,
    loadCursor,
    saveCursor,
    now,
    onStored: (objects) => objects.forEach(notifyObjectStored)
  });

  const controller = createInboxController({
    syncOnce,
    ...(now ? { now: () => now().getTime() } : {}),
    ...(setTimer ? { setTimer } : {}),
    ...(clearTimer ? { clearTimer } : {}),
    ...(controllerConfig ? { config: controllerConfig } : {})
  });

  return {
    start() {
      if (stopped || started) return;
      started = true;
      controller.start();
      controller.trigger('startup');
    },
    stop() {
      if (stopped) return;
      stopped = true;
      controller.stop();
    },
    notifyPeerConnected() {
      if (!stopped) controller.trigger('peer_connected');
    },
    notifyObjectStored
  };
}
