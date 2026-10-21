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

  it('stores image-size metadata separately from the Markdown source without image data', () => {
    const content = '![alt](https://images.example/picture.png)';
    const payload = createPostObjectPayload(content, [], [], undefined, undefined, [
      { url: 'https://images.example/picture.png', status: 'known', sizeBytes: 2048 }
    ]) as Record<string, unknown>;

    expect(payload.content).toBe(content);
    expect(payload.image_sizes).toEqual([
      { url: 'https://images.example/picture.png', status: 'known', sizeBytes: 2048 }
    ]);
    expect(JSON.stringify(payload)).not.toContain('data:image');
  });
});
