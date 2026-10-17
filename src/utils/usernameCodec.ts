import {
  adjectives,
  pluralNouns,
  singularNouns,
  verbs
} from 'virtual:mycelium-username-vocabulary';

const MAX_UINT64 = 0xffffffffffffffffn;
const INDEX_MASK_11_BITS = 0x7ffn;
const INDEX_MASK_10_BITS = 0x3ffn;

interface TrieNode {
  children: Map<string, TrieNode>;
  index?: number;
}

function pascalCaseEntry(entry: string): string {
  return entry
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

function createVocabularyTrie(entries: readonly string[], name: string): TrieNode {
  const root: TrieNode = { children: new Map() };
  entries.forEach((entry, index) => {
    const pascal = pascalCaseEntry(entry);
    if (!pascal) throw new Error(`Username vocabulary ${name} contains an empty entry.`);
    let node = root;
    for (const character of pascal) {
      let child = node.children.get(character);
      if (!child) {
        child = { children: new Map() };
        node.children.set(character, child);
      }
      node = child;
    }
    if (node.index !== undefined) {
      throw new Error(`Username vocabulary ${name} has duplicate PascalCase form "${pascal}".`);
    }
    node.index = index;
  });
  return root;
}

const adjectiveTrie = createVocabularyTrie(adjectives, 'adjectives');
const singularNounTrie = createVocabularyTrie(singularNouns, 'singular nouns');
const verbTrie = createVocabularyTrie(verbs, 'verbs');
const pluralNounTrie = createVocabularyTrie(pluralNouns, 'plural nouns');
const componentTries = [
  adjectiveTrie,
  adjectiveTrie,
  singularNounTrie,
  verbTrie,
  adjectiveTrie,
  pluralNounTrie
] as const;

function maxEntryLength(entries: readonly string[]): number {
  return entries.reduce((maximum, entry) => Math.max(maximum, pascalCaseEntry(entry).length), 0);
}

const maxUsernameLength = (maxEntryLength(adjectives) * 3)
  + maxEntryLength(singularNouns)
  + maxEntryLength(verbs)
  + maxEntryLength(pluralNouns);

function vocabularyMatchesAt(root: TrieNode, username: string, start: number): Array<{ index: number; end: number }> {
  const matches: Array<{ index: number; end: number }> = [];
  let node = root;
  for (let offset = start; offset < username.length; offset += 1) {
    const character = username[offset]!;
    const child = node.children.get(character);
    if (!child) break;
    node = child;
    if (node.index !== undefined) matches.push({ index: node.index, end: offset + 1 });
  }
  return matches;
}

export function vocabularyEntryToPascalCase(entry: string): string {
  return pascalCaseEntry(entry);
}

export function keyToUsername(key: bigint): string {
  if (typeof key !== 'bigint' || key < 0n || key > MAX_UINT64) {
    throw new Error('Username key must be an unsigned 64-bit BigInt.');
  }

  const adjective1 = Number((key >> 53n) & INDEX_MASK_11_BITS);
  const adjective2 = Number((key >> 42n) & INDEX_MASK_11_BITS);
  const singularNoun = Number((key >> 32n) & INDEX_MASK_10_BITS);
  const verb = Number((key >> 21n) & INDEX_MASK_11_BITS);
  const adjective3 = Number((key >> 10n) & INDEX_MASK_11_BITS);
  const pluralNoun = Number(key & INDEX_MASK_10_BITS);

  return [
    adjectives[adjective1],
    adjectives[adjective2],
    singularNouns[singularNoun],
    verbs[verb],
    adjectives[adjective3],
    pluralNouns[pluralNoun]
  ].map((entry) => pascalCaseEntry(entry!)).join('');
}

export function usernameToKey(username: string): bigint {
  if (typeof username !== 'string' || username.length === 0 || username.length > maxUsernameLength) {
    throw new Error('Malformed username.');
  }

  const memo = new Map<string, number[][]>();
  const parseFrom = (componentIndex: number, offset: number): number[][] => {
    if (componentIndex === componentTries.length) return offset === username.length ? [[]] : [];
    const memoKey = `${componentIndex}:${offset}`;
    const cached = memo.get(memoKey);
    if (cached) return cached;

    const matches = vocabularyMatchesAt(componentTries[componentIndex]!, username, offset);
    const results: number[][] = [];
    for (const match of matches) {
      for (const suffix of parseFrom(componentIndex + 1, match.end)) {
        results.push([match.index, ...suffix]);
        if (results.length > 1) {
          memo.set(memoKey, results);
          return results;
        }
      }
    }
    memo.set(memoKey, results);
    return results;
  };

  const decompositions = parseFrom(0, 0);
  if (decompositions.length === 0) {
    throw new Error('Username does not match the configured vocabulary.');
  }
  if (decompositions.length !== 1) {
    throw new Error('Username has more than one valid vocabulary decomposition.');
  }

  const [adjective1, adjective2, singularNoun, verb, adjective3, pluralNoun] = decompositions[0]!;
  const key = (BigInt(adjective1!) << 53n)
    | (BigInt(adjective2!) << 42n)
    | (BigInt(singularNoun!) << 32n)
    | (BigInt(verb!) << 21n)
    | (BigInt(adjective3!) << 10n)
    | BigInt(pluralNoun!);
  if (key < 0n || key > MAX_UINT64) throw new Error('Decoded username is outside the unsigned 64-bit range.');
  return key;
}
