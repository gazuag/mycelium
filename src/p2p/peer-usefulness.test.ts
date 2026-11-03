import { describe, expect, it } from 'vitest';
import {
  CONNECTION_EVIDENCE_HALF_LIFE_MS,
  FIND_EVIDENCE_HALF_LIFE_MS,
  OBJECT_EVIDENCE_HALF_LIFE_MS,
  estimatePeerUsefulness
} from './peer-usefulness';
import type {
  FindForwardingObservation,
  ObjectSupplyObservation,
  PeerConnectionObservation
} from './local-observations';

const NOW = Date.parse('2026-10-28T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function connection(peerId: string, connectedAt = NOW): PeerConnectionObservation {
  return {
    id: peerId,
    peer_id: peerId,
    success_count: 1,
    most_recent_success: new Date(connectedAt).toISOString(),
    recent_failures: [],
    sessions: [{
      id: `${peerId}-session`,
      opened_at: new Date(connectedAt).toISOString(),
      identity: { kind: 'session', peerId }
    }],
    updated_at: new Date(connectedAt).toISOString(),
    expires_at: new Date(NOW + 180 * DAY_MS).toISOString()
  };
}

function supply(
  supplierPeerId: string,
  objectId: string,
  objectAuthor = `author-${objectId}`,
  observedAt = NOW,
  expiresAt = NOW + 90 * DAY_MS
): ObjectSupplyObservation {
  const timestamp = new Date(observedAt).toISOString();
  return {
    id: `${encodeURIComponent(supplierPeerId)}|${encodeURIComponent(objectId)}`,
    supplier_peer_id: supplierPeerId,
    supplier_identity_kind: 'session',
    object_id: objectId,
    object_author: objectAuthor,
    object_author_verified: true,
    validated: true,
    first_observed_at: timestamp,
    last_observed_at: timestamp,
    updated_at: timestamp,
    expires_at: new Date(expiresAt).toISOString()
  };
}

function findResponse(
  id: string,
  incomingPeerId: string,
  childPeerId: string,
  status: FindForwardingObservation['status'] = 'responded',
  updatedAt = NOW,
  expiresAt = NOW + 30 * DAY_MS
): FindForwardingObservation {
  const timestamp = new Date(updatedAt).toISOString();
  return {
    id,
    request_id: `request-${id}`,
    incoming_peer_id: incomingPeerId,
    incoming_peer_identity_kind: 'session',
    child_peer_id: childPeerId,
    child_peer_identity_kind: 'session',
    status,
    observed_at: timestamp,
    updated_at: timestamp,
    expires_at: new Date(expiresAt).toISOString()
  };
}

function estimate(
  peerIds: readonly string[],
  records: {
    connections?: readonly PeerConnectionObservation[];
    findForwarding?: readonly FindForwardingObservation[];
    objectSupply?: readonly ObjectSupplyObservation[];
  } = {},
  connectedPeerIds: readonly string[] = peerIds
) {
  return estimatePeerUsefulness(peerIds, records, NOW, connectedPeerIds);
}

describe('local peer usefulness estimation', () => {
  it('returns neutral estimates with no evidence for new peers', () => {
    expect(estimate(['new-peer'], {})).toEqual([expect.objectContaining({
      peer_id: 'new-peer',
      direct_connection_observed: false,
      direct_identity_evidence: 'unknown',
      direct_connection_weight: 0,
      score: 0.5,
      confidence: 0,
      novel_object_weight: 0,
      forwarded_response_weight: 0
    })]);
  });

  it('keeps direct connection evidence separate from FIND forwarding paths', () => {
    const verifiedConnection = connection('verified-peer');
    verifiedConnection.sessions[0].identity = {
      kind: 'verified',
      peerId: 'verified-peer',
      publicKey: 'verified-public-key'
    };
    const [directPeer, , incomingPeer, childPeer] = estimate(
      ['direct-peer', 'verified-peer', 'incoming-peer', 'child-peer'],
      {
        connections: [connection('direct-peer'), verifiedConnection],
        findForwarding: [findResponse('find-1', 'incoming-peer', 'child-peer')]
      }
    );
    const [, verifiedPeer] = estimate(
      ['direct-peer', 'verified-peer'],
      { connections: [connection('direct-peer'), verifiedConnection] }
    );

    expect(directPeer).toMatchObject({
      direct_connection_observed: true,
      direct_identity_evidence: 'session'
    });
    expect(verifiedPeer).toMatchObject({
      direct_connection_observed: true,
      direct_identity_evidence: 'verified'
    });
    expect(incomingPeer.direct_connection_observed).toBe(false);
    expect(childPeer).toMatchObject({
      direct_connection_observed: false,
      direct_identity_evidence: 'unknown',
      responsive_forwarded_origins: 1
    });
  });

  it('excludes objects observed from another peer in the comparison set', () => {
    const estimates = estimate(['peer-a', 'peer-b'], {
      objectSupply: [
        supply('peer-a', 'unique-object', 'author-a'),
        supply('peer-a', 'shared-object', 'author-b'),
        supply('peer-b', 'shared-object', 'author-b')
      ]
    });

    expect(estimates[0].novel_object_weight).toBe(1);
    expect(estimates[1].novel_object_weight).toBe(0);
    expect(estimates[0].redundant_objects).toBe(1);
    expect(estimates[1].redundant_objects).toBe(1);
    expect(estimates[1].distinct_verified_authors).toBe(1);
    expect(estimates[0].score).toBeGreaterThan(estimates[1].score);
  });

  it('does not compare unconnected online candidates against each other', () => {
    const estimates = estimate(
      ['peer-a', 'peer-b'],
      {
        objectSupply: [
          supply('peer-a', 'shared-object', 'author-x'),
          supply('peer-b', 'shared-object', 'author-x')
        ]
      },
      []
    );

    expect(estimates.map(({ novel_object_weight }) => novel_object_weight)).toEqual([1, 1]);
  });

  it('excludes a shared object when its other supplier is currently connected', () => {
    const [peerA] = estimate(
      ['peer-a'],
      {
        objectSupply: [
          supply('peer-a', 'shared-object', 'author-x'),
          supply('peer-b', 'shared-object', 'author-x')
        ]
      },
      ['peer-b']
    );

    expect(peerA.novel_object_weight).toBe(0);
    expect(peerA.redundant_objects).toBe(1);
  });

  it('always includes the candidate while excluding disconnected historical peers and alternatives', () => {
    const [peerA] = estimate(
      ['peer-a'],
      {
        objectSupply: [
          supply('peer-a', 'candidate-object', 'author-x'),
          supply('disconnected-history', 'candidate-object', 'author-x'),
          supply('unconnected-alternative', 'candidate-object', 'author-x')
        ]
      },
      ['currently-connected']
    );

    expect(peerA.novel_object_weight).toBe(1);
    expect(peerA.redundant_objects).toBe(0);
  });

  it('credits observed objects not seen from other comparison peers', () => {
    const [peerA] = estimate(['peer-a'], {
      objectSupply: [supply('peer-a', 'object-x', 'author-x')]
    }, ['peer-a', 'peer-b']);

    expect(peerA.novel_object_weight).toBe(1);
  });

  it('does not discount an object because of a historical supplier outside the comparison set', () => {
    const [peerA] = estimate(['peer-a'], {
      objectSupply: [
        supply('peer-a', 'object-x', 'author-x'),
        supply('historical-peer-c', 'object-x', 'author-x')
      ]
    }, ['peer-a', 'peer-b']);

    expect(peerA.novel_object_weight).toBe(1);
    expect(peerA.redundant_objects).toBe(0);
  });

  it('credits different objects to their respective suppliers', () => {
    const estimates = estimate(['peer-a', 'peer-b'], {
      objectSupply: [
        supply('peer-a', 'object-x', 'author-x'),
        supply('peer-b', 'object-y', 'author-y')
      ]
    });

    expect(estimates.map(({ novel_object_weight }) => novel_object_weight)).toEqual([1, 1]);
  });

  it("treats a single-peer comparison set as all of that peer's observed supply", () => {
    const [peerA] = estimate(['peer-a'], {
      objectSupply: [
        supply('peer-a', 'object-x', 'author-x'),
        supply('peer-a', 'object-y', 'author-y')
      ]
    });

    expect(peerA.novel_object_weight).toBe(2);
    expect(peerA.redundant_objects).toBe(0);
  });

  it('does not let FIND responsiveness increase information score or confidence', () => {
    const objectOnly = estimate(['child-peer'], {})[0];
    const findOnly = estimate(['child-peer'], {
      findForwarding: [findResponse('find-only', 'origin-peer', 'child-peer')]
    })[0];

    expect(findOnly.responsive_forwarded_origins).toBe(1);
    expect(findOnly.forwarded_response_weight).toBe(1);
    expect(findOnly.novel_object_weight).toBe(0);
    expect(findOnly.score).toBe(objectOnly.score);
    expect(findOnly.confidence).toBe(objectOnly.confidence);
  });

  it('decays old object and FIND evidence by their configured half-lives', () => {
    const [oldObject, oldFind, oldConnection] = estimate(['object-peer', 'find-peer', 'connection-peer'], {
      connections: [connection('connection-peer', NOW - CONNECTION_EVIDENCE_HALF_LIFE_MS)],
      objectSupply: [supply('object-peer', 'half-life-object', 'author', NOW - OBJECT_EVIDENCE_HALF_LIFE_MS)],
      findForwarding: [
        findResponse('find-old', 'incoming-peer', 'find-peer', 'responded', NOW - FIND_EVIDENCE_HALF_LIFE_MS)
      ]
    });

    expect(oldObject.novel_object_weight).toBe(0.5);
    expect(oldFind.forwarded_response_weight).toBe(0.5);
    expect(oldConnection.direct_connection_weight).toBe(0.5);
    expect(oldObject.score).toBeGreaterThan(0.5);
    expect(oldObject.score).toBeLessThan(estimate(['object-peer'], {
      objectSupply: [supply('object-peer', 'fresh-object', 'author')]
    })[0].score);
  });

  it('deduplicates repeated records and caps the contribution from one author', () => {
    const oneObject = supply('peer-a', 'object-0', 'prolific-author');
    const manyObjects = Array.from({ length: 100 }, (_, index) => (
      supply('peer-a', `object-${index}`, 'prolific-author')
    ));
    const duplicateFind = findResponse('duplicate-find', 'incoming-peer', 'peer-a');
    const result = estimate(['peer-a'], {
      objectSupply: [...manyObjects, ...Array.from({ length: 10 }, () => oneObject)],
      findForwarding: [duplicateFind, { ...duplicateFind }]
    })[0];
    const oneObjectResult = estimate(['peer-a'], { objectSupply: [oneObject] })[0];
    const sameEvidenceWithoutDuplicateFind = estimate(['peer-a'], {
      objectSupply: manyObjects,
      findForwarding: [duplicateFind]
    })[0];

    expect(result.distinct_validated_objects).toBe(100);
    expect(result.distinct_verified_authors).toBe(1);
    expect(result.novel_object_weight).toBe(1);
    expect(result.responsive_forwarded_origins).toBe(1);
    expect(result.novel_object_weight).toBe(oneObjectResult.novel_object_weight);
    expect(result.score).toBe(sameEvidenceWithoutDuplicateFind.score);
    expect(result.score).toBeLessThanOrEqual(0.95);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('does not give repeated supplier/object records additional distinct-object novelty', () => {
    const object = supply('peer-a', 'one-object', 'one-author');
    const single = estimate(['peer-a'], { objectSupply: [object] })[0];
    const repeated = estimate(['peer-a'], {
      objectSupply: [object, { ...object }, { ...object }]
    })[0];

    expect(repeated.distinct_validated_objects).toBe(1);
    expect(repeated.novel_object_weight).toBe(single.novel_object_weight);
  });

  it('caps usefulness evidence and score despite many distinct objects and origins', () => {
    const objectSupply = Array.from({ length: 20 }, (_, index) => (
      supply('peer-a', `object-${index}`, `author-${index}`)
    ));
    const findForwarding = Array.from({ length: 20 }, (_, index) => (
      findResponse(`find-${index}`, `incoming-${index}`, 'peer-a')
    ));
    const [result] = estimate(['peer-a'], { objectSupply, findForwarding });

    expect(result.novel_object_weight).toBe(5);
    expect(result.forwarded_response_weight).toBe(2);
    expect(result.score).toBeLessThanOrEqual(0.95);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('ignores expired or invalid records and safely handles missing categories', () => {
    const result = estimate(['peer-a'], {
      objectSupply: [
        supply('peer-a', 'expired', 'author', NOW, NOW - 1)
      ],
      findForwarding: [
        findResponse('expired-find', 'incoming-peer', 'peer-a', 'responded', NOW, NOW - 1),
        findResponse('pending-find', 'incoming-peer', 'peer-a', 'pending')
      ]
    })[0];
    const missing = estimate(['peer-a'])[0];

    expect(result.score).toBe(0.5);
    expect(result.confidence).toBe(0);
    expect(result).toMatchObject({
      distinct_validated_objects: 0,
      responsive_forwarded_origins: 0
    });
    expect(missing).toEqual(estimate(['peer-a'], {})[0]);
  });

  it('returns deterministic estimates for identical inputs', () => {
    const input = {
      connections: [connection('peer-a')],
      findForwarding: [findResponse('find-1', 'incoming-peer', 'peer-a')],
      objectSupply: [supply('peer-a', 'object-1', 'author-1')]
    };

    expect(estimate(['peer-a', 'new-peer'], input))
      .toEqual(estimate(['peer-a', 'new-peer'], input));
  });
});
