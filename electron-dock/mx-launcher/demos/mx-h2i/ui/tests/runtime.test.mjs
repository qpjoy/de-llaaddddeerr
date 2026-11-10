import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { runtimeFixture, idleFixture } from './fixture.mjs';
import { connectionLabel, formatTransfer, updateStage } from '../src/model.ts';

const require = createRequire(import.meta.url);
const { mincaveWindowBounds, mincaveWindowMinimum } = require('../../src/mincave-window-policy.cjs');
const source = await readFile(new URL('../../src/renderer.js', import.meta.url), 'utf8');
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };

function harness(initial, methods = {}, bridgePresent = true) {
  let listener;
  const api = { platform: 'darwin', getState: async () => initial, onState: (cb) => { listener = cb; return () => {}; }, ...methods };
  const root = { addEventListener() {}, querySelector() { return null; } };
  const window = { addEventListener() {}, ...(bridgePresent ? { mxH2i: api } : {}) };
  const context = vm.createContext({ window, document: { documentElement: { dataset: { ui: 'mincave' } }, getElementById: () => root }, localStorage: { getItem: () => null, setItem() {} }, URL, URLSearchParams, console, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  return { view: window.MxH2iView, run: (code) => vm.runInContext(code, context), emit: (value) => listener(value) };
}

test('production missing preload fails closed instead of logging into a demo', async () => {
  const h = harness(null, {}, false);
  await flush();
  assert.match(h.view.getSnapshot().error, /桌面客户端/);
  assert.equal(h.view.getSnapshot().runtime, undefined);
});

test('late getState cannot replace a newer connection broadcast', async () => {
  let resolveInitial;
  const h = harness(null, { getState: () => new Promise((resolve) => { resolveInitial = resolve; }) });
  h.emit(runtimeFixture());
  resolveInitial(idleFixture());
  await flush();
  assert.equal(h.view.getSnapshot().connected, true);
  assert.equal(h.view.getSnapshot().runtime.identity.displayName, '测试员工');
});

test('catalog exposes only executable apps and no reserved/demo resources', async () => {
  const h = harness(runtimeFixture());
  await flush();
  assert.deepEqual(Array.from(h.view.getSnapshot().apps, (app) => app.id), ['h2o']);
  assert.equal(h.view.getSnapshot().showLogin, false);
});

test('one overseas install sequences dependencies and ignores duplicate clicks', async () => {
  const initial = runtimeFixture();
  initial.apps.appcenter.installed = false;
  initial.apps.h2o.installed = false;
  const dependencyReady = structuredClone(initial);
  dependencyReady.apps.appcenter.installed = true;
  let completeDependency;
  const calls = [];
  const h = harness(initial, {
    installAppCenter: () => { calls.push('appcenter'); return new Promise((resolve) => { completeDependency = resolve; }); },
    enableH2o: async () => { calls.push('h2o'); return runtimeFixture(); }
  });
  await flush();
  assert.equal(h.view.getSnapshot().apps[0].action.disabled, false);
  const installing = h.run("runAction('installOverseasProxy')");
  await h.run("runAction('installOverseasProxy')");
  assert.deepEqual(calls, ['appcenter']);
  assert.equal(h.view.getSnapshot().apps[0].action.label, '安装中');
  assert.equal(h.view.getSnapshot().apps[0].action.disabled, true);
  completeDependency(dependencyReady);
  await installing;
  assert.deepEqual(calls, ['appcenter', 'h2o']);
  assert.equal(h.view.getSnapshot().apps[0].installed, true);
  assert.equal(h.view.getSnapshot().apps[0].action.action, 'showH2oManager');
  assert.equal(h.view.getSnapshot().screen, 'launcher');
});

test('dependency failure stops the install, and retry reuses completed dependencies', async () => {
  const initial = runtimeFixture();
  initial.apps.appcenter.installed = false;
  initial.apps.h2o.installed = false;
  let dependencyAttempts = 0;
  let installAttempts = 0;
  const h = harness(initial, {
    installAppCenter: async () => {
      dependencyAttempts++;
      return dependencyAttempts === 1 ? initial : runtimeFixture({ apps: { ...initial.apps, appcenter: { installed: true } } });
    },
    enableH2o: async () => {
      installAttempts++;
      return installAttempts === 1
        ? runtimeFixture({ apps: { ...initial.apps, appcenter: { installed: true } } })
        : runtimeFixture();
    }
  });
  await flush();
  await h.run("runAction('installOverseasProxy')");
  assert.equal(installAttempts, 0);
  assert.equal(h.view.getSnapshot().apps[0].action.disabled, false);
  await h.run("runAction('installOverseasProxy')");
  assert.equal(installAttempts, 1);
  await h.run("runAction('installOverseasProxy')");
  assert.equal(dependencyAttempts, 2);
  assert.equal(installAttempts, 2);
  assert.equal(h.view.getSnapshot().apps[0].installed, true);
});

test('disconnect during dependency install prevents H2O follow-up and stale state replay', async () => {
  const initial = runtimeFixture();
  initial.apps.appcenter.installed = false;
  initial.apps.h2o.installed = false;
  let completeDependency;
  let followups = 0;
  const h = harness(initial, {
    installAppCenter: () => new Promise((resolve) => { completeDependency = resolve; }),
    enableH2o: async () => { followups++; return runtimeFixture(); }
  });
  await flush();
  const installing = h.run("runAction('installOverseasProxy')");
  h.emit(idleFixture());
  completeDependency(runtimeFixture());
  await installing;
  assert.equal(followups, 0);
  assert.equal(h.view.getSnapshot().connected, false);
  assert.equal(h.view.getSnapshot().showLogin, true);
  await h.run("runAction('installOverseasProxy')");
  assert.equal(followups, 0);
});

test('subscription projection excludes unverified, expired and other-user links', async () => {
  const initial = runtimeFixture();
  const h = harness(initial);
  await flush();
  assert.equal(h.view.getSnapshot().overseasSubscription.url, 'https://subscriptions.example.test/oversea.yaml');
  for (const patch of [{ status: 'unverified' }, { userId: 'another-user' }, { expiresAt: '2020-01-01T00:00:00Z' }]) {
    const next = runtimeFixture();
    Object.assign(next.apps.h2o.runtime.clashLink, patch);
    h.emit(next);
    assert.equal(h.view.getSnapshot().overseasSubscription.url, '');
  }
});

test('Feishu starts and cancels through the existing native methods', async () => {
  const calls = [];
  const h = harness(idleFixture(), { startFeishuLogin: async () => { calls.push('start'); return idleFixture(); }, cancelFeishuLogin: async () => { calls.push('cancel'); return idleFixture(); } });
  await flush();
  await h.run("runAction('login-feishu')");
  await h.run("runAction('cancel-feishu-login')");
  assert.deepEqual(calls, ['start', 'cancel']);
  assert.equal(h.view.getSnapshot().showLogin, true);
  assert.doesNotMatch(h.view.getSnapshot().loginHtml, /演示身份|林一/);
});

test('cancelling recovery preserves identity and rejects the older action response', async () => {
  let finishRepair;
  const paused = runtimeFixture({ networkOperation: { id: 'repair-1', kind: 'manual-repair', status: 'paused', cancelable: true } });
  const h = harness(runtimeFixture(), {
    repairSystemNetwork: () => new Promise((resolve) => { finishRepair = resolve; }),
    cancelNetworkOperation: async (id) => { assert.equal(id, 'repair-1'); return paused; }
  });
  await flush();
  const repairing = h.run("runAction('repairSystemNetwork')");
  await h.run("runAction('cancelNetworkOperation', { id: 'repair-1' })");
  finishRepair(idleFixture());
  await repairing;
  assert.equal(h.view.getSnapshot().paused, true);
  assert.equal(h.view.getSnapshot().runtime.identity.displayName, '测试员工');
  assert.equal(h.view.getSnapshot().connected, true);
});

test('retained employee stays in the workbench while a disabled guest cannot renew', async () => {
  const state = runtimeFixture();
  state.connection.state = 'tunnel-only';
  const h = harness(state);
  await flush();
  assert.equal(h.view.getSnapshot().retainedEmployee, true);
  assert.equal(h.view.getSnapshot().showLogin, false);
  h.emit(runtimeFixture({ connection: { ...state.connection, mode: 'guest' }, identity: { kind: 'anonymous' }, auth: null, launcherProductPresentation: { productId: 'mx-h2i', anonymousUiVisibility: 'hidden', anonymousEnrollmentPolicy: 'disabled' } }));
  assert.equal(h.view.getSnapshot().anonymousBlocked, true);
  assert.equal(h.view.getSnapshot().guestCanRenew, false);
});

test('Release Gate remains blocking and manual/silent delivery does not open a prompt', async () => {
  const h = harness(runtimeFixture());
  await flush();
  for (const deliveryMode of ['manual-download', 'silent-download-next-start']) {
    h.emit(runtimeFixture({ update: { status: 'update-available', artifactUrl: 'https://download.example.test/app.asar', latestVersion: '2.1.21', deliveryMode } }));
    assert.equal(h.view.getSnapshot().releasePrompt, false);
  }
  h.emit(runtimeFixture({ update: { status: 'blocked', artifactUrl: 'https://download.example.test/app.asar', deliveryMode: 'prompt-download-restart', latestVersion: '2.1.21' } }));
  assert.equal(h.view.getSnapshot().update.canApply, false);
  h.emit(runtimeFixture({ update: { status: 'update-available', artifactUrl: 'https://download.example.test/app.asar', deliveryMode: 'prompt-download-restart', latestVersion: '2.1.21' } }));
  assert.equal(h.view.getSnapshot().releasePrompt, true);
  h.view.dismissRelease();
  assert.equal(h.view.getSnapshot().releasePrompt, false);
});

test('wide window defaults, work-area clamps and custom resized bounds remain stable', () => {
  const area = { x: 0, y: 25, width: 1920, height: 1055 };
  const normal = mincaveWindowBounds(area);
  assert.equal(normal.width, 1120); assert.equal(normal.height, 760);
  const resized = { x: 100, y: 60, width: 1250, height: 900 };
  assert.deepEqual(mincaveWindowBounds(area, resized), resized);
  const small = { x: -800, y: 0, width: 800, height: 600 };
  const fitted = mincaveWindowBounds(small, resized);
  assert.deepEqual(fitted, { x: -800, y: 0, width: 800, height: 600 });
  assert.deepEqual(mincaveWindowMinimum({ width: 600, height: 400 }), { width: 600, height: 400 });
});

test('network and update labels preserve degraded and staged semantics', () => {
  assert.equal(connectionLabel('tunnel-only'), '网络需要修复');
  assert.equal(connectionLabel('connected', false, true), '恢复已暂停');
  assert.equal(updateStage('installer-opened'), 2);
  assert.equal(updateStage('downloading'), 1);
  assert.equal(formatTransfer(undefined), '');
  assert.equal(formatTransfer(0), '0 B');
});
