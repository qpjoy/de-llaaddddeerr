import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminSessionUi } from '../admin-session.js';

function fixture(t, initial, pageOrigin = 'https://launcher.example') {
  const nodes = new Map();
  const root = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: '', addEventListener() {}, close() {} });
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
