import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountIdentity, assertFstabMounted, recoverState } from './k8s-recovery-state.mjs';
import { guardPostgres } from './k8s-postgres-recovery.mjs';

const identity = { node: 'mx-internal-server', ca: 'same-ca', pgSystemId: 'original-db', mounts: [{ path: '/var/lib/mx-launcher', identity: { device: 'disk-uuid', root: '/mx-runtime/mx-launcher' } }] };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mx-recovery-test-'));
  const ns = 'mx-internal-shadow';
  const secrets = {};
  let failName, clusterUid = 'original-cluster';
  const writes = [], logs = [];
  function secret(name, value = name) {
    return { kind: 'Secret', apiVersion: 'v1', metadata: { name, namespace: ns, uid: 'old-uid', resourceVersion: '123', ownerReferences: [{ uid: 'old-owner' }] }, type: 'Opaque', data: { token: Buffer.from(value).toString('base64') } };
  }
  secrets['mx-launcher-db'] = secret('mx-launcher-db');
  secrets['mx-internal-ops'] = secret('mx-internal-ops');
  secrets['mx-feishu-oauth'] = secret('mx-feishu-oauth', 'private-feishu-test-secret');
  function execute(cmd, args, input) {
    assert.equal(cmd, 'kubectl');
    if (args.includes('get')) {
      const i = args.indexOf('get'), kind = args[i + 1], name = args[i + 2];
      if (name === failName) throw new Error('API read failed');
      if (kind === 'nodes') return JSON.stringify({ items: [{ metadata: { name: identity.node } }] });
      if (kind === 'namespace') return JSON.stringify({ metadata: { uid: clusterUid } });
      return secrets[name] ? JSON.stringify(secrets[name]) : '';
    }
    assert.ok(args.includes('create'), 'recovery can only create, never replace/delete');
    const value = JSON.parse(input);
    writes.push(value);
    if (secrets[value.metadata.name]) throw new Error('AlreadyExists');
    secrets[value.metadata.name] = value;
    return '';
  }
  const invoke = (action, patch = {}) => recoverState(action, { directory, namespace: ns, identity, execute, log: line => logs.push(line), ...patch });
  return { directory, secrets, writes, logs, secret, invoke, fail: name => { failName = name; }, cluster: uid => { clusterUid = uid; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('restore missing original credentials, preserve live values, and retain private snapshot generations', () => {
  const f = fixture();
  try {
    f.invoke('host'); f.invoke('restore'); f.invoke('checkpoint');
    const original = f.secrets['mx-internal-ops'].data;
    delete f.secrets['mx-internal-ops']; delete f.secrets['mx-feishu-oauth'];
    f.invoke('restore');
    assert.deepEqual(f.secrets['mx-internal-ops'].data, original);
    assert.equal(f.writes.length, 2);
    for (const restored of f.writes) {
      assert.equal(restored.metadata.uid, undefined);
      assert.equal(restored.metadata.ownerReferences, undefined);
    }
    f.invoke('restore'); f.invoke('checkpoint');
    assert.equal(f.writes.length, 2, 'repeated recovery makes no writes');
    assert.equal(readdirSync(f.directory).filter(name => name.startsWith('secrets-')).length, 1);
    f.secrets['mx-internal-ops'].data.token = Buffer.from('intentional-new-token').toString('base64');
    f.invoke('restore'); f.invoke('checkpoint');
    assert.equal(readdirSync(f.directory).filter(name => name.startsWith('secrets-')).length, 2);
    for (const file of readdirSync(f.directory)) assert.equal(statSync(join(f.directory, file)).mode & 0o777, 0o600);
    assert.doesNotMatch(f.logs.join('\n'), /private-feishu-test-secret|intentional-new-token/);
  } finally { f.cleanup(); }
});

test('API failures never become missing Secrets and all reads precede writes', () => {
  const f = fixture();
  try {
    f.invoke('checkpoint'); delete f.secrets['mx-internal-ops'];
    f.fail('mx-release-oss');
    assert.throws(() => f.invoke('restore'), /API read failed/);
    assert.equal(f.writes.length, 0);
  } finally { f.cleanup(); }
});

test('wrong CA, node, database, mount or cluster cannot restore credentials', () => {
  for (const field of ['ca', 'node', 'pgSystemId', 'mounts', 'clusterUid']) {
    const f = fixture();
    try {
      f.invoke('checkpoint'); delete f.secrets['mx-internal-ops'];
      if (field === 'clusterUid') f.cluster('new-cluster');
      const patch = field === 'clusterUid' ? {} : { identity: { ...identity, [field]: 'different' } };
      assert.throws(() => f.invoke('restore', patch), /identity|another cluster/);
      assert.equal(f.writes.length, 0);
    } finally { f.cleanup(); }
  }
});

test('first recovery cannot silently mint missing ops/database credentials', () => {
  for (const name of ['mx-internal-ops', 'mx-launcher-db']) {
    const f = fixture();
    try {
      delete f.secrets[name];
      assert.throws(() => f.invoke('restore'), /original.*Secrets first/);
      assert.equal(f.writes.length, 0);
    } finally { f.cleanup(); }
  }
});

test('missing Feishu does not overwrite the last good checkpoint', () => {
  const f = fixture();
  try {
    f.invoke('checkpoint');
    const before = readFileSync(join(f.directory, 'latest.json'));
    delete f.secrets['mx-feishu-oauth'];
    assert.throws(() => f.invoke('checkpoint'), /Secrets are missing/);
    assert.deepEqual(readFileSync(join(f.directory, 'latest.json')), before);
  } finally { f.cleanup(); }
});

test('corrupt/unsafe snapshots fail closed without exposing or restoring data', () => {
  const f = fixture();
  try {
    f.invoke('checkpoint'); delete f.secrets['mx-internal-ops'];
    chmodSync(join(f.directory, 'latest.json'), 0o644);
    assert.throws(() => f.invoke('restore'), /private regular file/);
    chmodSync(join(f.directory, 'latest.json'), 0o600);
    const snapshot = JSON.parse(readFileSync(join(f.directory, 'latest.json')));
    snapshot.secrets['mx-internal-ops'].data.token = Buffer.from('corrupted-but-valid-base64').toString('base64');
    writeFileSync(join(f.directory, 'latest.json'), JSON.stringify(snapshot));
    assert.throws(() => f.invoke('restore'), /checksum mismatch/);
    writeFileSync(join(f.directory, 'latest.json'), 'invalid');
    assert.throws(() => f.invoke('restore'), SyntaxError);
    assert.equal(f.writes.length, 0);
  } finally { f.cleanup(); }
});

test('mount identities tolerate device renumbering but catch bind-root loss and absent fstab mounts', () => {
  const mount = { target: '/var/lib/mx-launcher', source: '/dev/nvme0n1p1[/mx-runtime/mx-launcher]', uuid: 'persistent-uuid', fsroot: '/mx-runtime/mx-launcher', fstype: 'xfs', options: 'rw,noatime' };
  assert.deepEqual(mountIdentity(mount), mountIdentity({ ...mount, source: '/dev/nvme1n1p1[/mx-runtime/mx-launcher]' }));
  assert.notDeepEqual(mountIdentity(mount), mountIdentity({ ...mount, fsroot: '/' }));
  assert.throws(() => mountIdentity({ ...mount, options: 'ro' }), /read-only/);
  assert.throws(() => assertFstabMounted(['/var/lib/mx-launcher'], [{ path: '/var/lib/mx-launcher', identity: { target: '/' } }]), /mount is absent/);
});

test('PostgreSQL recovery uses original claim template and refuses initialization on subsequent boots', () => {
  const template = { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '2Gi' } } };
  const set = { kind: 'StatefulSet', metadata: { name: 'mx-internal-postgres' }, spec: {
    volumeClaimTemplates: [{ spec: template }], template: { spec: { containers: [{ name: 'postgres', image: 'postgres:16-alpine', env: [{ name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' }] }] } }
  } };
  const result = guardPostgres([set], 'mx-internal-server');
  const pod = result.items[0].spec.template.spec;
  assert.deepEqual(pod.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchFields[0].values, ['mx-internal-server']);
  assert.equal(pod.nodeName, undefined);
  assert.match(pod.containers[0].command[2], /initialization refused/);
  assert.match(pod.containers[0].command[2], /exec docker-entrypoint.sh postgres/);
  assert.deepEqual(result.items[0].spec.volumeClaimTemplates[0].spec, template);
  assert.equal(set.spec.template.spec.containers[0].command, undefined);
  const temp = mkdtempSync(join(tmpdir(), 'mx-pg-startup-guard-'));
  try {
    const env = { ...process.env, PGDATA: temp, PATH: `${temp}:${process.env.PATH}` };
    writeFileSync(join(temp, 'docker-entrypoint.sh'), '#!/bin/sh\necho ORIGINAL_DATABASE_STARTED\n', { mode: 0o700 });
    let started = spawnSync('sh', ['-ec', pod.containers[0].command[2]], { env, encoding: 'utf8' });
    assert.notEqual(started.status, 0);
    assert.match(started.stderr, /initialization refused/);
    assert.doesNotMatch(started.stdout, /ORIGINAL_DATABASE_STARTED/);
    writeFileSync(join(temp, 'PG_VERSION'), '16\n'); mkdirSync(join(temp, 'base')); mkdirSync(join(temp, 'global'));
    writeFileSync(join(temp, 'global/pg_control'), Buffer.alloc(8192));
    started = spawnSync('sh', ['-ec', pod.containers[0].command[2]], { env, encoding: 'utf8' });
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /ORIGINAL_DATABASE_STARTED/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
