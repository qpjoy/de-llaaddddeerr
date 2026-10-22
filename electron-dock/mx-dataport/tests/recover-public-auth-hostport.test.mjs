import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { recoverPublicAuth, recoveryLocks, execute, recoveryFailure, wrapperFailure } from '../scripts/recover-public-auth-hostport.mjs';

const NAME = 'mx-identity-public', NODE = 'mx-internal-server', IP = '10.88.88.88';
const IMAGE = 'sha256:' + 'a'.repeat(64), CONTAINER = 'b'.repeat(64);
const KEY = 'mx.qpjoy.com/identity-config-digest';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failedCommand = stderr => execute(process.execPath, ['-e', 'process.stderr.write(process.argv[1]);process.exit(1)', stderr]);
function fixture(change = () => {}) {
  const data = { 'config.json': Buffer.from('private-client-secret').toString('base64'), 'tls.key': 'private-tls-key' };
  const config = sha(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  const spec = { containers: [{ name: 'identity', image: 'qpjoy/mx-launcher-server:shadow', imagePullPolicy: 'Never',
    env: [{ name: 'MX_IDENTITY_ENTRY', value: 'public' }], ports: [{ hostIP: IP, hostPort: 18444, containerPort: 18444 }] }] };
  const state = {
    host: { platform: 'linux', uid: 0, name: NODE, addresses: [IP + '/32'] },
    cluster: { metadata: { uid: '399f2349-3a34-48f4-8105-d7bae56ca136' } },
    nodes: { items: [{ metadata: { uid: 'node-uid', name: NODE, labels: { 'kubernetes.io/hostname': NODE } },
      status: { conditions: [{ type: 'Ready', status: 'True' }] } }] },
    migration: { phase: 'services-restored', may_write: true, automatic_checks_passed: true, transaction: 'completed-migration' },
    runtime: '/run/mx-k8s-containerd/containerd.sock',
    deployment: { metadata: { uid: 'deployment-uid', resourceVersion: '10', generation: 4 },
      spec: { replicas: 1, strategy: { type: 'Recreate' }, template: { metadata: { annotations: { [KEY]: config } }, spec } },
      status: { observedGeneration: 4, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } },
    replicasets: { items: [{ metadata: { uid: 'rs-uid', ownerReferences: [{ controller: true, uid: 'deployment-uid' }] } }] },
    pods: { items: [{ metadata: { uid: 'pod-before', annotations: { [KEY]: config },
      ownerReferences: [{ controller: true, uid: 'rs-uid' }] }, spec: { ...structuredClone(spec), nodeName: NODE },
      status: { phase: 'Running', podIP: '10.244.0.80', conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: [{ name: 'identity', ready: true, state: { running: {} }, imageID: IMAGE, containerID: 'containerd://' + CONTAINER }] } }] },
    secret: { data }, hostHealth: { status: 0, category: 'refused' }, podHealth: { status: 200, category: 'http' },
    tagImage: IMAGE, runningImage: IMAGE, runningState: 'CONTAINER_RUNNING',
  };
  const calls = [], probes = []; let snapshots = 0, patched = false;
  change(state);
  const run = (command, args, options = {}) => {
    calls.push({ command, args, input: options.input, timeout: options.timeout });
    if (command === 'python3') return JSON.stringify(state.migration);
    if (command === 'crictl') {
      assert.ok(args.includes('--runtime-endpoint=unix://' + state.runtime));
      assert.ok(args.includes('--image-endpoint=unix://' + state.runtime));
      if (args.includes('inspect')) return JSON.stringify({ status: { state: state.runningState,
        metadata: { name: 'identity' }, labels: { 'io.kubernetes.pod.uid': state.containerPod || state.pods.items[0].metadata.uid }, imageRef: state.runningImage } });
      return JSON.stringify({ status: { id: args.at(-1).endsWith(':shadow') ? state.tagImage : IMAGE } });
    }
    assert.equal(command, 'kubectl');
    assert.ok(args.includes('--kubeconfig=/etc/kubernetes/admin.conf'));
    if (args.includes('patch')) {
      assert.equal(patched, false, 'must never retry a mutation');
      assert.deepEqual(args.slice(args.indexOf('patch'), -1), ['patch', 'deployment', NAME, '--type=json', '-p']);
      assert.equal(options.input, undefined);
      const patch = JSON.parse(args.at(-1));
      assert.deepEqual(patch.slice(0, 2), [
        { op: 'test', path: '/metadata/uid', value: state.deployment.metadata.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: state.deployment.metadata.resourceVersion },
      ]);
      assert.equal(patch.length, 3); assert.equal(patch[2].op, 'add');
      assert.equal(patch[2].path, '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt');
      if (state.patchCommandError) failedCommand(state.patchCommandError);
      if (state.rejectPatch) throw Error('private-api-message');
      patched = true;
      state.deployment.metadata.resourceVersion = '11'; state.deployment.metadata.generation++;
      state.deployment.status.observedGeneration++;
      state.deployment.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = patch[2].value;
      if (!state.keepOldPod) state.pods.items[0].metadata.uid = 'pod-after';
      state.hostHealth = state.postHealth || { status: 200, category: 'http' };
      return '{}';
    }
    if (args.includes('rollout')) {
      if (state.rolloutCommandError) failedCommand(state.rolloutCommandError);
      if (state.failRollout) throw Error('private-rollout-message'); return '';
    }
    const kind = args[args.indexOf('get') + 1];
    if (kind === 'namespace') {
      if (patched && state.postcheckCommandError) failedCommand(state.postcheckCommandError);
      snapshots++; state.onSnapshot?.(state, snapshots); return JSON.stringify(state.cluster);
    }
    return JSON.stringify(state[{ nodes: 'nodes', deployment: 'deployment', replicasets: 'replicasets', pods: 'pods', secret: 'secret' }[kind]]);
  };
  return { state, calls, probes, mutations: () => calls.filter(c => c.args.includes('patch')),
    recover: apply => recoverPublicAuth({ apply, run, host: state.host, runtime: () => state.runtime,
      probe: async url => { probes.push(url); return structuredClone(url.includes(IP + ':') ? state.hostHealth : state.podHealth); } }) };
}

test('default checks are read-only; healthy public host is always a no-op', async () => {
  const f = fixture(); assert.deepEqual(await f.recover(false), { ok: true, action: 'restart_required', applied: false });
  assert.equal(f.mutations().length, 0);
  assert.deepEqual(f.probes, ['http://10.244.0.80:18444/healthz', 'http://10.88.88.88:18444/healthz']);
  const healthy = fixture(s => { s.hostHealth = { status: 200 }; });
  assert.deepEqual(await healthy.recover(true), { ok: true, action: 'already_healthy', applied: false });
  assert.equal(healthy.mutations().length, 0);
});

test('apply rechecks, performs one CAS restart, and verifies new Pod with preserved image and configuration', async () => {
  const f = fixture(); const result = await f.recover(true);
  assert.deepEqual(result, { ok: true, action: 'recovered', applied: true }); assert.equal(f.mutations().length, 1);
  assert.equal(f.calls.filter(c => c.args.includes('namespace')).length, 3);
  assert.equal(f.calls.filter(c => c.args.includes('rollout')).length, 1);
  assert.ok(f.calls.every(c => !c.args.some(v => ['apply', 'delete', 'scale', 'restart', 'enroll', 'resume'].includes(v))));
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(recoveryLocks, ['/run/mx-move-k8s.lock', '/run/mx-move-etcd.lock', '/run/mx-launcher-deploy.lock', '/var/lib/mx-move/k8s-runtime-install.lock']);
});

test('unsafe host, cluster, migration, runtime, workload, identity and image states refuse before mutation', async () => {
  const cases = [
    ['wrong_host', s => { s.host.addresses = [IP + '/24']; }],
    ['cluster_changed', s => { s.cluster.metadata.uid = 'other'; }],
    ['node_changed', s => { s.nodes.items.push(structuredClone(s.nodes.items[0])); }],
    ['node_unschedulable', s => { s.nodes.items[0].spec = { unschedulable: true }; }],
    ['node_taint_untolerated', s => { s.nodes.items[0].spec = { taints: [{ key: 'maintenance', effect: 'NoSchedule' }] }; }],
    ['node_taint_untolerated', s => {
      s.nodes.items[0].spec = { taints: [{ key: 'maintenance', effect: 'NoExecute' }] };
      s.deployment.spec.template.spec.tolerations = [{ key: 'maintenance', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 60 }];
    }],
    ['migration_incomplete', s => { s.migration.phase = 'committed'; }],
    ['runtime_changed', s => { s.runtime = '/run/containerd/containerd.sock'; }],
    ['deployment_unstable', s => { s.deployment.status.updatedReplicas = 0; }],
    ['public_template_changed', s => { s.deployment.spec.template.spec.containers[0].ports[0].hostPort = 18443; }],
    ['pod_set_changed', s => { s.replicasets.items[0].metadata.ownerReferences[0].uid = 'another-deployment'; }],
    ['pod_set_changed', s => { s.pods.items.push(structuredClone(s.pods.items[0])); }],
    ['pod_unstable', s => { s.pods.items[0].spec.nodeName = 'another-node'; }],
    ['identity_config_changed', s => { s.secret.data['config.json'] = 'changed-secret'; }],
    ['identity_config_changed', s => { s.pods.items[0].metadata.annotations[KEY] = 'old-config'; }],
    ['container_changed', s => { s.containerPod = 'another-pod'; }],
    ['container_changed', s => { s.runningState = 'CONTAINER_EXITED'; }],
    ['image_changed', s => { s.tagImage = 'sha256:' + 'c'.repeat(64); }],
    ['pod_health_failed', s => { s.podHealth = { status: 503 }; }],
    ['host_failure_not_refused', s => { s.hostHealth = { status: 503, category: 'http' }; }],
    ['host_failure_not_refused', s => { s.hostHealth = { status: 0, category: 'unavailable' }; }],
  ];
  for (const [code, change] of cases) {
    const f = fixture(change); await assert.rejects(f.recover(true), { recoveryCode: code });
    assert.equal(f.mutations().length, 0, code);
  }
});

test('control-plane Exists and exact Equal tolerations permit the replacement on the sole node', async () => {
  for (const [taint, toleration] of [
    [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }, { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' }],
    [{ key: 'dedicated', value: 'identity', effect: 'NoExecute' }, { key: 'dedicated', value: 'identity', operator: 'Equal', effect: 'NoExecute' }],
  ]) {
    const f = fixture(s => { s.nodes.items[0].spec = { taints: [taint] }; s.deployment.spec.template.spec.tolerations = [toleration]; });
    assert.equal((await f.recover(true)).action, 'recovered'); assert.equal(f.mutations().length, 1);
  }
});

test('state drift and spontaneous recovery between checks never cause a restart', async () => {
  const f = fixture(s => { s.onSnapshot = (state, n) => { if (n === 2) state.deployment.metadata.resourceVersion = 'concurrent-change'; }; });
  await assert.rejects(f.recover(true), { recoveryCode: 'state_changed' }); assert.equal(f.mutations().length, 0);
  const recovered = fixture(s => { s.onSnapshot = (state, n) => { if (n === 2) state.hostHealth = { status: 200 }; }; });
  assert.equal((await recovered.recover(true)).action, 'already_healthy'); assert.equal(recovered.mutations().length, 0);
});

test('uncertain patch/rollout and failed postchecks never replay a mutation or report success', async () => {
  for (const change of [s => { s.rejectPatch = true; }, s => { s.failRollout = true; },
    s => { s.keepOldPod = true; }, s => { s.postHealth = { status: 0, category: 'refused' }; }]) {
    const f = fixture(change); await assert.rejects(f.recover(true), { mutationAttempted: true }); assert.equal(f.mutations().length, 1);
  }
});

test('CLI acquires four nonblocking locks in cutover order and sanitizes lock failures', t => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-recovery-lock-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recorded = join(dir, 'calls.json'), preload = join(dir, 'platform.mjs');
  writeFileSync(preload, "Object.defineProperty(process,'platform',{value:'linux'});process.getuid=()=>0;\n");
  writeFileSync(join(dir, 'flock'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(recorded)},JSON.stringify(process.argv.slice(2)));process.stderr.write('private-lock-details');process.exit(73);\n`, { mode: 0o700 });
  const child = spawnSync(process.execPath, ['--import', preload,
    new URL('../scripts/recover-public-auth-hostport.mjs', import.meta.url).pathname, '--apply'],
  { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 1); assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { ok: false, code: 'operation_locked', stage: 'lock', mutationAttempted: false, restartSubmitted: false });
  const args = JSON.parse(readFileSync(recorded, 'utf8'));
  const expected = recoveryLocks.flatMap(lock => ['flock', '-n', '-E', '73', lock]).slice(1);
  assert.deepEqual(args.slice(0, expected.length), expected);
  assert.equal(args.at(-1), '--apply'); assert.equal(args.at(-2), '--locked');
});

test('real command failures retain only an allowlisted category and no command output', () => {
  for (const [stderr, category] of [
    ['Error from server (Conflict): private-credential', 'conflict'],
    ['testing value /metadata/resourceVersion failed: test failed private-credential', 'conflict'],
    ['Error from server (Forbidden): private-credential', 'forbidden'],
    ['Error from server (NotFound): private-credential', 'not_found'],
    ['error: unknown flag: --private-credential', 'invalid_argument'],
    ['error: timed out waiting for the condition private-credential', 'timeout'],
    ['private-credential unrecognized backend failure', 'unknown'],
  ]) {
    assert.throws(() => failedCommand(stderr), error => {
      const result = recoveryFailure(error);
      assert.equal(result.commandCategory, category); assert.equal(result.stage, 'preflight');
      assert.equal(result.mutationAttempted, false); assert.equal(result.restartSubmitted, false);
      assert.ok(!JSON.stringify(result).includes('private-credential')); return true;
    });
  }
  assert.throws(() => execute('/__mx_auth_missing_executable__', []), { commandCategory: 'exec_failure' });
  assert.throws(() => execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 }), { commandCategory: 'timeout' });
});

test('real command rejection distinguishes restart, rollout and postcheck without replay or false no-op', async () => {
  for (const [field, stderr, stage, submitted, category] of [
    ['patchCommandError', 'Error from server (Conflict): private-credential', 'restart', 'unknown', 'conflict'],
    ['rolloutCommandError', 'error: timed out waiting for the condition private-credential', 'rollout', true, 'timeout'],
    ['postcheckCommandError', 'Error from server (Forbidden): private-credential', 'postcheck', true, 'forbidden'],
  ]) {
    const f = fixture(state => { state[field] = stderr; });
    await assert.rejects(f.recover(true), error => {
      const result = recoveryFailure(error);
      assert.equal(result.stage, stage); assert.equal(result.restartSubmitted, submitted);
      assert.equal(result.commandCategory, category); assert.equal(result.mutationAttempted, true);
      assert.equal(result.attemptedAt, JSON.parse(f.mutations()[0].args.at(-1))[2].value);
      assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('private-credential')); return true;
    });
    assert.equal(f.mutations().length, 1);
  }
});

test('an actual outer process timeout leaves apply outcome unknown even if stdout looked successful', () => {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write("private-credential");setInterval(()=>{},1000)'],
    { encoding: 'utf8', timeout: 100 });
  assert.equal(result.error.code, 'ETIMEDOUT');
  assert.deepEqual(wrapperFailure(result, true), { ok: false, code: 'recovery_failed', stage: 'wrapper',
    commandCategory: 'timeout', mutationAttempted: 'unknown', restartSubmitted: 'unknown' });
  assert.equal(wrapperFailure(result, false).mutationAttempted, false);
});

test('real kubectl accepts the credential-free CAS patch in argv without reopening stdin', t => {
  const available = spawnSync('kubectl', ['version', '--client', '-o', 'json'], { encoding: 'utf8', timeout: 5000 });
  if (available.error?.code === 'ENOENT') return t.skip('kubectl not installed');
  assert.equal(available.status, 0);
  const dir = mkdtempSync(join(tmpdir(), 'auth-recovery-kubectl-local-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'deployment.json');
  writeFileSync(file, JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: NAME, uid: 'fixture-uid', resourceVersion: '10' },
    spec: { template: { metadata: { annotations: {} } } } }));
  const patch = [{ op: 'test', path: '/metadata/uid', value: 'fixture-uid' },
    { op: 'test', path: '/metadata/resourceVersion', value: '10' },
    { op: 'add', path: '/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt', value: '2026-10-21T12:00:00.000Z' }];
  const args = ['--kubeconfig=/dev/null', 'patch', '--local', '-f', file, '--type=json', '-p', JSON.stringify(patch), '-o', 'json'];
  const result = JSON.parse(execute('kubectl', args));
  assert.equal(result.metadata.uid, 'fixture-uid');
  assert.equal(result.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'], patch[2].value);
});
