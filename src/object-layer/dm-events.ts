import type { DistributedObject } from './types';

export interface DmEvents {
  onDmArrived(handler: (object: DistributedObject) => void): () => void;
  emitDmArrived(object: DistributedObject): void;
}

export function createDmEvents(): DmEvents {
  const handlers = new Set<(object: DistributedObject) => void>();

  return {
    onDmArrived(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    emitDmArrived(object) {
      for (const handler of handlers) {
        try {
          handler(object);
        } catch {
          // One subscriber must not block other subscribers.
        }
      }
    }
  };
}
