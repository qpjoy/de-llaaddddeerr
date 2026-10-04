import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:https';
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
const browserModule = process.env.MX_SSO_BROWSER_MODULE;
test('browser Feishu navigation: cross-origin authorization, account switching, binding and no-JavaScript fallback', {
  skip: !databaseUrl || !browserModule, timeout: 90000
}, async t => {
  const target = new URL(databaseUrl!);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname.includes('sso_test'));
  const environment = `feishu-browser-${randomUUID()}`;
  const db = createPlatformDataSource({ ...loadConfig(), databaseUrl: databaseUrl!, environment, storeDriver: 'postgres' });
  const repository = new IdentityRepository(databaseUrl!, environment, environment, 'fixture-rate');
  const directory = mkdtempSync(join(tmpdir(), 'mx-feishu-browser-'));
  const servers: Server[] = [];
  const { chromium } = await import(browserModule!);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => {
    await browser.close();
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
    await repository.close();
    if (db.isInitialized) {
      await db.query('DELETE FROM mx_platform_records WHERE environment=$1', [environment]);
      await db.query('DELETE FROM mx_identity_records WHERE scope=$1', [environment]);
      await db.destroy();
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await db.initialize(); await db.runMigrations(); await repository.initialize();
  const memory = new MemoryStore(loadConfig());
  const password = 'ExistingPassword123!';
  const original = memory.createUserCenterUser({ account: 'OriginalUser', password, roleIds: ['mx-admin'] });
  const linked = memory.createUserCenterUser({ account: 'FeishuUser', password, externalIds: { feishuSubject: 'fixture:internal-user' } });
  for (const user of [original, linked]) for (const [kind, data] of [
    ['iam-user', user], ['iam-user-credential', createUserCenterUserCredential(user.userId, password)]
  ] as const) await db.query('INSERT INTO mx_platform_records(kind,id,environment,data) VALUES($1,$2,$3,$4)', [kind, user.userId, environment, data]);
  const before = await db.query('SELECT kind,id,data FROM mx_platform_records WHERE environment=$1 ORDER BY kind,id', [environment]);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', join(directory, 'key'), '-out', join(directory, 'cert')], { stdio: 'ignore' });
  const tls = { cert: readFileSync(join(directory, 'cert')), key: readFileSync(join(directory, 'key')) };
  const listen = async (server: Server) => {
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  let identity: ReturnType<typeof createIdentityProvider>;
  const authOrigin = await listen(createServer(tls, (req, res) => { void identity.handle(req, res); }));
  const appOrigin = await listen(createServer(tls, async (req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
    const code = new URL(req.url!, 'https://localhost').searchParams.get('code');
    const authorization = code ? await identity.provider.AuthorizationCode.find(code) : undefined;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<title>应用回调验收</title><h1>${authorization?.accountId ?? 'missing-code'}</h1>`);
  }));
  const authorizations = new Map<string, string>();
  let providerVisits = 0, exchanges = 0;
  const feishuOrigin = await listen(createServer(tls, (req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
    providerVisits++;
    const url = new URL(req.url!, 'https://localhost');
    assert.equal(req.method, 'GET', 'credentials/form bodies must never be forwarded to Feishu');
    assert.equal(req.headers.referer, undefined);
    const state = url.searchParams.get('state')!;
    assert.ok(authorizations.has(state));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<title>飞书授权验收</title><h1>飞书授权（测试）</h1><a href="${authOrigin}/identity/feishu/callback?state=${state}&amp;code=${state}">确认授权</a>`);
  }));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  identity = createIdentityProvider({ origin: authOrigin, issuer: `${authOrigin}/identity`, adminOrigin: appOrigin,
    clientId: 'launcher', clientSecret: 'fixture-secret', cookieKeys: ['fixture-cookie-key'],
    applications: [{ clientId: 'hub', clientSecret: 'hub-secret', origin: appOrigin, appId: 'mx-insight-hub', audience: 'hub' }],
    jwks: { keys: [{ ...pair.privateKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' }] }
  }, repository, name => repository.adapter(name), {
    policy: async () => ({ mode: 'closed', version: 1 }),
    register: async () => { throw new Error('Registration is not used'); },
    feishu: async (action, input) => {
      if (action === 'info') return { enabled: true };
      if (action === 'authorize') {
        authorizations.set(String(input.state), String(input.codeChallenge));
        return { authorizationUrl: `${feishuOrigin}/authorize?state=${input.state}`, exchangeHandle: 'fixture-handle' };
      }
      if (action === 'exchange') {
        assert.equal(input.exchangeHandle, 'fixture-handle');
        assert.equal(createHash('sha256').update(String(input.verifier)).digest('base64url'), authorizations.get(String(input.code)));
        exchanges++;
        return { subject: 'fixture:internal-user', userId: linked.userId };
      }
      throw new Error('Binding must still require verification of an MX account');
    }
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [], policies: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  page.on('console', (message: { type(): string; text(): string }) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', (response: { headers(): Record<string, string> }) => { const csp = response.headers()['content-security-policy']; if (csp) policies.push(csp); });
  await context.route('**/favicon.ico', (route: { fulfill(options: object): Promise<void> }) => route.fulfill({ status: 204 }));
  const authorize = (client: string, prompt = 'login') => `${authOrigin}/identity/auth?${new URLSearchParams({
    client_id: client, redirect_uri: `${appOrigin}${client === 'launcher' ? '/auth/admin/callback' : '/auth/sso/callback'}`,
    response_type: 'code', scope: 'openid', state: randomUUID(), nonce: randomUUID(), prompt,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update('a'.repeat(43)).digest('base64url')
  })}`;
  for (const client of ['launcher', 'hub']) {
    await page.goto(authorize(client));
    await page.getByLabel('账号', { exact: true }).fill(original.account);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录并继续' }).click();
    await page.getByRole('heading', { name: original.userId, exact: true }).waitFor();
    await page.goto(authorize(client, 'select_account'));
    await page.getByRole('heading', { name: '选择账号', exact: true }).waitFor();
    await page.getByRole('link', { name: '使用其他账号' }).click();
    // Autofill must not turn the external authorization into a credential submission.
    await page.getByLabel('账号', { exact: true }).fill('must-stay-at-auth');
    await page.getByLabel('密码', { exact: true }).fill('must-not-reach-feishu');
    await page.getByRole('button', { name: '使用飞书登录', exact: true }).click();
    await page.getByRole('heading', { name: '飞书授权（测试）' }).waitFor().catch(() => assert.fail(`Feishu navigation blocked: ${errors.join('\n')}`));
    assert.equal(new URL(page.url()).origin, feishuOrigin);
    await page.getByRole('link', { name: '确认授权' }).click();
    await page.getByRole('heading', { name: linked.userId, exact: true }).waitFor();
  }
  // Explicit linking reaches the same external origin but does not silently sign in.
  await page.goto(authorize('launcher', 'select_account'));
  await page.getByRole('link', { name: '使用其他账号' }).click();
  await page.getByText('绑定已有账号', { exact: true }).click();
  await page.getByRole('button', { name: '绑定飞书到已有 MX 账号' }).click();
  await page.getByRole('heading', { name: '飞书授权（测试）' }).waitFor();
  await page.getByRole('link', { name: '确认授权' }).click();
  await page.getByRole('heading', { name: '绑定你的 MX 账号' }).waitFor();
  assert.equal(new URL(page.url()).origin, authOrigin);

  const manual = await browser.newContext({ ignoreHTTPSErrors: true, javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const fallback = await manual.newPage();
  await fallback.goto(authorize('launcher'));
  await fallback.getByRole('button', { name: '使用飞书登录', exact: true }).click();
  await fallback.getByRole('link', { name: '继续前往飞书' }).waitFor();
  await fallback.screenshot({ path: join(tmpdir(), 'mx-feishu-handoff-mobile.png'), fullPage: true });
  await fallback.getByRole('link', { name: '继续前往飞书' }).click();
  await fallback.getByRole('heading', { name: '飞书授权（测试）' }).waitFor();
  await fallback.getByRole('link', { name: '确认授权' }).click();
  await fallback.getByRole('heading', { name: linked.userId, exact: true }).waitFor();
  assert.equal(providerVisits, 4); assert.equal(exchanges, 4);
  assert.deepEqual(errors, []);
  assert.ok(policies.length);
  for (const csp of policies) {
    assert.equal(csp.split(';').map(part => part.trim()).find(part => part.startsWith('form-action ')), `form-action 'self' ${appOrigin}`);
    assert.ok(!csp.includes(feishuOrigin) && !/script-src[^;]*unsafe-inline/.test(csp));
  }
  assert.deepEqual(await db.query('SELECT kind,id,data FROM mx_platform_records WHERE environment=$1 ORDER BY kind,id', [environment]), before);
});
