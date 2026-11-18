import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Isolated E2E environment (never touches the dev stack on 3000 / 5001 or the `barcode` DB):
 *   MySQL  barcode_e2e  <- rebuilt from Dump20260919.sql before every run
 *   API    http://127.0.0.1:5101
 *   UI     http://127.0.0.1:3100  (Vite dev server, talks straight to the 5101 API)
 */
export const API_PORT = Number(process.env.E2E_API_PORT || 5101);
export const UI_PORT = Number(process.env.E2E_UI_PORT || 3100);
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const UI_URL = `http://127.0.0.1:${UI_PORT}`;

const root = path.resolve(__dirname, '..');
const resetScript = path.join(__dirname, 'scripts', 'reset-db.mjs');
const dbName = process.env.E2E_DB_NAME || 'barcode_e2e';
// Set E2E_DEBUG_SERVERS=1 to stream backend/frontend stderr (useful when a server fails to start).
const DEBUG_SERVERS = !!process.env.E2E_DEBUG_SERVERS;

// Use the locally installed Chrome by default (no browser download needed).
// Set E2E_BROWSER=chromium to use Playwright's bundled Chromium (`npm run install:browsers`).
const channel = (process.env.E2E_BROWSER || 'chrome') === 'chromium' ? undefined : 'chrome';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The suite shares ONE database and the workflow tests build on each other -> run serially.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    baseURL: UI_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    { name: 'api', testDir: './tests/api', use: { baseURL: API_URL } },
    {
      name: 'ui',
      testDir: './tests/ui',
      // The UI project reads data created by the API project (and vice-versa) only through the
      // database, so keep the order api -> ui for a deterministic baseline.
      dependencies: ['api'],
      use: { ...devices['Desktop Chrome'], channel, viewport: { width: 1440, height: 900 } },
    },
  ],

  webServer: [
    {
      // 1) rebuild the E2E database, 2) start the NestJS API against it.
      command: `node "${resetScript}" && npm run start:dev`,
      cwd: path.join(root, 'backend'),
      url: `${API_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: DEBUG_SERVERS ? 'pipe' : 'ignore',
      env: {
        PORT: String(API_PORT),
        NODE_ENV: 'test',
        DB_NAME: dbName,
        JWT_SECRET: 'e2e-only-secret',
        FRONTEND_URL: UI_URL,
        CORS_ORIGINS: UI_URL,
        // No real AI calls during tests: AI endpoints must degrade gracefully without a key.
        GEMINI_API_KEY: '',
      },
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${UI_PORT} --strictPort`,
      cwd: path.join(root, 'frontend'),
      url: UI_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: DEBUG_SERVERS ? 'pipe' : 'ignore',
      env: { VITE_API_URL: API_URL },
    },
  ],
});
