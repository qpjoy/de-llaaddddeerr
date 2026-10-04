import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProfile, readProfile, savePrivate } from './identity-profile.mjs';
import { createPublicEntry } from './identity-public-profile.mjs';
import { resources } from './identity-deploy.mjs';
import { identityConsoleOverview, validateIdentityApplication, saveIdentityApplication } from './identity-console.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mx-identity-console-')), file = join(dir, 'profile.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = initializeProfile('https://10.88.88.88:18443', file);
  const profile = { ...p, publicEntry: createPublicEntry({ origin: 'https://auth.example.test', adminOrigin: 'https://launcher.example.test', hubOrigin: 'https://hub.example.test', audience: 'hub', privateOrigin: p.origin }) };
  savePrivate(file, profile);
  return { dir, file, profile };
}
function runtime(profile, { ready = true, annotated = true } = {}) {
  const { runtime: secret, deployment, publicDeployment } = resources(profile, 'fixture-revision');
  const deployments = [deployment, publicDeployment].filter(Boolean), pods = [];
  for (const item of deployments) {
    item.metadata.generation = 3;
    item.status = { observedGeneration: 3, replicas: 1, updatedReplicas: ready ? 1 : 0, availableReplicas: ready ? 1 : 0 };
    if (!annotated) delete item.spec.template.metadata.annotations['mx.qpjoy.com/identity-config-digest'];
    pods.push({ metadata: item.spec.template.metadata, status: { conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ state: { running: { startedAt: '2026-10-04T00:00:00Z' } } }] } });
  }
  // Kubernetes does not preserve the insertion order of Secret data keys.
  secret.data = Object.fromEntries(Object.entries(secret.data).reverse());
  return { secret, deployments, pods };
}
const input = { entry: 'public', appId: 'mx-pay', displayName: 'MX Pay', origin: 'https://pay.example.test', audience: 'pay' };

test('console adds a client idempotently, preserves old identities and redacts every secret', async t => {
  const f = fixture(t), live = runtime(f.profile);
  const overview = () => identityConsoleOverview({ file: f.file, readRuntime: async () => live });
  const before = await overview();
  assert.ok(before.entries.every(entry => entry.apps.every(app => app.status === 'active')));
  const request = { ...input, revision: before.revision };
  const preview = validateIdentityApplication(readProfile(f.file), request);
  assert.equal(preview.callbackUrl, `${input.origin}/auth/sso/callback`);
  const saved = saveIdentityApplication(request, { file: f.file });
  const updated = readProfile(f.file), snapshot = readFileSync(f.file, 'utf8');
  assert.deepEqual({ ...updated, publicEntry: undefined }, { ...f.profile, publicEntry: undefined });
  assert.deepEqual({ ...updated.publicEntry, applications: undefined }, { ...f.profile.publicEntry, applications: undefined });
  assert.deepEqual(updated.publicEntry.applications[0], f.profile.publicEntry.applications[0]);
  const consumerPath = join(f.dir, 'applications/public/mx-pay.json'), consumer = readFileSync(consumerPath, 'utf8');
  assert.equal(statSync(consumerPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.dir, 'console-changes.json')).mode & 0o777, 0o600);
  assert.equal(saveIdentityApplication(request, { file: f.file }).repeated, true);
  assert.equal(readFileSync(consumerPath, 'utf8'), consumer);
  assert.equal(readFileSync(f.file, 'utf8'), snapshot);
  assert.throws(() => saveIdentityApplication({ ...request, origin: 'https://other.example.test' }, { file: f.file }), /配置已变化/);
  assert.throws(() => saveIdentityApplication({ ...request, revision: saved.revision }, { file: f.file }), /已经登记/);
  assert.throws(() => saveIdentityApplication({ ...request, file: '/tmp/arbitrary' }, { file: f.file }), /不支持的字段/);
  const pending = await overview(), pay = pending.entries.find(entry => entry.entry === 'public').apps.at(-1);
  assert.equal(pay.status, 'pending'); assert.equal(pay.publishedAt, null); assert.equal(pay.consumerFile, consumerPath);
  const exposed = JSON.stringify(pending);
  for (const secret of [updated.clientSecret, ...updated.cookieKeys, updated.publicEntry.clientSecret, updated.publicEntry.applications.at(-1).clientSecret, JSON.parse(consumer).sessionKey, updated.tlsKey, updated.jwks.keys[0].d]) assert.ok(!exposed.includes(secret));
  const loaded = await identityConsoleOverview({ file: f.file, readRuntime: async () => runtime(updated) });
  assert.equal(loaded.entries.find(entry => entry.entry === 'public').apps.at(-1).status, 'active');
  assert.equal(loaded.entries.find(entry => entry.entry === 'public').apps.at(-1).publishedAt, '2026-10-04T00:00:00Z');
});

test('interrupted save recovers with the original revision without rotating credentials', async t => {
  const f = fixture(t), revision = (await identityConsoleOverview({ file: f.file, readRuntime: async () => null })).revision;
  const request = { ...input, revision }; saveIdentityApplication(request, { file: f.file });
  const snapshot = readFileSync(f.file, 'utf8'), historyPath = join(f.dir, 'console-changes.json');
  const history = JSON.parse(readFileSync(historyPath)); history[0].phase = 'saving'; history[0].savedAt = null;
  savePrivate(historyPath, history); rmSync(join(f.dir, 'applications/public/mx-pay.json'));
  assert.equal(saveIdentityApplication(request, { file: f.file }).repeated, true);
  const consumer = JSON.parse(readFileSync(join(f.dir, 'applications/public/mx-pay.json')));
  assert.equal(consumer.clientSecret, readProfile(f.file).publicEntry.applications.at(-1).clientSecret);
  assert.equal(readFileSync(f.file, 'utf8'), snapshot);
  assert.equal(JSON.parse(readFileSync(historyPath))[0].phase, 'saved');
});

test('runtime failures, old releases and unfinished rollout never claim active publication', async t => {
  const f = fixture(t);
  for (const options of [{ ready: false }, { annotated: false }]) {
    const result = await identityConsoleOverview({ file: f.file, readRuntime: async () => runtime(f.profile, options) });
    assert.ok(result.entries.every(entry => entry.apps.every(app => app.status === 'unverified' && app.publishedAt === null)));
  }
  const unknown = await identityConsoleOverview({ file: f.file, readRuntime: async () => { throw new Error('unreachable'); } });
  assert.ok(unknown.entries.every(entry => entry.apps.every(app => app.status === 'unknown')));
  assert.deepEqual((await identityConsoleOverview({ file: join(f.dir, 'absent.json') })).entries, []);
});

test('registration refuses arbitrary URLs, raw CSP, path injection and existing clients; private entry stays separate', async t => {
  const f = fixture(t);
  for (const bad of [
    { origin: 'http://pay.example.test' }, { origin: 'https://*.example.test' }, { origin: 'https://pay.example.test/path' },
    { origin: 'https://pay.example.test:443' }, { origin: 'https://user:pass@pay.example.test' }, { origin: f.profile.publicEntry.origin },
    { appId: '../elsewhere' }, { appId: 123 }, { appId: 'mx-h2i' }, { appId: 'mx-launcher' }, { appId: 'mx-insight-hub' },
    { displayName: '\n' }, { audience: '' }, { formAction: '*' }, { entry: 'invalid' }
  ]) assert.throws(() => validateIdentityApplication(f.profile, { ...input, ...bad }), JSON.stringify(bad));
  const revision = (await identityConsoleOverview({ file: f.file, readRuntime: async () => runtime(f.profile) })).revision;
  const privateInput = { ...input, entry: 'private', origin: 'https://10.88.88.90:19443', revision };
  saveIdentityApplication(privateInput, { file: f.file });
  assert.deepEqual(readProfile(f.file).publicEntry, f.profile.publicEntry);
  const consumer = JSON.parse(readFileSync(join(f.dir, 'applications/private/mx-pay.json')));
  assert.equal(consumer.issuer, f.profile.issuer); assert.equal(consumer.caCert, f.profile.caCert);
  assert.throws(() => saveIdentityApplication({ ...input, revision }, { file: f.file }), /配置已变化/);
});
