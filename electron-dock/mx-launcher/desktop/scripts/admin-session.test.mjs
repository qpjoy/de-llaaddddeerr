import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminSessionUi } from '../admin-session.js';

function fixture(t, initial, pageOrigin = 'https://launcher.example') {
  const nodes = new Map();
  const root = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: '', listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; }, close() {}, removeAttribute(name) { delete this[name]; } });
    return nodes.get(id);
  } };
  let payload = initial, base = pageOrigin, calls = 0;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  globalThis.location = new URL(`${pageOrigin}/admin/`);
  t.after(() => {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  });
  t.mock.method(globalThis, 'fetch', async path => {
    calls++;
    assert.equal(path, '/auth/admin/session');
    const value = await payload;
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value.clone();
    return new Response(JSON.stringify(value));
  });
  const ui = createAdminSessionUi({ root, serverBase: () => base });
  const prepare = (path = '/internal/v1/config-center/secret-runtime-bindings', ops = false, origin = pageOrigin) => {
    const url = new URL(path, origin), headers = ops ? { 'x-mx-ops-token': 'fixture-only' } : {};
    return ui.prepare(url, headers, ops).then(used => ({ used, url, headers }));
  };
  return { ui, nodes, prepare, set: value => { payload = value; }, base: value => { base = value; }, calls: () => calls };
}
const anonymous = { enabled: true, authenticated: false, accessMode: 'sso-only' };
const admin = { ...anonymous, authenticated: true, csrf: 'fixture-csrf', canManage: true, user: { displayName: '管理员' } };

test('anonymous public entry waits for session discovery and never sends raw Internal requests', async t => {
  let resolve;
  const f = fixture(t, new Promise(done => { resolve = done; }));
  const requests = Promise.allSettled([f.prepare(), f.prepare('/internal/v1/launcher-network/products', true)]);
  assert.equal(f.calls(), 1, 'concurrent initialization shares session discovery');
  resolve(anonymous);
  for (const result of await requests) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'session_required');
  }
  assert.match(f.nodes.get('admin-account-status').textContent, /登录个人账号/);
});

test('public JSON and artifact requests preserve path/query, use CSRF and ignore an emergency token', async t => {
  const f = fixture(t, admin);
  for (const path of ['/internal/v1/config-center/secret-runtime-bindings', '/internal/v1/release-artifacts?fileName=test.asar&version=1']) {
    const result = await f.prepare(path, true);
    assert.equal(result.used, true);
    assert.equal(result.url.href, `https://launcher.example/admin-api${path}`);
    assert.deepEqual(result.headers, { 'x-mx-admin-csrf': 'fixture-csrf' });
  }
});

test('a reset during session discovery cancels the original request even on the same origin', async t => {
  let resolve;
  const f = fixture(t, new Promise(done => { resolve = done; }));
  const pending = assert.rejects(f.prepare(), /连接地址已变化/);
  f.ui.reset();
  resolve(admin);
  await pending;
});

test('an expired public session never downgrades to raw APIs, including after failed refresh', async t => {
  const f = fixture(t, admin);
  await f.prepare();
  f.set(anonymous);
  await f.ui.rejected({ code: 'session_required' });
  await assert.rejects(f.prepare(), { code: 'session_required' });
  f.set(new Error('offline'));
  await f.ui.refresh();
  await assert.rejects(f.prepare('/internal/v1/user-center/users', true), { code: 'sso_unavailable' });
  assert.equal(f.calls(), 3, 'requests are not retried or replayed');
});

test('ordinary and unlinked accounts receive useful access errors without management requests', async t => {
  const f = fixture(t, { ...admin, canManage: false });
  await assert.rejects(f.prepare(), { code: 'management_forbidden' });
  f.set({ ...admin, bindingRequired: true });
  await f.ui.refresh();
  await assert.rejects(f.prepare(), { code: 'binding_required' });
});

test('private emergency mode preserves raw routes for protected and unprotected reads', async t => {
  const f = fixture(t, { ...anonymous, accessMode: 'sso-or-ops' });
  for (const path of ['/internal/v1/admin/dashboard', '/internal/v1/user-center/users']) {
    const result = await f.prepare(path, true);
    assert.equal(result.used, false);
    assert.equal(result.url.pathname, path);
    assert.equal(result.headers['x-mx-ops-token'], 'fixture-only');
  }
  f.set({ enabled: false, authenticated: false });
  await f.ui.refresh();
  assert.equal((await f.prepare()).used, false);
});

test('private HTTP entry keeps legacy reads and points personal login to HTTPS', async t => {
  const f = fixture(t, { ...anonymous, accessMode: 'sso-or-ops', loginOrigin: 'https://internal.example:18443' }, 'http://internal.example:18090');
  assert.equal((await f.prepare()).used, false);
  assert.equal(f.nodes.get('admin-account-login').textContent, '打开安全管理入口');
});

test('remote desktop connections and unrelated origins never receive session CSRF', async t => {
  const f = fixture(t, admin);
  f.base('http://internal.example:18090');
  assert.equal((await f.prepare('/internal/v1/user-center/users', true, 'http://internal.example:18090')).used, false);
  assert.equal(f.calls(), 0);
  f.base('https://launcher.example');
  await f.ui.refresh();
  assert.equal((await f.prepare('/internal/v1/user-center/users', false, 'https://other.example')).used, false);
});

test('failed first session discovery cannot turn an unknown public entry into raw Ops mode', async t => {
  const f = fixture(t, new Error('fixture-only transport failure'));
  await assert.rejects(f.prepare('/internal/v1/user-center/roles', true), { code: 'sso_unavailable' });
  assert.equal(f.ui.entry().unavailable, true);
  assert.equal(f.ui.entry().accessMode, undefined);
  await assert.rejects(f.ui.opsLoginMode(), { code: 'sso_unavailable' });
  assert.equal(f.calls(), 2, 'explicit login retries discovery once, without sending a raw API request');
});

test('Ops login retries an unavailable public session and recovers through the same-origin session endpoint', async t => {
  const f = fixture(t, { ...anonymous, loginOrigin: 'https://launcher.example' });
  assert.equal(await f.ui.opsLoginMode(), 'session');
  f.set(new Error('offline'));
  await f.ui.refresh();
  assert.equal(f.ui.entry().unavailable, true);
  f.set({ ...anonymous, loginOrigin: 'https://launcher.example' });
  assert.equal(await f.ui.opsLoginMode(), 'session');
  assert.equal(f.ui.entry().unavailable, undefined);
  assert.equal(f.calls(), 3);
});

test('missing access-mode metadata does not authorize raw APIs on a same-origin entry', async t => {
  const f = fixture(t, {});
  await assert.rejects(f.prepare('/internal/v1/user-center/roles', true), { code: 'sso_unavailable' });
  assert.equal(f.ui.entry().unavailable, true);
  assert.match(f.ui.entry().errorMessage, /会话状态格式无效/);
  await assert.rejects(f.ui.opsLoginMode(), { code: 'sso_unavailable' });
  f.set({ ...admin, accessMode: undefined, loginOrigin: 'https://launcher.example' });
  await f.ui.refresh();
  assert.equal(await f.ui.opsLoginMode(), 'session');
  assert.equal((await f.prepare('/internal/v1/user-center/roles', true)).used, true, 'an authenticated unknown mode uses the BFF');
});

test('disabled or malformed public discovery never enables legacy raw Ops access', async t => {
  const f = fixture(t, { ...anonymous, enabled: false });
  await assert.rejects(f.ui.opsLoginMode(), { code: 'sso_unavailable' });
  await assert.rejects(f.prepare('/internal/v1/user-center/roles', true), { code: 'sso_unavailable' });
  for (const enabled of [undefined, null, 'false', 0]) {
    f.set({ enabled, authenticated: false });
    await f.ui.refresh();
    assert.equal(f.ui.entry().unavailable, true);
    assert.match(f.ui.entry().errorMessage, /会话状态格式无效/);
    await assert.rejects(f.ui.opsLoginMode(), { code: 'sso_unavailable' });
  }
});

test('explicit private and remote desktop connections retain their emergency access mode', async t => {
  const f = fixture(t, { ...anonymous, accessMode: 'sso-or-ops', loginOrigin: 'https://internal.example:18443' }, 'http://internal.example:18090');
  assert.equal(await f.ui.opsLoginMode(), 'raw');
  f.set(new Error('private SSO unavailable'));
  await f.ui.refresh();
  assert.equal(await f.ui.opsLoginMode(), 'raw', 'previously confirmed private mode remains available during an SSO outage');
  assert.equal((await f.prepare('/internal/v1/user-center/roles', true)).used, false);
  f.set({ enabled: false, authenticated: false });
  await f.ui.refresh();
  assert.equal(await f.ui.opsLoginMode(), 'raw');
  f.base('http://remote-internal.example:18090');
  const calls = f.calls();
  assert.equal(await f.ui.opsLoginMode(), 'raw');
  assert.equal(f.calls(), calls, 'remote desktop mode never discovers the browser origin session');
});

test('reset or server changes during Ops discovery reject the original login attempt', async t => {
  let resolve;
  const f = fixture(t, new Promise(done => { resolve = done; }));
  const resetPending = assert.rejects(f.ui.opsLoginMode(), /连接地址已变化/);
  f.ui.reset();
  resolve({ ...anonymous, loginOrigin: 'https://launcher.example' });
  await resetPending;

  let resolveChanged;
  f.set(new Promise(done => { resolveChanged = done; }));
  const changedPending = assert.rejects(f.ui.opsLoginMode(), /连接地址已变化/);
  f.base('http://different-internal.example:18090');
  resolveChanged({ ...anonymous, loginOrigin: 'https://launcher.example' });
  await changedPending;
});

test('session diagnostics include HTTP status but never expose response bodies or transport details', async t => {
  const f = fixture(t, new Response('fixture-secret-in-proxy-error', { status: 404 }));
  await f.ui.refresh();
  assert.match(f.ui.entry().errorMessage, /HTTP 404/);
  assert.equal(f.ui.entry().errorStatus, 404);
  assert.doesNotMatch(f.ui.entry().errorMessage, /fixture-secret/);
  assert.match(f.nodes.get('admin-account-status').textContent, /HTTP 404/);
  await assert.rejects(f.prepare('/internal/v1/user-center/roles', true), { code: 'sso_unavailable', status: 404 });

  f.set(new Response('<html>fixture-secret</html>', { status: 200 }));
  await f.ui.refresh();
  assert.match(f.ui.entry().errorMessage, /HTTP 200.*JSON/);
  assert.doesNotMatch(f.ui.entry().errorMessage, /fixture-secret/);

  f.set(new Error('fixture-secret-from-transport'));
  await f.ui.refresh();
  assert.match(f.ui.entry().errorMessage, /网络错误|超时/);
  assert.doesNotMatch(f.ui.entry().errorMessage, /fixture-secret/);
});

test('Ops login errors report HTTP status without echoing the submitted token', async t => {
  const f = fixture(t, { ...anonymous, loginOrigin: 'https://launcher.example' });
  assert.equal(await f.ui.opsLoginMode(), 'session');
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/auth/admin/ops-login');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(JSON.parse(options.body).token, 'fixture-secret-token');
    return new Response(JSON.stringify({ message: 'fixture-secret-token must not be reflected' }), { status: 401 });
  });
  await assert.rejects(f.ui.signInWithOps('fixture-secret-token'), error => {
    assert.match(error.message, /Token.*HTTP 401/);
    assert.doesNotMatch(error.message, /fixture-secret-token/);
    return true;
  });
});

test('account linking retains useful server validation messages alongside HTTP status', async t => {
  const f = fixture(t, { ...admin, bindingRequired: true });
  await f.ui.refresh();
  t.mock.method(globalThis, 'fetch', async path => {
    assert.equal(path, '/auth/admin/link');
    return new Response(JSON.stringify({ message: '账号或密码不正确，或账号不可用。' }), { status: 401 });
  });
  const form = f.nodes.get('admin-account-link-form');
  const button = { disabled: false };
  form.querySelector = () => button;
  form.elements = { login: { value: 'fixture-user' }, password: { value: 'fixture-password' } };
  form.reset = () => {};
  await form.listeners.submit({ preventDefault() {} });
  assert.match(f.nodes.get('admin-account-link-feedback').textContent, /账号或密码不正确/);
  assert.match(f.nodes.get('admin-account-link-feedback').textContent, /HTTP 401/);
  assert.equal(form.elements.password.value, '');
  assert.equal(button.disabled, false);
});
