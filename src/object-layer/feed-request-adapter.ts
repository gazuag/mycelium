import type { DistributedObject, FeedCursor, FeedPageMetadata } from './types';

export interface FeedRequestPage {
  readonly objects: DistributedObject[];
  readonly next_cursor: FeedCursor | null;
  readonly has_more: boolean;
}

export type ProcessedFeedBatchHandler = (
  peerId: string,
  page: FeedPageMetadata | undefined,
  objects: DistributedObject[],
  processingError?: unknown
) => void;

export interface FeedRequestAdapterOptions {
  readonly sendPacket: (peerId: string, payload: {
    after: FeedCursor | null;
    limit: number;
    requestId: string;
  }) => void | Promise<void>;
  readonly subscribeBatches: (handler: ProcessedFeedBatchHandler) => () => void;
  readonly subscribeDisconnects: (handler: (peerId: string) => void) => () => void;
  readonly timeoutMs?: number;
}

export interface FeedRequestAdapter {
  readonly requestPage: (
    peerId: string,
    after: FeedCursor | null,
    limit?: number
  ) => Promise<FeedRequestPage>;
  dispose(): void;
}

export function createFeedRequestAdapter(
  options: FeedRequestAdapterOptions
): FeedRequestAdapter {
  const timeoutMs = options.timeoutMs ?? 8000;
  const pending = new Set<(error: Error) => void>();

  const requestPage = (peerId: string, after: FeedCursor | null, limit = 100) => new Promise<FeedRequestPage>((resolve, reject) => {
    const requestId = createRequestId();
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    let unsubscribeBatch = () => {};
    let unsubscribeDisconnect = () => {};

    const cleanup = () => {
      clearTimeout(timeout);
      unsubscribeBatch();
      unsubscribeDisconnect();
      pending.delete(fail);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    pending.add(fail);

    timeout = setTimeout(() => fail(new Error('Feed page request timed out')), timeoutMs);
    try {
      unsubscribeBatch = options.subscribeBatches((batchPeerId, page, objects, processingError) => {
        if (settled || batchPeerId !== peerId || page?.request_id !== requestId) return;
        if (processingError !== undefined) {
          fail(new Error('Feed batch processing failed'));
          return;
        }
        if (!page) return;
        settled = true;
        cleanup();
        resolve({
          objects,
          next_cursor: page.next_cursor,
          has_more: page.has_more
        });
      });
      unsubscribeDisconnect = options.subscribeDisconnects((disconnectedPeerId) => {
        if (disconnectedPeerId === peerId) fail(new Error('Feed peer disconnected'));
      });
    } catch (error) {
      fail(toError(error, 'Unable to subscribe to feed responses'));
      return;
    }

    Promise.resolve()
      .then(() => options.sendPacket(peerId, { after, limit, requestId }))
      .catch((error: unknown) => fail(toError(error, 'Unable to send feed request')));
  });

  return {
    requestPage,
    dispose() {
      for (const fail of [...pending]) fail(new Error('Feed request adapter disposed'));
    }
  };
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `feed-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
