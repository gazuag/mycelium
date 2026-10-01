import { webcrypto } from 'node:crypto';
import { describe, it } from 'vitest';
import { expect } from 'vitest';
import { calculateObjectId, canonicalizeObjectContent, validateObject } from './envelope';
import type { DistributedObject } from './types';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

const legacyObject: DistributedObject = {
  object_type: 'mycelium.legacy-fixture',
  created_at: '2026-09-30T12:34:56.000Z',
  payload: { content: 'legacy bytes', tags: ['compat'] },
  replication_policy: {},
  author: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJbTHH9ia4mvJfV9JPoq9gLazHXQAGfBq1xJCO9ud/2pI5l2qYgwI86d3z1ze8uc1ZtrajPIsCUHdvhm+ubJvGA==',
  object_id: '12b2412070faf86f46e92c2e6a53f678cefc933a8bf6e44217dd28e7cdd6b7c9',
  signature: 'iapp4rNI1EoVh4Et1XED0N0FQB6/VfgYMQB0YbikrAZtg9HsBrqydLKrUHkgzS4afwpMC170bMuGi7smL34w6A=='
};

const EXPECTED_CANONICAL =
  '{"author":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJbTHH9ia4mvJfV9JPoq9gLazHXQAGfBq1xJCO9ud/2pI5l2qYgwI86d3z1ze8uc1ZtrajPIsCUHdvhm+ubJvGA==",' +
  '"created_at":"2026-09-30T12:34:56.000Z","object_type":"mycelium.legacy-fixture",' +
  '"payload":{"content":"legacy bytes","tags":["compat"]},"replication_policy":{}}';

describe('legacy signed object fixture', () => {
  it('preserves canonical bytes, object ID, and signature for a legacy object', async () => {
    expect(canonicalizeObjectContent(legacyObject)).toBe(EXPECTED_CANONICAL);
    expect(await calculateObjectId(legacyObject)).toBe('12b2412070faf86f46e92c2e6a53f678cefc933a8bf6e44217dd28e7cdd6b7c9');
    expect(legacyObject.signature).toBe('iapp4rNI1EoVh4Et1XED0N0FQB6/VfgYMQB0YbikrAZtg9HsBrqydLKrUHkgzS4afwpMC170bMuGi7smL34w6A==');
    await expect(validateObject(legacyObject)).resolves.toBe(true);
  });
});
