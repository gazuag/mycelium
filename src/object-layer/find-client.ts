import { validateDistributedObject } from './envelope';
import { buildFindPacket, MAX_FIND_QUERY_LIMIT } from './transport';
import { createPacketId } from '../p2p/protocol';
import type { DistributedObject, FindQueryCriteria, FindResponsePacket, ObjectPacket } from './types';

export interface FindClientTransport {
  connectedPeers(): string[];
  send(peerId: string, packet: ObjectPacket): Promise<void>;
  subscribe(handler: (peerId: string, packet: ObjectPacket) => void): () => void;
}

export interface FindClientTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface CollectFindResultsOptions {
  transport: FindClientTransport;
  sender: string;
  criteria: FindQueryCriteria;
  validate?: (object: DistributedObject) => Promise<boolean>;
  fanout?: number;
  graceMs?: number;
  timeoutMs?: number;
  now?: () => Date;
  timers?: FindClientTimers;
}

export interface CollectFindResultsResult {
  objects: DistributedObject[];
  complete: boolean;
  responded: string[];
  failed: string[];
  timedOut: boolean;
}

export async function collectFindResults({
  transport,
  sender,
  criteria,
  validate = validateDistributedObject,
  fanout = 4,
  graceMs = 1000,
  timeoutMs = 5000,
  now = () => new Date(),
  timers = globalThis
}: CollectFindResultsOptions): Promise<CollectFindResultsResult> {
  const peers = [...new Set(transport.connectedPeers())].sort().slice(0, Math.max(0, fanout));
  if (peers.length === 0) return { objects: [], complete: false, responded: [], failed: [], timedOut: false };

  const requestId = createPacketId();
  const expiresAt = new Date(now().getTime() + timeoutMs).toISOString();
  const packets = await Promise.all(peers.map((peerId) => buildFindPacket(
    sender,
    peerId,
    [],
    undefined,
    requestId,
    1,
    sender,
    expiresAt,
    criteria
  )));
  const objects = new Map<string, DistributedObject>();
  const responsePeers = new Set<string>();
  const respondedPeers = new Set<string>();
  const failedPeers = new Set<string>();
  let settled = false;
  let pendingValidations = 0;
  let graceElapsed = false;
  let graceTimer: unknown;
  let timeoutTimer: unknown;
  let unsubscribe = () => {};

  return await new Promise<CollectFindResultsResult>((resolve, reject) => {
    const orderedPeers = (peerSet: Set<string>) => peers.filter((peerId) => peerSet.has(peerId));
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      const responded = orderedPeers(respondedPeers);
      const failed = orderedPeers(failedPeers);
      const mergedObjects = [...objects.values()];
      if (criteria.order === 'created_at_desc') {
        mergedObjects.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      }
      const requestedLimit = Number.isSafeInteger(criteria.limit) && (criteria.limit ?? 0) > 0
        ? Math.min(criteria.limit!, MAX_FIND_QUERY_LIMIT)
        : MAX_FIND_QUERY_LIMIT;
      resolve({
        objects: mergedObjects.slice(0, requestedLimit),
        complete: !timedOut && failed.length === 0 && responded.length === peers.length,
        responded,
        failed,
        timedOut
      });
    };
    const settleIfReady = () => {
      if (pendingValidations > 0) return;
      if (respondedPeers.size + failedPeers.size === peers.length) {
        finish(false);
      } else if (graceElapsed) {
        finish(false);
      }
    };
    const startGraceTimer = () => {
      if (graceTimer !== undefined) return;
      graceTimer = timers.setTimeout(() => {
        graceElapsed = true;
        settleIfReady();
      }, Math.max(0, graceMs));
    };

    try {
      unsubscribe = transport.subscribe((peerId, packet) => {
        if (settled || !peers.includes(peerId) || failedPeers.has(peerId)
          || responsePeers.has(peerId) || packet.type !== 'FIND_RESPONSE') return;
        const response = packet as FindResponsePacket;
        if (response.payload.requestId !== requestId) return;
        responsePeers.add(peerId);
        pendingValidations += 1;
        startGraceTimer();
        void (async () => {
          const candidates = Array.isArray(response.payload.objects)
            ? response.payload.objects
            : response.payload.object ? [response.payload.object] : [];
          for (const candidate of candidates) {
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
            const object = candidate as DistributedObject;
            if (criteria.recipient !== undefined && object.recipient !== criteria.recipient) continue;
            let isValid = false;
            try {
              isValid = await validate(object);
            } catch {
              isValid = false;
            }
            if (isValid && !objects.has(object.object_id)) objects.set(object.object_id, object);
          }
          respondedPeers.add(peerId);
        })().catch(() => {
          failedPeers.add(peerId);
        }).finally(() => {
          pendingValidations -= 1;
          settleIfReady();
        });
      });

      timeoutTimer = timers.setTimeout(() => finish(true), Math.max(0, timeoutMs));
      for (let index = 0; index < peers.length; index += 1) {
        const peerId = peers[index];
        try {
          void transport.send(peerId, packets[index]).catch(() => {
            if (!responsePeers.has(peerId)) failedPeers.add(peerId);
            settleIfReady();
          });
        } catch {
          failedPeers.add(peerId);
          settleIfReady();
        }
      }
    } catch (error) {
      reject(error);
    }
  }).finally(() => {
    if (graceTimer !== undefined) timers.clearTimeout(graceTimer);
    if (timeoutTimer !== undefined) timers.clearTimeout(timeoutTimer);
    unsubscribe();
  });
}

export function fetchPageFromPeers(
  transport: FindClientTransport,
  options: Omit<CollectFindResultsOptions, 'transport' | 'criteria'>
): (criteria: FindQueryCriteria) => Promise<DistributedObject[]> {
  return async (criteria) => (await collectFindResults({ ...options, transport, criteria })).objects;
}