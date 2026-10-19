import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const directory = dirname(fileURLToPath(import.meta.url));
const recovery = readFileSync(join(directory, 'k8s-production-recovery.sh'), 'utf8');
const manage = readFileSync(join(directory, 'manage.sh'), 'utf8');
const installer = readFileSync(join(directory, 'install-k8s-centos.sh'), 'utf8');
function fn(name, source = recovery) {
  const result = source.match(new RegExp(`^${name}\\(\\) [({]\\n[\\s\\S]*?^[})]$`, 'm'))?.[0];
  assert.ok(result, name);
  return result;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mx-managed-runtime-'));
  const marker = join(dir, 'active.json'), helper = join(dir, 'resolve.py'), calls = join(dir, 'calls');
  writeFileSync(marker, '{"phase":"active"}');
  writeFileSync(calls, '');
  writeFileSync(helper, `import os, sys
with open(os.environ['CALLS'], 'a') as out: out.write('resolve ' + ' '.join(sys.argv[1:]) + '\\n')
if os.environ.get('RESOLVER_FAIL') == '1': sys.exit(9)
values = {'address': '/run/mx-k8s/containerd.sock', 'root': '/var/lib/mx-k8s/containerd', 'service': 'mx-k8s-containerd.service', 'cri-endpoint': 'unix:///run/mx-k8s/containerd.sock'}
print(values[sys.argv[1]])
`);
  writeFileSync(join(dir, 'recovery.sh'), recovery
    .replaceAll('/etc/mx-k8s-runtime/active.json', marker)
    .replaceAll('/usr/local/lib/mx-k8s-runtime/resolve.py', helper));
  return {
    dir, marker, helper,
    run(body, env = {}) {
      return spawnSync('bash', ['-c', `set -Eeuo pipefail
say() { :; }
die() { echo "$*" >&2; exit 1; }
source "$RECOVERY"
ctr() { printf 'ctr %s\\n' "$*" >> "$CALLS"; }
crictl() { printf 'crictl %s\\n' "$*" >> "$CALLS"; }
${body}`], { encoding: 'utf8', timeout: 10000, env: {
        ...process.env, RECOVERY: join(dir, 'recovery.sh'), CALLS: calls,
        MX_K8S_CONTAINERD_ADDRESS: '', CRI_SOCKET: '', RESOLVER_FAIL: '', ...env,
      } });
    },
    calls: () => readFileSync(calls, 'utf8'),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('managed ctr and CRI always use verified explicit endpoints, including ordinary operations', () => {
  const f = fixture();
  try {
    const result = f.run(`${fn('k8s_crictl', manage)}
k8s_ctr images import input.tar
k8s_crictl info
k8s_ctr images ls -q`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((f.calls().match(/^resolve address$/gm) || []).length, 3);
    assert.match(f.calls(), /^ctr --address \/run\/mx-k8s\/containerd.sock -n k8s.io images import input.tar$/m);
    assert.match(f.calls(), /^crictl --runtime-endpoint=unix:\/\/\/run\/mx-k8s\/containerd.sock --image-endpoint=unix:\/\/\/run\/mx-k8s\/containerd.sock info$/m);
    assert.doesNotMatch(f.calls(), /\/run\/containerd\/|systemctl|docker/);
  } finally { f.close(); }
});

test('a conflicting explicit address fails before contacting either runtime', () => {
  const f = fixture();
  try {
    const result = f.run('k8s_ctr images import input.tar', { MX_K8S_CONTAINERD_ADDRESS: '/run/containerd/containerd.sock' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match/);
    assert.doesNotMatch(f.calls(), /^ctr /m);
    const service = f.run('k8s_containerd_service --allow-stopped-kubelet', { MX_K8S_CONTAINERD_ADDRESS: '/run/containerd/containerd.sock' });
    assert.notEqual(service.status, 0);
    assert.doesNotMatch(f.calls(), /^resolve service/m);
  } finally { f.close(); }
});

test('missing resolver, failed validation and dangling marker never fall back, even in a conditional', () => {
  for (const mode of ['missing', 'invalid', 'dangling']) {
    const f = fixture();
    try {
      if (mode === 'missing' || mode === 'dangling') rmSync(f.helper);
      if (mode === 'dangling') { rmSync(f.marker); symlinkSync(join(f.dir, 'missing-descriptor'), f.marker); }
      const result = f.run(`if k8s_ctr images import input.tar; then echo UNEXPECTED_SUCCESS; else echo BLOCKED; fi`, { RESOLVER_FAIL: mode === 'invalid' ? '1' : '' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /BLOCKED/);
      assert.doesNotMatch(result.stdout, /UNEXPECTED/);
      assert.doesNotMatch(f.calls(), /^ctr /m);
    } finally { f.close(); }
  }
});

test('resolver failures and damaged Python never disclose raw diagnostics', () => {
  for (const source of [
    'import sys\nsys.stderr.write("PRIVATE_CONFIG_DIAGNOSTIC")\nsys.exit(9)\n',
    'PRIVATE_CONFIG_DIAGNOSTIC = (\n',
  ]) {
    const f = fixture();
    try {
      writeFileSync(f.helper, source);
      const result = f.run('k8s_ctr images import input.tar');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cannot verify the managed Kubernetes runtime/);
      assert.doesNotMatch(result.stderr, /PRIVATE_CONFIG_DIAGNOSTIC|SyntaxError|Traceback/);
      assert.doesNotMatch(f.calls(), /^ctr /m);
    } finally { f.close(); }
  }
});

test('stopped-service recovery requires unsetting explicit runtime overrides', () => {
  for (const field of ['root', 'service']) {
    const f = fixture();
    try {
      const result = f.run(`k8s_containerd_${field} --allow-stopped-kubelet`, {
        MX_K8S_CONTAINERD_ADDRESS: '/run/mx-k8s/containerd.sock',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unset MX_K8S_CONTAINERD_ADDRESS before stopped-service recovery/);
      assert.equal(f.calls(), '');
    } finally { f.close(); }
  }
});

test('unmanaged hosts retain the default and explicit ctr addresses without requiring the helper', () => {
  for (const override of ['', '/run/custom/containerd.sock']) {
    const f = fixture();
    try {
      rmSync(f.marker); rmSync(f.helper);
      const result = f.run('k8s_ctr version\nk8s_containerd_service --allow-stopped-kubelet\nk8s_containerd_root', { MX_K8S_CONTAINERD_ADDRESS: override });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(f.calls(), `ctr --address ${override || '/run/containerd/containerd.sock'} -n k8s.io version\n`);
      assert.match(result.stdout, /^containerd\n\/var\/lib\/containerd\n$/);
    } finally { f.close(); }
  }
});

test('disk preflight inspects the Kubernetes root rather than the retained Docker runtime', () => {
  const f = fixture();
  try {
    const result = f.run(`kubectl() { echo False; }
df() { echo "df $*" >> "$CALLS"; printf 'Filesystem Blocks Used Available Capacity Mounted\\nfixture 100 90 10 90%% /\\n'; }
sed() { :; }
k8s_production_disk_preflight`, { K8S_RECOVERY_NODE: 'fixture' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.calls(), /^resolve root$/m);
    assert.match(f.calls(), /^df -P \/var\/lib\/mx-k8s\/containerd$/m);
    assert.doesNotMatch(f.calls(), /df .* \/var\/lib\/containerd/);
  } finally { f.close(); }
});

test('repair-cni restarts only the managed runtime and kubelet and diagnoses the matching CRI', () => {
  const f = fixture();
  try {
    const conf = join(f.dir, 'cni'), bin = join(f.dir, 'bin'), subnet = join(f.dir, 'subnet.env');
    mkdirSync(conf); mkdirSync(bin);
    writeFileSync(join(conf, '10-flannel.conflist'), '{}');
    writeFileSync(subnet, 'FLANNEL_NETWORK=10.0.0.0/8');
    for (const plugin of ['flannel', 'loopback', 'bridge', 'host-local', 'portmap']) writeFileSync(join(bin, plugin), '', { mode: 0o755 });
    const repair = fn('ops_internal_production_repair_cni', manage)
      .replaceAll('/etc/cni/net.d', conf).replaceAll('/opt/cni/bin', bin).replaceAll('/run/flannel/subnet.env', subnet);
    const result = f.run(`${fn('k8s_crictl', manage)}
${repair}
systemctl() { echo "systemctl $*" >> "$CALLS"; }
kubectl() { echo "kubectl $*" >> "$CALLS"; }
ops_internal_production_repair_cni`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.calls(), /^resolve service --allow-stopped-kubelet$/m);
    assert.deepEqual(f.calls().split('\n').filter(v => v.startsWith('systemctl ')), [
      'systemctl restart mx-k8s-containerd.service', 'systemctl restart kubelet',
    ]);
    assert.match(f.calls(), /crictl --runtime-endpoint=unix:\/\/\/run\/mx-k8s\/containerd.sock/);
  } finally { f.close(); }
});

test('production recovery can start the verified service before kubelet, without restarting Docker', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'kube-apiserver.yaml'), 'fixture');
    const prepare = fn('k8s_prepare_production_host')
      .replace('/etc/kubernetes/manifests/kube-apiserver.yaml', join(f.dir, 'kube-apiserver.yaml'))
      .replace('/run/mx-launcher-deploy.lock', join(f.dir, 'deploy.lock'));
    const result = f.run(`${prepare}
uname() { echo Linux; }
id() { echo 0; }
flock() { :; }
k8s_detect_node_name() { echo fixture; }
k8s_production_recovery_state() { :; }
k8s_resolve_containerd_address() { :; }
systemctl() { echo "systemctl $*" >> "$CALLS"; [ "$1" != is-active ]; }
timeout() { shift; "$@"; }
k8s_prepare_production_host`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls().split('\n').filter(v => v.startsWith('systemctl start ')), [
      'systemctl start mx-k8s-containerd.service', 'systemctl start kubelet', 'systemctl start docker',
    ]);
    assert.doesNotMatch(f.calls(), /systemctl restart|systemctl start containerd/);
  } finally { f.close(); }
});

test('installer blocks managed default reconfiguration before any host mutation', () => {
  const f = fixture();
  try {
    const result = f.run(`${fn('configure_runtime_selection', installer)}
${fn('main', installer)}
require_root() { :; }
detect_rhel_family() { :; }
disable_swap() { echo UNEXPECTED_MUTATION; }
main`, { K8S_CONFIGURE_CONTAINERD: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /K8S_CONFIGURE_CONTAINERD=0/);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_MUTATION/);
  } finally { f.close(); }
});

test('installer selects the managed CRI and rejects a conflicting requested socket', () => {
  for (const requested of ['', 'unix:///run/mx-k8s/containerd.sock', 'unix:///run/containerd/containerd.sock']) {
    const f = fixture();
    try {
      const result = f.run(`${fn('configure_runtime_selection', installer)}
configure_runtime_selection
printf '%s\\n' "$CRI_SOCKET"`, { K8S_CONFIGURE_CONTAINERD: '0', CRI_SOCKET: requested });
      if (requested === 'unix:///run/containerd/containerd.sock') {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /does not match/);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'unix:///run/mx-k8s/containerd.sock\n');
      }
    } finally { f.close(); }
  }
});

test('installer CNI reload selects the managed service and never reconfigures Docker', () => {
  const f = fixture();
  try {
    const result = f.run(`${fn('restart_runtime_after_cni', installer)}
run_allow_fail() { echo "$*" >> "$CALLS"; }
restart_runtime_after_cni`, { SKIP_INIT: '0', K8S_RESTART_RUNTIME_AFTER_CNI: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls().split('\n').filter(v => v.startsWith('systemctl ')), [
      'systemctl restart mx-k8s-containerd.service', 'systemctl restart kubelet',
    ]);
    const blocked = f.run(`${fn('configure_containerd', installer)}
package_manager() { echo UNEXPECTED; }
configure_containerd`, { K8S_CONFIGURE_CONTAINERD: '1' });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /refusing to rewrite/);
    assert.doesNotMatch(blocked.stdout, /UNEXPECTED/);
  } finally { f.close(); }
});

test('explicit reinit passes the managed CRI socket and blocks an unavailable resolver before credentials', () => {
  for (const failed of [false, true]) {
    const f = fixture();
    try {
      const result = f.run(`${fn('ops_internal_production_reinit_kubeadm', manage)}
k8s_detect_lan_ip() { echo 10.0.0.1; }
k8s_is_usable_lan_ip() { return 0; }
k8s_is_valid_node_name() { return 0; }
k8s_namespace() { echo fixture; }
k8s_require_db_recovery_env() { echo CREDENTIAL_CHECK >> "$CALLS"; }
kubectl() { return 1; }
bash() { echo "installer CRI_SOCKET=$CRI_SOCKET $*" >> "$CALLS"; }
ops_internal_production_reinit_kubeadm`, { ROOT: '/fixture', MX_K8S_NODE_NAME: 'fixture', RESOLVER_FAIL: failed ? '1' : '' });
      if (failed) {
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(f.calls(), /CREDENTIAL_CHECK|installer /);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(f.calls(), /^installer CRI_SOCKET=unix:\/\/\/run\/mx-k8s\/containerd.sock /m);
      }
    } finally { f.close(); }
  }
});

test('legacy discovery honors the running CLI, its actual config, and only then instance fallback', () => {
  const program = fn('k8s_resolve_containerd_address').match(/discovered="\$\(node -e '([\s\S]*?)\n    '\)"/)[1];
  for (const [args, configValue, expected] of [
    [['kubelet', '--config=/custom/kubelet.yaml'], 'unix:///run/config.sock', '/run/config.sock'],
    [['kubelet', '--config', '/custom/kubelet.yaml', '--container-runtime-endpoint=unix:///run/cli.sock'], 'unix:///run/config.sock', '/run/cli.sock'],
    [['kubelet', '--config', '/custom/kubelet.yaml', '--container-runtime-endpoint', 'unix:///run/cli.sock'], '', '/run/cli.sock'],
    [['kubelet', '--config=/custom/kubelet.yaml'], '', '/run/instance.sock'],
  ]) {
    const files = new Map([
      ['/proc/42/cmdline', args.join('\0')],
      ['/custom/kubelet.yaml', configValue ? `containerRuntimeEndpoint: ${configValue}\n` : 'apiVersion: kubelet.config.k8s.io/v1beta1\n'],
      ['/var/lib/kubelet/instance-config.yaml', 'containerRuntimeEndpoint: unix:///run/instance.sock\n'],
    ]);
    let output = '';
    vm.runInNewContext(program, {
      require(name) {
        if (name === 'fs') return { existsSync: path => files.has(path), readFileSync: path => files.get(path) };
        if (name === 'child_process') return { spawnSync: () => ({ status: 0, stdout: '42\n' }) };
        throw new Error(name);
      },
      process: { stdout: { write: value => { output += value; } }, exit: code => { throw new Error(`exit ${code}`); } },
    });
    assert.equal(output, expected);
  }
});
