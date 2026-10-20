import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOTS, assertLauncherOnlyChange, assertPayMountOnlyChange, snapshotChecksum, payPatches, check, prepare, reconcile, inspect, inspectLocal, safeDiagnostic } from '../storage-identities.mjs';
import { databaseResources } from '../../../mx-pay/scripts/postgres.mjs';
import { snapshotChecksum as etcdSnapshotChecksum } from '../../etcd/launcher-identity.mjs';

const oldUUID = '45fa3b72-5a59-4d3c-9a57-4f61aee13e5e';
const targetUUID = 'ea7e456d-19db-4f6e-b8b0-02c00f59d066';
const clusterUid = '399f2349-3a34-48f4-8105-d7bae56ca136';
const node = 'mx-internal-server';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const copy = value => structuredClone(value);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mx-identities-'));
  chmodSync(directory, 0o700); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runDirectory = join(directory, 'run'), targetBase = join(directory, 'data');
  mkdirSync(runDirectory, { mode: 0o700 });
  const targets = Object.fromEntries(Object.entries({ launcher: 'launcher', common: 'common', pay: 'pay-postgres' }).map(([name, key]) => [ROOTS[name], `${targetBase}/${key}`]));
  targets['/var/lib/kubelet'] = `${targetBase}/kubelet`; targets['/data/mx-rig'] = `${targetBase}/rig`;
  const mount = (target, device, root) => ({ target, device, root, type: 'xfs' });
  const host = { node, ca: 'a'.repeat(64), pgSystemId: '2330ad022115386a', mounts: [
    { path: '/data', identity: mount('/data', oldUUID, '/') },
    { path: '/data/docker', identity: mount('/data', oldUUID, '/') },
    { path: '/var/lib/containerd', identity: mount('/var/lib/containerd', oldUUID, '/mx-runtime/containerd') },
    { path: '/var/lib/etcd', identity: mount('/var/lib/etcd', targetUUID, '/var/lib/mx-move/etcd-data/existing') },
    { path: ROOTS.launcher, identity: mount(ROOTS.launcher, oldUUID, '/k8s/mx-runtime/mx-launcher') },
    { path: `${ROOTS.launcher}/k8s/postgres/pgdata`, identity: mount(ROOTS.launcher, oldUUID, '/k8s/mx-runtime/mx-launcher') },
  ] };
  const latest = { version: 1, namespace: 'mx-internal-shadow', clusterUid, identity: host,
    secrets: { 'mx-launcher-db': { data: { password: 'do-not-print' } } }, identityProfile: { caKey: 'do-not-print-key', installationId: 'original-id' } };
  latest.checksum = snapshotChecksum(latest);
  const common = { version: 1, mode: 'local', root: ROOTS.common, node, identifier: '7671038612254789664', mountTarget: '/data', filesystemUUID: oldUUID };
  const payHost = { context: 'kubernetes-admin@kubernetes', clusterUID: clusterUid, namespace: 'mx-pay', node, localPath: ROOTS.pay,
    mountTarget: '/data', filesystemUUID: oldUUID, volumeMountRoot: '/mx-pay/mx-pay/postgres' };
  const pay = { ...payHost, phase: 'ready', storageClass: '', image: 'postgres:16-bookworm', installationID: 'b'.repeat(32), systemIdentifier: '7671038612254789670', pvUID: 'pv-uid', pvcUID: 'pvc-uid', pvName: 'mx-pay-postgres-data' };
  const metadata = (name, uid, namespace) => ({ name, uid, resourceVersion: '100', ...(namespace ? { namespace } : {}) });
  const resources = {
    configMap: { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('mx-pay-database', 'cm-uid', 'mx-pay'), data: { identity: JSON.stringify(pay) } },
    statefulSet: { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: metadata('mx-pay-postgres', 'sts-uid', 'mx-pay'), spec: {
      replicas: 1, updateStrategy: { type: 'OnDelete' }, template: { spec: { containers: [{ name: 'postgres',
        command: ['sh', '-ec', `test "$MX_PAY_EXPECTED_MOUNT_ROOT"; pg_controldata; test installation = ${pay.installationID}; test system = ${pay.systemIdentifier}`],
        env: [{ name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' }, { name: 'MX_PAY_EXPECTED_MOUNT_ROOT', value: pay.volumeMountRoot }],
        volumeMounts: [{ name: 'bootstrap', mountPath: '/bootstrap', readOnly: true }],
      }] } } } },
    pv: { kind: 'PersistentVolume', metadata: metadata(pay.pvName, pay.pvUID), spec: { local: { path: ROOTS.pay }, persistentVolumeReclaimPolicy: 'Retain', claimRef: { name: 'mx-pay-postgres-data', namespace: 'mx-pay', uid: pay.pvcUID } }, status: { phase: 'Bound' } },
    pvc: { kind: 'PersistentVolumeClaim', metadata: metadata('mx-pay-postgres-data', pay.pvcUID, 'mx-pay'), spec: { volumeName: pay.pvName }, status: { phase: 'Bound' } },
  };
  resources.statefulSet.spec = databaseResources(pay, { installationID: pay.installationID }).items.find(item => item.kind === 'StatefulSet').spec;
  const paths = Object.fromEntries(['launcherHost', 'launcherLatest', 'common', 'payHost', 'payCheckpoint'].map(name => [name,
    name === 'payCheckpoint' ? join(directory, 'pay/.deploy/database.json') : join(directory, name, 'receipt.json')]));
  const documents = { launcherHost: host, launcherLatest: latest, common, payHost, payCheckpoint: pay };
  for (const [name, file] of Object.entries(paths)) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, json(documents[name]), { mode: 0o600 }); }
  const observation = { launcher: copy(host), common: { identifier: common.identifier, mountTarget: '/data', filesystemUUID: oldUUID, fsroot: '/' },
    pay: { systemIdentifier: pay.systemIdentifier, installationID: pay.installationID, mountTarget: '/data', filesystemUUID: oldUUID, volumeMountRoot: pay.volumeMountRoot, fsroot: '/' } };
  const migrated = copy(observation);
  for (const entry of migrated.launcher.mounts.filter(m => m.path.startsWith(ROOTS.launcher))) entry.identity = mount(ROOTS.launcher, targetUUID, targets[ROOTS.launcher]);
  Object.assign(migrated.common, { mountTarget: ROOTS.common, filesystemUUID: targetUUID, fsroot: targets[ROOTS.common] });
  Object.assign(migrated.pay, { mountTarget: ROOTS.pay, filesystemUUID: targetUUID, volumeMountRoot: targets[ROOTS.pay], fsroot: targets[ROOTS.pay] });
  const options = { runDirectory, targetBase, targets, targetUUID, node, clusterUid, payCheckpointPath: paths.payCheckpoint, paths, ownerUid: process.getuid(), resources, observation };
  return { options, observation, migrated, resources, paths, documents, pay, directory };
}

test('backs up all identities and changes only expected fields while retaining secrets/checksum', t => {
  const f = fixture(t);
  assert.equal(prepare(f.options).files, 5);
  assert.equal(prepare(f.options).phase, 'identities-prepared');
  const result = reconcile({ ...f.options, observation: f.migrated });
  assert.equal(result.files.length, 5);
  const latest = JSON.parse(readFileSync(f.paths.launcherLatest));
  assert.deepEqual(latest.secrets, f.documents.launcherLatest.secrets);
  assert.deepEqual(latest.identityProfile, f.documents.launcherLatest.identityProfile);
  assert.equal(latest.checksum, snapshotChecksum(latest));
  assertLauncherOnlyChange(f.documents.launcherHost, JSON.parse(readFileSync(f.paths.launcherHost)));
  const pay = JSON.parse(readFileSync(f.paths.payCheckpoint));
  assertPayMountOnlyChange(f.pay, pay);
  assert.equal(pay.volumeMountRoot, f.options.targets[ROOTS.pay]);
  const patches = JSON.parse(readFileSync(result.pay_patches_file));
  assert.deepEqual(patches.configMap.patch.slice(0, 2), [{ op: 'test', path: '/metadata/uid', value: 'cm-uid' }, { op: 'test', path: '/metadata/resourceVersion', value: '100' }]);
  assert.equal(patches.statefulSet.patch.at(-1).path, '/spec/template/spec/containers/0/env/1/value');
  assert.deepEqual(reconcile({ ...f.options, observation: f.migrated }).files, []);
});

test('check is read-only and does not require a precreated transaction directory', t => {
  const f = fixture(t); rmSync(f.options.runDirectory, { recursive: true });
  assert.deepEqual(check(f.options), { phase: 'identities-checked', files: 5, writes_performed: false });
  assert.throws(() => readFileSync(join(f.options.runDirectory, 'storage-identities/journal.json')), { code: 'ENOENT' });
});

test('snapshot checksum preserves the existing Launcher payload insertion order', () => {
  const value = { version: 1, namespace: 'mx-internal-shadow', identity: { z: 'last', a: 'first' }, secrets: {}, checksum: 'prior' };
  assert.equal(snapshotChecksum(value), etcdSnapshotChecksum(value));
  assert.notEqual(snapshotChecksum(value), snapshotChecksum({ namespace: value.namespace, version: 1, identity: value.identity, secrets: {} }));
});

test('checks the observed Internal Launcher namespace instead of assuming the product name', t => {
  const f = fixture(t);
  assert.equal(check(f.options).phase, 'identities-checked');
  const wrong = { ...f.documents.launcherLatest, namespace: 'mx-launcher' }; wrong.checksum = snapshotChecksum(wrong);
  writeFileSync(f.paths.launcherLatest, json(wrong), { mode: 0o600 });
  assert.throws(() => check(f.options), /snapshot identity or checksum/);
});

test('target layout refuses a missing or redirected non-identity storage root', t => {
  const f = fixture(t); delete f.options.targets['/var/lib/kubelet'];
  assert.throws(() => check(f.options), /transaction storage targets/);
  f.options.targets['/var/lib/kubelet'] = '/data/other';
  assert.throws(() => check(f.options), /transaction storage targets/);
});

test('resumes interrupted individual file transitions and restores exact original bytes', t => {
  const f = fixture(t), bytes = Object.fromEntries(Object.entries(f.paths).map(([k, p]) => [k, readFileSync(p)]));
  prepare(f.options);
  assert.throws(() => reconcile({ ...f.options, observation: f.migrated, afterReplace(name) { if (name === 'launcherHost') throw new Error('interrupted'); } }), /interrupted/);
  reconcile({ ...f.options, observation: f.migrated });
  assert.equal(inspect({ ...f.options, observation: f.migrated, resources: undefined }, { localOnly: true }).phase, 'identities-local-verified');
  assert.throws(() => reconcile({ ...f.options, observation: f.migrated }, true), /restore original mounts/);
  reconcile(f.options, true);
  for (const [name, file] of Object.entries(f.paths)) assert.deepEqual(readFileSync(file), bytes[name]);
  assert.equal(inspect(f.options, { restore: true, requireApplied: true }).phase, 'identities-verified');
});

test('does not overwrite a concurrent identity update', t => {
  const f = fixture(t); prepare(f.options);
  assert.throws(() => reconcile({ ...f.options, observation: f.migrated, beforeReplace(name) {
    if (name === 'launcherHost') writeFileSync(f.paths.common, json({ ...f.documents.common, identifier: 'changed' }), { mode: 0o600 });
  } }), /changed outside/);
  assert.deepEqual(JSON.parse(readFileSync(f.paths.launcherHost)), f.documents.launcherHost);
});

test('refuses copied journal in different context and corrupt originals', t => {
  const f = fixture(t); prepare(f.options);
  assert.throws(() => prepare({ ...f.options, node: 'other-node' }), /changed migration context/);
  writeFileSync(join(f.options.runDirectory, 'storage-identities/common.original.json'), '{}\n');
  assert.throws(() => reconcile({ ...f.options, observation: f.migrated }), /backup checksum/);
});

for (const field of ['ca', 'pgSystemId', 'node']) test(`rejects Launcher ${field} identity drift`, t => {
  const f = fixture(t); prepare(f.options); f.migrated.launcher[field] = field === 'ca' ? 'c'.repeat(64) : field === 'pgSystemId' ? 'c'.repeat(16) : 'other-node';
  assert.throws(() => reconcile({ ...f.options, observation: f.migrated }), /Launcher.*changed/);
});
for (const mount of ['/var/lib/etcd', '/var/lib/containerd', '/data/docker']) test(`retains unrelated ${mount} mount`, t => {
  const f = fixture(t); prepare(f.options); f.migrated.launcher.mounts.find(m => m.path === mount).identity.root = '/changed';
  assert.throws(() => reconcile({ ...f.options, observation: f.migrated }), /unrelated mount changed/);
});
for (const [component, field] of [['common', 'identifier'], ['pay', 'systemIdentifier'], ['pay', 'installationID']]) test(`rejects ${component} ${field} drift`, t => {
  const f = fixture(t); prepare(f.options); f.migrated[component][field] = 'wrong';
  assert.throws(() => reconcile({ ...f.options, observation: f.migrated }), /database or payment installation changed/);
});

test('rejects destination fallback and unrelated transaction root', t => {
  const f = fixture(t); prepare(f.options);
  f.migrated.common.mountTarget = '/';
  assert.throws(() => reconcile({ ...f.options, observation: f.migrated }), /destination mount/);
  f.migrated.common.mountTarget = ROOTS.common; f.migrated.pay.fsroot = '/var/lib/mx-move/other';
  assert.throws(() => reconcile({ ...f.options, observation: f.migrated }), /destination mount/);
});

test('verify requires completed local and API updates; fresh patches tolerate scale zero and API RV changes', t => {
  const f = fixture(t); prepare(f.options);
  assert.throws(() => inspect({ ...f.options, observation: f.migrated }, { requireApplied: true }), /local storage identity/);
  reconcile({ ...f.options, observation: f.migrated });
  assert.throws(() => inspect({ ...f.options, observation: f.migrated }, { requireApplied: true }), /API mount identities/);
  const fresh = copy(f.resources);
  fresh.statefulSet.spec.replicas = 0; fresh.statefulSet.metadata.resourceVersion = '101'; fresh.configMap.metadata.resourceVersion = '102';
  const options = { ...f.options, observation: f.migrated, resources: fresh };
  const result = inspect(options, { writePatches: true });
  const patches = JSON.parse(readFileSync(result.pay_patches_file));
  assert.equal(patches.statefulSet.patch[1].value, '101');
  assert.equal(patches.configMap.patch[1].value, '102');
  fresh.configMap.data.identity = JSON.stringify(JSON.parse(readFileSync(f.paths.payCheckpoint)));
  fresh.statefulSet.spec.template.spec.containers[0].env[1].value = f.options.targets[ROOTS.pay];
  assert.equal(inspect(options, { requireApplied: true }).phase, 'identities-verified');
});

test('accepts one applied API patch after interruption but refuses replaced objects or database identity', t => {
  const f = fixture(t); prepare(f.options); reconcile({ ...f.options, observation: f.migrated });
  const desired = JSON.parse(readFileSync(f.paths.payCheckpoint)), fresh = copy(f.resources);
  fresh.configMap.data.identity = JSON.stringify(desired);
  const options = { ...f.options, observation: f.migrated, resources: fresh };
  const result = inspect(options, { writePatches: true });
  assert.equal(JSON.parse(readFileSync(result.pay_patches_file)).configMap.patch.length, 0);
  fresh.statefulSet.metadata.uid = 'replacement';
  assert.throws(() => inspect(options, { writePatches: true }), /was replaced/);
  fresh.statefulSet.metadata.uid = 'sts-uid'; fresh.configMap.data.identity = JSON.stringify({ ...desired, installationID: 'f'.repeat(32) });
  assert.throws(() => inspect(options, { writePatches: true }), /changed outside/);
});

test('supports StatefulSet-first partial API update and generates reverse CAS patches after restoring original mounts', t => {
  const f = fixture(t); prepare(f.options); reconcile({ ...f.options, observation: f.migrated });
  const fresh = copy(f.resources);
  fresh.statefulSet.spec.template.spec.containers[0].env[1].value = f.options.targets[ROOTS.pay];
  const result = inspect({ ...f.options, observation: f.migrated, resources: fresh }, { writePatches: true });
  const forward = JSON.parse(readFileSync(result.pay_patches_file));
  assert.equal(forward.statefulSet.patch.length, 0);
  assert.ok(forward.configMap.patch.length);
  fresh.configMap.data.identity = JSON.stringify(JSON.parse(readFileSync(f.paths.payCheckpoint)));
  reconcile({ ...f.options, resources: fresh }, true);
  const reverse = JSON.parse(readFileSync(result.pay_patches_file));
  assert.equal(JSON.parse(reverse.configMap.patch.at(-1).value).volumeMountRoot, f.pay.volumeMountRoot);
  assert.equal(reverse.statefulSet.patch.at(-1).value, f.pay.volumeMountRoot);
});

test('refuses changed workload command and credential mount despite matching database IDs', t => {
  const f = fixture(t); prepare(f.options);
  f.resources.statefulSet.spec.template.spec.containers[0].command[2] += '; unexpected-command';
  assert.throws(() => reconcile({ ...f.options, observation: f.migrated }), /workload or non-identity/);
});

test('rejects PV replacement, missing binding and recovery checksum corruption before backup', t => {
  const f = fixture(t);
  f.resources.pv.metadata.uid = 'replacement';
  assert.throws(() => prepare(f.options), /PV\/PVC binding/);
  f.resources.pv.metadata.uid = 'pv-uid';
  writeFileSync(f.paths.launcherLatest, json({ ...f.documents.launcherLatest, checksum: 'bad' }), { mode: 0o600 });
  assert.throws(() => prepare(f.options), /snapshot identity or checksum/);
});

test('rejects identity symlinks and public files/directories', t => {
  const f = fixture(t);
  chmodSync(f.paths.payCheckpoint, 0o644);
  assert.throws(() => prepare(f.options), /private regular file/);
  chmodSync(f.paths.payCheckpoint, 0o600); chmodSync(dirname(f.paths.payCheckpoint), 0o755);
  assert.throws(() => prepare(f.options), /private and owned/);
  chmodSync(dirname(f.paths.payCheckpoint), 0o700); unlinkSync(f.paths.payCheckpoint); symlinkSync(f.paths.payHost, f.paths.payCheckpoint);
  assert.throws(() => prepare(f.options));
});

test('retains the existing common 0755 parent through check, migration and restore', t => {
  const f = fixture(t), directory = dirname(f.paths.common);
  chmodSync(directory, 0o755);
  const original = Object.fromEntries(Object.entries(f.paths).map(([name, path]) => [name, readFileSync(path)]));
  assert.equal(check(f.options).phase, 'identities-checked');
  assert.equal(prepare(f.options).phase, 'identities-prepared');
  assert.equal(reconcile({ ...f.options, observation: f.migrated }).phase, 'identities-updated');
  assert.equal(lstatSync(directory).mode & 0o777, 0o755);
  assert.equal(lstatSync(f.paths.common).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.paths.common).nlink, 1);
  assert.equal(reconcile(f.options, true).phase, 'identities-restored');
  for (const [name, path] of Object.entries(f.paths)) assert.deepEqual(readFileSync(path), original[name]);
  assert.equal(lstatSync(directory).mode & 0o777, 0o755);
});

test('common parent still rejects group or other writers and symbolic links', t => {
  const f = fixture(t), directory = dirname(f.paths.common);
  for (const mode of [0o775, 0o757, 0o777]) {
    chmodSync(directory, mode);
    assert.throws(() => check(f.options), /mx-common identity directory must be owned/);
  }
  chmodSync(directory, 0o755);
  const moved = `${directory}-original`;
  renameSync(directory, moved); symlinkSync(moved, directory);
  assert.throws(() => check(f.options), /mx-common identity directory must be owned/);
});

test('common receipt stays private, single-linked and non-symbolic under a 0755 parent', t => {
  const f = fixture(t), file = f.paths.common;
  chmodSync(dirname(file), 0o755); chmodSync(file, 0o644);
  assert.throws(() => check(f.options), /private regular file/);
  chmodSync(file, 0o600);
  const alias = `${file}.alias`;
  linkSync(file, alias);
  assert.throws(() => check(f.options), /private regular file/);
  unlinkSync(alias);
  assert.equal(check(f.options).phase, 'identities-checked');
  renameSync(file, alias); symlinkSync(alias, file);
  assert.throws(() => check(f.options));
});

test('0755 allowance never applies to Launcher or Pay identity parents', t => {
  const f = fixture(t);
  for (const name of ['launcherHost', 'launcherLatest', 'payHost', 'payCheckpoint']) {
    const directory = dirname(f.paths[name]);
    chmodSync(directory, 0o755);
    assert.throws(() => check(f.options), /private and owned/);
    chmodSync(directory, 0o700);
  }
});

test('patch builder never modifies replicas, commands, database IDs, credentials, PVCs or PVs', t => {
  const f = fixture(t), desired = { ...f.pay, mountTarget: ROOTS.pay, filesystemUUID: targetUUID, volumeMountRoot: f.options.targets[ROOTS.pay] };
  const result = payPatches(f.resources, f.pay, desired, f.options);
  assert.deepEqual(result.configMap.patch.filter(p => p.op === 'replace').map(p => p.path), ['/data/identity']);
  assert.deepEqual(result.statefulSet.patch.filter(p => p.op === 'replace').map(p => p.path), ['/spec/template/spec/containers/0/env/1/value']);
  assertPayMountOnlyChange(f.pay, JSON.parse(result.configMap.patch.at(-1).value));
});

test('unknown init containers and custom startup commands are refused before backup', t => {
  const f = fixture(t);
  f.resources.statefulSet.spec.template.spec.initContainers = [{ name: 'unknown', image: 'busybox' }];
  assert.throws(() => prepare(f.options), /without init containers/);
  delete f.resources.statefulSet.spec.template.spec.initContainers;
  f.resources.statefulSet.spec.template.spec.containers[0].command[2] += '; extra';
  assert.throws(() => prepare(f.options), /command or image changed/);
});

function diagnosticFor(operation) {
  let failure;
  try { operation(); } catch (error) { failure = error; }
  assert.ok(failure, 'the rejected operation must still throw');
  return safeDiagnostic(failure);
}

test('missing retained file has a fixed diagnostic without its filesystem path', t => {
  const f = fixture(t);
  unlinkSync(f.paths.payCheckpoint);
  const detail = diagnosticFor(() => check(f.options));
  assert.deepEqual(detail, { schema_version: 1, stage: 'source-file', subject: 'payCheckpoint', reason: 'missing_path', rule: '' });
  assert.ok(!JSON.stringify(detail).includes(f.directory));
});

test('private file permission guard retains its decision and exposes only its fixed rule', t => {
  const f = fixture(t);
  chmodSync(f.paths.payCheckpoint, 0o644);
  const detail = diagnosticFor(() => check(f.options));
  assert.deepEqual(detail, { schema_version: 1, stage: 'source-file', subject: 'payCheckpoint', reason: 'guard_rejected',
    rule: createHash('sha256').update('identity file must be a private regular file').digest('hex').slice(0, 12) });
  assert.ok(!JSON.stringify(detail).includes(f.directory));
});

test('malformed private JSON does not expose contents or hash the parser message', t => {
  const f = fixture(t);
  writeFileSync(f.paths.launcherLatest, '{"credential":"do-not-print-secret",INVALID', { mode: 0o600 });
  const detail = diagnosticFor(() => check(f.options));
  assert.deepEqual(detail, { schema_version: 1, stage: 'source-file', subject: 'launcherLatest', reason: 'invalid_json',
    rule: createHash('sha256').update('invalid private identity JSON; values omitted').digest('hex').slice(0, 12) });
  assert.ok(!JSON.stringify(detail).includes('do-not-print'));
});

test('Launcher mismatch identifies its guard without exposing identity or credentials', t => {
  const f = fixture(t);
  f.observation.launcher.ca = 'f'.repeat(64);
  const detail = diagnosticFor(() => check(f.options));
  assert.deepEqual(detail, { schema_version: 1, stage: 'validation', subject: 'launcherHost', reason: 'guard_rejected',
    rule: createHash('sha256').update('Launcher host identity does not match original storage').digest('hex').slice(0, 12) });
  assert.ok(!JSON.stringify(detail).includes('do-not-print'));
  assert.ok(!JSON.stringify(detail).includes(f.observation.launcher.ca));
});

test('unknown errors cannot inject a diagnostic or derive a rule from private text', () => {
  for (const failure of [new Error('credential=do-not-print'), new TypeError('private=value'), null, 'do-not-print']) {
    if (failure && typeof failure === 'object') Object.assign(failure, { stage: 'private-stage', subject: 'private-subject', reason: 'private-reason', rule: 'private-rule' });
    assert.deepEqual(safeDiagnostic(failure), { schema_version: 1, stage: 'operation', subject: 'none', reason: 'unexpected_error', rule: '' });
  }
});

test('diagnostics remain safe when an imported exception has hostile accessors', () => {
  const failure = new Proxy({}, { get() { throw new Error('do-not-print'); }, getPrototypeOf() { throw new Error('do-not-print'); } });
  assert.deepEqual(safeDiagnostic(failure), { schema_version: 1, stage: 'operation', subject: 'none', reason: 'unexpected_error', rule: '' });
});

test('OS error codes map to fixed reasons without echoing private file names', () => {
  for (const [code, reason] of [['ENOENT', 'missing_path'], ['EACCES', 'permission_denied'], ['EPERM', 'permission_denied'],
    ['ELOOP', 'symlink_or_not_directory'], ['ENOTDIR', 'symlink_or_not_directory'], ['EIO', 'io_error'], ['PRIVATE_SECRET', 'unexpected_error']]) {
    const detail = safeDiagnostic(Object.assign(new Error('do-not-print'), { code, path: '/private/secret' }));
    assert.deepEqual(detail, { schema_version: 1, stage: 'operation', subject: 'none', reason, rule: '' });
  }
});

test('local inspection command failures report the product and never command output', () => {
  const detail = diagnosticFor(() => inspectLocal(node, () => { throw new Error('command output credential=do-not-print'); }));
  assert.deepEqual(detail, { schema_version: 1, stage: 'local-observation', subject: 'common', reason: 'command_failed', rule: '' });
});

test('CLI failure emits only a single machine diagnostic and no error stack', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../storage-identities.mjs', import.meta.url)), 'private-secret-action'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const lines = result.stderr.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('MX_MOVE_IDENTITY_DIAGNOSTIC='));
  const detail = JSON.parse(lines[0].slice('MX_MOVE_IDENTITY_DIAGNOSTIC='.length));
  assert.equal(detail.stage, 'request');
  assert.equal(detail.subject, 'request');
  assert.equal(detail.reason, 'guard_rejected');
  assert.match(detail.rule, /^[a-f0-9]{12}$/);
  assert.ok(!result.stderr.includes('private-secret'));
});
