import { validateDistributedObject } from './envelope';
import { buildFindPacket, compareObjectsByCreatedAtDesc, MAX_FIND_QUERY_LIMIT } from './transport';
import { createPacketId } from '../p2p/protocol';
import type { DistributedObject, FindQueryCriteria, FindResponsePacket, ObjectPacket } from './types';

const MAX_FIND_ROUNDS = 2;

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
  peerOffset?: number;
  graceMs?: number;
  timeoutMs?: number;
  now?: () => Date;
  timers?: FindClientTimers;
}

export interface CollectFindResultsResult {
  objects: DistributedObject[];
  complete: boolean;
  paginationSupported: boolean;
  hasMore: boolean;
  responded: string[];
  failed: string[];
  timedOut: boolean;
}

export type FindPageResult = Pick<CollectFindResultsResult, 'objects' | 'complete' | 'paginationSupported' | 'hasMore'>;

export async function collectFindResults({
  transport,
  sender,
  criteria,
  validate = validateDistributedObject,
  fanout = 4,
  peerOffset = 0,
  graceMs = 1000,
  timeoutMs = 5000,
  now = () => new Date(),
  timers = globalThis
}: CollectFindResultsOptions): Promise<CollectFindResultsResult> {
  const eligiblePeers = [...new Set(transport.connectedPeers())].sort();
  const offset = eligiblePeers.length === 0 ? 0 : ((peerOffset % eligiblePeers.length) + eligiblePeers.length) % eligiblePeers.length;
  const initialPeers = [...eligiblePeers.slice(offset), ...eligiblePeers.slice(0, offset)]
    .slice(0, Math.max(0, fanout));
  if (initialPeers.length === 0) return {
    objects: [],
    complete: false,
    paginationSupported: false,
    hasMore: false,
    responded: [],
    failed: [],
    timedOut: false
  };

  const requestedLimit = Number.isSafeInteger(criteria.limit) && (criteria.limit ?? 0) > 0
    ? Math.min(criteria.limit!, MAX_FIND_QUERY_LIMIT)
    : MAX_FIND_QUERY_LIMIT;
  const overallDeadlineMs = Date.now() + Math.max(0, timeoutMs);
  const expiresAt = new Date(now().getTime() + Math.max(0, timeoutMs)).toISOString();
  const queriedPeers = new Set<string>();
  const objects = new Map<string, DistributedObject>();
  const responded: string[] = [];
  const failed: string[] = [];
  let complete = true;
  let paginationSupported = true;
  let hasMore = false;
  let timedOut = false;
  let peers = initialPeers;
  let round = 0;

  while (peers.length > 0 && round < MAX_FIND_ROUNDS) {
    const remainingMs = Math.max(0, overallDeadlineMs - Date.now());
    if (round > 0 && remainingMs === 0) break;
    peers.forEach((peerId) => queriedPeers.add(peerId));

    const result = await collectFindRound({
      transport,
      sender,
      criteria,
      peers,
      validate,
      graceMs,
      timeoutMs: remainingMs,
      expiresAt,
      timers
    });
    for (const object of result.objects) {
      if (!objects.has(object.object_id)) objects.set(object.object_id, object);
    }
    responded.push(...result.responded);
    failed.push(...result.failed);
    complete &&= result.complete;
    paginationSupported &&= result.paginationSupported;
    hasMore ||= result.hasMore;
    timedOut ||= result.timedOut;
    round += 1;

    if (objects.size >= requestedLimit || result.complete || round >= MAX_FIND_ROUNDS || timedOut) break;

    const remainingPeers = [...new Set(transport.connectedPeers())]
      .sort()
      .filter((peerId) => !queriedPeers.has(peerId));
    peers = remainingPeers.slice(0, Math.max(0, fanout));
  }

  const mergedObjects = [...objects.values()];
  if (criteria.order === 'created_at_desc') {
    mergedObjects.sort(compareObjectsByCreatedAtDesc);
  }
  return {
    objects: mergedObjects.slice(0, requestedLimit),
    complete,
    paginationSupported,
    hasMore,
    responded,
    failed,
    timedOut
  };
}

async function collectFindRound({
  transport,
  sender,
  criteria,
  peers,
  validate,
  graceMs,
  timeoutMs,
  expiresAt,
  timers
}: {
  transport: FindClientTransport;
  sender: string;
  criteria: FindQueryCriteria;
  peers: string[];
  validate: (object: DistributedObject) => Promise<boolean>;
  graceMs: number;
  timeoutMs: number;
  expiresAt: string;
  timers: FindClientTimers;
}): Promise<CollectFindResultsResult> {
  const requestId = createPacketId();
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
  const paginationPeers = new Set<string>();
  let hasMore = false;
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
        mergedObjects.sort(compareObjectsByCreatedAtDesc);
      }
      const requestedLimit = Number.isSafeInteger(criteria.limit) && (criteria.limit ?? 0) > 0
        ? Math.min(criteria.limit!, MAX_FIND_QUERY_LIMIT)
        : MAX_FIND_QUERY_LIMIT;
      resolve({
        objects: mergedObjects.slice(0, requestedLimit),
        complete: !timedOut && failed.length === 0 && responded.length === peers.length,
        paginationSupported: !requiresPaginationMetadata(criteria) || paginationPeers.size === peers.length,
        hasMore,
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
          if (response.payload.complete === true) respondedPeers.add(peerId);
          else failedPeers.add(peerId);
          if (response.payload.pagination_supported === true && typeof response.payload.has_more === 'boolean') {
            paginationPeers.add(peerId);
            hasMore ||= response.payload.has_more;
          }
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
): (criteria: FindQueryCriteria) => Promise<FindPageResult> {
  let peerOffset = options.peerOffset ?? 0;
  return async (criteria) => {
    const result = await collectFindResults({ ...options, transport, criteria, peerOffset });
    if (transport.connectedPeers().length > 0) peerOffset += 1;
    return {
      objects: result.objects,
      complete: result.complete,
      paginationSupported: result.paginationSupported,
      hasMore: result.hasMore
    };
  };
}

function requiresPaginationMetadata(criteria: FindQueryCriteria): boolean {
  return criteria.page_before !== undefined
    || (criteria.order === 'created_at_desc' && criteria.limit !== undefined);
}