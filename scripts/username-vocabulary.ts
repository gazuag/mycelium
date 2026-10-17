import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

const VOCABULARY_FILES = {
  adjectives: ['adjectives.txt', 2048],
  singularNouns: ['singular_nouns.txt', 1024],
  pluralNouns: ['plural_nouns.txt', 1024],
  verbs: ['verbs.txt', 2048]
} as const;

export function usernameVocabularyPlugin(): Plugin {
  let vocabularyDirectory = '';

  return {
    name: 'mycelium-username-vocabulary',
    configResolved(config) {
      vocabularyDirectory = resolve(config.root, 'public/vocabulary');
    },
    resolveId(source) {
      if (source === 'virtual:mycelium-username-vocabulary') {
        return '\0virtual:mycelium-username-vocabulary';
      }
      return undefined;
    },
    load(id) {
      if (id !== '\0virtual:mycelium-username-vocabulary') return undefined;

      const vocabulary = Object.fromEntries(
        Object.entries(VOCABULARY_FILES).map(([name, [filename, expectedCount]]) => {
          const text = readFileSync(resolve(vocabularyDirectory, filename), 'utf8');
          const entries = text.split(/\r?\n/);
          if (entries[entries.length - 1] === '') entries.pop();
          if (entries.length !== expectedCount || entries.some((entry) => entry.length === 0)) {
            throw new Error(
              `Username vocabulary ${filename} must contain exactly ${expectedCount} non-empty entries; found ${entries.length}.`
            );
          }
          return [name, entries];
        })
      );

      return Object.entries(vocabulary)
        .map(([name, entries]) => `export const ${name} = ${JSON.stringify(entries)};`)
        .join('\n');
    }
  };
}
