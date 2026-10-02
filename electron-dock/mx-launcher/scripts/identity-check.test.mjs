import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { initializeProfile } from './identity-profile.mjs';
import { identityProbe } from './identity-check.mjs';
import { verifyIdentity } from './identity-deploy.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mx-identity-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'profile.json'); const p = initializeProfile('https://10.88.88.88:18443', file);
  const ca = join(dir, 'ca.crt'); writeFileSync(ca, p.caCert);
  return { file, p, fingerprint: new X509Certificate(p.caCert).fingerprint256, env: {
    MX_ADMIN_SSO_ENABLED: '1', MX_ADMIN_SSO_ORIGIN: p.origin, MX_ADMIN_SSO_ISSUER: p.issuer,
    MX_ADMIN_SSO_CLIENT_ID: p.clientId, MX_ADMIN_SSO_CLIENT_SECRET: p.clientSecret, NODE_EXTRA_CA_CERTS: ca
  } };
}
const good = stage => JSON.stringify({ version: 1, ok: true, stage: stage ?? 'complete', code: 'OK' });
const pods = () => ({ items: [
  { metadata: { name: 'api-terminating', creationTimestamp: '2026-10-03T02:00:00Z', deletionTimestamp: '2026-10-03T02:01:00Z' }, status: { phase: 'Running', containerStatuses: [{ name: 'internal-api', ready: true }] } },
  { metadata: { name: 'api-ready', creationTimestamp: '2026-10-03T02:00:00Z' }, status: { phase: 'Running', containerStatuses: [{ name: 'internal-api', ready: true }] } }
] });

test('probe distinguishes local SSO configuration, external TLS/discovery and HTTPS proxy failures without leaking values', async t => {
  const f = fixture(t); const calls = [];
  const request = async url => {
    calls.push(url);
    return new Response(JSON.stringify(url.includes('openid-configuration') ? { issuer: f.p.issuer } : { enabled: true }));
  };
  const run = (fetcher = request, env = f.env) => identityProbe(f.p.origin, f.fingerprint, { env, fetcher });
  assert.deepEqual(await run(), JSON.parse(good()));
  assert.equal(calls[0], 'http://127.0.0.1:18090/auth/admin/session');
  assert.equal((await run(request, { ...f.env, MX_ADMIN_SSO_ENABLED: '0' })).code, 'CONFIG_DISABLED');
  assert.equal((await run(request, { ...f.env, NODE_EXTRA_CA_CERTS: '/missing/ca.crt' })).code, 'CA_UNREADABLE');
  let result = await run(async () => new Response(JSON.stringify({ enabled: false, unavailable: true })));
  assert.equal(result.stage, 'local-session'); assert.equal(result.code, 'CONFIG_UNAVAILABLE');
  result = await run(async url => {
    if (url.startsWith('https:')) throw Object.assign(new Error(f.p.clientSecret), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: f.p.clientSecret } });
    return request(url);
  });
  assert.equal(result.stage, 'discovery'); assert.equal(result.code, 'UND_ERR_CONNECT_TIMEOUT');
  assert.ok(!JSON.stringify(result).includes(f.p.clientSecret));
  result = await run(async url => url.endsWith('/auth/admin/session') && url.startsWith('https:') ? new Response(f.p.clientSecret, { status: 502 }) : request(url));
  assert.deepEqual(result, { version: 1, ok: false, stage: 'https-session', code: 'HTTP_ERROR', status: 502 });
  // The exact function sent through kubectl must remain executable on its own.
  const standalone = new Function(`return (${identityProbe.toString()})`)();
  assert.deepEqual(await standalone(f.p.origin, f.fingerprint, { env: f.env, fetcher: request }), JSON.parse(good()));
});

test('verification selects a non-terminating ready API Pod and retries only read-only transient checks', async t => {
  const f = fixture(t); const calls = []; let attempts = 0; let waits = 0;
  await verifyIdentity({ file: f.file, log() {}, wait: async () => { waits++; }, execute: args => {
    calls.push(args);
    if (args.includes('get')) return JSON.stringify(pods());
    assert.ok(args.includes('api-ready')); assert.ok(!args.includes('api-terminating'));
    if (++attempts === 1) throw new Error(`transport error containing ${f.p.clientSecret}`);
    return good();
  } });
  assert.equal(attempts, 2); assert.equal(waits, 1);
  assert.ok(calls.every(args => args.includes('get') || args.includes('exec')));
  assert.ok(!JSON.stringify(calls).includes(f.p.clientSecret));
});

test('verification reports a precise permanent stage/code, and cannot accept malformed or sensitive probe output', async t => {
  const f = fixture(t); let attempts = 0;
  const execute = args => {
    if (args.includes('get')) return JSON.stringify(pods());
    attempts++;
    return JSON.stringify({ version: 1, ok: false, stage: 'discovery', code: 'CERT_HAS_EXPIRED' });
  };
  await assert.rejects(verifyIdentity({ file: f.file, execute, log() {}, wait: async () => assert.fail('permanent error must not retry') }), /discovery\/CERT_HAS_EXPIRED/);
  assert.equal(attempts, 1);
  await assert.rejects(verifyIdentity({ file: f.file, execute: args => args.includes('get') ? JSON.stringify(pods()) : f.p.clientSecret,
    log() {}, wait: async () => {} }), error => error.message.includes('KUBECTL_EXEC_FAILED') && !error.message.includes(f.p.clientSecret));
});
