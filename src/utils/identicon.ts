export function createIdenticonDataUrl(seed: string, size = 48) {
  const normalizedSeed = (seed || 'mycelium').trim() || 'mycelium';

  let hash = 14695981039346656037n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < normalizedSeed.length; i += 1) {
    hash ^= BigInt(normalizedSeed.charCodeAt(i));
    hash = (hash * 1099511628211n) & mask;
  }

  const binary = hash.toString(2).padStart(64, '0');
  const colorTable: Record<string, { dark: string; light: string }> = {
    '000': { dark: '#000000', light: '#aaaaaa' },
    '001': { dark: '#000088', light: '#aaaaff' },
    '010': { dark: '#008800', light: '#aaffaa' },
    '100': { dark: '#880000', light: '#ffaaaa' },
    '011': { dark: '#008888', light: '#aaffff' },
    '101': { dark: '#880088', light: '#ffaaff' },
    '110': { dark: '#888800', light: '#ffffaa' },
    '111': { dark: '#888888', light: '#ffffff' }
  };

  const squares = Array.from({ length: 16 }, (_, index) => {
    const chunk = binary.slice(index * 4, index * 4 + 4);
    const variantBit = chunk[0];
    const familyBits = chunk.slice(1);
    const palette = colorTable[familyBits] ?? colorTable['000'];
    const fill = variantBit === '0' ? palette.dark : palette.light;

    const row = Math.floor(index / 4);
    const column = index % 4;
    const x = 5 + column * 10;
    const y = 5 + row * 10;
    return `<rect x="${x}" y="${y}" width="8" height="8" rx="1.5" fill="${fill}" />`;
  }).join('');

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48" role="img" aria-label="Identity icon">
      <rect width="48" height="48" rx="8" fill="#0b1020" />
      ${squares}
    </svg>
  `;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
