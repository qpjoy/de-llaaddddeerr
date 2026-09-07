import { test, type Page } from '@playwright/test';

import { markBlocked, recordCaseEvidence } from './evidence.js';
import { closeCompass, launchCompass, type LaunchedCompass } from './helpers.js';

async function clearCredentialFields(window: Page): Promise<void> {
  await window
    .evaluate(() => {
      for (const selector of ['#account', '#password']) {
        const input = document.querySelector<HTMLInputElement>(selector);
        if (input) input.value = '';
      }
    })
    .catch(() => undefined);
}

async function waitForAuthOutcome(
  window: Page,
  timeoutMs = 60_000
): Promise<'home' | 'captcha' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outcome = await window
      .evaluate(() => {
        const visible = (element: Element | null) =>
          Boolean(
            element &&
              element.getClientRects().length > 0 &&
              getComputedStyle(element).visibility !== 'hidden'
          );
        if (visible(document.querySelector('.captcha-trigger'))) return 'captcha';
        if (visible(document.querySelector('.ai-home-page, .arco-main-layout'))) return 'home';
        return 'waiting';
      })
      .catch(() => 'waiting');
    if (outcome === 'home' || outcome === 'captcha') return outcome;
    await window.waitForTimeout(250);
  }
  return 'timeout';
}

test('CPS-EL-AUTH-001 dedicated test user completes the packaged login flow', async () => {
  const caseId = 'CPS-EL-AUTH-001';
  const account = process.env.COMPASS_E2E_ACCOUNT;
  const password = process.env.COMPASS_E2E_PASSWORD;
  let instance: LaunchedCompass | null = null;
  let warnings: string[] = [];

  try {
    if (!account || !password) {
      const reason = 'The formal auth lane has no dedicated Compass test credentials.';
      await markBlocked('credentials', reason);
      throw new Error(`[blocked] ${reason}`);
    }
    if (process.env.COMPASS_AUTH_CAPTCHA_MODE !== 'reviewed-test-hook') {
      const reason = 'The formal auth lane has no reviewed non-production captcha contract.';
      await markBlocked('captcha', reason);
      throw new Error(`[blocked] ${reason}`);
    }

    instance = await launchCompass();
    if (instance.rendererSurface !== 'login') {
      const reason = 'The isolated Compass profile opened an authenticated surface before this test submitted credentials.';
      await markBlocked('auth-state', reason);
      throw new Error(`[blocked] ${reason}`);
    }

    const accountField = instance.window.locator('#account');
    const passwordField = instance.window.locator('#password');
    try {
      await accountField.waitFor({ state: 'visible', timeout: 15_000 });
      await passwordField.waitFor({ state: 'visible', timeout: 15_000 });
      await accountField.fill(account);
      await passwordField.fill(password);
    } catch {
      await clearCredentialFields(instance.window);
      throw new Error('Compass credential fields could not be populated in the reviewed login renderer.');
    }

    const captcha = instance.window.locator('.captcha-trigger');
    if (await captcha.isVisible().catch(() => false)) {
      const reason =
        'The packaged Compass build still exposes its production captcha; the declared reviewed acceptance hook is not active.';
      await markBlocked('captcha', reason);
      throw new Error(`[blocked] ${reason}`);
    }

    try {
      await instance.window.locator('.login-button').click();
    } catch {
      await clearCredentialFields(instance.window);
      throw new Error('Compass could not submit the reviewed login form.');
    }
    const outcome = await waitForAuthOutcome(instance.window);
    if (outcome === 'captcha') {
      await clearCredentialFields(instance.window);
      const reason = 'Production captcha appeared after login submission; the reviewed acceptance hook is not active.';
      await markBlocked('captcha', reason);
      throw new Error(`[blocked] ${reason}`);
    }
    if (outcome === 'timeout') {
      await clearCredentialFields(instance.window);
      throw new Error('Compass did not reach the authenticated home after login submission.');
    }
    if (/\/login(?:[?#]|$)/u.test(instance.window.url())) {
      throw new Error('Compass still reports the login route after the authenticated home became visible.');
    }
  } finally {
    warnings = await closeCompass(instance);
    await recordCaseEvidence({
      caseId,
      coverageMode: 'automated-renderer',
      runtime: instance?.runtime,
      warnings,
      artifacts: [
        { role: 'runtime-metadata', path: 'logs/electron-metadata.json', sensitivity: 'internal' }
      ]
    });
  }
});
