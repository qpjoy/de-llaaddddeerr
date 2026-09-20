import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkVolume, ensureLocalPvs } from './k8s-local-pv-ensure.mjs';

function fixture() {
  const desired = { apiVersion: 'v1', kind: 'PersistentVolume',
    metadata: { name: 'mx-internal-postgres-local-pv' },
    spec: { hostPath: { path: '/var/lib/mx-launcher/k8s/postgres', type: 'DirectoryOrCreate' },
      persistentVolumeReclaimPolicy: 'Retain', volumeMode: 'Filesystem', capacity: { storage: '2Gi' },
      accessModes: ['ReadWriteOnce'],
      claimRef: { namespace: 'mx-internal-shadow', name: 'postgres-data-mx-internal-postgres-0' } }
  };
  const pv = structuredClone(desired);
  pv.metadata.uid = 'existing-pv';
  pv.metadata.resourceVersion = '120';
  pv.metadata.finalizers = ['kubernetes.io/pv-protection'];
  pv.spec.hostPath.type = 'Directory';
  pv.spec.claimRef.uid = 'original-pvc';
  pv.spec.storageClassName = '';
  pv.spec.nodeAffinity = { required: { nodeSelectorTerms: [
    { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['mx-internal-server'] }] }
  ] } };
  pv.status = { phase: 'Bound' };
  const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name: desired.spec.claimRef.name, namespace: desired.spec.claimRef.namespace, uid: 'original-pvc' },
    spec: { volumeName: desired.metadata.name }, status: { phase: 'Bound' } };
  return { desired, pv, pvc };
}

function fakeCluster(items, pvs = [], pvcs = [], fail = () => {}) {
  const state = {
    pvs: new Map(pvs.map(p => [p.metadata.name, structuredClone(p)])),
    pvcs: new Map(pvcs.map(p => [`${p.metadata.namespace}/${p.metadata.name}`, structuredClone(p)]))
  };
  const calls = [];
  const writes = [];
  const run = (args, input) => {
    calls.push({ args, input });
    fail(args);
    if (args[0] === 'create' && args.includes('--dry-run=client')) return JSON.stringify({ kind: 'List', items });
    if (args[0] === 'get' && args[1] === 'pv') return JSON.stringify(state.pvs.get(args[2])) ?? '';
    if (args[0] === 'get' && args[1] === 'pvc') return JSON.stringify(state.pvcs.get(`${args[4]}/${args[2]}`)) ?? '';
    if (args[0] === 'create' && !args.some(a => a.startsWith('--dry-run'))) {
      const object = JSON.parse(input);
      if (state.pvs.has(object.metadata.name)) throw new Error('AlreadyExists');
      state.pvs.set(object.metadata.name, { ...structuredClone(object), status: { phase: 'Available' } });
      writes.push(object);
      return 'created';
    }
    throw new Error(`unexpected operation: ${args.join(' ')}`);
  };
  return { run, state, calls, writes };
}

test('recovered Directory PV is preserved verbatim, including UID, binding, node affinity and capacity', () => {
  for (const type of ['Directory', 'DirectoryOrCreate']) {
    const { desired, pv, pvc } = fixture();
    pv.spec.hostPath.type = type;
    pv.spec.capacity.storage = '10Gi';
    const cluster = fakeCluster([desired], [pv], [pvc]);
    const before = structuredClone(cluster.state);
    const messages = [];
    ensureLocalPvs('ensure', 'manifest.yaml', cluster.run, message => messages.push(message));
    ensureLocalPvs('ensure', 'manifest.yaml', cluster.run, () => {});
    assert.deepEqual(cluster.state, before);
    assert.deepEqual(cluster.writes, []);
    assert.match(messages[0], /preserve PV .*source and binding unchanged/);
  }
});

test('only missing PVs are created; repeated runs do not apply or replace existing storage', () => {
  const { desired, pv, pvc } = fixture();
  const missing = structuredClone(desired);
  missing.metadata.name = 'mx-launcher-site-slots-local-pv';
  missing.spec.hostPath.path = '/var/lib/mx-launcher/k8s/site-slots';
  missing.spec.claimRef.name = 'mx-launcher-site-slots';
  const cluster = fakeCluster([desired, missing], [pv], [pvc]);
  ensureLocalPvs('ensure', 'manifest.yaml', cluster.run, () => {});
  ensureLocalPvs('ensure', 'manifest.yaml', cluster.run, () => {});
  assert.deepEqual(cluster.writes, [missing]);
  assert.deepEqual(cluster.state.pvs.get(pv.metadata.name), pv);
  assert.ok(!cluster.calls.some(c => ['apply', 'patch', 'delete', 'replace'].includes(c.args[0])));
});

test('preflight is read-only even when all PVs are missing', () => {
  const { desired } = fixture();
  const cluster = fakeCluster([desired]);
  ensureLocalPvs('preflight', 'manifest.yaml', cluster.run, () => {});
  assert.equal(cluster.state.pvs.size, 0);
  assert.deepEqual(cluster.writes, []);
});

test('released, failed and terminating PVs stop recovery without deleting storage or clearing claimRef', () => {
  for (const alter of [
    p => { p.status.phase = 'Released'; },
    p => { p.status.phase = 'Failed'; },
    p => { p.metadata.deletionTimestamp = '2026-09-20T00:00:00Z'; }
  ]) {
    const { desired, pv, pvc } = fixture();
    alter(pv);
    const cluster = fakeCluster([desired], [pv], [pvc]);
    const before = structuredClone(cluster.state);
    assert.throws(() => ensureLocalPvs('ensure', 'manifest.yaml', cluster.run, () => {}), /storage was not changed/);
    assert.deepEqual(cluster.state, before);
    assert.deepEqual(cluster.writes, []);
  }
});

test('source, reclaim-policy and reservation mismatches stop the entire batch before any creation', () => {
  for (const alter of [
    p => { p.spec.hostPath.path = '/different/data'; },
    p => { p.spec.hostPath.type = 'File'; },
    p => { delete p.spec.hostPath; p.spec.csi = { driver: 'unrelated' }; },
    p => { p.spec.persistentVolumeReclaimPolicy = 'Delete'; },
    p => { p.spec.claimRef.name = 'different-pvc'; },
    p => { p.spec.claimRef.namespace = 'different-namespace'; },
    p => { delete p.spec.claimRef; },
    p => { p.spec.storageClassName = 'different-class'; },
    p => { p.spec.volumeMode = 'Block'; },
    p => { p.spec.accessModes = ['ReadOnlyMany']; }
  ]) {
    const { desired, pv, pvc } = fixture();
    alter(pv);
    const first = structuredClone(desired);
    first.metadata.name = 'missing-first-pv';
    first.spec.claimRef.name = 'missing-first-pvc';
    const cluster = fakeCluster([first, desired], [pv], [pvc]);
    assert.throws(() => ensureLocalPvs('ensure', 'manifest.yaml', cluster.run, () => {}), /storage was not changed/);
    assert.deepEqual(cluster.writes, []);
  }
});

test('PVC identity changes, other volume bindings and lost/deleting claims fail closed', () => {
  for (const alter of [
    p => { p.metadata.uid = 'recreated-pvc'; },
    p => { p.spec.volumeName = 'another-pv'; },
    p => { p.status.phase = 'Lost'; },
    p => { p.metadata.deletionTimestamp = '2026-09-20T00:00:00Z'; }
  ]) {
    const { desired, pv, pvc } = fixture();
    alter(pvc);
    assert.throws(() => checkVolume(desired, pv, pvc), /storage was not changed/);
  }
  const { desired, pv, pvc } = fixture();
  assert.throws(() => checkVolume(desired, pv, null), /claim UID/);
  assert.throws(() => checkVolume(desired, null, pvc), /PVC is still Bound/);
});

test('new prebound Available PVs can be reused before a PVC exists', () => {
  const { desired } = fixture();
  const pv = { ...structuredClone(desired), status: { phase: 'Available' } };
  assert.equal(checkVolume(desired, pv, null), 'preserve');
});

test('API read failures are not mistaken for absent resources', () => {
  for (const resource of ['pv', 'pvc']) {
    const { desired } = fixture();
    const cluster = fakeCluster([desired], [], [], args => {
      if (args[0] === 'get' && args[1] === resource) throw new Error('Forbidden or timeout');
    });
    assert.throws(() => ensureLocalPvs('ensure', 'manifest.yaml', cluster.run, () => {}), /Forbidden or timeout/);
    assert.deepEqual(cluster.writes, []);
  }
});

test('a concurrent PV creation stops without applying, overwriting or deleting it', () => {
  const { desired } = fixture();
  const cluster = fakeCluster([desired], [], [], args => {
    if (args[0] === 'create' && !args.includes('--dry-run=client')) throw new Error('AlreadyExists');
  });
  assert.throws(() => ensureLocalPvs('ensure', 'manifest.yaml', cluster.run, () => {}), /AlreadyExists/);
  assert.deepEqual(cluster.writes, []);
  assert.ok(!cluster.calls.some(c => ['apply', 'patch', 'delete', 'replace'].includes(c.args[0])));
});

test('deploy validates storage before build and before Secret writes; apply uses the safe ensure path', () => {
  const source = readFileSync(new URL('./manage.sh', import.meta.url), 'utf8');
  const deploy = source.match(/    deploy\|cycle\)\n([\s\S]*?)\n    apply\)/)[1];
  assert.ok(deploy.indexOf('k8s_local_pvs preflight') >= 0);
  assert.ok(deploy.indexOf('k8s_local_pvs preflight') < deploy.indexOf('shadow_image_build'));
  const apply = source.match(/^k8s_apply\(\) \{\n[\s\S]*?^\}/m)[0];
  assert.ok(apply.indexOf('k8s_local_pvs preflight') < apply.indexOf('k8s_ensure_secret_bundle'));
  assert.ok(apply.indexOf('k8s_local_pvs ensure') > apply.indexOf('k8s_local_pvs preflight'));
  assert.doesNotMatch(apply, /kubectl apply[^\n]*18-local-pv\.yaml/);
  assert.doesNotMatch(source, /kubectl delete pv |k8s_repair_released_local_pv/);
});
