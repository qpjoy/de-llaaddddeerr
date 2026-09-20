import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { recoverState } from './k8s-recovery-state.mjs';
import { RESTORE_KEYS, planAuth, validateDeployEnvironment, secretPatch, validateExtractedOriginals, applyAuthSecrets,
  rolloutPatch, assertRuntimeLayout, assertRuntimeReport, standardRunnerUnit } from './restore-confirmed-mx-auth.mjs';

const NS = 'mx-internal-shadow', DB = 'mx-launcher-db', OPS = 'mx-internal-ops', FEISHU = 'mx-feishu-oauth';
const b64 = value => Buffer.from(value).toString('base64');
const secret = (name, values, live = false) => ({ apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
  metadata: { name, namespace: NS, ...(live ? { uid: `uid-${name}`, resourceVersion: '10' } : {}) },
  data: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, b64(value)])) });
function fixture() {
  const dbValues = { PG_USER: 'mx_internal', PG_PASSWORD: 'fixture-db-password', PG_DB: 'mx_internal_shadow',
    DATABASE_HOST: 'mx-internal-postgres', DATABASE_URL: 'postgres://mx_internal:fixture-db-password@mx-internal-postgres:5432/mx_internal_shadow' };
  const originals = {
    [OPS]: secret(OPS, { token: 'fixture-original-token-' + 'a'.repeat(32) }),
    [FEISHU]: secret(FEISHU, { 'app-id': 'cli_fixture', 'app-secret': 'fixture-feishu-original-secret', 'tenant-keys': 'tenant-fixture' }),
    [DB]: secret(DB, { ...dbValues, DATABASE_HOST: '192.168.224.6', DATABASE_URL: 'postgres://mx_internal:fixture-db-password@192.168.224.6:5432/mx_internal_shadow' })
  };
  const live = { [OPS]: secret(OPS, { token: 'fixture-replacement-token-' + 'b'.repeat(32), 'extra-key': 'keep-this' }, true),
    [FEISHU]: null, [DB]: secret(DB, dbValues, true), 'mx-sdk-service-account-secrets': null };
  return { originals, live, inspected: structuredClone(live), service: { metadata: { uid: 'svc-uid' }, spec: { clusterIP: '192.168.241.51' } } };
}

test('plan restores just the two original auth secrets, preserving the working database Service and extra fields', () => {
  const f = fixture(), before = structuredClone(f);
  const plan = planAuth(f.originals, f.inspected, f.live);
  assert.deepEqual(plan.changes.map(c => c.name), [OPS, FEISHU]);
  assert.equal(plan.desired[OPS].data['extra-key'], f.live[OPS].data['extra-key']);
  assert.deepEqual(plan.desired[DB], f.live[DB]);
  assert.equal(plan.desired['mx-sdk-service-account-secrets'], null);
  assert.deepEqual(f, before);
  validateDeployEnvironment(plan.desired, {}, {}, f.service);
});

test('partial recovery resumes without requiring old generated token or recreating existing Feishu', () => {
  for (const names of [[OPS], [FEISHU], [OPS, FEISHU]]) {
    const f = fixture();
    for (const name of names) f.live[name] = { ...structuredClone(f.originals[name]), metadata: { ...f.originals[name].metadata, uid: `restored-${name}` } };
    const plan = planAuth(f.originals, f.inspected, f.live);
    assert.deepEqual(plan.changes.map(c => c.name), [OPS, FEISHU].filter(name => !names.includes(name)));
    validateDeployEnvironment(plan.desired, {}, {}, f.service);
  }
});

test('missing originals, changed live credentials, replacement resources and database changes stop before mutation', () => {
  for (const mutate of [
    f => { delete f.originals[FEISHU]; }, f => { delete f.originals[FEISHU].data['app-secret']; },
    f => { f.live[OPS].data.token = b64('third-party-new-token'); },
    f => { f.live[OPS].metadata.uid = 'recreated'; }, f => { f.live[OPS].immutable = true; },
    f => { f.live[FEISHU] = secret(FEISHU, { 'app-id': 'another-app' }, true); },
    f => { f.live[DB].data.DATABASE_URL = b64('postgres://other'); },
    f => { f.originals[DB].data.PG_PASSWORD = b64('wrong-old-password'); },
    f => { f.live[DB].metadata.uid = 'different-db-secret'; }
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => planAuth(f.originals, f.inspected, f.live));
  }
});

test('future deploy must retain the restored values, never override them from env or generate an SDK credential', () => {
  const f = fixture(), desired = planAuth(f.originals, f.inspected, f.live).desired;
  for (const [file, shell] of [
    [{ MX_INTERNAL_OPS_TOKEN: 'x'.repeat(40) }, {}], [{}, { MX_FEISHU_APP_ID: 'another-app' }],
    [{ MX_FEISHU_APP_SECRET: '' }, {}], [{ PG_PASSWORD: 'different' }, {}],
    [{ DATABASE_HOST: 'postgres' }, {}], [{ MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON: JSON.stringify({ account: 'x'.repeat(40) }) }, {}]
  ]) assert.throws(() => validateDeployEnvironment(desired, file, shell, f.service));
  validateDeployEnvironment(desired, { MX_INTERNAL_OPS_TOKEN: Buffer.from(desired[OPS].data.token, 'base64').toString() }, {}, f.service);
});

test('patch has UID, version and data preconditions, with credentials absent from command arguments', () => {
  const f = fixture(), change = planAuth(f.originals, f.inspected, f.live).changes[0];
  const patch = secretPatch(change, f.live[OPS]);
  assert.deepEqual(patch.slice(0, 3).map(op => op.path), ['/metadata/uid', '/metadata/resourceVersion', '/data']);
  assert.deepEqual(patch.at(-1).value, change.resource.data);
  assert.throws(() => secretPatch(change, { ...f.live[OPS], metadata: { uid: 'other' } }));
  assert.throws(() => secretPatch(change, { ...f.live[OPS], data: { token: b64('changed') } }));
});

test('partial write failure is resumable and never writes a database/PVC or deletes any resource', () => {
  const f = fixture(), calls = [], patches = new Map();
  let failCreate = true;
  const get = (_kind, name) => f.live[name];
  const kubectl = (args, input) => {
    calls.push(args);
    assert.doesNotMatch(args.join(' '), /fixture-|Zml4dHVyZ|delete|mx-launcher-db|statefulset|persistentvolume/);
    if (args[0] === 'patch') {
      const name = args[2], patch = patches.get(args[args.indexOf('--patch-file') + 1]);
      assert.equal(patch[1].value, f.live[name].metadata.resourceVersion);
      f.live[name].data = patch.at(-1).value;
      return JSON.stringify(f.live[name]);
    }
    assert.equal(args[0], 'create');
    if (failCreate) throw new Error('simulated API failure');
    const object = JSON.parse(input); object.metadata.uid = 'restored-feishu';
    f.live[object.metadata.name] = object; return JSON.stringify(object);
  };
  const helpers = { get, kubectl, log() {}, savePatch: (name, data) => { patches.set(name, data); return name; } };
  assert.throws(() => applyAuthSecrets(planAuth(f.originals, f.inspected, f.live), helpers), /simulated/);
  assert.equal(f.live[OPS].data.token, f.originals[OPS].data.token);
  assert.equal(f.live[FEISHU], null);
  failCreate = false;
  applyAuthSecrets(planAuth(f.originals, f.inspected, f.live), helpers);
  assert.equal(calls.filter(args => args[0] === 'patch').length, 1);
  assert.equal(planAuth(f.originals, f.inspected, f.live).changes.length, 0);
});

test('rollout preserves other annotations and is skipped on an unchanged successful repeat', () => {
  const api = { metadata: { uid: 'api', resourceVersion: '30' }, spec: { replicas: 1, template: { metadata: { annotations: { unrelated: 'retained' } } } } };
  const patch = rolloutPatch(api, 'digest', true, 123);
  assert.equal(patch.at(-1).value.unrelated, 'retained');
  assert.equal(patch[1].value, '30');
  api.spec.template.metadata.annotations = patch.at(-1).value;
  assert.equal(rolloutPatch(api, 'digest', false), null);
  assert.ok(rolloutPatch(api, 'digest', true, 456));
  assert.ok(rolloutPatch(api, 'different', false));
});

function runtimeFixture() {
  const f = fixture();
  const env = Object.entries({ MX_INTERNAL_OPS_TOKEN: [OPS, 'token'], MX_FEISHU_APP_ID: [FEISHU, 'app-id'], MX_FEISHU_APP_SECRET: [FEISHU, 'app-secret'],
    MX_FEISHU_ALLOWED_TENANT_KEYS: [FEISHU, 'tenant-keys'], ...Object.fromEntries(['DATABASE_URL', 'DATABASE_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DB'].map(key => [key, [DB, key]])) })
    .map(([name, [secret, key]]) => ({ name, valueFrom: { secretKeyRef: { name: secret, key } } }));
  const state = { secrets: f.live, api: { metadata: { uid: 'api' }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'internal-api', env }] } } } },
    pg: { metadata: { uid: 'pg' }, spec: { replicas: 1 } }, pod: { metadata: { uid: 'pod', ownerReferences: [{ uid: 'pg' }] },
      spec: { nodeName: 'mx-internal-server', volumes: [{ persistentVolumeClaim: { claimName: 'claim' } }] }, status: { podIP: '10.1.0.3', conditions: [{ type: 'Ready', status: 'True' }] } },
    pv: { metadata: { uid: 'pv', name: 'pv' }, spec: { hostPath: { path: '/var/lib/mx-launcher/k8s/postgres' }, persistentVolumeReclaimPolicy: 'Retain', claimRef: { uid: 'pvc' } }, status: { phase: 'Bound' } },
    pvc: { metadata: { uid: 'pvc', name: 'claim' }, spec: { volumeName: 'pv' }, status: { phase: 'Bound' } }, service: f.service,
    slices: { items: [{ endpoints: [{ targetRef: { uid: 'pod' }, addresses: ['10.1.0.3'], conditions: { ready: true } }] }] },
    config: { data: { INTERNAL_STORE_DRIVER: 'postgres', MX_ENVIRONMENT: 'shadow' } } };
  return { state, saved: structuredClone(state) };
}
test('live layout validates the restored volume, Service, API environment and exact Secret refs', () => {
  const good = runtimeFixture(); assertRuntimeLayout(good.saved, good.state);
  for (const mutate of [s => { s.pv.spec.hostPath.path = '/old'; }, s => { s.pvc.metadata.uid = 'new-pvc'; },
    s => { s.slices.items[0].endpoints[0].addresses = ['10.1.0.9']; }, s => { s.api.spec.replicas = 0; },
    s => { s.api.spec.template.spec.containers[0].env[0].value = 'inline-token'; },
    s => { s.config.data.MX_ENVIRONMENT = 'production'; }, s => { s.pod.status.conditions = []; }]) {
    const { state, saved } = runtimeFixture(); mutate(state); assert.throws(() => assertRuntimeLayout(saved, state));
  }
});

test('checkpoint verification requires loaded originals, Ops acceptance, Feishu enabled and latest business markers', () => {
  const good = { environment_matches: true, store_matches: true, credentials_loaded: true, database_url_matches: true, original_ops_accepted: true, feishu_enabled: true,
    database: { server_address: '10.1.0.3', database: 'mx_internal_shadow', records: [{ environment: 'shadow', has_smh: true, has_sqb: true, smh_has_credential: true, sqb_has_credential: true }] } };
  assertRuntimeReport(good, '10.1.0.3', 'mx_internal_shadow');
  for (const key of Object.keys(good).filter(key => key !== 'database')) assert.throws(() => assertRuntimeReport({ ...good, [key]: false }, '10.1.0.3', 'mx_internal_shadow'));
  assert.throws(() => assertRuntimeReport(good, '10.1.0.4', 'mx_internal_shadow'));
  const old = structuredClone(good); old.database.records[0].has_smh = false;
  assert.throws(() => assertRuntimeReport(old, '10.1.0.3', 'mx_internal_shadow'));
});

test('first checkpoint pins latest bind root and restores identical auth bytes after a missing-Secret incident', () => {
  const f = fixture(), desired = planAuth(f.originals, f.inspected, f.live).desired;
  const directory = mkdtempSync(join(tmpdir(), 'mx-auth-checkpoint-'));
  const identity = { node: 'mx-internal-server', ca: 'fixture-ca', pgSystemId: 'fixture-pg', mounts: [{ path: '/var/lib/mx-launcher', identity: { root: '/k8s/mx-runtime/mx-launcher' } }] };
  const execute = (_command, args, input) => {
    if (args.includes('create')) { const object = JSON.parse(input); desired[object.metadata.name] = object; return '{}'; }
    if (args.includes('nodes')) return JSON.stringify({ items: [{ metadata: { name: identity.node } }] });
    if (args.includes('kube-system')) return JSON.stringify({ metadata: { uid: 'cluster-fixture' } });
    return desired[args[args.indexOf('secret') + 1]] ? JSON.stringify(desired[args[args.indexOf('secret') + 1]]) : '';
  };
  try {
    recoverState('checkpoint', { directory, namespace: NS, identity, execute, log() {} });
    const checkpoint = JSON.parse(readFileSync(join(directory, 'latest.json')));
    assert.equal(checkpoint.identity.mounts[0].identity.root, '/k8s/mx-runtime/mx-launcher');
    delete desired[OPS]; delete desired[FEISHU];
    recoverState('restore', { directory, namespace: NS, identity, execute, log() {} });
    assert.equal(desired[OPS].data.token, f.originals[OPS].data.token);
    assert.deepEqual(desired[FEISHU].data, f.originals[FEISHU].data);
    assert.equal(desired[DB].data.DATABASE_HOST, f.live[DB].data.DATABASE_HOST);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('extracted protobuf maps and persisted JSON compare by content despite null map prototype', () => {
  const vi = value => { const bytes = []; do { const n = value & 127; value >>>= 7; bytes.push(n | (value ? 128 : 0)); } while (value); return Buffer.from(bytes); };
  const bytes = (number, value) => { const b = Buffer.from(value); return Buffer.concat([vi(number * 8 + 2), vi(b.length), b]); };
  const f = fixture(), responses = {};
  for (const [name, object] of Object.entries(f.originals)) {
    const body = Buffer.concat([bytes(1, Buffer.concat([bytes(1, name), bytes(3, NS)])),
      ...Object.entries(object.data).map(([key, value]) => bytes(2, Buffer.concat([bytes(1, key), bytes(2, Buffer.from(value, 'base64'))]))), bytes(3, 'Opaque')]);
    const wrapped = Buffer.concat([Buffer.from('k8s\0'), bytes(1, Buffer.concat([bytes(1, 'v1'), bytes(2, 'Secret')])), bytes(2, body)]);
    responses[name] = { header: { revision: 4 }, count: 1, kvs: [{ key: b64(`/registry/secrets/${NS}/${name}`), value: wrapped.toString('base64') }] };
  }
  validateExtractedOriginals(f.originals, responses);
  f.originals[OPS].data.token = b64('tampered');
  assert.throws(() => validateExtractedOriginals(f.originals, responses));
});

test('native runner recovery accepts only enabled standard units without overrides or hooks', () => {
  const root = '/root/project';
  const props = { LoadState: 'loaded', UnitFileState: 'enabled', WorkingDirectory: root, NeedDaemonReload: 'no' };
  const text = `[Service]\nWorkingDirectory=${root}\nExecStart=/root/.nvm/bin/node server/scripts/internal-service-peer-host-runner.mjs 19190\nEnvironment=MX_INTERNAL_HOST_RUNNER_HOST=0.0.0.0\nEnvironment=MX_INTERNAL_HOST_RUNNER_PORT=19190\nEnvironment=MX_INTERNAL_SERVICE_ARTIFACT_DIR=/private/artifacts\nEnvironment=MX_QP_TUNNEL_CLI_BUNDLE_DIR=/private/bundle\nEnvironment=PATH=/usr/bin:/bin\nRestart=always\n`;
  assert.equal(standardRunnerUnit(text, props, root), true);
  for (const patch of [{ DropInPaths: '/custom.conf' }, { ExecStartPre: 'network-mutation' }, { EnvironmentFiles: '/custom.env' },
    { NeedDaemonReload: 'yes' }, { WorkingDirectory: '/other' }, { UnitFileState: 'disabled' }]) assert.equal(standardRunnerUnit(text, { ...props, ...patch }, root), false);
  assert.equal(standardRunnerUnit(text + 'Environment=MX_INTERNAL_HOST_RUNNER_PORT=12345\n', props, root), false);
  assert.equal(standardRunnerUnit(text.replace('internal-service-peer-host-runner.mjs', 'other.mjs'), props, root), false);
});

test('wrapper syntax and auth completion exclude database/data-plane mutation commands', () => {
  const shell = readFileSync(new URL('./restore-confirmed-mx-auth.sh', import.meta.url), 'utf8');
  assert.equal(spawnSync('bash', ['-n'], { input: shell }).status, 0);
  const source = readFileSync(new URL('./restore-confirmed-mx-auth.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\['(?:delete|scale|replace)'|\['patch', '(?:statefulset|pv|pvc)'|initdb|pg_hba|ALTER ROLE|wg-quick|\['mount'|\['umount'/);
  assert.ok(source.indexOf('assertRuntimeReport(runtime,') < source.indexOf("recoverState('checkpoint'"));
});
