import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../tests/fixtures/network-contract.json';
import { deriveFingerprint } from '../crypto/identity';
import { canonicalize, canonicalizeV3, isMyceliumPacket, isPeerFingerprint } from './protocol';
import {
  isNegotiationId,
  isPeerSignalMessage,
  shouldYieldToRemoteOffer
} from './signalling';

describe('shared networking contract fixtures', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives the documented peer fingerprint from the same public key', async () => {
    vi.stubGlobal('crypto', webcrypto);
    await expect(deriveFingerprint(fixture.identity.publicKey)).resolves.toBe(fixture.identity.fingerprint);
    for (const peerId of fixture.peerIds) {
      expect(isPeerFingerprint(peerId.value)).toBe(peerId.valid);
    }
  });

  it('validates common negotiation identifiers and signalling messages', () => {
    for (const negotiationId of fixture.negotiationIds) {
      expect(isNegotiationId(negotiationId.value)).toBe(negotiationId.valid);
    }
    for (const signal of fixture.signals) {
      expect(isPeerSignalMessage(signal.message)).toBe(signal.valid);
    }
    const tooLong = {
      ...fixture.signals[0].message,
      payload: { ...fixture.signals[0].message.payload, negotiationId: 'n'.repeat(129) }
    };
    expect(isPeerSignalMessage(tooLong)).toBe(false);
  });

  it('elects the same offer regardless of which peer is polite', () => {
    const { lowerPeerId, higherPeerId, winningNegotiationId, lowerNegotiationId } = fixture.simultaneousOffers;
    expect(shouldYieldToRemoteOffer(lowerPeerId, higherPeerId)).toBe(false);
    expect(shouldYieldToRemoteOffer(higherPeerId, lowerPeerId)).toBe(true);
    expect(lowerNegotiationId).toBe(winningNegotiationId);
  });

  it('accepts and serializes the shared Mycelium packet fixtures consistently', async () => {
    for (const entry of fixture.packets) {
      expect(isMyceliumPacket(entry.packet)).toBe(entry.valid);
    }
    expect(canonicalize(fixture.canonicalization.value)).toBe(fixture.canonicalization.v1);
    expect(canonicalizeV3(fixture.canonicalization.value)).toBe(fixture.canonicalization.v3);
  });
});
