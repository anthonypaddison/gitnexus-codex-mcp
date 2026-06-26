import { defineConfig, devices } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Enable insecure browser config (disabled security + CSP bypass) only when explicitly requested.
// Example: PLAYWRIGHT_INSECURE=1 npx playwright test
const insecureE2E = process.env.PLAYWRIGHT_INSECURE === '1';

// Base launch args: always enable software WebGL for sigma.js graph rendering in headless mode.
const launchArgs = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-webgl',
  '--enable-unsafe-swiftshader',
];

if (insecureE2E) {
  // Allow cross-origin requests to gitnexus serve on a different port when explicitly enabled.
  launchArgs.unshift('--disable-web-security', '--disable-site-isolation-trials');
}

const webRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/manual-record.spec.ts', '**/debug-issues.spec.ts'],
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  webServer: [
    {
      name: 'local-gitnexus',
      command: 'node scripts/e2e-local-gitnexus-server.mjs',
      cwd: webRoot,
      url: 'http://localhost:4747/api/repos',
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 },
    },
    {
      name: 'vite',
      command: 'npm run dev',
      cwd: webRoot,
      url: 'http://localhost:5173',
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 },
    },
  ],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'retain-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: launchArgs,
    },
    // Vite dev server sets COEP require-corp for SharedArrayBuffer (LadybugDB WASM).
    // Only bypass CSP when explicitly running in insecure E2E mode.
    bypassCSP: insecureE2E,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
    {
      name: 'edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
  ],
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
});
