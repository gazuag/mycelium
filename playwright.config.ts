import { defineConfig, devices } from '@playwright/test';

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
    baseURL: 'http://localhost:8080'
  },
  webServer: {
    command: 'npm run dev -- --host localhost --port 8080 --strictPort',
    url: 'http://localhost:8080',
    reuseExistingServer: true,
    timeout: 30_000
  }
});
