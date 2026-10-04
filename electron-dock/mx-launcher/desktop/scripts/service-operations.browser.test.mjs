import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE_CATALOG_VERSION, defaultServiceProfile } from '../service-operations-catalog.js';

test('Launcher plan feedback survives task polling and execute requires a current acknowledged plan', {
  skip: !process.env.MX_SSO_BROWSER_MODULE, timeout: 60000
}, async t => {
  const { chromium } = await import(process.env.MX_SSO_BROWSER_MODULE);
  const staticRoot = fileURLToPath(new URL('../', import.meta.url));
  const plans = new Map(), operations = new Map(), calls = [];
  let planMode = 'success', finishTasks = false, pollUnavailable = false, releasePlan;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (path === '/auth/admin/session') return send({ enabled: true, authenticated: true, canManage: true, csrf: 'fixture-csrf', user: { userId: 'fixture-admin', account: 'Administrator' } });
      if (path.includes('/service-operations/')) {
        assert.ok(path.startsWith('/admin-api/'));
        assert.equal(req.headers['x-mx-admin-csrf'], 'fixture-csrf');
        const suffix = path.split('/service-operations/')[1];
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : null; calls.push({ suffix, body });
        if (suffix === 'instances') return send({ catalogVersion: SERVICE_CATALOG_VERSION, host: 'fixture-host', instances: [{ id: 'launcher', service: 'launcher', profile: defaultServiceProfile('launcher') }] });
        if (suffix === 'operations') return send({ operations: [...operations.values()] });
        if (suffix.startsWith('operations/')) {
          if (pollUnavailable) return send({ message: '运维执行器暂不可达，请查询原任务。' }, 503);
          const operation = operations.get(suffix.split('/')[1]);
          if (finishTasks) { operation.status = 'succeeded'; operation.message = '命令已完成；服务健康以输出和验收为准'; }
          return send({ operation, log: 'Only synthetic task records; no deployment command runs.' });
        }
        if (suffix === 'plans') {
          if (planMode === 'reject') return send({ message: '项目存在未提交改动，请先提交并确定发布版本；仍可查看状态或复制命令' }, 400);
          if (planMode === 'malformed') return send({});
          const plan = { id: randomUUID(), instanceId: body.instanceId, service: 'launcher', action: body.action,
            revision: 'a'.repeat(40), requiresAcknowledgement: body.action === 'deploy',
            expiresAt: new Date(Date.now() + (planMode === 'expired' ? -1000 : 300000)).toISOString() };
          plans.set(plan.id, plan);
          if (planMode === 'pending') { releasePlan = () => send(plan); return; }
          return send(plan);
        }
        if (suffix === 'execute') {
          const plan = plans.get(body.planId);
          assert.ok(plan && Date.parse(plan.expiresAt) > Date.now());
          assert.ok(!plan.requiresAcknowledgement || body.acknowledged === true);
          const operation = { id: plan.id, service: plan.service, action: plan.action, status: 'running',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: '测试任务执行中' };
          operations.set(operation.id, operation); return send(operation);
        }
        throw new Error(`Unexpected operation: ${suffix}`);
      }
      if (path.includes('/internal/')) return send(path.includes('/dashboard') ? { overview: { siteId: 'fixture', storeDriver: 'fixture' }, sites: [] } : {});
      if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const relative = path === '/admin/' ? 'index.html' : path.replace(/^\/admin\//, '');
      const target = resolve(staticRoot, relative);
      if (!target.startsWith(staticRoot)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' })[extname(target)] || 'application/octet-stream' });
      res.end(readFileSync(target));
    } catch (error) { send({ message: error.message }, 500); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], consoleErrors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleErrors.push(message.text()); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/admin/`);
  await page.locator('#login-gate').waitFor({ state: 'hidden' });
  await page.locator('#tab-admin').click();
  await page.locator('[data-admin-section="services"]').click();
  const panel = page.locator('#service-operations-panel');
  const planButton = panel.locator('[data-service-command="plan"]'), execute = panel.locator('[data-service-command="execute"]');
  const feedback = panel.locator('[data-service-feedback]'), reason = panel.locator('[data-service-execute-reason]');
  const waitIdle = () => page.waitForFunction(() => !document.querySelector('[data-service-command="plan"]').disabled);
  const screenshot = async name => {
    if (!process.env.MX_OPERATIONS_SCREENSHOTS) return;
    mkdirSync(process.env.MX_OPERATIONS_SCREENSHOTS, { recursive: true });
    await panel.locator('.service-command-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.MX_OPERATIONS_SCREENSHOTS, name), fullPage: false, animations: 'disabled' });
  };
  await waitIdle();
  assert.equal(page.url(), `${origin}/admin/`); assert.equal(await page.title(), 'MX Launcher');
  assert.ok(await panel.getByRole('heading', { name: '服务与部署', exact: true }).isVisible());
  assert.equal(await page.locator('vite-error-overlay, nextjs-portal').count(), 0);

  await t.test('failed preflight stays visible when an earlier status task finishes', async () => {
    // Submit one synthetic read-only task, then attempt a new deploy preflight.
    await planButton.click(); await waitIdle(); await execute.click(); await waitIdle();
    await panel.locator('[data-service-action]').selectOption('deploy'); planMode = 'reject';
    await planButton.click(); await waitIdle();
    assert.match(await feedback.innerText(), /^预检失败：.*未提交改动/);
    pollUnavailable = true;
    await panel.locator('[data-service-task-error]').filter({ hasText: '暂不可达' }).waitFor({ timeout: 9000 });
    assert.match(await feedback.innerText(), /^预检失败：.*未提交改动/);
    assert.equal(await execute.isDisabled(), true);
    pollUnavailable = false;
    await panel.locator('[data-service-command="task-refresh"]').click(); await waitIdle();
    assert.match(await feedback.innerText(), /^预检失败：.*未提交改动/);
    assert.equal(await feedback.getAttribute('data-state'), 'error');
    finishTasks = true;
    await panel.locator('.service-task-summary p').filter({ hasText: '命令已完成' }).waitFor({ timeout: 9000 });
    assert.match(await feedback.innerText(), /^预检失败：.*未提交改动/);
    assert.equal(await feedback.getAttribute('data-state'), 'error');
    assert.equal(await execute.isDisabled(), true);
    assert.match(await reason.innerText(), /尚未生成有效计划/);
    assert.equal(calls.filter(call => call.suffix === 'execute').length, 1);
    await page.locator('[data-theme-toggle]:visible').click();
    await screenshot('preflight-failure-desktop.png');
  });

  await t.test('pending preflight shows progress; acknowledgement enables exactly one submission', async () => {
    planMode = 'pending'; await planButton.click();
    await planButton.filter({ hasText: '正在预检' }).waitFor();
    assert.equal(await execute.isDisabled(), true); assert.match(await reason.innerText(), /正在预检/);
    while (!releasePlan) await new Promise(resolve => setTimeout(resolve, 10));
    releasePlan(); await waitIdle();
    assert.match(await panel.locator('[data-service-plan]').innerText(), /计划已就绪/);
    assert.equal(await execute.isDisabled(), true); assert.match(await reason.innerText(), /勾选/);
    await panel.locator('[data-service-ack]').check();
    assert.equal(await execute.isEnabled(), true);
    await screenshot('plan-ready-desktop.png');
    await execute.click(); await waitIdle();
    assert.equal(calls.filter(call => call.suffix === 'execute').length, 2);
    assert.equal(await execute.isDisabled(), true);
  });

  await t.test('a rejected recheck discards an older acknowledged plan', async () => {
    planMode = 'success'; await planButton.click(); await waitIdle(); await panel.locator('[data-service-ack]').check();
    assert.equal(await execute.isEnabled(), true);
    planMode = 'reject'; await planButton.click(); await waitIdle();
    assert.equal(await execute.isDisabled(), true); assert.equal(await panel.locator('[data-service-ack]').count(), 0);
    assert.match(await feedback.innerText(), /预检失败/);
  });

  await t.test('malformed and expired plans explain why execution stays disabled', async () => {
    planMode = 'malformed'; await planButton.click(); await waitIdle();
    assert.match(await feedback.innerText(), /返回的计划无效/); assert.equal(await execute.isDisabled(), true);
    planMode = 'expired'; await planButton.click(); await waitIdle();
    assert.match(await reason.innerText(), /过期/); assert.equal(await execute.isDisabled(), true);
  });

  await t.test('mobile keeps failure reasons visible and edits invalidate a ready plan', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    planMode = 'reject'; await planButton.click(); await waitIdle();
    assert.match(await feedback.innerText(), /预检失败/);
    assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await screenshot('preflight-failure-mobile.png');
    planMode = 'success'; await planButton.click(); await waitIdle(); await panel.locator('[data-service-ack]').check();
    assert.equal(await execute.isEnabled(), true);
    await panel.locator('[data-service-field="tmpDir"]').fill('/data/tmp-updated');
    assert.equal(await execute.isDisabled(), true); assert.match(await reason.innerText(), /尚未生成有效计划/);
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors.filter(message => !/Failed to load resource: the server responded with a status of (400|503)/.test(message)), []);
  console.log(JSON.stringify({ url: `${origin}/admin/`, viewports: ['1440x1000', '390x844'],
    checks: ['page identity', 'nonblank', 'no framework overlay', 'console clean except intentional HTTP 400/503 fixtures', 'polling race', 'acknowledgement', 'stale plan rejected', 'mobile'],
    realDeployments: 0 }));
});
