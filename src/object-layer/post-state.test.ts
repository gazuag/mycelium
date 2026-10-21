import { describe, expect, it } from 'vitest';
import { createPostObjectPayload } from './post-state';

describe('post object payloads', () => {
  it('stores structured mention identities while leaving visible content unchanged', () => {
    expect(createPostObjectPayload(
      'Hey @GreenRunningFox, check this out!',
      ['hello'],
      [{ handle: 'GreenRunningFox', peerId: 'peer-id', publicKey: 'peer-public-key' }]
    )).toEqual({
      content: 'Hey @GreenRunningFox, check this out!',
      tags: ['hello'],
      mentions: [{ handle: 'GreenRunningFox', peerId: 'peer-id', publicKey: 'peer-public-key' }]
    });
  });

  it('omits mention metadata for legacy-compatible posts without mentions and preserves reply fields', () => {
    expect(createPostObjectPayload('A post without mentions', [], [], 'parent-id', 'parent-author'))
      .toEqual({
        content: 'A post without mentions',
        tags: [],
        reply_to: 'parent-id',
        reply_to_author: 'parent-author'
      });
  });
});
