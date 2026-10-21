import type { PostMention } from '../object-layer';

export interface ActiveMention {
  readonly start: number;
  readonly query: string;
}

export interface MentionInsertion {
  readonly text: string;
  readonly caret: number;
}

export function activeMentionAt(text: string, caret: number): ActiveMention | null {
  const beforeCaret = text.slice(0, caret);
  const match = /(?:^|[^A-Za-z0-9_@.+-])@([A-Za-z]*)$/.exec(beforeCaret);
  if (!match) return null;
  return {
    start: caret - match[1]!.length - 1,
    query: match[1]!
  };
}

export function insertMention(
  text: string,
  caret: number,
  activeMention: ActiveMention,
  handle: string
): MentionInsertion {
  const suffix = text.slice(caret);
  const separator = !suffix || /^[A-Za-z0-9_]/.test(suffix) ? ' ' : '';
  const inserted = `@${handle}${separator}`;
  return {
    text: `${text.slice(0, activeMention.start)}${inserted}${suffix}`,
    caret: activeMention.start + inserted.length
  };
}

export function mentionsPresentInText(
  text: string,
  mentions: readonly PostMention[]
): PostMention[] {
  const present = new Map<string, PostMention>();
  for (const mention of mentions) {
    const escapedHandle = mention.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(`(?:^|[^A-Za-z0-9_])@${escapedHandle}(?![A-Za-z0-9_])`);
    const identity = mention.peerId || mention.publicKey;
    if (matcher.test(text) && !present.has(identity)) present.set(identity, mention);
  }
  return [...present.values()];
}
