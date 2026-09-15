import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1,
  timeout: 60000, expect: { timeout: 10000 },
  use: { baseURL: 'http://127.0.0.1:13000', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node tests/e2e/serve.mjs', url: 'http://127.0.0.1:13000/health/ready', reuseExistingServer: false, timeout: 30000 },
});
