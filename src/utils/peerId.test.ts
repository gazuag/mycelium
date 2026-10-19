import { describe, expect, it } from 'vitest';
import { fingerprintToHumanName } from './fingerprintNames';
import { parsePeerId } from './peerId';

describe('parsePeerId', () => {
  it('converts a handle to the canonical 64-bit peer ID', () => {
    const peerId = '00:00:00:00:00:00:00:00';
    const handle = fingerprintToHumanName(peerId);

    expect(parsePeerId(`@${handle}`)).toBe(peerId);
    expect(parsePeerId(handle)).toBe(peerId);
  });

  it('accepts colon-separated and compact 64-bit peer IDs', () => {
    expect(parsePeerId('AA:BB:CC:DD:EE:FF:00:11')).toBe('aa:bb:cc:dd:ee:ff:00:11');
    expect(parsePeerId('aabbccddeeff0011')).toBe('aa:bb:cc:dd:ee:ff:00:11');
  });

  it('returns null for values that are neither a handle nor a 64-bit peer ID', () => {
    expect(parsePeerId('')).toBeNull();
    expect(parsePeerId('@notAValidHandle!')).toBeNull();
    expect(parsePeerId('aabbccddeeff001')).toBeNull();
  });
});
