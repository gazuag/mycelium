import { defineConfig } from 'vitest/config';
import { usernameVocabularyPlugin } from './scripts/username-vocabulary';

export default defineConfig({
  plugins: [usernameVocabularyPlugin()],
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
