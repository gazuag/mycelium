import { describe, expect, it } from 'vitest';
import { generateFirstPost, FIRST_POST_ICEBREAKERS } from './first-post-generator';
import { fingerprintToHumanName } from './fingerprintNames';
import { friendlyNameFromUsername } from './usernameCodec';

describe('first post generation', () => {
  it('uses the display name when one is set', () => {
    const post = generateFirstPost('  Ada Lovelace  ', 'TangiestExcitedCat...', [], 0, undefined, () => 0);

    expect(post).toContain("I'm Ada Lovelace.");
    expect(post).not.toContain('Excited Cat');
  });

  it('uses the handle second adjective and singular noun when no display name exists', () => {
    const handle = fingerprintToHumanName('0123456789abcdef');
    const post = generateFirstPost('', handle, [], 0, undefined, () => 0);

    expect(post).toContain(`I'm ${friendlyNameFromUsername(handle)}.`);
    expect(friendlyNameFromUsername(handle).split(' ')).toHaveLength(2);
  });

  it('omits the interest section when none are selected', () => {
    const post = generateFirstPost('Ada', 'Handle', [], 0, undefined, () => 0);

    expect(post.split('\n\n')).toHaveLength(2);
    expect(post).not.toMatch(/interested|passionate|enjoy|love are/);
    expect(post.split('\n\n')[1]).toMatch(/\?$/);
  });

  it('formats one, two, and multiple interests with natural punctuation', () => {
    const one = generateFirstPost('Ada', 'Handle', ['Books'], 0, undefined, () => 0);
    const two = generateFirstPost('Ada', 'Handle', ['Books', 'Music'], 0, undefined, () => 0);
    const several = generateFirstPost('Ada', 'Handle', ['Books', 'Music', 'Art', 'Travel'], 0, undefined, () => 0);

    expect(one).toContain("I'm interested in Books.");
    expect(two).toContain("I'm interested in Books and Music.");
    expect(several).toContain("I'm interested in Books, Music, Art, and Travel.");
    expect(several.split('\n\n')).toHaveLength(3);
  });

  it('changes each wording section on regeneration and keeps the selected interests', () => {
    const first = generateFirstPost('Ada', 'Handle', ['Books', 'Music'], 0, undefined, () => 0);
    const firstQuestion = first.split('\n\n')[2]!;
    const second = generateFirstPost('Ada', 'Handle', ['Books', 'Music'], 1, firstQuestion, () => 0);
    const firstSections = first.split('\n\n');
    const secondSections = second.split('\n\n');

    expect(secondSections).toHaveLength(3);
    expect(secondSections[0]).not.toBe(firstSections[0]);
    expect(secondSections[1]).not.toBe(firstSections[1]);
    expect(secondSections[1]).toContain('Books and Music');
    expect(secondSections[2]).not.toBe(firstQuestion);
    expect(FIRST_POST_ICEBREAKERS.length).toBeGreaterThanOrEqual(40);
  });
});
