import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Release Center binds edit, withdraw and restore actions to the authenticated admin API', {
  skip: !process.env.MX_SSO_BROWSER_MODULE, timeout: 60000
}, async t => {
  const { chromium } = await import(process.env.MX_SSO_BROWSER_MODULE);
  const staticRoot = fileURLToPath(new URL('../', import.meta.url));
  const calls = [], serverErrors = [], externalRequests = [], pageErrors = [];
  let plan = {
    planId: 'fixture-installer-plan', releaseId: 'mx-h2i-installer-3.0.1', productId: 'mx-h2i',
    channel: 'stable', createdAt: '2026-11-19T12:00:00.000Z', createdBy: 'fixture-admin',
    components: { launcher: {
      componentId: 'mx-h2i', componentKind: 'app-installer', currentVersion: '3.0.0',
      targetVersion: '3.0.1', updateAvailable: true, updateMode: 'manual'
    } },
    artifacts: [{ artifactId: 'fixture-installer', componentId: 'mx-h2i', kind: 'app-installer',
      version: '3.0.1', fileName: 'MinCave-3.0.1-mac-universal.dmg', platform: 'darwin', arch: 'universal',
      sizeBytes: 320 * 1024 * 1024, digest: `sha256:${'a'.repeat(64)}`, activation: 'installer-manual',
      source: 'Internal fixture', url: '/fixture/never-downloaded.dmg' }],
    rollout: { strategy: 'all', percentage: 100, segmentId: 'stable-all', rings: ['stable'],
      featureKeys: [], audience: { userIds: [], installIds: [] } },
    activation: { majorUpdateRequiresInstaller: true, connectionSafeMode: true },
    deliveryMode: 'prompt-download-restart', releaseNotes: 'Initial installer release notes.',
    test: { suiteId: 'fixture-gate', gate: { verdict: 'passed' } },
    decisions: { readyToPromote: true, nextActions: [] }
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    const send = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      if (path === '/auth/admin/session') return send({ enabled: true, authenticated: true,
        canManage: true, csrf: 'fixture-csrf', user: { userId: 'fixture-admin', account: 'Administrator' } });
      if (path.endsWith('/release-management/plans')) return send({ plans: [plan] });
      if (path.endsWith(`/release-management/plans/${plan.planId}`)) {
        assert.equal(req.method, 'PATCH');
        assert.equal(path, `/admin-api/internal/v1/release-management/plans/${plan.planId}`);
        assert.equal(req.headers['x-mx-admin-csrf'], 'fixture-csrf');
        assert.equal(req.headers['x-mx-ops-token'], undefined);
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); calls.push(body);
        if (Object.hasOwn(body, 'withdrawn')) {
          assert.equal(typeof body.withdrawn, 'boolean');
          plan = { ...plan, withdrawnAt: body.withdrawn ? '2026-11-19T12:30:00.000Z' : null,
            withdrawnBy: body.withdrawn ? 'fixture-admin' : null };
        } else {
          plan = { ...plan, releaseNotes: body.releaseNotes, channel: body.channel,
            rollout: { ...plan.rollout, strategy: body.rolloutStrategy, percentage: body.rolloutPercentage,
              rings: body.rolloutRings, featureKeys: body.featureKeys,
              audience: { userIds: body.targetUserIds, installIds: body.targetInstallIds } } };
        }
        return send({ plan });
      }
      if (path.includes('/internal/')) return send(path.includes('/dashboard') ? {
        overview: { siteId: 'fixture', storeDriver: 'fixture', releaseManagementPlans: 1 },
        sites: [], latestReleasePlans: [plan]
      } : {});
      if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const relative = path === '/admin/' ? 'index.html' : path.replace(/^\/admin\//, '');
      const target = resolve(staticRoot, relative);
      if (!target.startsWith(staticRoot)) { res.writeHead(404); return res.end(); }
      const content = readFileSync(target);
      res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' })[extname(target)] || 'application/octet-stream' });
      res.end(content);
    } catch (error) { serverErrors.push(error.message); send({ message: error.message }, 500); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', error => pageErrors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const screenshot = async name => {
    if (!process.env.MX_RELEASE_SCREENSHOTS) return;
    mkdirSync(process.env.MX_RELEASE_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.MX_RELEASE_SCREENSHOTS, name), animations: 'disabled' });
  };
  try {
    await page.goto(`${origin}/admin/`);
    await page.locator('#login-gate').waitFor({ state: 'hidden' });
    await page.locator('#tab-releases').click();
    const row = page.locator(`[data-release-select="${plan.planId}"]`);
    const drawer = page.locator('#user-editor-drawer');
    await row.waitFor();
    assert.equal(page.url(), `${origin}/admin/`);
    assert.equal(await row.getByRole('button', { name: '详情', exact: true }).isVisible(), true);
    assert.equal(await row.getByRole('button', { name: '编辑', exact: true }).isVisible(), true);
    assert.equal(await row.getByRole('button', { name: '撤销分发', exact: true }).isVisible(), true);
    await screenshot('release-ready.png');

    await row.getByRole('button', { name: '详情', exact: true }).click();
    await drawer.waitFor({ state: 'visible' });
    assert.match(await drawer.innerText(), /MinCave-3\.0\.1-mac-universal\.dmg/);
    await drawer.getByRole('button', { name: 'Done', exact: true }).click();
    await row.getByRole('button', { name: '编辑', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'releaseNotes');
    await page.waitForFunction(() => {
      const scroll = document.querySelector('#user-editor-drawer .app-drawer-scroll');
      const notes = document.querySelector('#user-editor-drawer [name="releaseNotes"]');
      if (!scroll || !notes || scroll.scrollTop <= 0) return false;
      const viewport = scroll.getBoundingClientRect(), field = notes.getBoundingClientRect();
      return field.top >= viewport.top && field.bottom <= viewport.bottom;
    });
    await screenshot('release-edit.png');
    await drawer.getByRole('button', { name: 'Done', exact: true }).click();

    const confirm = async (button, accept, expected, keyboard = false) => {
      const dialogPromise = page.waitForEvent('dialog');
      if (keyboard) await button.focus();
      const click = keyboard ? page.keyboard.press('Enter') : button.click();
      const dialog = await dialogPromise;
      assert.equal(dialog.type(), 'confirm');
      assert.match(dialog.message(), expected);
      assert.match(dialog.message(), /mx-h2i-installer-3\.0\.1/);
      if (accept) await dialog.accept(); else await dialog.dismiss();
      await click;
    };
    await confirm(row.getByRole('button', { name: '撤销分发', exact: true }), false, /撤销后/, true);
    assert.equal(calls.length, 0, 'cancel must not submit a lifecycle change');
    assert.equal(await drawer.isHidden(), true, 'button keyboard events must not open the row details');
    await confirm(row.getByRole('button', { name: '撤销分发', exact: true }), true, /已下载的安装包不会被删除/);
    await row.locator('mark[data-kind="withdrawn"]').waitFor();
    assert.equal(calls.length, 1); assert.equal(calls[0].withdrawn, true);
    assert.match(await row.innerText(), /已停止分发/);
    await screenshot('release-withdrawn.png');

    await row.getByRole('button', { name: '编辑', exact: true }).click();
    await drawer.locator('[name="releaseNotes"]').fill('Corrected release notes while withdrawn.');
    await drawer.getByRole('button', { name: 'Save release', exact: true }).click();
    await drawer.locator('.profile-feedback').filter({ hasText: '仍为已撤销' }).waitFor();
    assert.equal(calls.length, 2);
    assert.equal(Object.hasOwn(calls[1], 'withdrawn'), false, 'metadata editing must not restore distribution');
    assert.ok(plan.withdrawnAt);
    assert.equal(plan.releaseNotes, 'Corrected release notes while withdrawn.');
    await screenshot('release-withdrawn-edited.png');
    await confirm(drawer.getByRole('button', { name: '恢复分发', exact: true }), true, /Gate 状态重新提供/);
    await drawer.locator('.profile-feedback').filter({ hasText: '已恢复分发' }).waitFor();
    assert.equal(calls.length, 3); assert.equal(calls[2].withdrawn, false);
    assert.equal(plan.withdrawnAt, null);
    await drawer.getByRole('button', { name: 'Done', exact: true }).click();
    await row.locator('mark[data-kind="ready"]').waitFor();
    await screenshot('release-restored.png');
    await page.setViewportSize({ width: 1000, height: 900 });
    await row.locator('.app-table-actions').scrollIntoViewIfNeeded();
    for (const button of await row.locator('.app-table-actions button').all()) {
      assert.equal(await button.evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        return range.getClientRects().length;
      }), 1, 'each action label must remain on one line at a narrower viewport');
    }
    await screenshot('release-actions-narrow.png');
    assert.deepEqual(serverErrors, []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, [], 'the browser must never request a production or external origin');
    console.log(JSON.stringify({ origin, csrfProtectedPatches: calls.length,
      checks: ['details', 'keyboard edit scroll and focus', 'keyboard withdraw cancellation', 'withdraw', 'edit preserves withdrawal', 'restore', 'narrow action labels'],
      externalRequests: 0, realReleasesChanged: 0 }));
  } catch (error) {
    await screenshot('release-failure.png');
    throw error;
  }
});
