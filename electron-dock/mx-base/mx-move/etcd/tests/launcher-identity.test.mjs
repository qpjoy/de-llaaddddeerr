import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertEtcdOnlyChange, prepare, reconcile, snapshotChecksum } from '../launcher-identity.mjs';

const originalIdentity = () => ({ node: 'internal', ca: 'original-ca', pgSystemId: 'original-pg', mounts: [
  { path: '/var/lib/etcd', identity: { target: '/var/lib/etcd', device: 'two-tb', root: '/etcd', type: 'xfs' } },
  { path: '/var/lib/mx-launcher', identity: { target: '/var/lib/mx-launcher', device: 'two-tb', root: '/launcher', type: 'xfs' } }
] });
const movedIdentity = () => {
  const identity = originalIdentity();
  identity.mounts[0].identity = { target: '/var/lib/etcd', device: 'one-tb', root: '/mx-move/etcd', type: 'ext4' };
  return identity;
};
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const read = path => JSON.parse(readFileSync(path, 'utf8'));

function fixture(t, { missing = [], noDirectory = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mx-move-identity-'));
  const runDirectory = join(root, 'run');
  const recoveryDirectory = join(root, 'recovery');
  mkdirSync(runDirectory, { mode: 0o700 });
  if (!noDirectory) mkdirSync(recoveryDirectory, { mode: 0o700 });
  const hostFile = join(recoveryDirectory, 'host.json');
  const latestFile = join(recoveryDirectory, 'latest.json');
  const payload = { version: 1, namespace: 'mx-launcher', clusterUid: 'original-cluster', identity: originalIdentity(),
    secrets: { 'mx-launcher-db': { data: { password: 'credential-must-never-change' } } },
    identityProfile: { jwks: ['original-private-key'], cookieKeys: ['original-cookie-key'] },
    futureField: { retain: 'all other fields exactly' } };
  const snapshot = { ...payload, checksum: snapshotChecksum(payload) };
  if (!noDirectory && !missing.includes('host')) writeFileSync(hostFile, encode(originalIdentity()), { mode: 0o600 });
  if (!noDirectory && !missing.includes('latest')) writeFileSync(latestFile, encode(snapshot), { mode: 0o600 });
  const options = { runDirectory, recoveryDirectory, node: 'internal', clusterUid: 'original-cluster',
    identity: originalIdentity(), ownerUid: process.getuid() };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, options, hostFile, latestFile, snapshot };
}

test('prepare only copies exact bytes; migration preserves every credential/profile field and checksum', t => {
  const f = fixture(t);
  const hostBytes = readFileSync(f.hostFile);
  const latestBytes = readFileSync(f.latestFile);
  assert.deepEqual(prepare(f.options), { status: 'prepared', files: ['host', 'latest'] });
  assert.deepEqual(readFileSync(f.hostFile), hostBytes);
  assert.deepEqual(readFileSync(f.latestFile), latestBytes);
  assert.deepEqual(readFileSync(join(f.options.runDirectory, 'launcher-identity/latest.original.json')), latestBytes);
  assert.equal(reconcile({ ...f.options, identity: movedIdentity() }).status, 'reconciled');
  assert.deepEqual(read(f.hostFile), movedIdentity());
  const latest = read(f.latestFile);
  assert.deepEqual(latest.identity, movedIdentity());
  assert.equal(latest.checksum, snapshotChecksum(latest));
  for (const key of Object.keys(f.snapshot).filter(key => !['identity', 'checksum'].includes(key))) {
    assert.deepEqual(latest[key], f.snapshot[key]);
  }
  assert.equal(reconcile({ ...f.options, identity: movedIdentity() }).status, 'unchanged');
  assert.equal(reconcile(f.options).status, 'reconciled');
  assert.deepEqual(readFileSync(f.hostFile), hostBytes);
  assert.deepEqual(readFileSync(f.latestFile), latestBytes);
  assert.equal(reconcile(f.options).status, 'unchanged');
  assert.equal(reconcile({ ...f.options, identity: movedIdentity() }).status, 'reconciled');
});

test('an interrupted host-only update can resume or roll back without restoring stale secrets', t => {
  for (const rollback of [false, true]) {
    const f = fixture(t);
    prepare(f.options);
    assert.throws(() => reconcile({ ...f.options, identity: movedIdentity(), afterReplace: name => {
      if (name === 'host') throw new Error('simulated interruption');
    } }), /simulated interruption/);
    assert.deepEqual(read(f.hostFile), movedIdentity());
    assert.deepEqual(read(f.latestFile), f.snapshot);
    assert.equal(reconcile({ ...f.options, identity: rollback ? originalIdentity() : movedIdentity() }).status, 'reconciled');
    assert.deepEqual(read(f.hostFile), rollback ? originalIdentity() : movedIdentity());
    assert.equal(read(f.latestFile).checksum, snapshotChecksum(read(f.latestFile)));
    assert.deepEqual(read(f.latestFile).secrets, f.snapshot.secrets);
  }
});

test('write-ahead interruption before the first source update is retryable', t => {
  const f = fixture(t);
  prepare(f.options);
  assert.throws(() => reconcile({ ...f.options, identity: movedIdentity(), beforeReplace: () => { throw new Error('stopped'); } }), /stopped/);
  assert.deepEqual(read(f.hostFile), originalIdentity());
  assert.equal(reconcile({ ...f.options, identity: movedIdentity() }).status, 'reconciled');
});

test('rejects node, CA, PG and any other mount or mount path changes', () => {
  const changes = [
    identity => { identity.node = 'different'; },
    identity => { identity.ca = 'different'; },
    identity => { identity.pgSystemId = 'different'; },
    identity => { identity.mounts[1].identity.device = 'different'; },
    identity => { identity.mounts.push({ path: '/new', identity: identity.mounts[0].identity }); },
    identity => { identity.mounts[0].path = '/wrong'; },
    identity => { identity.mounts[0].unexpected = true; },
  ];
  for (const change of changes) {
    const identity = movedIdentity(); change(identity);
    assert.throws(() => assertEtcdOnlyChange(originalIdentity(), identity));
  }
});

test('prepare rejects changed host, damaged checksum, wrong cluster and latest without host', t => {
  for (const variant of ['host', 'checksum', 'cluster', 'latest-only']) {
    const f = fixture(t, variant === 'latest-only' ? { missing: ['host'] } : {});
    if (variant === 'host') f.options.identity = movedIdentity();
    if (variant === 'checksum') {
      const latest = read(f.latestFile); latest.secrets.extra = 'changed';
      writeFileSync(f.latestFile, encode(latest));
    }
    if (variant === 'cluster') f.options.clusterUid = 'other-cluster';
    assert.throws(() => prepare(f.options));
    assert.equal(existsSync(join(f.options.runDirectory, 'launcher-identity')), false);
  }
});

test('missing recovery state remains absent and localIdentity is never invoked', t => {
  for (const noDirectory of [true, false]) {
    const f = fixture(t, { noDirectory, missing: ['host', 'latest'] });
    const options = { ...f.options, identity: undefined, identityProvider: () => { throw new Error('must not read local identity'); } };
    assert.equal(prepare(options).status, 'absent');
    assert.equal(reconcile(options).status, 'absent');
    assert.equal(existsSync(f.options.recoveryDirectory), !noDirectory);
    assert.equal(existsSync(f.hostFile), false);
  }
});

test('host-only recovery state updates without creating latest', t => {
  const f = fixture(t, { missing: ['latest'] });
  assert.deepEqual(prepare(f.options).files, ['host']);
  assert.deepEqual(reconcile({ ...f.options, identity: movedIdentity() }).files, ['host']);
  assert.equal(existsSync(f.latestFile), false);
});

test('new recovery state after an absent prepare is rejected', t => {
  const f = fixture(t, { missing: ['host', 'latest'] });
  prepare(f.options);
  writeFileSync(f.hostFile, encode(originalIdentity()), { mode: 0o600 });
  assert.throws(() => reconcile(f.options), /changed outside/);
});

test('unrelated Launcher checkpoint or credentials update is never overwritten', t => {
  const f = fixture(t);
  prepare(f.options);
  const latest = read(f.latestFile);
  latest.secrets['mx-launcher-db'].data.password = 'concurrent-new-credential';
  latest.checksum = snapshotChecksum(latest);
  writeFileSync(f.latestFile, encode(latest));
  const bytes = readFileSync(f.latestFile);
  assert.throws(() => reconcile({ ...f.options, identity: movedIdentity() }), /changed outside/);
  assert.deepEqual(readFileSync(f.latestFile), bytes);
  assert.deepEqual(read(f.hostFile), originalIdentity());
});

test('CAS checks both files immediately before replacement', t => {
  const f = fixture(t);
  prepare(f.options);
  assert.throws(() => reconcile({ ...f.options, identity: movedIdentity(), beforeReplace: () => {
    const latest = read(f.latestFile); latest.futureField.concurrent = true;
    latest.checksum = snapshotChecksum(latest); writeFileSync(f.latestFile, encode(latest));
  } }), /changed outside/);
  assert.deepEqual(read(f.hostFile), originalIdentity());
  assert.equal(read(f.latestFile).futureField.concurrent, true);
});

test('rejects symlinks and group/world-readable directories and files', t => {
  for (const variant of ['file-mode', 'directory-mode', 'run-mode', 'file-symlink', 'directory-symlink', 'owner']) {
    const f = fixture(t);
    if (variant === 'file-mode') chmodSync(f.latestFile, 0o644);
    if (variant === 'directory-mode') chmodSync(f.options.recoveryDirectory, 0o755);
    if (variant === 'run-mode') chmodSync(f.options.runDirectory, 0o755);
    if (variant === 'file-symlink') {
      rmSync(f.latestFile); symlinkSync(f.hostFile, f.latestFile);
    }
    if (variant === 'directory-symlink') {
      const link = join(f.root, 'link'); symlinkSync(f.options.recoveryDirectory, link); f.options.recoveryDirectory = link;
    }
    if (variant === 'owner') f.options.ownerUid = process.getuid() + 1;
    assert.throws(() => prepare(f.options));
  }
});

test('preserves all historical copies and rejects altered backup or journal context', t => {
  const f = fixture(t);
  prepare(f.options);
  reconcile({ ...f.options, identity: movedIdentity() });
  reconcile(f.options);
  const directory = join(f.options.runDirectory, 'launcher-identity');
  const files = readdirSync(directory);
  assert.equal(files.filter(name => /^host-[a-f0-9-]+\.json$/.test(name)).length, 2);
  assert.equal(files.filter(name => /^latest-[a-f0-9-]+\.json$/.test(name)).length, 2);
  assert.throws(() => reconcile({ ...f.options, clusterUid: 'another-cluster' }), /journal/);
  writeFileSync(join(directory, 'host.original.json'), encode(movedIdentity()));
  assert.throws(() => reconcile(f.options), /backup checksum/);
});

test('malformed JSON error never includes private contents', t => {
  const f = fixture(t);
  writeFileSync(f.latestFile, '{"SECRET_DO_NOT_PRINT":broken-json');
  assert.throws(() => prepare(f.options), error => /invalid private JSON/.test(error.message) && !error.message.includes('SECRET_DO_NOT_PRINT'));
});

test('null JSON is invalid state, never an absent recovery snapshot', t => {
  for (const name of ['host', 'latest']) {
    const f = fixture(t, name === 'host' ? { missing: ['latest'] } : {});
    writeFileSync(name === 'host' ? f.hostFile : f.latestFile, 'null\n');
    assert.throws(() => prepare(f.options));
  }
});
