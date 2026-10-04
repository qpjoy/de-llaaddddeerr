import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeProfile, readProfile, savePrivate } from '../../scripts/identity-profile.mjs';
import { createPublicEntry } from '../../scripts/identity-public-profile.mjs';
import { identityConsoleOverview, saveIdentityApplication, validateIdentityApplication } from '../../scripts/identity-console.mjs';
import { resources } from '../../scripts/identity-deploy.mjs';
import { SERVICE_CATALOG_VERSION, defaultServiceProfile } from '../service-operations-catalog.js';

test('real Launcher shell registers applications, preserves drafts, routes to publication and supports both themes/mobile', { skip: !process.env.MX_SSO_BROWSER_MODULE, timeout: 60000 }, async t => {
  const { chromium } = await import(process.env.MX_SSO_BROWSER_MODULE);
  const dir = mkdtempSync(join(tmpdir(), 'mx-identity-ui-')), file = join(dir, 'profile.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profile = initializeProfile('https://10.88.88.88:18443', file);
  profile.publicEntry = createPublicEntry({ origin: 'https://auth.example.test', adminOrigin: 'https://launcher.example.test', hubOrigin: 'https://hub.example.test', audience: 'hub', privateOrigin: profile.origin });
  savePrivate(file, profile);
  let saves = 0, csrfChecks = 0, online = true;
  const staticRoot = fileURLToPath(new URL('../', import.meta.url));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (path === '/auth/admin/session') return send({ enabled: true, authenticated: true, canManage: true, csrf: 'fixture-csrf', user: { userId: 'fixture-admin', account: 'Administrator' } });
      if (path.includes('/service-operations/identity')) {
        assert.ok(path.startsWith('/admin-api/'), 'real renderer must use the admin BFF');
        assert.equal(req.headers['x-mx-admin-csrf'], 'fixture-csrf'); csrfChecks++;
        if (!online) return send({ message: '测试：执行器暂不可达' }, 503);
        const suffix = path.split('/service-operations/identity')[1];
        if (!suffix) return send(await identityConsoleOverview({ file, readRuntime: async () => ({ secret: resources(profile).runtime, deployments: [], pods: [] }) }));
        let raw = ''; for await (const chunk of req) raw += chunk;
        const input = JSON.parse(raw);
        if (suffix === '/validate') return send({ application: validateIdentityApplication(readProfile(file), input) });
        if (suffix === '/applications') { saves++; return send(saveIdentityApplication(input, { file })); }
      }
      if (path.endsWith('/service-operations/instances')) return send({ catalogVersion: SERVICE_CATALOG_VERSION, instances: [{ id: 'launcher', service: 'launcher', profile: defaultServiceProfile('launcher') }] });
      if (path.endsWith('/service-operations/operations')) return send({ operations: [] });
      if (path.includes('/internal/')) return send(path.includes('/dashboard') ? { overview: { siteId: 'fixture', storeDriver: 'fixture' }, sites: [] } : {});
      if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const relative = path === '/admin/' ? 'index.html' : path.replace(/^\/admin\//, '');
      const target = resolve(staticRoot, relative);
      if (!target.startsWith(staticRoot)) { res.writeHead(404); return res.end(); }
      const content = readFileSync(target);
      res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' })[extname(target)] || 'application/octet-stream' }); res.end(content);
    } catch (error) { send({ message: error.message }, error.status || 500); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/admin/`);
  await page.locator('#login-gate').waitFor({ state: 'hidden' });
  await page.locator('#tab-internal').click();
  await page.locator('[data-admin-subsection="identity-applications"]').click();
  const panel = page.locator('#identity-applications-panel');
  await panel.getByRole('heading', { name: '公网认证', exact: true }).waitFor();
  assert.equal(await page.locator('#foundation-grid').isVisible(), false);
  assert.equal(await page.locator('#admin-inspector').isVisible(), false);
  await panel.getByLabel('应用名称', { exact: true }).fill('MX Pay');
  await panel.getByLabel('应用标识', { exact: true }).fill('mx-pay');
  await panel.getByLabel('应用 HTTPS 地址', { exact: true }).fill('https://pay.example.test/path');
  await panel.getByLabel('权限标识 Audience', { exact: true }).fill('pay');
  await panel.getByRole('button', { name: '校验配置' }).click();
  await panel.locator('[role="status"]').filter({ hasText: '合法的 HTTPS' }).waitFor();
  assert.equal(await panel.getByLabel('应用名称', { exact: true }).inputValue(), 'MX Pay');
  await panel.getByLabel('应用 HTTPS 地址', { exact: true }).fill('https://pay.example.test');
  await panel.getByRole('button', { name: '校验配置' }).click();
  await panel.getByRole('button', { name: '保存应用' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-identity="save"]').disabled);
  await panel.getByRole('button', { name: '保存应用' }).click();
  await panel.locator('[role="status"]').filter({ hasText: '应用已保存' }).waitFor();
  assert.equal(saves, 1); assert.ok(csrfChecks >= 4);
  assert.match(await panel.locator('.identity-app').filter({ hasText: 'MX Pay' }).innerText(), /待发布/);
  assert.equal(await panel.getByRole('button', { name: '保存应用' }).isDisabled(), true);
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.locator('[data-theme-toggle]:visible').click();
    await panel.evaluate(el => { for (let node = el; node; node = node.parentElement) node.scrollTop = 0; });
    if (process.env.MX_IDENTITY_SCREENSHOTS) await page.screenshot({ path: join(process.env.MX_IDENTITY_SCREENSHOTS, `identity-applications-${theme}.png`), animations: 'disabled' });
  }
  online = false; await panel.getByRole('button', { name: '刷新状态' }).click();
  await panel.locator('[role="status"]').filter({ hasText: '执行器暂不可达' }).waitFor();
  assert.equal(await panel.getByLabel('应用名称', { exact: true }).inputValue(), 'MX Pay');
  online = true;
  await panel.getByRole('button', { name: '前往 Launcher 发布' }).click();
  await page.locator('#service-operations-panel [data-service-action]').waitFor();
  assert.equal(await page.locator('[data-service-action]').inputValue(), 'deploy');
  assert.equal(await page.locator('[data-service-select="launcher"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#tab-internal').click(); await page.locator('[data-admin-subsection="identity-applications"]').click();
  assert.equal(await panel.getByLabel('应用名称', { exact: true }).inputValue(), 'MX Pay');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile panel must not overflow');
  await panel.getByRole('button', { name: '刷新状态' }).click();
  await panel.locator('[role="status"]').filter({ hasText: '已刷新' }).waitFor();
  await panel.evaluate(el => { for (let node = el; node; node = node.parentElement) node.scrollTop = 0; });
  if (process.env.MX_IDENTITY_SCREENSHOTS) await page.screenshot({ path: join(process.env.MX_IDENTITY_SCREENSHOTS, 'identity-applications-mobile.png') });
  assert.deepEqual(errors, []);
});
