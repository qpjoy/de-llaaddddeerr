import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMincaveAdminBridge } = require('../../src/mincave-admin.cjs');
function harness() {
  const runtime = {
    auth: { accessToken: 'current-token', subject: 'user:current-user', provider: 'feishu' },
    connection: { state: 'connected', wireGuard: { active: true } },
  };
  const server = { role: 'admin', status: 200 };
  const calls = [];
  const denied = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, 'https://h2i.example.test');
    assert.equal(options.headers.authorization, 'Bearer current-token');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers['x-mx-ops-token'], undefined);
    const path = new URL(url).pathname;
    if (server.status !== 200)
      return {
        ok: false,
        status: server.status,
        json: async () => ({ code: 'test-rejected', message: '测试拒绝' }),
      };
    const value = path.endsWith('/session')
      ? {
          allowed: true,
          canManage: server.role === 'admin',
          role: server.role,
          userId: 'current-user',
        }
      : options.method === 'PATCH'
        ? { saved: true }
        : {
            administratorId: 'current-user',
            members: [
              {
                id: 'member-1',
                name: '员工',
                role: 'employee',
                enabled: true,
                accountActive: true,
              },
            ],
          };
    return { ok: true, status: 200, json: async () => value };
  };
  const bridge = createMincaveAdminBridge({
    getRuntime: () => runtime,
    fetch,
    resolveBaseUrl: async () => 'https://h2i.example.test',
    onDenied: (token) => {
      denied.push(token);
    },
  });
  return { bridge, calls, runtime, server, denied };
}
test('MinCave uses current Feishu bearer and dedicated routes, never Launcher cookies or SSO', async () => {
  const h = harness();
  const result = await h.bridge.request({ action: 'workspace' });
  assert.equal(result.ok, true);
  assert.equal(result.value.members[0].name, '员工');
  assert.deepEqual(
    h.calls.map((call) => new URL(call.url).pathname),
    ['/internal/v1/mincave/session', '/internal/v1/mincave/members'],
  );
  assert.equal(h.bridge.snapshot().canManage, true);
  assert.ok(!JSON.stringify(result).includes('current-token'));
});
test('employees cannot request management data and live promotion/demotion requires no new login', async () => {
  const h = harness();
  h.server.role = 'employee';
  assert.equal((await h.bridge.request({ action: 'workspace' })).ok, false);
  assert.ok(!h.calls.some((call) => call.url.endsWith('/members')));
  h.server.role = 'admin';
  assert.equal((await h.bridge.request({ action: 'workspace' })).ok, true);
  h.server.role = 'employee';
  await h.bridge.refresh();
  assert.equal(h.bridge.snapshot().canManage, false);
});
test('member changes whitelist only MinCave role and enabled fields and reject old arbitrary admin actions', async () => {
  const h = harness();
  assert.equal(
    (
      await h.bridge.request({
        action: 'saveMember',
        id: 'member-1',
        value: { role: 'admin', enabled: true },
      })
    ).ok,
    true,
  );
  const call = h.calls.find((call) => call.options.method === 'PATCH');
  assert.deepEqual(JSON.parse(call.options.body), { role: 'admin', enabled: true });
  const count = h.calls.filter((call) => call.options.method === 'PATCH').length;
  assert.equal(
    (
      await h.bridge.request({
        action: 'saveMember',
        id: 'member-1',
        value: { role: 'admin', enabled: true, roleIds: ['mx-admin'] },
      })
    ).ok,
    false,
  );
  for (const action of ['saveApp', 'savePolicy', 'activity', 'login', 'fetch'])
    assert.equal((await h.bridge.request({ action })).error.code, 'invalid_action');
  assert.equal(h.calls.filter((call) => call.options.method === 'PATCH').length, count);
});
test('temporary outage preserves only an already verified connected session, with management suspended', async () => {
  const h = harness();
  await h.bridge.refresh();
  h.server.status = 503;
  const access = await h.bridge.refresh();
  assert.equal(access.allowed, true);
  assert.equal(access.canManage, false);
  assert.equal(access.status, 'unavailable');
  assert.equal((await h.bridge.request({ action: 'workspace' })).ok, false);
  await assert.rejects(h.bridge.checkLogin(h.runtime.auth));
  assert.deepEqual(h.denied, []);
  h.runtime.connection = { state: 'idle' };
  await h.bridge.refresh();
  assert.equal(h.bridge.snapshot().allowed, false);
  const fresh = harness();
  fresh.server.status = 404;
  await fresh.bridge.refresh();
  assert.equal(fresh.bridge.snapshot().allowed, false);
});
test('explicit rejection locks MinCave and requests the original scoped disconnect handler', async () => {
  const h = harness();
  await h.bridge.refresh();
  h.server.status = 403;
  await h.bridge.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.bridge.snapshot().allowed, false);
  assert.equal(h.bridge.snapshot().canManage, false);
  assert.deepEqual(h.denied, ['current-token']);
  await h.bridge.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    h.denied,
    ['current-token'],
    'a cancelled cleanup must not reopen OS authorization on every poll',
  );
});
test('identity change during response parsing never publishes old privileges or returns old member data', async () => {
  const runtime = { auth: { accessToken: 'old', subject: 'user:old', provider: 'feishu' } };
  const bridge = createMincaveAdminBridge({
    getRuntime: () => runtime,
    resolveBaseUrl: async () => 'https://h2i.example.test',
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        runtime.auth = { accessToken: 'new', subject: 'user:new', provider: 'feishu' };
        return { allowed: true, role: 'admin', canManage: true, userId: 'old' };
      },
    }),
  });
  const result = await bridge.request({ action: 'workspace' });
  assert.equal(result.ok, false);
  assert.equal(result.value, undefined);
  assert.equal(bridge.snapshot().canManage, false);
});
test('password and mismatched subject proofs cannot authorize a connection', async () => {
  const h = harness();
  await assert.rejects(h.bridge.checkLogin({ ...h.runtime.auth, provider: 'password' }));
  await assert.rejects(h.bridge.checkLogin({ ...h.runtime.auth, subject: 'user:another' }));
  assert.equal(h.bridge.snapshot().canManage, false);
});
