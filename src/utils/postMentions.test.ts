import { describe, expect, it } from 'vitest';
import type { PostMention } from '../object-layer';
import { activeMentionAt, insertMention, mentionsPresentInText } from './postMentions';

const mention: PostMention = {
  handle: 'GreenRunningFox',
  peerId: '00:00:00:00:00:00:00:01',
  publicKey: 'peer-public-key'
};

describe('post mention editing helpers', () => {
  it('opens mention completion only at a mention boundary and returns the typed handle prefix', () => {
    expect(activeMentionAt('Hello @Gre', 10)).toEqual({ start: 6, query: 'Gre' });
    expect(activeMentionAt('email me@Gre', 12)).toBeNull();
    expect(activeMentionAt('word@Gre', 8)).toBeNull();
    expect(activeMentionAt('Hello @', 7)).toEqual({ start: 6, query: '' });
  });

  it('replaces the active prefix, preserves suffix text, and positions the caret after the inserted handle', () => {
    expect(insertMention('Hi @Gre there', 7, { start: 3, query: 'Gre' }, mention.handle))
      .toEqual({ text: 'Hi @GreenRunningFox there', caret: 19 });
    expect(insertMention('Hi @GreNext', 7, { start: 3, query: 'Gre' }, mention.handle))
      .toEqual({ text: 'Hi @GreenRunningFox Next', caret: 20 });
  });

  it('retains metadata only while its selected handle remains in text and deduplicates peers', () => {
    const duplicateHandle = { ...mention, handle: 'GreenRunningFox', publicKey: 'duplicate-public-key' };
    expect(mentionsPresentInText('Hey @GreenRunningFox and @GreenRunningFox!', [mention, duplicateHandle]))
      .toEqual([mention]);
    expect(mentionsPresentInText('Hey @GreenRunningFoxes!', [mention])).toEqual([]);
    expect(mentionsPresentInText('No mention here', [mention])).toEqual([]);
  });
});
