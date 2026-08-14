export function createIdenticonDataUrl(seed: string, size = 48) {
  const normalizedSeed = (seed || 'mycelium').trim() || 'mycelium';
  const hash = Array.from(normalizedSeed).reduce((total, char) => total + char.charCodeAt(0), 0);
  const colors = ['#1f7f59', '#4ecdc4', '#f4d35e', '#ee6c4d', '#7c6ef5', '#9ad0c2'];
  const background = '#0d1b15';
  const color = colors[hash % colors.length];

  const cells = Array.from({ length: 25 }, (_, index) => {
    const value = (hash + index * 17) % 7;
    return value > 3;
  });

  const squares = cells
    .map((filled, index) => {
      if (!filled) return '';
      const row = Math.floor(index / 5);
      const col = index % 5;
      const x = col * 10 + 1;
      const y = row * 10 + 1;
      return `<rect x="${x}" y="${y}" width="8" height="8" rx="1.5" fill="${color}" />`;
    })
    .join('');

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 50 50" role="img" aria-label="Identity icon">
      <rect width="50" height="50" rx="8" fill="${background}" />
      ${squares}
    </svg>
  `;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
