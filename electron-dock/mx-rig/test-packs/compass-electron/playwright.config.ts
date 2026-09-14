import { resolve } from 'node:path';

import { defineConfig } from '@playwright/test';

const artifactRoot = resolve(
  process.env.MX_AUTO_ARTIFACTS_DIR ||
    process.env.MXT_ARTIFACTS_DIR ||
    process.env.MX_AUTOTEST_ARTIFACTS_DIR ||
    'artifacts'
);
const lane = process.env.MX_AUTO_ELECTRON_LANE === 'auth' ? 'auth' : 'bootstrap';
if (process.env.MX_AUTO_WRAPPER_GUARD !== 'compass-electron-v1') {
  throw new Error('Compass Electron Playwright must run through scripts/run.mjs.');
}
if (lane === 'auth' && process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1') {
  throw new Error('The Compass auth lane requires the reviewed Playwright privacy guard.');
}

export default defineConfig({
  testDir: './tests',
  testMatch: lane === 'auth' ? '**/login.spec.ts' : '**/boot.spec.ts',
  outputDir: resolve(artifactRoot, 'logs', 'playwright'),
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter:
    lane === 'auth'
      ? [
          ['junit', { outputFile: resolve(artifactRoot, 'junit', 'compass-electron.xml') }]
        ]
      : [
          ['line'],
          ['junit', { outputFile: resolve(artifactRoot, 'junit', 'compass-electron.xml') }],
          ['html', { outputFolder: resolve(artifactRoot, 'report'), open: 'never' }]
        ]
});
