import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import * as oidc from 'openid-client';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '../config.js';
import { MemoryStore } from '../store/memory.js';
import { assertInternalOpsToken, internalOpsTokenMatches } from '../lib/internal-ops-auth.js';
import { internalAdminContext } from '../lib/internal-admin-context.js';
import { AdminController } from '../modules/admin/admin.controller.js';
import { loadAdminSsoConfig } from './config.js';
import { createAdminOidcClient } from './oidc.js';
import { createAdminSsoMiddleware } from './middleware.js';
import { bindingKey, digest, type SsoKind, type SsoRecord, type SsoRepository } from './repository.js';

class TestRepository implements SsoRepository {
  records = new Map<string, { data: SsoRecord; touched: number }>();
  async insert(kind: SsoKind, id: string, data: SsoRecord) {
    const key = `${kind}:${id}`;
    if (this.records.has(key)) return false;
    this.records.set(key, { data: structuredClone(data), touched: Date.now() }); return true;
  }
  async read(kind: SsoKind, id: string) { return structuredClone(this.records.get(`${kind}:${id}`)?.data ?? null); }
  async take(kind: SsoKind, id: string) {
    const value = this.records.get(`${kind}:${id}`); this.records.delete(`${kind}:${id}`);
    return structuredClone(value?.data ?? null);
  }
  async remove(kind: SsoKind, id: string) { await this.take(kind, id); }
  async touchSession(id: string) {
    const value = this.records.get(`admin-sso-session:${id}`);
    if (!value || Date.parse(value.data.expiresAt as string) <= Date.now() || Date.now() - value.touched >= 1800000) return null;
    value.touched = Date.now(); return structuredClone(value.data);
  }
}
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const close = (server: Server) => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
const cookieValue = (response: Response, name: string) => response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`))?.split(';')[0] ?? '';
type TestPayload = { csrf: string; authenticated: boolean; bindingRequired?: boolean; canManage?: boolean; user: { userId: string }; actor?: string };
type TestResponse = Omit<Response, 'json'> & { json(): Promise<TestPayload> };

async function fixture(localSubjects = false) {
  const repository = new TestRepository();
  const store = new MemoryStore(loadConfig());
  await store.createUserCenterUser({ userId: 'existing-admin', account: 'Admin', password: 'ExistingPassword123!', roleIds: ['mx-admin'] });
  await store.createUserCenterUser({ userId: 'existing-user', account: 'User', password: 'UserPassword123!', roleIds: ['mx-user'] });
  const codes = new Map<string, URLSearchParams>();
  let claimsOverride: Record<string, unknown> = {};
  let invalidSignature = false;
  let redemptionCount = 0;
  let pkceCount = 0;
  let issuer = '';
  const provider = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url === '/token') {
      let body = ''; for await (const part of req) body += part;
      const params = new URLSearchParams(body);
      const auth = codes.get(params.get('code') ?? '');
      codes.delete(params.get('code') ?? '');
      assert.equal(req.headers.authorization, `Basic ${Buffer.from('launcher:secret').toString('base64')}`);
      const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
      if (!auth || auth.get('code_challenge') !== challenge || params.get('redirect_uri') !== auth.get('redirect_uri')) {
        res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      pkceCount++; redemptionCount++;
      const now = Math.floor(Date.now() / 1000);
      const payload = { iss: issuer, aud: 'launcher', sub: 'sso-subject', nonce: auth.get('nonce'), iat: now, exp: now + 300, auth_time: now, ...claimsOverride };
      const signed = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode(payload)}`;
      const signature = sign('RSA-SHA256', Buffer.from(signed), (invalidSignature ? wrongKey : key).privateKey).toString('base64url');
      return res.end(JSON.stringify({ token_type: 'Bearer', access_token: 'fixture-only', expires_in: 300, id_token: `${signed}.${signature}` }));
    }
    res.statusCode = 404; res.end('{}');
  });
  issuer = await listen(provider);
  let middleware: ReturnType<typeof createAdminSsoMiddleware>;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const request = Object.assign(req, { body: body ? JSON.parse(body) as Record<string, unknown> : {}, ip: '127.0.0.1' });
    middleware(request, res, () => {
      try {
        assertInternalOpsToken(typeof req.headers['x-mx-ops-token'] === 'string' ? req.headers['x-mx-ops-token'] : undefined);
        assert.equal(internalOpsTokenMatches(undefined), Boolean(internalAdminContext.getStore()));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ path: req.url, actor: internalAdminContext.getStore()?.userId ?? 'ops' }));
      } catch { res.statusCode = 401; res.end('{}'); }
    });
  });
  const origin = await listen(server);
  const settings = { issuer, origin, clientId: 'launcher', clientSecret: 'secret', callbackUrl: `${origin}/auth/admin/callback`, localSubjects };
  const config = new oidc.Configuration({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }, 'launcher',
    { client_secret: 'secret', id_token_signed_response_alg: 'RS256' }, oidc.ClientSecretBasic('secret'));
  oidc.allowInsecureRequests(config); // Test fixture only; production config requires HTTPS.
  middleware = createAdminSsoMiddleware({ config: settings, oidc: createAdminOidcClient(settings, config), repository, store });
  async function request(path: string, sessionCookie = '', body?: unknown, csrf?: string, requestOrigin = origin) {
    return await fetch(`${origin}${path}`, { redirect: 'manual', ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { ...(sessionCookie ? { cookie: sessionCookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json', origin: requestOrigin } : {}), ...(csrf ? { 'x-mx-admin-csrf': csrf } : {}) } }) as TestResponse;
  }
  async function begin(sessionCookie = '') {
    const response = await request('/auth/admin/login', sessionCookie);
    assert.equal(response.status, 303);
    const authorize = new URL(response.headers.get('location')!);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('scope'), 'openid');
    const code = randomUUID(); codes.set(code, authorize.searchParams);
    return { loginCookie: cookieValue(response, '__Host-mx-admin-login'), callback: `/auth/admin/callback?code=${code}&state=${authorize.searchParams.get('state')}` };
  }
  async function login(sessionCookie = '') {
    const flow = await begin(sessionCookie);
    const response = await request(flow.callback, `${flow.loginCookie}; ${sessionCookie}`);
    assert.equal(response.headers.get('location'), '/admin/');
    const nextCookie = cookieValue(response, '__Host-mx-admin-session');
    assert.match(response.headers.getSetCookie().join(';'), /HttpOnly; Secure; SameSite=Lax/);
    return nextCookie;
  }
  async function bind(sessionCookie: string, login = 'Admin', password = 'ExistingPassword123!') {
    const session = await (await request('/auth/admin/session', sessionCookie)).json();
    const response = await request('/auth/admin/link', sessionCookie, { login, password }, session.csrf);
    assert.equal(response.status, 200, await response.text());
    return cookieValue(response, '__Host-mx-admin-session');
  }
  return { repository, store, origin, issuer, request, begin, login, bind,
    middleware: () => middleware,
    disable: () => { middleware = createAdminSsoMiddleware({ config: null, store }); },
    setClaims: (claims: Record<string, unknown>) => { claimsOverride = claims; },
    badSignature: () => { invalidSignature = true; },
    counts: () => ({ redemptionCount, pkceCount }),
    close: async () => { await close(server); await close(provider); }
  };
}

test('SSO config defaults off; enabled config requires HTTPS and fixed callback', () => {
  assert.equal(loadAdminSsoConfig({}), null);
  const env = { MX_ADMIN_SSO_ENABLED: '1', MX_ADMIN_SSO_ISSUER: 'https://identity.test/realms/mx', MX_ADMIN_SSO_ORIGIN: 'https://launcher.test', MX_ADMIN_SSO_CLIENT_ID: 'launcher', MX_ADMIN_SSO_CLIENT_SECRET: 'secret' };
  assert.equal(loadAdminSsoConfig(env)?.callbackUrl, 'https://launcher.test/auth/admin/callback');
  for (const origin of ['http://localhost', 'https://user:pass@launcher.test', 'https://launcher.test/redirect', 'https://launcher.test?x=1']) {
    assert.throws(() => loadAdminSsoConfig({ ...env, MX_ADMIN_SSO_ORIGIN: origin }));
  }
});

test('managed identity preserves the existing account without requiring a second password binding', async () => {
  const f = await fixture(true);
  try {
    const before = await f.store.listUserCenterUsers();
    f.setClaims({ sub: 'existing-admin' });
    const cookie = await f.login();
    const session = await (await f.request('/auth/admin/session', cookie)).json();
    assert.ok(!session.bindingRequired);
    assert.equal(session.canManage, true);
    assert.equal(session.user.userId, 'existing-admin');
    assert.deepEqual(await f.store.listUserCenterUsers(), before);
    assert.equal((await (await f.request('/auth/admin/session', await f.login())).json()).user.userId, 'existing-admin');
  } finally { await f.close(); }
});

test('managed identity cannot mint a new account or elevate an ordinary existing user', async () => {
  const f = await fixture(true);
  try {
    f.setClaims({ sub: 'unknown-user' });
    const flow = await f.begin();
    const rejected = await f.request(flow.callback, flow.loginCookie);
    assert.match(rejected.headers.get('location')!, /sso_error/);
    f.setClaims({ sub: 'existing-user' });
    const cookie = await f.login();
    const session = await (await f.request('/auth/admin/session', cookie)).json();
    assert.equal(session.canManage, false);
    assert.equal(session.user.userId, 'existing-user');
  } finally { await f.close(); }
});

test('real OIDC code/PKCE/signature -> verified old password -> same local admin -> logout, with isolated legacy paths', async () => {
  const f = await fixture();
  try {
    const beforeUsers = await f.store.listUserCenterUsers();
    const pendingCookie = await f.login();
    const pending = await (await f.request('/auth/admin/session', pendingCookie)).json();
    assert.equal(pending.bindingRequired, true);
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', pendingCookie, undefined, pending.csrf)).status, 401);
    const sessionCookie = await f.bind(pendingCookie);
    assert.equal((await (await f.request('/auth/admin/session', pendingCookie)).json()).authenticated, false);
    const session = await (await f.request('/auth/admin/session', sessionCookie)).json();
    assert.equal(session.user.userId, 'existing-admin'); assert.equal(session.canManage, true);
    const result = await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf);
    assert.equal(result.status, 200); assert.equal((await result.json()).actor, 'existing-admin');
    assert.equal((await f.request('/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 401);
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie)).status, 403);
    assert.equal((await f.request('/admin-api/internal/v1/admin/service-operations/execute', sessionCookie, {}, session.csrf, 'https://evil.test')).status, 403);
    assert.equal((await f.request('/admin-api/internal/v1/admin/service-operations/execute', sessionCookie, {}, session.csrf)).status, 200);
    assert.deepEqual(await f.store.listUserCenterUsers(), beforeUsers);
    assert.deepEqual(f.counts(), { pkceCount: 1, redemptionCount: 1 });
    assert.equal((await f.request('/auth/admin/logout', sessionCookie, {}, session.csrf)).status, 200);
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 401);
    const returning = await (await f.request('/auth/admin/session', await f.login())).json();
    assert.equal(returning.canManage, true); assert.equal(returning.bindingRequired, undefined);
  } finally { await f.close(); }
});

test('ordinary accounts gain no management rights; role removal and account disable take effect on the next request', async () => {
  const f = await fixture();
  try {
    const sessionCookie = await f.bind(await f.login(), 'User', 'UserPassword123!');
    const session = await (await f.request('/auth/admin/session', sessionCookie)).json();
    assert.equal(session.canManage, false);
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 403);
    await f.store.createUserCenterUser({ userId: 'existing-user', account: 'User', roleIds: ['mx-admin'] });
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 200);
    await f.store.createUserCenterUser({ userId: 'existing-user', account: 'User', roleIds: ['mx-user'] });
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 403);
    await f.store.createUserCenterUser({ userId: 'existing-user', account: 'User', roleIds: ['mx-admin'], status: 'disabled' });
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 401);
  } finally { await f.close(); }
});

test('write operations require recent authentication; expired/idle sessions cannot resurrect after logout', async () => {
  const f = await fixture();
  try {
    const sessionCookie = await f.bind(await f.login());
    const session = await (await f.request('/auth/admin/session', sessionCookie)).json();
    const id = digest(sessionCookie.split('=')[1]);
    const record = f.repository.records.get(`admin-sso-session:${id}`)!;
    record.data.authTime = Math.floor(Date.now() / 1000) - 301;
    assert.equal((await f.request('/admin-api/internal/v1/admin/service-operations/execute', sessionCookie, {}, session.csrf)).status, 401);
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 200);
    record.touched = Date.now() - 1800001;
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 401);
    record.touched = Date.now(); record.data.expiresAt = new Date(Date.now() - 1).toISOString();
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 401);
  } finally { await f.close(); }
});

test('callback is browser-bound, state-checked, expiring and one-time', async () => {
  const f = await fixture();
  try {
    const flow = await f.begin();
    assert.match((await f.request(flow.callback)).headers.get('location')!, /login_failed/);
    const first = await f.request(flow.callback, flow.loginCookie);
    assert.equal(first.headers.get('location'), '/admin/');
    assert.match((await f.request(flow.callback, flow.loginCookie)).headers.get('location')!, /login_failed/);
    const mismatch = await f.begin();
    assert.match((await f.request(mismatch.callback.replace(/state=.*/, 'state=attacker'), mismatch.loginCookie)).headers.get('location')!, /login_failed/);
    const expired = await f.begin();
    f.repository.records.get(`admin-sso-transaction:${digest(expired.loginCookie.split('=')[1])}`)!.data.expiresAt = new Date(Date.now() - 1).toISOString();
    assert.match((await f.request(expired.callback, expired.loginCookie)).headers.get('location')!, /login_failed/);
    assert.equal(f.counts().redemptionCount, 1);
  } finally { await f.close(); }
});

for (const [name, claims] of Object.entries({ nonce: { nonce: 'wrong' }, issuer: { iss: 'https://evil.test' }, audience: { aud: 'other' }, expired: { exp: 1 }, oldAuth: { auth_time: 1 }, missingAuth: { auth_time: undefined } })) {
  test(`OIDC rejects invalid ${name} claims`, async () => {
    const f = await fixture();
    try {
      f.setClaims(claims);
      const flow = await f.begin();
      assert.match((await f.request(flow.callback, flow.loginCookie)).headers.get('location')!, /login_failed/);
      assert.equal([...f.repository.records.keys()].filter((key) => key.startsWith('admin-sso-session')).length, 0);
    } finally { await f.close(); }
  });
}
test('OIDC rejects a correctly-shaped JWT signed by a different key', async () => {
  const f = await fixture();
  try {
    f.badSignature(); const flow = await f.begin();
    assert.match((await f.request(flow.callback, flow.loginCookie)).headers.get('location')!, /login_failed/);
  } finally { await f.close(); }
});

test('binding requires the old password; concurrent claims cannot rebind one external subject', async () => {
  const f = await fixture();
  try {
    const cookies = await Promise.all([f.login(), f.login()]);
    const sessions = await Promise.all(cookies.map(async (cookie) => (await f.request('/auth/admin/session', cookie)).json()));
    assert.equal((await f.request('/auth/admin/link', cookies[0], { login: 'Admin', password: 'wrong' }, sessions[0].csrf)).status, 401);
    const results = await Promise.all(cookies.map((cookie, index) => f.request('/auth/admin/link', cookie,
      index ? { login: 'User', password: 'UserPassword123!' } : { login: 'Admin', password: 'ExistingPassword123!' }, sessions[index].csrf)));
    assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
    const binding = await f.repository.read('admin-sso-binding', bindingKey(f.issuer, 'sso-subject'));
    assert.ok(binding?.userId);
  } finally { await f.close(); }
});

test('default-off middleware leaves emergency Ops auth usable, even with a stale SSO cookie', async () => {
  const f = await fixture(); const previous = process.env.MX_INTERNAL_OPS_TOKEN;
  try {
    const sessionCookie = await f.bind(await f.login());
    f.disable();
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie)).status, 503);
    process.env.MX_INTERNAL_OPS_TOKEN = 'fixture-emergency';
    const response = await fetch(`${f.origin}/internal/v1/user-center/users`, { headers: { cookie: sessionCookie, 'x-mx-ops-token': 'fixture-emergency' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as TestPayload).actor, 'ops');
    assert.equal((await f.request('/internal/v1/user-center/users', sessionCookie)).status, 401);
  } finally {
    if (previous === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN; else process.env.MX_INTERNAL_OPS_TOKEN = previous;
    await f.close();
  }
});

test('password linking is rate limited and does not create new users', async () => {
  const f = await fixture();
  try {
    const sessionCookie = await f.login();
    const session = await (await f.request('/auth/admin/session', sessionCookie)).json();
    for (let i = 0; i < 5; i++) assert.equal((await f.request('/auth/admin/link', sessionCookie, { login: 'Admin', password: 'wrong' }, session.csrf)).status, 401);
    assert.equal((await f.request('/auth/admin/link', sessionCookie, { login: 'Admin', password: 'ExistingPassword123!' }, session.csrf)).status, 429);
    assert.equal((await f.store.listUserCenterUsers()).length, 2);
  } finally { await f.close(); }
});

test('historical demo/bootstrap passwords cannot grant personal console access', async () => {
  const f = await fixture();
  try {
    await f.store.createUserCenterUser({ userId: 'usr_demo_admin', account: 'demo', password: 'PresetPassword123!', roleIds: ['mx-admin'] });
    const sessionCookie = await f.login();
    const session = await (await f.request('/auth/admin/session', sessionCookie)).json();
    assert.equal((await f.request('/auth/admin/link', sessionCookie, { login: 'demo', password: 'PresetPassword123!' }, session.csrf)).status, 401);
    assert.equal(await f.repository.read('admin-sso-binding', bindingKey(f.issuer, 'sso-subject')), null);
    assert.equal((await f.store.verifyUserCenterPassword({ userId: 'usr_demo_admin', password: 'PresetPassword123!' })).ok, true);
  } finally { await f.close(); }
});

test('personal action policy uses the verified account and ignores impersonation query parameters', async () => {
  const f = await fixture();
  try {
    const controller = new AdminController(f.store);
    const result = await internalAdminContext.run({ userId: 'existing-admin', requestId: 'test-personal-policy' }, () =>
      controller.actions('Bearer untrusted', 'untrusted', 'existing-user'));
    assert.equal(result.actionPolicy.authMode, 'personal-sso-v1');
    assert.equal(result.actionPolicy.principal.userId, 'existing-admin');
    assert.deepEqual(result.actionPolicy.warnings, []);
    const legacy = await controller.actions();
    assert.equal(legacy.actionPolicy.authMode, 'shadow-rbac-v1');
  } finally { await f.close(); }
});

class SsoFixtureController {
  async read() { await Promise.resolve(); assertInternalOpsToken(undefined); return { actor: internalAdminContext.getStore()?.userId }; }
}
class SsoFixtureModule {}
Get()(SsoFixtureController.prototype, 'read', Object.getOwnPropertyDescriptor(SsoFixtureController.prototype, 'read')!);
Controller('internal/v1/sso-fixture')(SsoFixtureController);
Module({ controllers: [SsoFixtureController] })(SsoFixtureModule);

test('BFF context survives real Nest/Express routing and cannot leak into concurrent legacy requests', async () => {
  const f = await fixture();
  const app = await NestFactory.create(SsoFixtureModule, { logger: false });
  try {
    app.use(f.middleware()); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const sessionCookie = await f.bind(await f.login());
    const session = await (await f.request('/auth/admin/session', sessionCookie)).json();
    const headers = { cookie: sessionCookie, 'x-mx-admin-csrf': session.csrf };
    const [personal, legacy] = await Promise.all([
      fetch(`${origin}/admin-api/internal/v1/sso-fixture`, { headers }),
      fetch(`${origin}/internal/v1/sso-fixture`, { headers })
    ]);
    assert.equal(personal.status, 200); assert.equal((await personal.json() as TestPayload).actor, 'existing-admin');
    assert.ok([401, 503].includes(legacy.status));
  } finally { await app.close(); await f.close(); }
});
