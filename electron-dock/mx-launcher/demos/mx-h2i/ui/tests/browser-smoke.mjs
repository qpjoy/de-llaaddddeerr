import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { runtimeFixture, idleFixture, devicesFixture } from './fixture.mjs';

const demoRoot = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(demoRoot, 'src/renderer-dist');
const output = path.join(demoRoot, 'out/ui-qa');
await mkdir(output, { recursive: true });
const chrome = process.env.MINCAVE_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const browser = await chromium.launch({ headless: true, ...(chrome && existsSync(chrome) ? { executablePath: chrome } : {}) });
const errors = [];

async function createPage(fixture, { bridge = true, width = 1120, height = 760 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mincave.test') return route.abort();
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(dist, `.${relative}`);
    if (!file.startsWith(dist + path.sep)) return route.abort();
    try {
      const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
      await route.fulfill({ body: await readFile(file), contentType });
    } catch { await route.fulfill({ status: 404, body: 'Not found' }); }
  });
  await context.addInitScript(({ state, bridge, devices }) => {
    if (!bridge) return;
    let runtime = structuredClone(state);
    let notify;
    window.__calls = [];
    const commit = (patch) => { runtime = { ...runtime, ...patch }; notify?.(structuredClone(runtime)); return structuredClone(runtime); };
    window.__emit = commit;
    window.mxH2i = {
      mincaveDevices: async () => ({ ok: true, value: devices }),
      platform: 'darwin',
      getState: async () => structuredClone(runtime),
      onState: (cb) => { notify = cb; return () => { notify = undefined; }; },
      startFeishuLogin: async () => { window.__calls.push('startFeishuLogin'); return commit({ authFlow: { provider: 'feishu', stage: 'awaiting-callback' } }); },
      cancelFeishuLogin: async () => { window.__calls.push('cancelFeishuLogin'); return commit({ authFlow: null }); },
      loginEmployee: async () => { window.__calls.push('loginEmployee'); return structuredClone(runtime); },
      repairSystemNetwork: async () => { window.__calls.push('repairSystemNetwork'); return structuredClone(runtime); },
      disconnect: async () => { window.__calls.push('disconnect'); return commit({ connection: { state: 'idle', mode: 'employee', health: {}, diagnostics: {} }, auth: null }); },
      cancelNetworkOperation: async () => { window.__calls.push('cancelNetworkOperation'); return commit({ networkOperation: { id: 'test-op', kind: 'manual-repair', status: 'paused', cancelable: true } }); },
      checkUpdates: async () => { window.__calls.push('checkUpdates'); return structuredClone(runtime); },
      applyUpdate: async () => {
        window.__calls.push('applyUpdate');
        commit({ update: { ...runtime.update, status: 'downloading', downloadProgress: { state: 'downloading', bytes: 512, totalBytes: 4096, percent: 12.5 } } });
        return new Promise((resolve) => { window.__finishDownload = () => resolve(commit({ update: { ...runtime.update, status: 'staged', restartRequired: true, restartPrompt: true, stagedPath: '/test/app.asar' } })); });
      },
      restartApp: async () => { window.__calls.push('restartApp'); return structuredClone(runtime); },
      openAdmin: async () => { window.__calls.push('openAdmin'); return true; },
      windowControl: async (action) => { window.__calls.push(`window:${action}`); return true; }
    };
  }, { state: fixture, bridge, devices: devicesFixture(fixture.mincaveAccess?.userId) });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://mincave.test/');
  return page;
}

try {
  const missing = await createPage(idleFixture(), { bridge: false });
  await missing.getByRole('heading', { name: '无法连接客户端' }).waitFor();
  assert.equal(await missing.getByText('使用飞书登录', { exact: true }).count(), 0);
  await missing.close();

  const login = await createPage(idleFixture());
  await login.getByRole('heading', { name: 'MinCave，探索从这里开始' }).waitFor();
  assert.equal(await login.locator('input[name="account"]').isVisible(), false);
  await login.screenshot({ path: path.join(output, 'login.png') });
  await login.getByRole('button', { name: '使用飞书登录', exact: true }).click();
  await login.getByRole('button', { name: '取消飞书登录', exact: true }).waitFor();
  assert.deepEqual(await login.evaluate(() => window.__calls), ['startFeishuLogin']);
  assert.equal(await login.getByRole('dialog').count(), 0);
  await login.getByRole('button', { name: '取消飞书登录', exact: true }).click();
  assert.equal(await login.locator('input[name="account"]').count(), 0);
  assert.equal(await login.getByRole('button', { name: '高级选项', exact: true }).count(), 0);
  await login.getByRole('button', { name: '使用飞书登录', exact: true }).focus();
  await login.evaluate(() => window.__emit({ feedback: { tone: 'info', message: '测试状态更新' } }));
  assert.equal(await login.getByText('测试状态更新', { exact: true }).count(), 0);
  await login.close();

  const home = await createPage(runtimeFixture());
  await home.getByRole('heading', { name: '欢迎，测试员工' }).waitFor();
  const body = await home.locator('body').innerText();
  for (const removed of ['今日流量', '月度用量', '演示员工', 'Sandbox', 'Nightall', '未实现应用', 'Luo', '工作了', '切换网关', '退出登录']) assert.ok(!body.includes(removed), removed);
  assert.equal(await home.locator('.mincave-resource-card').count(), 7);
  await home.screenshot({ path: path.join(output, 'workbench.png') });
  await home.getByRole('searchbox', { name: '搜索应用' }).fill('no-matching-app');
  await home.getByText('没有匹配的应用', { exact: true }).waitFor();
  await home.evaluate(() => window.__emit({ feedback: { tone: 'info', message: '刷新状态' } }));
  assert.equal(await home.getByRole('searchbox', { name: '搜索应用' }).inputValue(), 'no-matching-app');
  await home.getByRole('searchbox', { name: '搜索应用' }).fill('');
  await home.getByRole('button', { name: '列表视图', exact: true }).click();
  assert.equal(await home.locator('.mincave-apps-grid.is-list').count(), 1);
  await home.getByRole('button', { name: '网格视图', exact: true }).click();
  await home.getByRole('button', { name: '设备', exact: true }).click();
  await home.getByRole('heading', { name: 'QA Mac', exact: true }).waitFor();
  assert.equal(await home.locator('.mincave-device').count(), 2);
  assert.equal(await home.getByText('qa-device', { exact: true }).count(), 0);
  assert.equal(await home.getByText('已授权', { exact: true }).count(), 0);
  await home.locator('.mincave-account').click();
  await home.screenshot({ path: path.join(output, 'account.png') });
  await home.getByRole('button', { name: '设置', exact: true }).click();
  await home.getByRole('heading', { name: '连接设置' }).waitFor();
  await home.getByRole('button', { name: '打开设置', exact: true }).click();
  await home.getByRole('heading', { name: '高级设置' }).waitFor();
  assert.equal(await home.locator('input[name="bootstrapApiBaseUrl"]').count(), 1);
  assert.equal(await home.getByText('指纹、人脸与密码', { exact: true }).count(), 0);
  await home.getByRole('button', { name: '工作台', exact: true }).click();
  await home.getByRole('button', { name: '打开管理 海外代理', exact: true }).click();
  await home.getByRole('dialog', { name: '海外订阅' }).waitFor();
  assert.equal(await home.getByRole('textbox', { name: 'Clash 订阅' }).inputValue(), 'https://subscriptions.example.test/oversea.yaml');
  assert.equal(await home.getByText('上传总量', { exact: true }).count(), 0);
  await home.screenshot({ path: path.join(output, 'overseas-subscription.png') });
  await home.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await home.getByRole('button', { name: '工作台', exact: true }).click();
  await home.evaluate(() => window.__emit({ connection: { state: 'tunnel-only', mode: 'employee', health: { wireGuard: 'ready' }, localIp: '10.88.1.21', diagnostics: {} }, networkOperation: { id: 'test-op', kind: 'manual-repair', status: 'running', cancelable: true } }));
  await home.getByRole('button', { name: '取消', exact: true }).click();
  await home.getByText('恢复已暂停', { exact: true }).waitFor();
  assert.ok((await home.evaluate(() => window.__calls)).includes('cancelNetworkOperation'));
  await home.close();

  const release = runtimeFixture();
  release.update = { ...release.update, status: 'update-available', latestVersion: '2.1.21', artifactUrl: 'https://download.example.test/app.asar', artifactKind: 'app-asar', releaseNotes: '更新说明', deliveryMode: 'prompt-download-restart', activation: 'restart-auto' };
  const updates = await createPage(release);
  await updates.getByRole('dialog', { name: '版本更新' }).waitFor();
  await updates.getByRole('button', { name: '下载更新', exact: true }).click();
  await updates.getByRole('progressbar', { name: '更新下载进度' }).waitFor();
  assert.equal(await updates.getByRole('dialog').count(), 1);
  assert.equal(await updates.getByRole('button', { name: '取消下载', exact: true }).count(), 0);
  await updates.screenshot({ path: path.join(output, 'update-downloading.png') });
  await updates.evaluate(() => window.__finishDownload());
  await updates.getByRole('button', { name: '重新启动', exact: true }).waitFor();
  await updates.screenshot({ path: path.join(output, 'update-ready.png') });
  await updates.keyboard.press('Escape');
  assert.equal(await updates.getByRole('dialog').count(), 0);
  await updates.close();

  const small = await createPage(runtimeFixture(), { width: 760, height: 560 });
  await small.getByRole('heading', { name: '欢迎，测试员工' }).waitFor();
  assert.equal(await small.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await small.screenshot({ path: path.join(output, 'small-window.png') });
  await small.getByRole('button', { name: '断开', exact: true }).click();
  await small.getByRole('heading', { name: 'MinCave，探索从这里开始' }).waitFor();
  await small.close();
  assert.deepEqual(errors, []);
  console.log(`Browser UI smoke passed. Screenshots: ${output}`);
} finally { await browser.close(); }
