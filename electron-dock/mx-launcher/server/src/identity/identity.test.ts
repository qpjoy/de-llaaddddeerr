import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { createServer, request as httpsRequest } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createPlatformDataSource } from '../db/data-source.js';
import { loadConfig } from '../config.js';
import { MemoryStore } from '../store/memory.js';
import { createUserCenterUserCredential } from '../store/domain.js';
import { IdentityRepository } from './repository.js';
import { createIdentityProvider } from './provider.js';

const databaseUrl = process.env.MX_SSO_TEST_DATABASE_URL;
test('real persisted provider: old password, HTTPS code/PKCE, one-use code, restart, account disable and durable throttling', { skip: !databaseUrl }, async () => {
  const target = new URL(databaseUrl!);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname.includes('sso_test'));
  const environment = `identity-test-${randomUUID()}`; const scope = environment;
  const db = createPlatformDataSource({ ...loadConfig(), databaseUrl: databaseUrl!, environment, storeDriver: 'postgres' });
  await db.initialize(); await db.runMigrations();
  const directory = mkdtempSync(join(tmpdir(), 'mx-identity-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
  const cert = readFileSync(join(directory, 'cert.pem')); const key = readFileSync(join(directory, 'key.pem'));
  let repository = new IdentityRepository(databaseUrl!, environment, scope, 'fixture-rate-key');
  await repository.initialize();
  const memory = new MemoryStore(loadConfig());
  const user = await memory.createUserCenterUser({ userId: 'identity-existing-admin', account: 'ExactAdmin', password: 'OldPassword123!', roleIds: ['mx-admin'] });
  const credential = createUserCenterUserCredential(user.userId, 'OldPassword123!');
  for (const [kind, data] of [['iam-user', user], ['iam-user-credential', credential]] as const) await db.query('INSERT INTO mx_platform_records (kind,id,environment,data) VALUES ($1,$2,$3,$4)', [kind, user.userId, environment, data]);
  let application: ReturnType<typeof createIdentityProvider>;
  const server = createServer({ cert, key }, (req, res) => { void application.handle(req, res).catch(() => { res.statusCode = 500; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`; const issuer = `${origin}/identity`;
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const settings = { origin, issuer, clientId: 'mx-launcher-admin', clientSecret: 'fixture-secret', cookieKeys: ['fixture-cookie-key1', 'fixture-cookie-key2'], jwks: { keys: [{ ...pair.privateKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] } };
  let providerError = '';
  const restart = async () => {
    await repository.close(); repository = new IdentityRepository(databaseUrl!, environment, scope, 'fixture-rate-key'); await repository.initialize();
    application = createIdentityProvider(settings, repository, name => repository.adapter(name));
    application.provider.on('server_error', (_ctx, error) => { providerError = error.stack ?? error.message; });
  };
  application = createIdentityProvider(settings, repository, name => repository.adapter(name));
  const jar = new Map<string, string>();
  const request = (path: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}) => new Promise<{ status: number; text: string; location?: string }>((resolve, reject) => {
    const req = httpsRequest(new URL(path, origin), { ca: cert, method: options.method ?? 'GET', headers: { cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; '), ...options.headers } }, res => {
      for (const value of res.headers['set-cookie'] ?? []) { const item = value.split(';')[0]; const index = item.indexOf('='); jar.set(item.slice(0, index), item.slice(index + 1)); }
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode!, text, location: res.headers.location }));
    }); req.on('error', reject); req.end(options.body);
  });
  try {
    assert.equal((await repository.authenticate('ExactAdmin', 'OldPassword123!'))?.userId, user.userId);
    assert.equal(await repository.authenticate('exactadmin', 'OldPassword123!'), undefined);
    const before = await db.query('SELECT kind,id,data FROM mx_platform_records WHERE environment=$1 ORDER BY kind', [environment]);
    const discovery = JSON.parse((await request('/identity/.well-known/openid-configuration')).text);
    assert.equal(discovery.issuer, issuer); assert.match(discovery.authorization_endpoint, /\/identity\/auth$/);
    const verifier = 'a'.repeat(43); const state = randomUUID(); const nonce = randomUUID();
    const authorize = `${discovery.authorization_endpoint}?${new URLSearchParams({ client_id: settings.clientId, response_type: 'code', redirect_uri: `${origin}/auth/admin/callback`, scope: 'openid', state, nonce, max_age: '300', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') })}`;
    const badRedirect = new URL(authorize); badRedirect.searchParams.set('redirect_uri', 'https://other.invalid/callback');
    const refused = await request(badRedirect.href);
    assert.equal(refused.status, 400); assert.ok(!refused.location?.startsWith('https://other.invalid'));
    let step = await request(authorize); assert.equal(step.status, 303, step.text);
    const interaction = step.location!;
    step = await request(interaction); assert.equal(step.status, 200, step.text);
    const csrf = /name="csrf" value="([^"]+)"/.exec(step.text)![1];
    const submit = (password: string, token = csrf) => request(interaction, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: token, login: 'ExactAdmin', password }).toString() });
    assert.equal((await submit('OldPassword123!', 'wrong-csrf')).status, 400);
    assert.equal((await submit('bad-password')).status, 401);
    step = await submit('OldPassword123!'); assert.equal(step.status, 303, step.text);
    for (let i = 0; i < 5 && !step.location?.includes('/auth/admin/callback'); i++) step = await request(step.location!);
    const callback = new URL(step.location!); assert.equal(callback.searchParams.get('state'), state, JSON.stringify(step));
    const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code')!, code_verifier: verifier, redirect_uri: `${origin}/auth/admin/callback` }).toString();
    const token = (body = tokenBody) => request(discovery.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64')}` }, body });
    await restart(); // The already-issued authorization code survives restart.
    assert.equal((await token(tokenBody.replace(verifier, 'b'.repeat(43)))).status, 400);
    const redeemed = await token(); assert.equal(redeemed.status, 200, `${redeemed.text}\n${providerError}`);
    const jwt = JSON.parse(redeemed.text).id_token; const [header, payload, signature] = jwt.split('.');
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature, 'base64url')), true);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(claims.sub, user.userId); assert.equal(claims.iss, issuer); assert.equal(claims.nonce, nonce); assert.ok(claims.auth_time);
    assert.notEqual((await token()).status, 200);
    await restart();
    step = await request(authorize);
    assert.ok(step.location?.includes('/auth/admin/callback'), `SSO session must survive restart: ${JSON.stringify(step)}`);
    assert.deepEqual(await db.query('SELECT kind,id,data FROM mx_platform_records WHERE environment=$1 ORDER BY kind', [environment]), before);
    await db.query("UPDATE mx_platform_records SET data=jsonb_set(data,'{status}','\"disabled\"') WHERE environment=$1 AND kind='iam-user'", [environment]);
    assert.equal(await repository.authenticate('ExactAdmin', 'OldPassword123!'), undefined);
    assert.equal(await repository.account(user.userId), undefined);
    step = await request(authorize);
    assert.ok(!step.location?.includes('code='), 'disabled user must not obtain another code');
    for (let i = 0; i < 8; i++) assert.equal(await repository.allowAttempt('test-ip', 'bounded-login'), true);
    await restart(); assert.equal(await repository.allowAttempt('test-ip', 'bounded-login'), false);
    const a = repository.adapter('AuthorizationCode'); await a.upsert('atomic', { jti: 'atomic' }, 60);
    const consumed = await Promise.allSettled([a.consume('atomic'), a.consume('atomic')]);
    assert.equal(consumed.filter(result => result.status === 'fulfilled').length, 1);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await repository.close();
    await db.query('DELETE FROM mx_platform_records WHERE environment=$1', [environment]);
    await db.query('DELETE FROM mx_identity_records WHERE scope=$1', [scope]); await db.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});
