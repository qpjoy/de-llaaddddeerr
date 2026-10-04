import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountIdentity, assertFstabMounted, recoverState } from './k8s-recovery-state.mjs';
import { guardPostgres } from './k8s-postgres-recovery.mjs';
import { initializeProfile, readProfile, savePrivate } from './identity-profile.mjs';
import { inspectIdentity, resources } from './identity-deploy.mjs';
import { createPublicEntry } from './identity-public-profile.mjs';
import { registerApplication } from './identity-app.mjs';

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
  return { directory, secrets, writes, logs, secret, invoke, execute, fail: name => { failName = name; }, cluster: uid => { clusterUid = uid; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function identityFixture(entry) {
  const f = fixture();
  const file = join(f.directory, 'identity', 'profile.json');
  const profile = initializeProfile('https://10.88.88.88:18443', file);
  if (entry === 'public') {
    profile.publicEntry = createPublicEntry({ origin: 'https://auth.example.com', adminOrigin: 'https://launcher.example.com',
      hubOrigin: 'https://hub.example.com', audience: 'mx-insight-hub', privateOrigin: profile.origin });
  } else {
    profile.applications = [{ appId: 'mx-insight-hub', clientId: 'mx-insight-hub-web', clientSecret: 'h'.repeat(43),
      origin: 'https://10.88.88.88:18151', audience: 'mx-insight-hub' }];
  }
  savePrivate(file, profile);
  const publish = p => {
    for (const s of Object.values(resources(p, 'abc')).filter(r => r.kind === 'Secret')) f.secrets[s.metadata.name] = s;
  };
  publish(profile);
  return { ...f, file, profile, publish, invoke: action => f.invoke(action, { identityProfileFile: file }) };
}

for (const entry of ['public', 'private']) test(`${entry} application registration survives predeploy recovery, checkpoint and missing-file recovery`, () => {
  const f = identityFixture(entry);
  try {
    f.invoke('checkpoint');
    const running = structuredClone(f.secrets);
    registerApplication({ file: f.file, appFile: join(f.directory, 'applications', 'mx-pay.json'), entry,
      appId: 'mx-pay', origin: 'https://pay.example.com', audience: 'mx-pay' });
    const pending = readProfile(f.file);
    // The same unpublished profile is accepted by normal deployment.
    inspectIdentity(pending, args => f.execute('kubectl', args));
    f.invoke('restore'); f.invoke('checkpoint'); f.invoke('restore');
    assert.deepEqual(f.secrets, running, 'recovery must not publish registrations or replace live credentials');
    assert.equal(f.writes.length, 0);
    const checkpoint = JSON.parse(readFileSync(join(f.directory, 'latest.json'), 'utf8'));
    assert.deepEqual(checkpoint.identityProfile, pending);
    assert.deepEqual(checkpoint.secrets['mx-identity-runtime'].data, running['mx-identity-runtime'].data);
    unlinkSync(f.file);
    delete f.secrets['mx-identity-runtime'];
    f.invoke('restore');
    assert.deepEqual(readProfile(f.file), pending, 'recover both published clients and the saved pending registration');
    assert.deepEqual(f.secrets['mx-identity-runtime'].data, running['mx-identity-runtime'].data);
    f.invoke('checkpoint');
    f.publish(pending); // Model the later normal deployment publishing the saved profile.
    f.invoke('restore'); f.invoke('checkpoint');
    assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'latest.json'), 'utf8')).identityProfile, pending);
    const clients = entry === 'public' ? pending.publicEntry.applications : pending.applications;
    for (const app of clients) assert.ok(!f.logs.join('\n').includes(app.clientSecret));
  } finally { f.cleanup(); }
});

for (const entry of ['public', 'private']) test(`${entry} recovery still rejects existing client or core credential drift before any write`, async t => {
  const f = identityFixture(entry);
  try {
    f.invoke('checkpoint');
    const checkpoint = readFileSync(join(f.directory, 'latest.json'), 'utf8');
    const secret = f.secrets['mx-identity-runtime'];
    const original = JSON.parse(Buffer.from(secret.data['config.json'], 'base64').toString());
    const select = config => entry === 'public' ? config.publicEntry : config;
    const changes = [
      ...['appId', 'clientId', 'clientSecret', 'origin', 'audience'].map(key => ({ name: `existing application ${key}`,
        mutate: config => { select(config).applications[0][key] = 'changed-existing-value'; } })),
      { name: 'removed application', mutate: config => { select(config).applications.push({ appId: 'mx-pay', clientId: 'mx-pay-web',
        clientSecret: 'p'.repeat(43), origin: 'https://pay.example.com', audience: 'mx-pay' }); } },
      ...['origin', 'issuer', 'clientId', 'clientSecret', 'cookieKeys', 'jwks', ...(entry === 'public' ? ['adminOrigin', 'transportOrigin', 'ingressToken'] : [])]
        .map(key => ({ name: `core ${key}`, mutate: config => { select(config)[key] = 'changed-core-value'; } })),
      ...(entry === 'public' ? [{ name: 'removed public entry', mutate: () => {} }] : [])
    ];
    // A missing unrelated Secret would be restored if the identity guard were bypassed.
    delete f.secrets['mx-internal-ops'];
    for (const { name, mutate } of changes) await t.test(name, () => {
      const config = structuredClone(original); mutate(config);
      secret.data['config.json'] = Buffer.from(JSON.stringify(config)).toString('base64');
      const profile = structuredClone(f.profile);
      if (name === 'removed public entry') delete profile.publicEntry;
      savePrivate(f.file, profile);
      for (const action of ['restore', 'checkpoint']) {
        assert.throws(() => f.invoke(action), /credentials differ/);
        assert.equal(f.writes.length, 0);
        assert.equal(readFileSync(join(f.directory, 'latest.json'), 'utf8'), checkpoint);
      }
    });
  } finally { f.cleanup(); }
});

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

test('identity recovery preserves installation ownership and original keys', () => {
  const f = fixture();
  try {
    const name = 'mx-identity-runtime';
    f.secrets[name] = f.secret(name);
    f.secrets[name].metadata.labels = { 'mx.qpjoy.com/identity-installation': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', unrelated: 'drop' };
    f.invoke('checkpoint'); const before = f.secrets[name]; delete f.secrets[name]; f.invoke('restore');
    assert.deepEqual(f.secrets[name].data, before.data);
    assert.deepEqual(f.secrets[name].metadata.labels, { 'mx.qpjoy.com/identity-installation': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  } finally { f.cleanup(); }
});

test('checkpoint retains the full host identity profile; a lost host file and runtime Secrets restore together', () => {
  const f = fixture();
  try {
    const file = join(f.directory, 'identity', 'profile.json');
    const p = initializeProfile('https://10.88.88.88:18443', file);
    const r = resources(p, 'abc123');
    for (const s of [r.runtime, r.admin, r.ca]) f.secrets[s.metadata.name] = s;
    f.invoke('checkpoint', { identityProfileFile: file });
    const first = readFileSync(join(f.directory, 'latest.json'), 'utf8');
    assert.deepEqual(JSON.parse(first).identityProfile, p);
    for (const s of [r.runtime, r.admin, r.ca]) delete f.secrets[s.metadata.name];
    unlinkSync(file);
    f.invoke('restore', { identityProfileFile: file });
    assert.deepEqual(readProfile(file), p);
    assert.equal(readFileSync(join(f.directory, 'identity', 'ca.crt'), 'utf8'), p.caCert);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(f.writes).includes(p.caKey), 'CA private key must never be written to Kubernetes');
    f.invoke('restore', { identityProfileFile: file });
    f.invoke('checkpoint', { identityProfileFile: file });
    assert.equal(readFileSync(join(f.directory, 'latest.json'), 'utf8'), first);
    assert.equal(readdirSync(f.directory).filter(name => name.startsWith('secrets-')).length, 1);
    assert.ok(!f.logs.join('').includes(p.clientSecret));
    unlinkSync(file);
    assert.throws(() => f.invoke('checkpoint', { identityProfileFile: file }), /identity profile missing/);
    assert.equal(readFileSync(join(f.directory, 'latest.json'), 'utf8'), first);
  } finally { f.cleanup(); }
});

test('identity restore never overwrites a live profile or restores keys inconsistent with running Secrets', () => {
  const f = fixture();
  try {
    const file = join(f.directory, 'identity', 'profile.json');
    const p = initializeProfile('https://10.88.88.88:18443', file);
    for (const s of Object.values(resources(p, 'abc')).filter(r => r.kind === 'Secret')) f.secrets[s.metadata.name] = s;
    f.invoke('checkpoint', { identityProfileFile: file });
    const original = readFileSync(file, 'utf8');
    f.invoke('restore', { identityProfileFile: file });
    assert.equal(readFileSync(file, 'utf8'), original);
    unlinkSync(file);
    const config = JSON.parse(Buffer.from(f.secrets['mx-identity-runtime'].data['config.json'], 'base64').toString());
    config.clientSecret = 'foreign-runtime';
    f.secrets['mx-identity-runtime'].data['config.json'] = Buffer.from(JSON.stringify(config)).toString('base64');
    assert.throws(() => f.invoke('restore', { identityProfileFile: file }), /credentials differ/);
    assert.equal(f.writes.length, 0);
    assert.equal(readProfile(file), null);
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
