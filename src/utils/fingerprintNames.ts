const INITIALS = [
  "q", "w", "r", "t", "y", "p", "s", "d", "f", "g",
  "h", "j", "k", "l", "z", "x", "c", "v", "b", "n", "m",
  "bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "pl",
  "pr", "sl", "sm", "sn", "sp", "st", "sk", "sw", "tr",
  "tw", "sh", "ch"
];

const VOWELS = [
  "a", "e", "i", "o", "u",
  "ae", "ai", "au", "ao",
  "ea", "ei", "eu", "eo",
  "ia", "ie", "iu", "io",
  "oa", "oe", "oi", "ou",
  "ua", "ue", "ui", "uo",
  "aa", "ee", "oo", "uu"
];

const FINALS = [
  "",
  "q", "w", "r", "t", "y", "p", "s", "d", "f", "g",
  "h", "j", "k", "l", "z", "x", "c", "v", "b", "n", "m",
  "ck", "nd", "nt", "st", "sk", "sp", "ft", "mp",
  "ld", "lf", "lk", "lm", "ln", "lp", "lt",
  "rn", "rd", "rk", "rp", "rt", "rv", "rz",
  "sh", "th", "ch", "ng", "nk",
  "ns", "ks", "gz", "rs", "rb"
];

const INITIAL_COUNT = INITIALS.length;
const VOWEL_COUNT = VOWELS.length;
const FINAL_COUNT = FINALS.length;

export function encodeSyllable(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value >= 65536) {
    throw new Error('Value must be between 0 and 65535.');
  }

  const finalIndex = value % FINAL_COUNT;
  value = Math.floor(value / FINAL_COUNT);

  const vowelIndex = value % VOWEL_COUNT;
  value = Math.floor(value / VOWEL_COUNT);

  const initialIndex = value;

  return INITIALS[initialIndex] + VOWELS[vowelIndex] + FINALS[finalIndex];
}

export function decodeSyllable(syllable: string): number {
  for (let initialIndex = 0; initialIndex < INITIALS.length; initialIndex++) {
    const initial = INITIALS[initialIndex];

    if (!syllable.startsWith(initial)) {
      continue;
    }

    const remainderAfterInitial = syllable.slice(initial.length);

    for (let vowelIndex = 0; vowelIndex < VOWELS.length; vowelIndex++) {
      const vowel = VOWELS[vowelIndex];

      if (!remainderAfterInitial.startsWith(vowel)) {
        continue;
      }

      const remainder = remainderAfterInitial.slice(vowel.length);

      for (let finalIndex = 0; finalIndex < FINALS.length; finalIndex++) {
        if (FINALS[finalIndex] === remainder) {
          return ((initialIndex * VOWEL_COUNT) + vowelIndex) * FINAL_COUNT + finalIndex;
        }
      }
    }
  }

  throw new Error(`Invalid syllable: ${syllable}`);
}

function splitIntoSyllables(text: string): string[] {
  const syllables: string[] = [];
  let index = 0;

  while (index < text.length) {
    let best: string | null = null;
    let bestLength = 0;

    for (let i = 0; i < INITIALS.length; i++) {
      const initial = INITIALS[i];
      const candidate = text.slice(index, index + initial.length);
      if (candidate !== initial) continue;

      for (let vowelIndex = 0; vowelIndex < VOWELS.length; vowelIndex++) {
        const vowel = VOWELS[vowelIndex];
        const suffixStart = index + initial.length;
        const vowelCandidate = text.slice(suffixStart, suffixStart + vowel.length);
        if (vowelCandidate !== vowel) continue;

        for (let finalIndex = 0; finalIndex < FINALS.length; finalIndex++) {
          const final = FINALS[finalIndex];
          const syllableLength = initial.length + vowel.length + final.length;
          const candidateText = text.slice(index, index + syllableLength);
          if (candidateText.length > bestLength) {
            best = candidateText;
            bestLength = candidateText.length;
          }
        }
      }
    }

    if (!best) {
      throw new Error(`Could not decode syllable starting at index ${index}: ${text}`);
    }

    syllables.push(best);
    index += best.length;
  }

  return syllables;
}

export function encode64(value: bigint): string {
  if (value < 0n || value > 0xFFFFFFFFFFFFFFFFn) {
    throw new Error('Value must be an unsigned 64-bit integer.');
  }

  const syllables: string[] = [];

  for (let i = 0; i < 4; i++) {
    const chunk = Number((value >> BigInt(i * 16)) & 0xFFFFn);
    syllables.push(encodeSyllable(chunk));
  }

  return syllables.join('');
}

export function decode64(text: string): bigint {
  const syllables = splitIntoSyllables(text);

  if (syllables.length !== 4) {
    throw new Error('Expected exactly four syllables.');
  }

  let result = 0n;

  for (let i = 0; i < 4; i++) {
    const chunk = BigInt(decodeSyllable(syllables[i]));
    result |= chunk << BigInt(i * 16);
  }

  return result;
}

function capitalizeWord(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function fingerprintToHumanName(fingerprint: string): string {
  const normalized = fingerprint.replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (!normalized || normalized.length !== 16) {
    return fingerprint.trim() || 'Unknown peer';
  }

  const value = BigInt(`0x${normalized}`);
  const syllables = [] as string[];

  for (let i = 0; i < 4; i++) {
    const chunk = Number((value >> BigInt(i * 16)) & 0xFFFFn);
    syllables.push(encodeSyllable(chunk));
  }

  const firstWord = capitalizeWord(syllables[0] + syllables[1]);
  const secondWord = capitalizeWord(syllables[2] + syllables[3]);
  return `${firstWord} ${secondWord}`;
}

export function displayNameOrFallback(displayName: string | undefined, fingerprint: string): string {
  const trimmed = displayName?.trim();
  if (trimmed) {
    return trimmed;
  }

  return fingerprintToHumanName(fingerprint);
}
