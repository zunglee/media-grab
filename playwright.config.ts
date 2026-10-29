import { defineConfig, devices } from '@playwright/test';

/**
 * Two suites.
 *
 * `ui` drives the fixture harness — the real popup and options components with
 * an in-memory fake of the browser API. Fast, and where the accessibility gates
 * live.
 *
 * `extension` loads the real built extension into a real Chromium and points it
 * at a local fixture site. It needs `dist/chrome-test`, which is the shipping
 * Chrome build plus host permissions for 127.0.0.1 and a declarative content
 * script — the browser's own permission prompt cannot be scripted, and those two
 * manifest lines are the whole difference.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  use: { trace: 'on-first-retry' },

  projects: [
    {
      name: 'ui',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5177' },
    },
    {
      name: 'extension',
      testDir: './tests/extension',
      // The spec launches its own persistent context; no shared browser here.
      use: {},
    },
  ],

  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5177',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
