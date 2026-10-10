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
    if (!value || Date.parse(value.data.expiresAt as string) <= Date.now()) return null;
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
type TestPayload = { csrf: string; authenticated: boolean; bindingRequired?: boolean; canManage?: boolean; accessMode?: string; user: { userId: string; account?: string }; actor?: string };
type TestResponse = Omit<Response, 'json'> & { json(): Promise<TestPayload> };

async function fixture(localSubjects = false, publicGateway = false) {
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
      const payload = { iss: issuer, aud: 'launcher', sub: 'sso-subject', nonce: auth.get('nonce'), iat: now, exp: now + 300, auth_time: Date.now() / 1000, ...claimsOverride };
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
  const settings = { issuer, origin, clientId: 'launcher', clientSecret: 'secret', callbackUrl: `${origin}/auth/admin/callback`, localSubjects, ...(publicGateway ? { ingressToken: 'test-gateway-secret' } : {}) };
  const config = new oidc.Configuration({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }, 'launcher',
    { client_secret: 'secret', id_token_signed_response_alg: 'RS256' }, oidc.ClientSecretBasic('secret'));
  oidc.allowInsecureRequests(config); // Test fixture only; production config requires HTTPS.
  middleware = createAdminSsoMiddleware({ config: settings, oidc: createAdminOidcClient(settings, config), repository, store });
  async function request(path: string, sessionCookie = '', body?: unknown, csrf?: string, requestOrigin = origin) {
    return await fetch(`${origin}${path}`, { redirect: 'manual', ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { ...(publicGateway ? { 'x-mx-identity-gateway': 'test-gateway-secret', 'x-mx-client-ip': '203.0.113.1' } : {}), ...(sessionCookie ? { cookie: sessionCookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json', origin: requestOrigin } : {}), ...(csrf ? { 'x-mx-admin-csrf': csrf } : {}) } }) as TestResponse;
  }
  async function begin(sessionCookie = '', switching = false, selecting = false) {
    const response = await request('/auth/admin/login' + (switching ? '?switch=1' : selecting ? '?select=1' : ''), sessionCookie);
    assert.equal(response.status, 303);
    const authorize = new URL(response.headers.get('location')!);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('scope'), 'openid');
    assert.equal(authorize.searchParams.get('prompt'), switching || (sessionCookie && !selecting) ? 'login' : selecting ? 'select_account' : null);
    assert.equal(authorize.searchParams.get('max_age'), switching || (sessionCookie && !selecting) ? '300' : '2592000');
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
    assert.equal(session.user.account, 'User', 'the permission gate identifies the signed-in login account');
  } finally { await f.close(); }
});

test('real OIDC code/PKCE/signature -> verified old password -> same local admin -> logout, with isolated legacy paths', async () => {
  const f = await fixture();
  try {
    const beforeUsers = await f.store.listUserCenterUsers();
    assert.equal((await (await f.request('/auth/admin/session')).json()).accessMode, 'sso-or-ops');
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
    for (const endpoint of ['identity/validate', 'identity/applications']) {
      const path = `/admin-api/internal/v1/admin/service-operations/${endpoint}`;
      assert.equal((await f.request(path, sessionCookie, {})).status, 403);
      assert.equal((await f.request(path, sessionCookie, {}, session.csrf, 'https://evil.test')).status, 403);
      assert.equal((await f.request(path, sessionCookie, {}, session.csrf)).status, 200);
    }
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

test('write operations require recent authentication; 30-day sessions survive idle time but expire absolutely', async () => {
  const f = await fixture();
  try {
    const sessionCookie = await f.bind(await f.login());
    const session = await (await f.request('/auth/admin/session', sessionCookie)).json();
    const id = digest(sessionCookie.split('=')[1]);
    const record = f.repository.records.get(`admin-sso-session:${id}`)!;
    record.data.authTime = Math.floor(Date.now() / 1000) - 301;
    assert.equal((await f.request('/admin-api/internal/v1/admin/service-operations/execute', sessionCookie, {}, session.csrf)).status, 401);
    assert.equal((await f.request('/admin-api/internal/v1/admin/service-operations/identity/applications', sessionCookie, {}, session.csrf)).status, 401);
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 200);
    assert.ok(Date.parse(record.data.expiresAt as string) - Date.now() > 29 * 86400000);
    record.touched = Date.now() - 20 * 86400000;
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 200);
    record.touched = Date.now(); record.data.expiresAt = new Date(Date.now() - 1).toISOString();
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', sessionCookie, undefined, session.csrf)).status, 401);
  } finally { await f.close(); }
});

test('registration writes require reauthentication and a fresh CSRF token before an explicit resubmission', async () => {
  const f = await fixture(true);
  try {
    f.setClaims({ sub: 'existing-admin' });
    const original = await f.login();
    const session = await (await f.request('/auth/admin/session', original)).json();
    const record = f.repository.records.get(`admin-sso-session:${digest(original.split('=')[1])}`)!;
    record.data.authTime = Math.floor(Date.now() / 1000) - 301;
    const base = '/admin-api/internal/v1/user-center/registration';
    const writes = [
      ['/policy', { mode: 'invite_code', hubMode: 'open', applicationModes: { 'mx-harbor': 'invite_code' } }],
      ['/invitations', { label: 'Harbor fixture', admissionAppId: 'mx-harbor', maxUses: 1, days: 7 }],
      ['/invitations/revoke', { id: 'fixture-invitation' }]
    ] as const;
    assert.equal((await f.request(base, original, undefined, session.csrf)).status, 200);
    for (const [path, body] of writes) {
      const response = await f.request(`${base}${path}`, original, body, session.csrf);
      assert.equal(response.status, 401);
      assert.equal((await response.json() as unknown as { code: string }).code, 'reauth_required');
    }
    const renewed = await f.login(original);
    const fresh = await (await f.request('/auth/admin/session', renewed)).json();
    assert.equal(fresh.user.userId, session.user.userId);
    assert.notEqual(fresh.csrf, session.csrf);
    assert.equal((await f.request(`${base}/policy`, renewed, writes[0][1], session.csrf)).status, 403);
    assert.equal((await f.request(`${base}/policy`, original, writes[0][1], session.csrf)).status, 401);
    for (const [path, body] of writes) {
      const response = await f.request(`${base}${path}`, renewed, body, fresh.csrf);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).actor, 'existing-admin');
    }
  } finally { await f.close(); }
});

test('reauthentication pins the current account; logout removes the pin so another existing account can log in', async () => {
  const f = await fixture(true);
  try {
    f.setClaims({ sub: 'existing-user' });
    const original = await f.login();
    const session = await (await f.request('/auth/admin/session', original)).json();
    const reauth = await f.begin(original);
    f.setClaims({ sub: 'existing-admin' });
    assert.match((await f.request(reauth.callback, `${reauth.loginCookie}; ${original}`)).headers.get('location')!, /login_failed/);
    assert.equal((await f.request('/auth/admin/logout', original, {}, session.csrf)).status, 200);
    const switched = await f.login();
    assert.equal((await (await f.request('/auth/admin/session', switched)).json()).user.userId, 'existing-admin');
    assert.equal((await (await f.request('/auth/admin/session', original)).json()).authenticated, false);
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

// Public Host alone must never grant access through an untrusted proxy hop.
test('public console requires gateway provenance and immediately honors a user app ban', async () => {
  const f = await fixture(true, true);
  try {
    const anonymous = await (await f.request('/auth/admin/session')).json();
    assert.equal(anonymous.accessMode, 'sso-only');
    assert.equal(anonymous.authenticated, false);
    f.setClaims({ sub: 'existing-admin' });
    const cookie = await f.login();
    const { csrf, accessMode } = await (await f.request('/auth/admin/session', cookie)).json();
    assert.equal(accessMode, 'sso-only');
    assert.equal((await f.request('/admin-api/internal/v1/admin', cookie, undefined, csrf)).status, 200);
    assert.equal((await fetch(`${f.origin}/auth/admin/session`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${f.origin}/admin-api/internal/v1/admin`, { headers: { cookie, 'x-mx-identity-gateway': 'spoofed' } })).status, 403);
    await f.store.createUserCenterUser({ userId: 'existing-admin', deniedAppIds: ['mx-launcher'] });
    assert.equal((await f.request('/admin-api/internal/v1/admin', cookie, undefined, csrf)).status, 401);
  } finally { await f.close(); }
});


test('public Ops sign-in issues an opaque 30-day cookie; checks origin, gateway, CSRF, rotation and logout without creating a user', async () => {
  const previous = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'fixture-ops-secret';
  const f = await fixture(true, true);
  try {
    const users = await f.store.listUserCenterUsers();
    assert.equal((await f.request('/auth/admin/ops-login', '', { token: 'wrong' })).status, 401);
    assert.equal((await f.request('/auth/admin/ops-login', '', { token: 'fixture-ops-secret' }, undefined, 'https://evil.test')).status, 403);
    assert.equal((await f.request('/auth/admin/ops-login', '', { token: 'fixture-ops-secret' }, undefined, '')).status, 403);
    assert.equal((await fetch(`${f.origin}/auth/admin/ops-login`, { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'fixture-ops-secret' }) })).status, 403);
    const login = await f.request('/auth/admin/ops-login', '', { token: 'fixture-ops-secret' });
    assert.equal(login.status, 200);
    assert.match(login.headers.getSetCookie().join(';'), /HttpOnly; Secure; SameSite=Lax; Max-Age=2592000/);
    const cookie = cookieValue(login, '__Host-mx-admin-session');
    assert.ok(!cookie.includes('fixture-ops-secret'));
    assert.ok(!JSON.stringify([...f.repository.records]).includes('fixture-ops-secret'));
    const session = await (await f.request('/auth/admin/session', cookie)).json();
    assert.equal(session.canManage, true);
    assert.equal(session.user.userId, null);
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', cookie)).status, 403);
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', cookie, {}, session.csrf, 'https://evil.test')).status, 403);
    const response = await f.request('/admin-api/internal/v1/user-center/users', cookie, undefined, session.csrf);
    assert.equal(response.status, 200); assert.equal((await response.json()).actor, 'ops');
    assert.equal((await f.request('/internal/v1/user-center/users', cookie, undefined, session.csrf)).status, 401);
    assert.equal((await f.request('/auth/admin/logout', cookie, {}, session.csrf)).status, 200);
    assert.equal((await f.request('/admin-api/internal/v1/user-center/users', cookie, undefined, session.csrf)).status, 401);
    const next = cookieValue(await f.request('/auth/admin/ops-login', '', { token: 'fixture-ops-secret' }), '__Host-mx-admin-session');
    process.env.MX_INTERNAL_OPS_TOKEN = 'fixture-rotated';
    assert.equal((await (await f.request('/auth/admin/session', next)).json()).authenticated, false);
    assert.deepEqual(await f.store.listUserCenterUsers(), users);
  } finally { await f.close(); if (previous === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN; else process.env.MX_INTERNAL_OPS_TOKEN = previous; }
});

test('normal SSO accepts a remembered identity; explicit switching and write reauthentication require fresh proof', async () => {
  const f = await fixture(true);
  try {
    f.setClaims({ sub: 'existing-admin', auth_time: Math.floor(Date.now() / 1000) - 20 * 86400 });
    const cookie = await f.login();
    const session = await (await f.request('/auth/admin/session', cookie)).json();
    assert.equal(session.canManage, true);
    assert.equal((await f.request('/admin-api/internal/v1/admin/actions', cookie, {}, session.csrf)).status, 401);
    const stale = await f.begin(cookie);
    assert.match((await f.request(stale.callback, `${stale.loginCookie}; ${cookie}`)).headers.get('location')!, /sso_error/);
    f.setClaims({ sub: 'existing-user' });
    const switched = await f.begin(cookie, true);
    const result = await f.request(switched.callback, `${switched.loginCookie}; ${cookie}`);
    assert.equal(result.headers.get('location'), '/admin/');
    const next = cookieValue(result, '__Host-mx-admin-session');
    assert.equal((await (await f.request('/auth/admin/session', next)).json()).user.userId, 'existing-user');
  } finally { await f.close(); }
});

test('account selection allows changing identity without granting management or refreshing old proof', async () => {
  const f = await fixture(true);
  try {
    f.setClaims({ sub: 'existing-admin', auth_time: Math.floor(Date.now() / 1000) - 86400 });
    const old = await f.login();
    const selected = await f.begin(old, false, true);
    const response = await f.request(selected.callback, `${selected.loginCookie}; ${old}`);
    const continued = cookieValue(response, '__Host-mx-admin-session');
    const current = await (await f.request('/auth/admin/session', continued)).json();
    assert.equal((await f.request('/admin-api/internal/v1/admin/actions', continued, {}, current.csrf)).status, 401);
    f.setClaims({ sub: 'existing-user' });
    const switchToUser = await f.begin(continued, false, true);
    const result = await f.request(switchToUser.callback, `${switchToUser.loginCookie}; ${continued}`);
    assert.equal(result.headers.get('location'), '/admin/');
    const next = cookieValue(result, '__Host-mx-admin-session');
    const user = await (await f.request('/auth/admin/session', next)).json();
    assert.equal(user.user.userId, 'existing-user');
    assert.equal(user.canManage, false);
    assert.equal((await f.request('/admin-api/internal/v1/admin/actions', next, {}, user.csrf)).status, 403);
  } finally { await f.close(); }
});

test('password changes revoke existing browser sessions without extending old expiry; profile edits do not', async () => {
  const f = await fixture(true);
  try {
    f.setClaims({ sub: 'existing-admin', mx_session_uid: 'signed-browser-uid' });
    const sid = await f.login();
    const session = await (await f.request('/auth/admin/session', sid)).json();
    await f.store.createUserCenterUser({ userId: 'existing-admin', displayName: 'Renamed', roleIds: ['mx-admin'] });
    assert.equal((await (await f.request('/auth/admin/session', sid)).json()).authenticated, true);
    await f.store.updateUserCenterPassword({ userId: 'existing-admin', password: 'ChangedPassword456!' });
    assert.equal((await f.request('/admin-api/internal/v1/audit-probe', sid, {}, session.csrf)).status, 401);
    assert.equal((await (await f.request('/auth/admin/session', sid)).json()).authenticated, false);
    const fresh = await f.login();
    assert.equal((await (await f.request('/auth/admin/session', fresh)).json()).authenticated, true);
    await f.store.createUserCenterUser({ userId: 'existing-admin', password: 'AnotherPassword789!', roleIds: ['mx-admin'] });
    assert.equal((await (await f.request('/auth/admin/session', fresh)).json()).authenticated, false, 'admin upsert password also revokes web sessions');
  } finally { await f.close(); }
});

test('managed browser checks carry signed session UID; legacy sessions remain usable until explicitly revoked', async () => {
  const f = await fixture(true);
  try {
    const proofs: unknown[] = [];
    let active = true;
    Object.assign(f.repository, { webSessionActive: async (userId: string, proof: unknown) => { proofs.push({ userId, proof }); return active; } });
    f.setClaims({ sub: 'existing-admin', mx_session_uid: 'signed-browser-uid' });
    const sid = await f.login();
    const session = await (await f.request('/auth/admin/session', sid)).json();
    assert.equal(session.authenticated, true);
    assert.equal((proofs.at(-1) as { proof: { sessionUid: string } }).proof.sessionUid, 'signed-browser-uid');
    active = false;
    assert.equal((await f.request('/admin-api/internal/v1/audit-probe', sid, {}, session.csrf)).status, 401);
    active = true;
    f.setClaims({ sub: 'existing-admin' });
    const legacy = await f.login();
    assert.equal((await (await f.request('/auth/admin/session', legacy)).json()).authenticated, true);
    active = false;
    assert.equal((await (await f.request('/auth/admin/session', legacy)).json()).authenticated, false);
  } finally { await f.close(); }
});
