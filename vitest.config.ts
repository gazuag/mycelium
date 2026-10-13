import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache}/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'src/integration/**'
    ]
  }
});
