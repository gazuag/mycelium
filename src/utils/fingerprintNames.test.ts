import { describe, expect, it } from 'vitest';
import { displayNameOrFallback, fingerprintToHumanName, shortPeerId } from './fingerprintNames';
import { keyToUsername } from './usernameCodec';

describe('peer identity display helpers', () => {
  it('keeps display names and compacts identity-only labels without an @ prefix', () => {
    expect(displayNameOrFallback(' Alice ', 'aa:bb:cc:dd:ee:ff:00:11')).toBe('Alice');
    expect(shortPeerId('aa:bb:cc:dd:ee:ff:00:11')).toBe('aa:bb:…:00:11');
    expect(shortPeerId('long-peer-identifier-1234')).toBe('long-pee…1234');
    expect(fingerprintToHumanName('long-peer-identifier-1234')).toBe('long-pee…1234');
  });

  it('does not change short IDs or the source identity value', () => {
    const peerId = 'peer-1234';
    expect(shortPeerId(peerId)).toBe(peerId);
    expect(peerId).toBe('peer-1234');
  });

  it('renders 64-bit fingerprints through the deterministic vocabulary codec', () => {
    expect(fingerprintToHumanName('00:00:00:00:00:00:00:00')).toBe(keyToUsername(0n));
  });
});
