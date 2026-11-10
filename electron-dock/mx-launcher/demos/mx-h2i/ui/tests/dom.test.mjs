import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { idleFixture, runtimeFixture, adminFixture, devicesFixture } from './fixture.mjs';

const index = await readFile(
  new URL('../../src/renderer-dist/index.html', import.meta.url),
  'utf8',
);
const entry = index.match(/src="([^"]+\.js)"/)[1];
const bundle = (
  await readFile(new URL(path.join('../../src/renderer-dist', entry), import.meta.url), 'utf8')
).replaceAll('import.meta.url', '"http://mincave.test/assets/app.js"');
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function mount(initial, withBridge = true, methods = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(
    '<!doctype html><html lang="zh-CN" data-ui="mincave"><body><div id="app"></div></body></html>',
    {
      url: 'http://mincave.test/',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole,
    },
  );
  const { window } = dom;
  let runtime = structuredClone(initial);
  let listener;
  const management = adminFixture();
  const calls = [];
  const emit = (patch) => {
    runtime = { ...runtime, ...patch };
    listener?.(structuredClone(runtime));
    return structuredClone(runtime);
  };
  Object.defineProperty(window.navigator, 'clipboard', {
    value: {
      writeText: async (value) => {
        calls.push(['copy', value]);
      },
    },
  });
  window.HTMLElement.prototype.scrollTo = function (x, y) {
    this.scrollLeft = x;
    this.scrollTop = y;
  };
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  if (withBridge)
    window.mxH2i = {
      platform: 'darwin',
      getState: async () => structuredClone(runtime),
      onState: (cb) => {
        listener = cb;
        return () => {
          listener = null;
        };
      },
      startFeishuLogin: async () => {
        calls.push('startFeishuLogin');
        return emit({ authFlow: { provider: 'feishu', stage: 'awaiting-callback' } });
      },
      cancelFeishuLogin: async () => {
        calls.push('cancelFeishuLogin');
        return emit({ authFlow: null });
      },
      disconnect: async () => {
        calls.push('disconnect');
        return emit({
          auth: null,
          connection: { state: 'idle', mode: 'employee', health: {}, diagnostics: {} },
        });
      },
      cancelNetworkOperation: async () => {
        calls.push('cancelNetworkOperation');
        return emit({ networkOperation: { id: 'op-1', kind: 'manual-repair', status: 'paused' } });
      },
      applyUpdate: async () => {
        calls.push('applyUpdate');
        return emit({
          update: {
            ...runtime.update,
            status: 'downloading',
            downloadProgress: { percent: 12.5, bytes: 512, totalBytes: 4096 },
          },
        });
      },
      restartApp: async () => {
        calls.push('restartApp');
        return structuredClone(runtime);
      },
      windowControl: async (action) => {
        calls.push(`window:${action}`);
        return true;
      },
      openAdmin: async () => {
        calls.push('openAdmin');
        return true;
      },
      mincaveDevices: async () => ({ ok: true, value: devicesFixture(runtime.mincaveAccess?.userId) }),
      mincaveAdmin: async (input) => {
        calls.push(`admin:${input.action}`);
        if (input.action === 'workspace') return { ok: true, value: structuredClone(management) };
        if (input.action === 'saveMember') {
          Object.assign(
            management.members.find((member) => member.id === input.id),
            input.value,
          );
          return { ok: true, value: { saved: true } };
        }
        return { ok: true, value: {} };
      },
      ...methods,
    };
  new vm.Script(bundle).runInContext(dom.getInternalVMContext());
  await tick();
  const document = window.document;
  const button = (name) => {
    const found = [...document.querySelectorAll('button')].find(
      (el) => el.textContent.trim() === name || el.getAttribute('aria-label') === name,
    );
    assert.ok(found, `button ${name} exists`);
    return found;
  };
  const click = async (name) => {
    button(name).click();
    await tick();
  };
  const input = async (selector, value) => {
    const field = document.querySelector(selector);
    assert.ok(field, selector);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
    return field;
  };
  return { dom, document, window, calls, emit, click, input, button, errors };
}

test('rendered login exposes only Feishu and preserves its focus through broadcasts', async () => {
  const h = await mount(idleFixture());
  try {
    assert.match(h.document.body.textContent, /MinCave，探索从这里开始/);
    assert.equal(h.document.querySelector('.password-open'), null);
    await h.click('使用飞书登录');
    assert.deepEqual(h.calls, ['startFeishuLogin']);
    assert.ok(h.button('取消飞书登录'));
    assert.equal(h.document.querySelector('dialog'), null);
    await h.click('取消飞书登录');
    assert.equal(h.document.querySelector('input[name="account"]'), null);
    assert.equal(h.document.querySelector('input[name="password"]'), null);
    assert.equal(h.document.querySelector('[aria-label="通知"]'), null);
    assert.ok(!h.document.body.textContent.includes('高级选项'));
    const button = h.button('使用飞书登录');
    button.focus();
    h.emit({ feedback: { tone: 'info', message: '不属于原型的提示' } });
    await tick();
    assert.equal(h.document.activeElement, button);
    assert.ok(!h.document.body.textContent.includes('不属于原型的提示'));
    assert.deepEqual(h.errors, []);
  } finally {
    h.dom.window.close();
  }
});

test('workbench omits unsupported UI and retains search, list, device and H2O navigation', async () => {
  const h = await mount(runtimeFixture());
  try {
    const text = h.document.body.textContent;
    for (const removed of [
      '今日流量',
      '月度用量',
      'Sandbox',
      'Nightall',
      '未实现应用',
      '切换网关',
      '退出登录',
    ])
      assert.ok(!text.includes(removed), removed);
    assert.equal(h.document.querySelectorAll('.mincave-resource-card').length, 7);
    assert.ok(!h.document.body.textContent.includes('AppCenter'));
    assert.ok(!h.document.body.textContent.includes('安装应用中心'));
    await h.input('input[type="search"]', 'nothing-matches');
    assert.match(h.document.body.textContent, /没有匹配的应用/);
    h.emit({ feedback: { tone: 'info', message: '刷新' } });
    await tick();
    assert.equal(h.document.querySelector('input[type="search"]').value, 'nothing-matches');
    await h.input('input[type="search"]', '');
    await h.click('列表视图');
    assert.ok(h.document.querySelector('.mincave-apps-grid.is-list'));
    await h.click('设备');
    assert.match(h.document.body.textContent, /QA Mac/);
    assert.match(h.document.body.textContent, /QA Windows/);
    assert.ok(!h.document.body.textContent.includes('qa-device'));
    assert.ok(!h.document.body.textContent.includes('已授权'));
    await h.click('工作台');
    await h.click('打开管理 海外代理');
    assert.equal(h.document.querySelector('dialog[aria-label="海外订阅"]')?.open, true);
    assert.equal(
      h.document.querySelector('#clash-subscription').value,
      'https://subscriptions.example.test/oversea.yaml',
    );
    for (const removed of [
      '上传总量',
      '下载总量',
      '本地代理',
      '节点',
      '规则',
      '订阅管理',
      'AppCenter',
    ]) {
      assert.ok(!h.document.querySelector('dialog').textContent.includes(removed), removed);
    }
    await h.click('复制订阅');
    assert.deepEqual(h.calls, [['copy', 'https://subscriptions.example.test/oversea.yaml']]);
    await h.click('关闭弹窗');
    assert.equal(h.document.querySelector('dialog'), null);
    await h.click('工作台');
    await h.click('断开');
    assert.ok(h.calls.includes('disconnect'));
    assert.match(h.document.body.textContent, /MinCave，探索从这里开始/);
    assert.deepEqual(h.errors, []);
  } finally {
    h.dom.window.close();
  }
});

test('employee navigation and real web apps preserve exact URLs and connection gating', async () => {
  const h = await mount(runtimeFixture());
  const entries = [
    ['Delta', 'http://delta.mxinfo-inc.cn/web/data-hub'],
    ['Night-All', 'http://10.88.88.88:13141/console/platform'],
    ['Hub', 'https://hub.minsight-ai.com/admin/?admin=1#/dataport/support'],
    ['Compass', 'http://10.88.88.88:55855/'],
    ['Compass管理后台', 'http://10.88.88.88:55866/admin'],
    ['Argus', 'https://inhouse.arguseek.com/research/new'],
  ];
  try {
    assert.deepEqual(
      [...h.document.querySelectorAll('nav[aria-label="主导航"] button')].map((b) =>
        b.textContent.trim(),
      ),
      ['工作台', '设备'],
    );
    for (const [name, url] of entries) {
      const link = h.document.querySelector(`a[aria-label="打开 ${name}"]`);
      assert.ok(link, name);
      assert.equal(link.getAttribute('href'), url);
      assert.equal(link.target, '_blank');
      assert.equal(link.getAttribute('aria-disabled'), 'false');
    }
    await h.click('管理控制台');
    assert.deepEqual(h.calls, ['admin:workspace']);
    assert.match(h.document.body.textContent, /成员与角色/);
    await h.click('员工工作台');
    for (const [category, expected] of [
      ['中台应用 3', ['Delta', 'Hub', 'Night-All']],
      ['产品应用 2', ['Compass', 'Argus']],
      ['管理后台 1', ['Compass管理后台']],
      ['员工福利 1', ['海外代理']],
    ]) {
      await h.click(category);
      assert.deepEqual(
        [...h.document.querySelectorAll('.mincave-resource-card h3')].map((el) => el.textContent),
        expected,
      );
    }
    const overseas = h.document.querySelector('[data-app-id="h2o"]');
    assert.ok(overseas);
    assert.equal(overseas.dataset.action, 'showH2oManager');
    await h.click('全部应用 7');
    await h.click('设备');
    await h.click('员工工作台');
    assert.ok(h.document.querySelector('a[aria-label="打开 Delta"]'));
    await h.input('input[type="search"]', 'Compass');
    assert.equal(h.document.querySelectorAll('.mincave-resource-card').length, 2);
    await h.input('input[type="search"]', '');
    h.emit({ connection: { state: 'tunnel-only', mode: 'employee' } });
    await tick();
    for (const link of h.document.querySelectorAll('.mincave-resource-main[role="link"]')) {
      assert.equal(link.getAttribute('href'), null);
      assert.equal(link.getAttribute('aria-disabled'), 'true');
    }
    assert.deepEqual(h.errors, []);
  } finally {
    h.dom.window.close();
  }
});

test('overseas card presents one install while preparing both underlying components', async () => {
  const initial = runtimeFixture();
  initial.apps.appcenter.installed = false;
  initial.apps.h2o.installed = false;
  const dependencyReady = structuredClone(initial);
  dependencyReady.apps.appcenter.installed = true;
  const calls = [];
  let completeDependency;
  const h = await mount(initial, true, {
    installAppCenter: () => {
      calls.push('dependency');
      return new Promise((resolve) => {
        completeDependency = resolve;
      });
    },
    enableH2o: async () => {
      calls.push('overseas');
      return runtimeFixture();
    },
  });
  try {
    assert.equal(h.button('安装 海外代理').disabled, false);
    await h.click('安装 海外代理');
    assert.equal(h.button('安装中 海外代理').disabled, true);
    assert.ok(!h.document.body.textContent.includes('AppCenter'));
    assert.ok(!h.document.body.textContent.includes('H2O'));
    assert.deepEqual(calls, ['dependency']);
    completeDependency(dependencyReady);
    await tick();
    assert.deepEqual(calls, ['dependency', 'overseas']);
    assert.ok(h.button('打开管理 海外代理'));
    assert.equal(h.document.querySelector('.mincave-h2o'), null);
    assert.deepEqual(h.errors, []);
  } finally {
    h.dom.window.close();
  }
});

test('management console contains only members and saves only MinCave permission changes', async () => {
  const h = await mount(runtimeFixture());
  try {
    await h.click('管理控制台');
    assert.match(h.document.body.textContent, /成员与角色/);
    assert.match(h.document.body.textContent, /测试成员/);
    const nav = [...h.document.querySelectorAll('nav button')].map((button) =>
      button.textContent.trim(),
    );
    assert.deepEqual(nav, ['成员']);
    assert.ok(!h.calls.includes('openAdmin'));
    await h.click('管理 测试成员');
    assert.equal(h.document.querySelector('dialog input[type="text"]'), null);
    const select = h.document.querySelector('select[aria-label="MinCave 角色"]');
    select.value = 'admin';
    select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await tick();
    await h.click('保存');
    assert.ok(h.calls.includes('admin:saveMember'));
    assert.equal(h.document.querySelector('dialog'), null);
    assert.match(h.document.querySelector('tbody').textContent, /管理员/);
    await h.click('员工工作台');
    assert.ok(h.document.querySelector('a[aria-label="打开 Delta"]'));
    assert.deepEqual(h.errors, []);
  } finally {
    h.dom.window.close();
  }
});

test('employee cannot see management entries and role revocation ejects an open console', async () => {
  const h = await mount(
    runtimeFixture({
      mincaveAccess: { status: 'allowed', allowed: true, canManage: false, role: 'employee' },
    }),
  );
  try {
    assert.ok(!h.document.body.textContent.includes('管理控制台'));
    h.document.querySelector('.mincave-account').click();
    await tick();
    assert.ok(
      !h.document.querySelector('.mincave-account-menu').textContent.includes('管理控制台'),
    );
    h.emit({ mincaveAccess: { status: 'allowed', allowed: true, canManage: true, role: 'admin' } });
    await tick();
    // Close the account menu before using the top switch.
    h.document.querySelector('.mincave-account').click();
    await tick();
    await h.click('管理控制台');
    assert.ok(h.document.querySelector('.mincave-admin-table'));
    h.emit({
      mincaveAccess: { status: 'allowed', allowed: true, canManage: false, role: 'employee' },
    });
    await tick();
    assert.equal(h.document.querySelector('.mincave-admin-table'), null);
    assert.ok(!h.document.body.textContent.includes('管理控制台'));
    assert.deepEqual(h.errors, []);
  } finally {
    h.dom.window.close();
  }
});

test('unverified or denied access cannot expose a workbench; temporary failure preserves only confirmed employee use', async () => {
  const h = await mount(
    runtimeFixture({
      mincaveAccess: { status: 'checking', allowed: false, canManage: false, role: null },
    }),
  );
  try {
    assert.equal(h.document.querySelector('.mincave-shell'), null);
    assert.equal(h.document.querySelector('a[aria-label="打开 Delta"]'), null);
    h.emit({
      mincaveAccess: { status: 'unavailable', allowed: true, canManage: false, role: 'admin' },
    });
    await tick();
    assert.ok(h.document.querySelector('.mincave-shell'));
    assert.ok(!h.document.body.textContent.includes('管理控制台'));
    h.emit({
      mincaveAccess: {
        status: 'denied',
        allowed: false,
        canManage: false,
        role: null,
        message: '当前账号无 MinCave 使用权限。',
      },
    });
    await tick();
    assert.equal(h.document.querySelector('.mincave-shell'), null);
    assert.match(h.document.body.textContent, /当前账号无 MinCave 使用权限/);
    assert.deepEqual(h.errors, []);
  } finally {
    h.dom.window.close();
  }
});

test('management permission refusal never substitutes local demo data', async () => {
  const h = await mount(runtimeFixture(), true, {
    mincaveAdmin: async () => ({
      ok: false,
      error: { code: 'management_forbidden', message: '暂无管理控制台权限' },
    }),
  });
  try {
    await h.click('管理控制台');
    assert.match(h.document.body.textContent, /暂无管理控制台权限/);
    assert.equal(h.document.querySelector('.mincave-admin-table'), null);
    assert.ok(!h.calls.includes('openAdmin'));
    await h.click('员工工作台');
    assert.match(h.document.body.textContent, /欢迎，测试员工/);
  } finally {
    h.dom.window.close();
  }
});

test('remote-only Clash link is not rotated until an explicit confirmed generation', async () => {
  const initial = runtimeFixture();
  initial.apps.h2o.runtime.clashLink = {
    userId: 'qa-employee',
    status: 'remote-only',
    issuedAt: '2026-11-09T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
  };
  let issues = 0;
  const h = await mount(initial, true, {
    refreshH2oSubscription: async () => initial,
    issueH2oClashLink: async () => {
      issues++;
      return runtimeFixture();
    },
  });
  try {
    await h.click('打开管理 海外代理');
    assert.equal(h.document.querySelector('#clash-subscription'), null);
    assert.equal(issues, 0);
    h.window.confirm = () => false;
    await h.click('重新生成订阅');
    assert.equal(issues, 0);
    h.window.confirm = () => true;
    await h.click('重新生成订阅');
    assert.equal(issues, 1);
    assert.equal(
      h.document.querySelector('#clash-subscription').value,
      'https://subscriptions.example.test/oversea.yaml',
    );
  } finally {
    h.dom.window.close();
  }
});

test('notifications show real version updates and reopen the existing download flow in either mode', async () => {
  const state = runtimeFixture();
  state.update = {
    ...state.update,
    status: 'update-available',
    latestVersion: '2.1.21',
    artifactUrl: 'https://download.example.test/app.asar',
    releaseNotes: '版本更新说明',
    deliveryMode: 'manual',
  };
  const h = await mount(state);
  try {
    assert.ok(h.document.querySelector('.mincave-notification-dot'));
    await h.click('管理控制台');
    await h.click('通知');
    assert.equal(h.document.querySelector('dialog')?.getAttribute('aria-label'), '通知');
    assert.match(h.document.querySelector('dialog').textContent, /版本更新 · 2.1.21/);
    assert.equal(h.document.querySelector('dialog [data-action="applyUpdate"]'), null);
    await h.click('查看更新');
    assert.equal(h.document.querySelectorAll('dialog').length, 1);
    assert.equal(h.document.querySelector('dialog').getAttribute('aria-label'), '版本更新');
    assert.match(h.document.querySelector('dialog').textContent, /版本更新说明/);
    await h.click('下载更新');
    assert.ok(h.calls.includes('applyUpdate'));
    await h.click('关闭弹窗');
    await h.click('通知');
    assert.match(h.document.querySelector('dialog').textContent, /正在下载更新/);
    h.emit({
      update: {
        ...state.update,
        status: 'up-to-date',
        updateAvailable: false,
        latestVersion: '2.1.20',
      },
    });
    await tick();
    assert.equal(h.document.querySelector('.mincave-notification-dot'), null);
    assert.match(h.document.querySelector('dialog').textContent, /暂无版本更新通知/);
    assert.deepEqual(h.errors, []);
  } finally {
    h.dom.window.close();
  }
});

test('empty notifications check through the existing updater and close on logout', async () => {
  let checks = 0;
  const h = await mount(runtimeFixture(), true, {
    checkUpdates: async () => {
      checks++;
      return runtimeFixture();
    },
  });
  try {
    assert.equal(h.document.querySelector('.mincave-notification-dot'), null);
    await h.click('通知');
    assert.match(h.document.querySelector('dialog').textContent, /暂无版本更新通知/);
    assert.match(h.document.querySelector('dialog').textContent, /当前版本 2.1.20/);
    await h.click('检查更新');
    assert.equal(checks, 1);
    assert.equal(h.document.querySelector('dialog')?.open, true);
    h.emit({
      auth: null,
      connection: { state: 'idle', mode: 'employee', health: {}, diagnostics: {} },
    });
    await tick();
    assert.equal(h.document.querySelector('dialog'), null);
    assert.equal(h.document.querySelector('[aria-label="通知"]'), null);
    assert.deepEqual(h.errors, []);
  } finally {
    h.dom.window.close();
  }
});

test('updates retain their dialog during download and use the native restart action', async () => {
  const state = runtimeFixture();
  state.update = {
    ...state.update,
    status: 'update-available',
    latestVersion: '2.1.21',
    artifactUrl: 'https://download.example.test/app.asar',
    releaseNotes: '更新说明',
    deliveryMode: 'prompt-download-restart',
  };
  const h = await mount(state);
  try {
    await tick();
    assert.equal(h.document.querySelector('dialog')?.open, true);
    await h.click('下载更新');
    assert.equal(h.document.querySelector('dialog')?.open, true);
    assert.equal(
      h.document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
      '12.5',
    );
    assert.ok(!h.document.body.textContent.includes('取消下载'));
    h.emit({
      update: { ...state.update, status: 'staged', restartPrompt: true, restartRequired: true },
    });
    await tick();
    await h.click('重新启动');
    assert.ok(h.calls.includes('restartApp'));
    await h.click('关闭弹窗');
    assert.equal(h.document.querySelector('dialog'), null);
    assert.deepEqual(h.errors, []);
  } finally {
    h.dom.window.close();
  }
});

test('rendered retained employee can pause recovery without losing the workbench', async () => {
  const state = runtimeFixture();
  state.connection.state = 'tunnel-only';
  state.networkOperation = {
    id: 'op-1',
    kind: 'manual-repair',
    status: 'running',
    cancelable: true,
  };
  const h = await mount(state);
  try {
    await h.click('取消');
    assert.ok(h.calls.includes('cancelNetworkOperation'));
    assert.match(h.document.body.textContent, /恢复已暂停/);
    assert.match(h.document.body.textContent, /欢迎，测试员工/);
  } finally {
    h.dom.window.close();
  }
});

test('rendered production page without preload displays an unavailable state', async () => {
  const h = await mount(null, false);
  try {
    assert.match(h.document.body.textContent, /无法连接客户端/);
    assert.ok(!h.document.body.textContent.includes('使用飞书登录'));
  } finally {
    h.dom.window.close();
  }
});


test('enterprise login refusal shows only its actionable reason on the Feishu login page', async () => {
  const state = idleFixture();
  state.mincaveLoginError = '仅明悉科技企业成员可使用 MinCave。';
  const h = await mount(state);
  try {
    assert.equal(h.document.querySelector('[role="alert"]').textContent, state.mincaveLoginError);
    assert.equal(h.document.querySelector('.mincave-shell'), null);
    assert.equal(h.document.querySelector('[aria-label="通知"]'), null);
    assert.ok(h.button('使用飞书登录'));
    h.emit({ mincaveLoginError: null }); await tick();
    assert.equal(h.document.querySelector('[role="alert"]'), null);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});


test('account devices follow prototype cards, current connection only, and hide installation identifiers', async () => {
  const h = await mount(runtimeFixture());
  try {
    await h.click('设备');
    const cards = () => [...h.document.querySelectorAll('.mincave-device')];
    assert.equal(cards().length, 2);
    assert.equal(cards()[0].querySelector('h2').textContent, 'QA Mac');
    assert.match(cards()[0].textContent, /当前设备已连接虚拟地址10.88.1.21/);
    assert.match(cards()[1].textContent, /历史设备已绑定最近虚拟地址10.88.1.22/);
    assert.ok(!cards()[1].textContent.includes('已连接'));
    assert.equal(h.document.querySelector('.mincave-device dl'), null);
    for (const removed of ['qa-device', 'qa-install', '设备标识', '安装标识', '站点标识'])
      assert.ok(!h.document.querySelector('main').textContent.includes(removed));
    h.emit({ connection: { state: 'lease-only', mode: 'employee', localIp: '10.88.1.21' } });
    await tick();
    assert.match(cards()[0].textContent, /当前设备未连接虚拟地址未连接/);
    assert.ok(!cards()[0].textContent.includes('10.88.1.21'));
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});
test('device errors and empty states do not invent a current device; retries restore own history', async () => {
  let result = { ok: false, error: { code: 'unavailable' } };
  const h = await mount(runtimeFixture(), true, { mincaveDevices: async () => result });
  try {
    await h.click('设备');
    assert.equal(h.document.querySelectorAll('.mincave-device').length, 0);
    assert.match(h.document.querySelector('[role="alert"]').textContent, /无法获取设备/);
    result = { ok: true, value: { userId: 'qa-employee', devices: [] } };
    await h.click('重试');
    assert.match(h.document.querySelector('main').textContent, /暂无设备记录/);
    await h.click('工作台');
    result = { ok: true, value: devicesFixture() };
    await h.click('设备');
    assert.equal(h.document.querySelectorAll('.mincave-device').length, 2);
  } finally { h.dom.window.close(); }
});
test('switching accounts clears previous device data and discards a late response for the former account', async () => {
  let resolveOld;
  let calls = 0;
  const h = await mount(runtimeFixture(), true, { mincaveDevices: () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ ok: true, value: { userId: 'new-user', devices: [] } });
  } });
  try {
    await h.click('设备');
    h.emit({ mincaveAccess: { status: 'allowed', allowed: true, role: 'employee', canManage: false, userId: 'new-user' } });
    await tick();
    resolveOld({ ok: true, value: devicesFixture() });
    await tick();
    assert.equal(h.document.querySelectorAll('.mincave-device').length, 0);
    assert.ok(!h.document.querySelector('main').textContent.includes('QA Mac'));
    assert.match(h.document.querySelector('main').textContent, /暂无设备记录/);
  } finally { h.dom.window.close(); }
});
