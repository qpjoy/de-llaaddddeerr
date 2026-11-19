import 'reflect-metadata';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import test from 'node:test';
import type { IdentityRepository } from './repository.js';
import { adminProxyTimeout, createIdentityServer } from './server.js';

test('only exact artifact POST endpoints receive the OSS response timeout', () => {
  for (const path of ['/internal/v1/release-artifacts', '/admin-api/internal/v1/release-artifacts']) {
    assert.equal(adminProxyTimeout('POST', path), 900_000);
    for (const method of ['GET', 'PUT', 'DELETE', undefined]) assert.equal(adminProxyTimeout(method, path), 30_000);
    for (const suffix of ['/', '/artifact/download', '-other']) assert.equal(adminProxyTimeout('POST', path + suffix), 30_000);
  }
  for (const path of ['/identity/token', '/auth/admin/callback', '/admin-api/internal/v1/release-management/plans', '/admin-api/internal/v1/launcher-network/leases']) {
    assert.equal(adminProxyTimeout('POST', path), 30_000);
  }
});

test('public artifact proxy waits for OSS while retaining normal timeout and ingress guards', { timeout: 45_000 }, async t => {
  const received: Array<{ path: string; headers: Record<string, unknown>; body: string }> = [];
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ path: req.url!, headers: req.headers, body });
      // Internal has received the bytes but is still uploading them to OSS.
      const timer = setTimeout(() => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ artifact: { fileName: 'MinCave.dmg', sizeBytes: Buffer.byteLength(body) } }));
      }, 31_500);
      res.once('close', () => clearTimeout(timer));
    });
  });
  await listen(upstream);
  const settings = {
    origin: 'https://auth.example.test', adminOrigin: 'https://launcher.example.test',
    issuer: 'https://auth.example.test/identity', clientId: 'mx-launcher-public-admin',
    clientSecret: 's'.repeat(43), ingressToken: 'g'.repeat(43), cookieKeys: ['a'.repeat(43), 'b'.repeat(43)],
    jwks: { keys: [{ ...generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' }), kid: 'proxy-test', alg: 'RS256', use: 'sig' }] }
  };
  const repository = { adapter: () => { throw new Error('proxy must not access identity storage'); } } as unknown as IdentityRepository;
  const server = createIdentityServer({ settings, repository, cert: Buffer.alloc(0), key: Buffer.alloc(0), upstream: new URL(`http://127.0.0.1:${port(upstream)}`) });
  await listen(server);
  t.after(async () => {
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([close(server), close(upstream)]);
  });
  assert.equal(server.requestTimeout, 30_000);
  assert.equal(server.headersTimeout, 10_000);
  const call = (path: string, headers: Record<string, string> = {}, body = '') => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: port(server), method: 'POST', path, headers: {
      host: 'launcher.example.test', 'x-mx-identity-gateway': settings.ingressToken, 'x-mx-client-ip': '198.51.100.9',
      'content-type': 'application/octet-stream', 'content-length': String(Buffer.byteLength(body)), ...headers
    } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, text }));
    });
    req.on('error', reject); req.end(body);
  });
  const path = '/admin-api/internal/v1/release-artifacts?kind=app-installer&fileName=MinCave.dmg';
  assert.equal((await call(path, { 'x-mx-identity-gateway': 'wrong' })).status, 403);
  assert.equal((await call(path, { 'x-mx-client-ip': 'invalid' })).status, 403);
  assert.equal((await call(path, { host: 'wrong.example.test' })).status, 421);
  assert.equal((await call(path, { host: 'auth.example.test' })).status, 404);
  assert.equal((await call('/internal/v1/release-artifacts')).status, 404);
  assert.equal(received.length, 0);

  const [uploaded, normal] = await Promise.all([
    call(path, { 'x-mx-ops-token': 'must-not-forward', authorization: 'Bearer must-not-forward',
      cookie: 'mx-admin-session=fixture', 'x-mx-admin-csrf': 'fixture-csrf' }, 'installer bytes'),
    call('/auth/admin/session')
  ]);
  assert.equal(uploaded.status, 201, uploaded.text);
  assert.deepEqual(JSON.parse(uploaded.text), { artifact: { fileName: 'MinCave.dmg', sizeBytes: 15 } });
  assert.equal(normal.status, 502);
  const artifactRequest = received.find(item => item.path === path)!;
  assert.equal(artifactRequest.body, 'installer bytes');
  assert.equal(artifactRequest.headers.host, 'launcher.example.test');
  assert.equal(artifactRequest.headers['x-mx-ops-token'], undefined);
  assert.equal(artifactRequest.headers.authorization, undefined);
  assert.equal(artifactRequest.headers.cookie, 'mx-admin-session=fixture');
  assert.equal(artifactRequest.headers['x-mx-admin-csrf'], 'fixture-csrf');
});

function port(server: Server): number { return (server.address() as { port: number }).port; }
async function listen(server: Server): Promise<void> { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); }
async function close(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
