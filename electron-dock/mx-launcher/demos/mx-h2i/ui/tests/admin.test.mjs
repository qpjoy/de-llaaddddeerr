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
    const value = path.endsWith('/devices')
      ? { userId: 'current-user', devices: [{ deviceId: 'own-device', deviceLabel: 'My Mac' }] }
      : path.endsWith('/session')
      ? {
          allowed: true,
          canManage: server.role === 'admin',
          role: server.role,
          userId: 'current-user',
          ...(server.applications !== undefined ? { applications: server.applications } : {}),
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
  for (const action of ['saveApp', 'activity', 'login', 'fetch'])
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


test('employees register only main-process installation metadata and read their own account devices with the current bearer', async () => {
  const h = harness();
  h.server.role = 'employee';
  h.runtime.installation = { deviceId: 'my-device', deviceLabel: 'My Mac', userId: 'injected-owner', installId: 'private-install' };
  const result = await h.bridge.devices();
  assert.equal(result.ok, true);
  assert.equal(result.value.devices[0].deviceId, 'own-device');
  assert.equal(h.bridge.snapshot().canManage, false);
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { device: { deviceId: 'my-device', deviceLabel: 'My Mac', platform: null, deviceModel: null, osVersion: null } });
  assert.equal(h.calls[1].url, 'https://h2i.example.test/internal/v1/mincave/devices');
  assert.ok(!JSON.stringify(result).includes('current-token'));
  h.server.status = 503;
  assert.equal((await h.bridge.devices()).ok, false);
});
test('device responses are discarded after account switches or if the server returns a different owner', async () => {
  const runtime = { auth: { accessToken: 'old', subject: 'user:old', provider: 'feishu' } };
  let change = false;
  const bridge = createMincaveAdminBridge({
    getRuntime: () => runtime, resolveBaseUrl: async () => 'https://h2i.example.test',
    fetch: async url => ({ ok: true, json: async () => {
      if (url.endsWith('/session')) return { allowed: true, canManage: false, role: 'employee', userId: 'old' };
      if (change) runtime.auth = { accessToken: 'new', subject: 'user:new', provider: 'feishu' };
      return { userId: change ? 'old' : 'different-owner', devices: [{ deviceId: 'secret-old-device' }] };
    } }),
  });
  assert.equal((await bridge.devices()).ok, false);
  change = true;
  const result = await bridge.devices();
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('secret-old-device'));
});

test('app and policy mutations use only the dedicated MinCave workspace route with a revision and current bearer', async () => {
  const h = harness();
  for (const [action, value] of [
    ['saveApplication', { name: 'Delta', url: 'https://example.test/', category: '中台应用', published: false }],
    ['savePolicy', { name: '部门规则', department: '技术部', appIds: ['web-delta'], action: 'deny', enabled: true }],
  ]) {
    const result = await h.bridge.request({ action, id: 'web-delta', revision: 2, value });
    assert.equal(result.ok, true);
    const call = h.calls.filter(call => call.options.method === 'PATCH').at(-1);
    assert.equal(new URL(call.url).pathname, '/internal/v1/mincave/workspace');
    assert.deepEqual(JSON.parse(call.options.body), { revision: 2, kind: action === 'saveApplication' ? 'application' : 'policy', id: 'web-delta', value });
    assert.equal((await h.bridge.request({ action, id: '../members/admin', revision: 2, value })).ok, false);
    assert.equal((await h.bridge.request({ action, revision: 2, value: { ...value, roleIds: ['mx-admin'] } })).ok, false);
    h.server.role = 'employee';
    assert.equal((await h.bridge.request({ action, revision: 2, value })).ok, false);
    h.server.role = 'admin';
  }
});
test('allowed application projection survives a temporary outage but never survives account changes', async () => {
  const runtime = { auth: { accessToken: 'token', subject: 'user:one', provider: 'feishu' }, connection: { state: 'connected' } };
  let online = true;
  const bridge = createMincaveAdminBridge({ getRuntime: () => runtime, resolveBaseUrl: async () => 'https://example.test', fetch: async () => {
    if (!online) throw new Error('offline');
    return { ok: true, json: async () => ({ allowed: true, role: 'employee', canManage: false, userId: 'one', applications: [
      { id: 'good', name: 'Allowed', url: 'https://example.test/', category: '产品应用', icon: 'apps', color: 'purple' },
      { id: 'unsafe', name: 'Unsafe', url: 'javascript:alert(1)', category: '产品应用' },
    ] }) };
  } });
  await bridge.refresh();
  assert.deepEqual(bridge.snapshot().applications.map(app => app.id), ['good']);
  online = false;
  await bridge.refresh();
  assert.deepEqual(bridge.snapshot().applications.map(app => app.id), ['good']);
  runtime.auth = { ...runtime.auth, accessToken: 'new', subject: 'user:two' };
  assert.equal(bridge.snapshot().applications, undefined);
  await bridge.refresh();
  assert.equal(bridge.snapshot().allowed, false);
});

test('absent catalog supports old servers; malformed or empty catalog never restores all default entries', async () => {
  const h = harness();
  await h.bridge.refresh();
  assert.equal(h.bridge.snapshot().applications, undefined);
  for (const applications of [null, [], {}, [null, { id: 'bad', name: 'Bad', category: '产品应用', url: 'file:///tmp/local' }]]) {
    h.server.applications = applications;
    await h.bridge.refresh();
    assert.equal(h.bridge.snapshot().allowed, true);
    assert.deepEqual(h.bridge.snapshot().applications, []);
  }
});

test('member application grants use only optional appIds and preserve legacy role-only writes', async () => {
  const h = harness();
  const value = { role: 'employee', enabled: true, appIds: ['web-hub'] };
  assert.equal((await h.bridge.request({ action: 'saveMember', id: 'member-1', value })).ok, true);
  const patch = h.calls.find(call => call.options.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.options.body), value);
  for (const appIds of ['web-hub', ['../admin'], [null], Array(201).fill('web-hub')])
    assert.equal((await h.bridge.request({ action: 'saveMember', id: 'member-1', value: { ...value, appIds } })).ok, false);
});
