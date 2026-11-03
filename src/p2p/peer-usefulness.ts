import {
  loadConnectionObservations,
  loadFindForwardingObservations,
  loadObjectSupplyObservations,
  type FindForwardingObservation,
  type ObjectSupplyObservation,
  type PeerConnectionObservation
} from './local-observations';

export const OBJECT_EVIDENCE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
export const FIND_EVIDENCE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
export const CONNECTION_EVIDENCE_HALF_LIFE_MS = 60 * 24 * 60 * 60 * 1000;

const MAX_AUTHOR_REACH_WEIGHT = 1;
const MAX_OBJECT_REACH_WEIGHT = 5;
const MAX_FIND_REACH_WEIGHT = 2;
const MAX_SCORE = 0.95;

export interface PeerUsefulnessObservations {
  connections?: readonly PeerConnectionObservation[];
  findForwarding?: readonly FindForwardingObservation[];
  objectSupply?: readonly ObjectSupplyObservation[];
}

export interface PeerUsefulnessEstimate {
  peer_id: string;
  direct_connection_observed: boolean;
  direct_identity_evidence: 'verified' | 'session' | 'unknown';
  direct_connection_weight: number;
  distinct_validated_objects: number;
  distinct_verified_authors: number;
  redundant_objects: number;
  responsive_forwarded_origins: number;
  novel_object_weight: number;
  forwarded_response_weight: number;
  score: number;
  confidence: number;
}

interface ActiveObjectSupply {
  supplierPeerId: string;
  objectId: string;
  author: string;
  weight: number;
}

interface ActiveFindResponse {
  id: string;
  incomingPeerId: string;
  childPeerId: string;
  updatedAt: number;
  status: FindForwardingObservation['status'];
}

export function estimatePeerUsefulness(
  peerIds: readonly string[],
  observations: PeerUsefulnessObservations,
  now = Date.now(),
  connectedPeerIds: readonly string[] = peerIds
): PeerUsefulnessEstimate[] {
  const activeObjects = getActiveObjectSupplies(observations.objectSupply ?? [], now);
  const activeFindResponses = getActiveFindResponses(observations.findForwarding ?? [], now);
  const uniquePeerIds = [...new Set(peerIds.filter((peerId) => typeof peerId === 'string' && peerId.length > 0))];

  return uniquePeerIds.map((peerId) => {
    const comparisonPeers = new Set([...connectedPeerIds, peerId]);
    const supplierCountByObject = new Map<string, number>();
    for (const object of activeObjects) {
      if (!comparisonPeers.has(object.supplierPeerId)) continue;
      const suppliers = supplierCountByObject.get(object.objectId) ?? 0;
      supplierCountByObject.set(object.objectId, suppliers + 1);
    }

    const connection = (observations.connections ?? []).find((record) => (
      isUnexpired(record?.expires_at, now)
      && record.peer_id === peerId
      && Number.isFinite(record.success_count)
      && record.success_count > 0
      && isUsableTimestamp(record.most_recent_success, now)
    ));
    const directIdentityEvidence = connection
      ? getIdentityEvidence(connection, peerId)
      : 'unknown';
    const directConnectionWeight = connection && connection.most_recent_success
      ? decayWeight(Date.parse(connection.most_recent_success), now, CONNECTION_EVIDENCE_HALF_LIFE_MS)
      : 0;

    const objects = activeObjects.filter((object) => object.supplierPeerId === peerId);
    const objectIds = new Set(objects.map((object) => object.objectId));
    const authorWeights = new Map<string, number>();
    const novelAuthorWeights = new Map<string, number>();
    let redundantObjects = 0;
    for (const object of objects) {
      authorWeights.set(
        object.author,
        Math.min(MAX_AUTHOR_REACH_WEIGHT, (authorWeights.get(object.author) ?? 0) + object.weight)
      );
      const suppliers = supplierCountByObject.get(object.objectId) ?? 1;
      if (suppliers > 1) {
        redundantObjects += 1;
        continue;
      }
      novelAuthorWeights.set(
        object.author,
        Math.min(MAX_AUTHOR_REACH_WEIGHT, (novelAuthorWeights.get(object.author) ?? 0) + object.weight)
      );
    }

    const findWeightsByOrigin = new Map<string, number>();
    for (const response of activeFindResponses) {
      if (response.childPeerId !== peerId || response.incomingPeerId === peerId) continue;
      const weight = decayWeight(response.updatedAt, now, FIND_EVIDENCE_HALF_LIFE_MS);
      findWeightsByOrigin.set(
        response.incomingPeerId,
        Math.max(findWeightsByOrigin.get(response.incomingPeerId) ?? 0, weight)
      );
    }

    const novelObjectWeight = Math.min(MAX_OBJECT_REACH_WEIGHT, sum(novelAuthorWeights.values()));
    const forwardedResponseWeight = Math.min(MAX_FIND_REACH_WEIGHT, sum(findWeightsByOrigin.values()));
    const objectEvidence = novelObjectWeight;
    const confidence = clamp(1 - Math.exp(-objectEvidence / 3), 0, 1);
    const score = Math.min(
      MAX_SCORE,
      0.5 + (MAX_SCORE - 0.5) * (objectEvidence / (objectEvidence + 2))
    );

    return {
      peer_id: peerId,
      direct_connection_observed: Boolean(connection),
      direct_identity_evidence: directIdentityEvidence,
      direct_connection_weight: round(directConnectionWeight),
      distinct_validated_objects: objectIds.size,
      distinct_verified_authors: authorWeights.size,
      redundant_objects: redundantObjects,
      responsive_forwarded_origins: findWeightsByOrigin.size,
      novel_object_weight: round(novelObjectWeight),
      forwarded_response_weight: round(forwardedResponseWeight),
      score: round(score),
      confidence: round(confidence)
    };
  });
}

export async function estimateLocalPeerUsefulness(
  peerIds: readonly string[],
  connectedPeerIds: readonly string[] = peerIds,
  now = Date.now()
): Promise<PeerUsefulnessEstimate[]> {
  const [connections, findForwarding, objectSupply] = await Promise.all([
    loadConnectionObservations(now),
    loadFindForwardingObservations(now),
    loadObjectSupplyObservations(now)
  ]);
  return estimatePeerUsefulness(peerIds, { connections, findForwarding, objectSupply }, now, connectedPeerIds);
}

function getIdentityEvidence(
  connection: PeerConnectionObservation,
  peerId: string
): PeerUsefulnessEstimate['direct_identity_evidence'] {
  const identities = (Array.isArray(connection.sessions) ? connection.sessions : [])
    .map((session) => session?.identity)
    .filter((identity) => identity?.peerId === peerId);
  if (identities.some((identity) => (
    identity.kind === 'verified' && typeof identity.publicKey === 'string' && identity.publicKey.length > 0
  ))) return 'verified';
  return identities.some((identity) => identity.kind === 'session') ? 'session' : 'unknown';
}

function getActiveObjectSupplies(records: readonly ObjectSupplyObservation[], now: number): ActiveObjectSupply[] {
  const bySupplierAndObject = new Map<string, ActiveObjectSupply>();
  for (const record of records) {
    if (record?.validated !== true
      || record.object_author_verified !== true
      || !hasText(record.supplier_peer_id)
      || !hasText(record.object_id)
      || !hasText(record.object_author)
      || !isUnexpired(record.expires_at, now)) continue;
    const observedAt = parseUsableTimestamp(record.last_observed_at, now);
    if (observedAt === null) continue;
    const key = `${record.supplier_peer_id.length}:${record.supplier_peer_id}${record.object_id}`;
    const previous = bySupplierAndObject.get(key);
    const weight = decayWeight(observedAt, now, OBJECT_EVIDENCE_HALF_LIFE_MS);
    if (!previous || weight > previous.weight) {
      bySupplierAndObject.set(key, {
        supplierPeerId: record.supplier_peer_id,
        objectId: record.object_id,
        author: record.object_author,
        weight
      });
    }
  }
  return [...bySupplierAndObject.values()];
}

function getActiveFindResponses(
  records: readonly FindForwardingObservation[],
  now: number
): ActiveFindResponse[] {
  const byId = new Map<string, ActiveFindResponse>();
  for (const record of records) {
    if (!hasText(record?.id)
      || !hasText(record.incoming_peer_id)
      || !hasText(record.child_peer_id)
      || record.incoming_peer_id === record.child_peer_id
      || !['pending', 'responded', 'failed'].includes(record.status)
      || !isUnexpired(record.expires_at, now)) continue;
    const updatedAt = parseUsableTimestamp(record.updated_at, now);
    if (updatedAt === null) continue;
    const previous = byId.get(record.id);
    if (!previous
      || statusRank(record.status) > statusRank(previous.status)
      || (record.status === previous.status && updatedAt > previous.updatedAt)) {
      byId.set(record.id, {
        id: record.id,
        incomingPeerId: record.incoming_peer_id,
        childPeerId: record.child_peer_id,
        updatedAt,
        status: record.status
      });
    }
  }
  return [...byId.values()].filter((record) => record.status === 'responded');
}

function statusRank(status: FindForwardingObservation['status']): number {
  if (status === 'responded') return 2;
  if (status === 'failed') return 1;
  return 0;
}

function isUnexpired(expiresAt: string | undefined, now: number): boolean {
  if (typeof expiresAt !== 'string') return false;
  const expiration = Date.parse(expiresAt);
  return Number.isFinite(expiration) && expiration > now;
}

function isUsableTimestamp(timestamp: string | undefined, now: number): boolean {
  return parseUsableTimestamp(timestamp, now) !== null;
}

function parseUsableTimestamp(timestamp: string | undefined, now: number): number | null {
  if (typeof timestamp !== 'string') return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed <= now ? parsed : null;
}

function decayWeight(observedAt: number, now: number, halfLifeMs: number): number {
  return Math.pow(0.5, Math.max(0, now - observedAt) / halfLifeMs);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
