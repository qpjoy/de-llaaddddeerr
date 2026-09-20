import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { apiEndpoint, planEndpointRepair, repairEndpoint } from './k8s-kube-proxy-endpoint.mjs';

function fixture(server = 'https://192.168.1.4:6443') {
  const kubeconfig = `apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    server: "${server}" # retain this comment
  name: default
contexts:
- context:
    cluster: default
    user: default
  name: default
current-context: default
users:
- name: default
  user:
    tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
`;
  return {
    cm: { kind: 'ConfigMap', metadata: { name: 'kube-proxy', namespace: 'kube-system', resourceVersion: '40' },
      data: { 'kubeconfig.conf': kubeconfig, 'config.conf': 'clusterCIDR: 192.168.224.0/20\nmode: iptables\n' } },
    ds: { kind: 'DaemonSet', metadata: { name: 'kube-proxy', namespace: 'kube-system', resourceVersion: '50' },
      spec: { updateStrategy: { type: 'RollingUpdate' }, template: {
        metadata: { annotations: { keep: 'unchanged' } },
        spec: { hostNetwork: true, volumes: [{ configMap: { name: 'kube-proxy' } }] }
      } } },
    config: { clusters: [{ name: 'default', cluster: { server } }],
      contexts: [{ name: 'default', context: { cluster: 'default', user: 'default' } }], 'current-context': 'default' }
  };
}

function applyPlan(state, plan) {
  if (plan.configPatch) {
    state.cm.data['kubeconfig.conf'] = plan.configPatch.at(-1).value;
    state.cm.metadata.resourceVersion = '41';
    state.config.clusters[0].cluster.server = plan.endpoint;
  }
  if (plan.rolloutPatch) Object.assign(state.ds.spec.template.metadata.annotations, plan.rolloutPatch.spec.template.metadata.annotations);
}

test('only the server changes; CA, identity, CIDR, mode and metadata are retained', () => {
  for (const host of ['192.168.1.2', '10.22.33.44']) {
    const state = fixture();
    state.cm.data['kubeconfig.conf'] = state.cm.data['kubeconfig.conf'].replaceAll('\n', '\r\n');
    const before = structuredClone(state);
    const plan = planEndpointRepair(state.cm, state.ds, state.config, host);
    assert.deepEqual(state, before, 'planning must not mutate the input');
    assert.deepEqual(plan.configPatch.slice(0, 2).map(p => [p.op, p.path]), [
      ['test', '/metadata/resourceVersion'], ['test', '/data/kubeconfig.conf']
    ]);
    assert.equal(plan.configPatch[0].value, '40');
    assert.equal(plan.configPatch.at(-1).value,
      before.cm.data['kubeconfig.conf'].replace('https://192.168.1.4:6443', `https://${host}:6443`));
    applyPlan(state, plan);
    assert.equal(state.cm.data['config.conf'], before.cm.data['config.conf']);
    assert.equal(state.ds.spec.template.metadata.annotations.keep, 'unchanged');
    const next = planEndpointRepair(state.cm, state.ds, state.config, host);
    assert.equal(next.configPatch, null);
    assert.equal(next.rolloutPatch, null, 'repeat runs must not restart kube-proxy');
  }
});

test('a corrected ConfigMap without a completed template update still schedules rollout', () => {
  const state = fixture('https://192.168.1.2:6443');
  const plan = planEndpointRepair(state.cm, state.ds, state.config, '192.168.1.2');
  assert.equal(plan.configPatch, null);
  assert.ok(plan.rolloutPatch);
  assert.equal(plan.rolloutPatch.metadata.resourceVersion, '50');
});

test('invalid targets and ambiguous/nonstandard resources fail closed', () => {
  for (const host of ['', 'hostname', '127.0.0.1', '0.0.0.0', '169.254.1.1', '192.168.999.2', '192.168.1.2:6443']) {
    assert.throws(() => apiEndpoint(host), /usable IPv4/);
  }
  for (const alter of [
    s => s.config.clusters.push({ name: 'another' }),
    s => s.config['current-context'] = 'missing',
    s => s.cm.data['kubeconfig.conf'] += 'server: https://192.168.1.5:6443\n',
    s => s.ds.spec.updateStrategy.type = 'OnDelete',
    s => s.ds.spec.template.spec.hostNetwork = false,
    s => s.ds.spec.template.spec.volumes = [],
    s => s.cm.metadata.namespace = 'unrelated',
    s => delete s.cm.metadata.resourceVersion
  ]) {
    const state = fixture();
    alter(state);
    assert.throws(() => planEndpointRepair(state.cm, state.ds, state.config, '192.168.1.2'));
  }
});

function mockKubectl(state, calls, fail = '') {
  return (args, input) => {
    calls.push(args);
    if (args.includes('--raw=/readyz')) {
      if (fail === 'tls') throw new Error('TLS failure');
      return 'ok';
    }
    if (args.includes('view')) {
      assert.equal(input, state.cm.data['kubeconfig.conf']);
      return JSON.stringify(state.config);
    }
    const kind = args.includes('configmap') ? 'cm' : 'ds';
    if (args.includes('get')) return JSON.stringify(state[kind]);
    assert.ok(args.includes('patch'));
    const path = args[args.indexOf('--patch-file') + 1];
    const patch = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    if (fail === kind) throw new Error('resourceVersion conflict');
    if (kind === 'cm') {
      assert.equal(patch[0].value, state.cm.metadata.resourceVersion);
      assert.equal(patch[1].value, state.cm.data['kubeconfig.conf']);
      state.cm.data['kubeconfig.conf'] = patch[2].value;
      state.config.clusters[0].cluster.server = 'https://192.168.1.2:6443';
      state.cm.metadata.resourceVersion = '41';
    } else Object.assign(state.ds.spec.template.metadata.annotations, patch.spec.template.metadata.annotations);
    return 'patched';
  };
}

test('repair backs up before patching, retries interrupted rollout and then is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-kube-proxy-test-'));
  const state = fixture();
  const calls = [];
  const before = structuredClone(state);
  try {
    assert.throws(() => repairEndpoint('192.168.1.2', dir, mockKubectl(state, calls, 'ds')), /conflict/);
    const backup = join(dir, readdirSync(dir)[0]);
    assert.equal(statSync(backup).mode & 0o777, 0o700);
    for (const [file, original] of [['configmap-before.json', before.cm], ['daemonset-before.json', before.ds]]) {
      assert.equal(statSync(join(backup, file)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(join(backup, file))), original);
    }
    calls.length = 0;
    repairEndpoint('192.168.1.2', dir, mockKubectl(state, calls));
    assert.equal(calls.filter(a => a.includes('patch') && a.includes('configmap')).length, 0);
    assert.equal(calls.filter(a => a.includes('patch') && a.includes('daemonset')).length, 1);
    calls.length = 0;
    const backupCount = readdirSync(dir).length;
    repairEndpoint('192.168.1.2', dir, mockKubectl(state, calls));
    assert.equal(calls.filter(a => a.includes('patch')).length, 0);
    assert.equal(readdirSync(dir).length, backupCount);
    assert.ok(calls.every(a => a.includes('--kubeconfig=/dev/stdin') ||
      (a.includes('--server=https://192.168.1.2:6443') && a.includes('--insecure-skip-tls-verify=false'))));
    assert.ok(calls.every(a => !a.some(x => /secret|postgres|pvc|delete|apply/.test(x))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed API check or conflicting ConfigMap never triggers a rollout', () => {
  for (const fail of ['tls', 'cm']) {
    const dir = mkdtempSync(join(tmpdir(), 'mx-kube-proxy-test-'));
    const calls = [];
    try {
      assert.throws(() => repairEndpoint('192.168.1.2', dir, mockKubectl(fixture(), calls, fail)));
      assert.ok(!calls.some(a => a.includes('patch') && a.includes('daemonset')));
      if (fail === 'tls') assert.equal(readdirSync(dir).length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('kubectl can parse the untouched and repaired kubeconfig locally through stdin', t => {
  const state = fixture();
  const parse = input => spawnSync('kubectl', ['--kubeconfig=/dev/stdin', 'config', 'view', '--raw', '-o', 'json'], { input, encoding: 'utf8' });
  const before = parse(state.cm.data['kubeconfig.conf']);
  if (before.error?.code === 'ENOENT') return t.skip('kubectl not installed');
  assert.equal(before.status, 0, before.stderr);
  const parsed = JSON.parse(before.stdout);
  const plan = planEndpointRepair(state.cm, state.ds, parsed, '192.168.1.2');
  const after = parse(plan.configPatch.at(-1).value);
  assert.equal(after.status, 0, after.stderr);
  parsed.clusters[0].cluster.server = 'https://192.168.1.2:6443';
  assert.deepEqual(JSON.parse(after.stdout), parsed);
});
