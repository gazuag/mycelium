import { defineConfig, devices } from '@playwright/test';

const testPort = process.env.MYCELIUM_TEST_PORT ?? '8080';
const baseURL = process.env.MYCELIUM_BASE_URL ?? `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: './src/integration',
  timeout: 240_000,
  expect: {
    timeout: 30_000
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL
  },
  ...(process.env.MYCELIUM_BASE_URL ? {} : {
    webServer: {
      command: `npm run dev -- --host 127.0.0.1 --port ${testPort} --strictPort`,
      url: baseURL,
      env: { ...process.env, VITE_E2E_TEST_API: 'true' },
      reuseExistingServer: false,
      timeout: 30_000
    }
  })
});
