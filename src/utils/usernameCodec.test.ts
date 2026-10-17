import { describe, expect, it } from 'vitest';
import {
  adjectives,
  pluralNouns,
  singularNouns,
  verbs
} from 'virtual:mycelium-username-vocabulary';
import { keyToUsername, usernameToKey, vocabularyEntryToPascalCase } from './usernameCodec';

const MAX_UINT64 = 0xffffffffffffffffn;

function composeKey(
  adjective1: number,
  adjective2: number,
  singularNoun: number,
  verb: number,
  adjective3: number,
  pluralNoun: number
): bigint {
  return (BigInt(adjective1) << 53n)
    | (BigInt(adjective2) << 42n)
    | (BigInt(singularNoun) << 32n)
    | (BigInt(verb) << 21n)
    | (BigInt(adjective3) << 10n)
    | BigInt(pluralNoun);
}

describe('deterministic username codec', () => {
  it('preserves authoritative vocabulary counts and entry order', () => {
    expect(adjectives).toHaveLength(2048);
    expect(singularNouns).toHaveLength(1024);
    expect(verbs).toHaveLength(2048);
    expect(pluralNouns).toHaveLength(1024);
    expect(adjectives[0]).toBe('acidic');
    expect(singularNouns[0]).toBe('aardvark');
    expect(verbs[0]).toBe('agreed with');
    expect(pluralNouns[0]).toBe('aardvarks');
    for (const entries of [adjectives, singularNouns, verbs, pluralNouns]) {
      const rendered = entries.map(vocabularyEntryToPascalCase);
      expect(new Set(rendered).size).toBe(entries.length);
    }
  });

  it('encodes zero and the maximum unsigned 64-bit key', () => {
    expect(keyToUsername(0n)).toBe('AcidicAcidicAardvarkAgreedWithAcidicAardvarks');
    expect(keyToUsername(MAX_UINT64)).toBe('ZigzaggyZigzaggyZucchiniWroteToZigzaggyZucchinis');
    expect(usernameToKey(keyToUsername(0n))).toBe(0n);
    expect(usernameToKey(keyToUsername(MAX_UINT64))).toBe(MAX_UINT64);
  });

  it('round-trips values around every fixed bit-field boundary', () => {
    const keys = new Set<bigint>([0n, MAX_UINT64]);
    for (const bit of [10n, 11n, 20n, 21n, 31n, 32n, 41n, 42n, 52n, 53n, 63n]) {
      keys.add((1n << bit) - 1n);
      keys.add(1n << bit);
      if (bit > 0n) keys.add((1n << bit) + 1n);
    }

    for (const key of keys) {
      const username = keyToUsername(key);
      expect(usernameToKey(username), `round-trip key ${key}`).toBe(key);
    }
  });

  it('round-trips a deterministic set of 64-bit values without Number conversion', () => {
    let state = 0x9e3779b97f4a7c15n;
    for (let index = 0; index < 256; index += 1) {
      state ^= state << 13n;
      state ^= state >> 7n;
      state ^= state << 17n;
      state &= MAX_UINT64;
      const username = keyToUsername(state);
      expect(usernameToKey(username), `round-trip key ${state}`).toBe(state);
    }
  });

  it('decodes valid generated usernames back to their exact source spelling', () => {
    const username = 'BraveBlueRobotEatsGreenUnicorns';
    expect(keyToUsername(usernameToKey(username))).toBe(username);
  });

  it.each(['looks for', 'dreams of', 'listening to', 'jumps over'])(
    'round-trips the exact multiword verb construct "%s"',
    (verbEntry) => {
      const verbIndex = verbs.indexOf(verbEntry);
      expect(verbIndex).toBeGreaterThanOrEqual(0);
      const key = composeKey(
        adjectives.indexOf('brave'),
        adjectives.indexOf('blue'),
        singularNouns.indexOf('robot'),
        verbIndex,
        adjectives.indexOf('green'),
        pluralNouns.indexOf('unicorns')
      );
      const username = keyToUsername(key);

      expect(username).toBe(`BraveBlueRobot${vocabularyEntryToPascalCase(verbEntry)}GreenUnicorns`);
      expect(usernameToKey(username)).toBe(key);
    }
  );

  it('PascalCases each whitespace-separated word without linguistic changes', () => {
    expect(vocabularyEntryToPascalCase('brave')).toBe('Brave');
    expect(vocabularyEntryToPascalCase('looks for')).toBe('LooksFor');
    expect(vocabularyEntryToPascalCase('listening to')).toBe('ListeningTo');
  });

  it('rejects invalid keys and malformed, unknown, or ambiguous usernames', () => {
    expect(() => keyToUsername(-1n)).toThrow(/unsigned 64-bit/i);
    expect(() => keyToUsername(MAX_UINT64 + 1n)).toThrow(/unsigned 64-bit/i);
    expect(() => keyToUsername(1 as unknown as bigint)).toThrow(/unsigned 64-bit/i);
    expect(() => usernameToKey('')).toThrow(/malformed/i);
    expect(() => usernameToKey('braveBlueRobotEatsGreenUnicorns')).toThrow();
    expect(() => usernameToKey('BraveBlueUnknownEatsGreenUnicorns')).toThrow(/vocabulary/i);
    expect(() => usernameToKey('BraveBlueRobotLooksForGreenUnicorns!')).toThrow(/vocabulary/i);
  });
});
