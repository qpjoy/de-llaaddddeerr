import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manage.sh'), 'utf8');
function shellFunction(name) {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(body, `missing function ${name}`);
  // Simulate only the local kubeadm marker. No host configuration is created.
  return body.replace('[ -f /etc/kubernetes/manifests/kube-apiserver.yaml ] || return 0', ':');
}

function run(script, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mx-control-plane-health-'));
  try {
    const result = spawnSync('bash', ['-c', `set -Eeuo pipefail
say() { printf '%s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
sleep() { :; }
need_kubectl() { :; }
k8s_detect_lan_ip() { echo 192.168.1.2; }
k8s_apiserver_failure_diagnostics() { echo diagnostics >> "$MX_TEST_DIR/actions"; }
kubectl() {
  printf '%s\\n' "$*" >> "$MX_TEST_DIR/calls"
  case "$*" in
    *'--raw=/version'*) echo version; return 0 ;;
    *'--raw=/readyz?verbose'*) echo '[-]etcd failed'; return 1 ;;
    *'--raw=/readyz'*)
      local count=0
      [ ! -f "$MX_TEST_DIR/count" ] || read -r count < "$MX_TEST_DIR/count"
      count=$((count + 1))
      printf '%s\\n' "$count" > "$MX_TEST_DIR/count"
      [ "$count" -gt "$MX_TEST_FAILURES" ] ;;
    *) echo "unexpected kubectl call: $*" >&2; return 97 ;;
  esac
}
${script}`], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, MX_TEST_DIR: directory, MX_TEST_FAILURES: '0',
        MX_K8S_APISERVER_PREFLIGHT_ATTEMPTS: '3', MX_K8S_APISERVER_PREFLIGHT_TIMEOUT: '3s',
        MX_K8S_AUTO_REPAIR_KUBEADM_ENDPOINT: '1', ...env }
    });
    const read = name => {
      try { return readFileSync(join(directory, name), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    };
    return { ...result, calls: read('calls').trim().split('\n').filter(Boolean), actions: read('actions') };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const healthFunctions = `${shellFunction('k8s_apiserver_endpoint_healthy')}
${shellFunction('k8s_require_apiserver_ready')}`;

const repairFunctions = `${healthFunctions}
${shellFunction('k8s_repair_kubeadm_endpoint')}
k8s_apply_requested_os_hostname() { :; }
k8s_detect_node_name() { echo mx-internal-server; }
k8s_is_usable_lan_ip() { return 0; }
k8s_kubeadm_endpoint_ips() { echo 192.168.1.2; }
k8s_kubeadm_endpoint_files() { :; }
k8s_kubeadm_cert_repair_needed_for_ip() { return 1; }
k8s_node_internal_ip_repair_needed() { return 1; }
k8s_kubelet_flags_need_repair() { return 1; }
systemctl() { printf 'systemctl %s\\n' "$*" >> "$MX_TEST_DIR/actions"; }
k8s_restart_static_pod_containers() { printf 'restart static pods %s\\n' "$*" >> "$MX_TEST_DIR/actions"; }
k8s_wait_apiserver_after_endpoint_repair() { echo repair-wait >> "$MX_TEST_DIR/actions"; }
k8s_wait_node_internal_ip() { :; }
k8s_wait_control_plane_observers() { :; }
`;

test('control-plane health rejects an unhealthy readyz even when version remains reachable', () => {
  const result = run(`${healthFunctions}
k8s_apiserver_endpoint_healthy
echo UNEXPECTED_HEALTHY`, { MX_TEST_FAILURES: '20' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, ['--request-timeout=5s get --raw=/readyz']);
  assert.doesNotMatch(result.stdout, /UNEXPECTED_HEALTHY/);
});

test('readiness preflight tolerates a transient outage with bounded read-only requests', () => {
  const result = run(`${healthFunctions}
k8s_require_apiserver_ready`, { MX_TEST_FAILURES: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    '--request-timeout=3s get --raw=/readyz',
    '--request-timeout=3s get --raw=/readyz'
  ]);
  assert.equal(result.actions, '');
});

test('persistent readiness failure stops deploy after bounded retries and prints verbose health evidence', () => {
  const result = run(`${healthFunctions}
k8s_require_apiserver_ready
echo UNEXPECTED_DEPLOY`, { MX_TEST_FAILURES: '20' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, [
    '--request-timeout=3s get --raw=/readyz',
    '--request-timeout=3s get --raw=/readyz',
    '--request-timeout=3s get --raw=/readyz',
    '--request-timeout=3s get --raw=/readyz?verbose'
  ]);
  assert.equal(result.actions, 'diagnostics\n');
  assert.match(result.stdout, /etcd failed/);
  assert.doesNotMatch(result.stdout, /UNEXPECTED_DEPLOY/);
});

test('unchanged control-plane configuration recovers from transient readiness failure without restarting services', () => {
  const result = run(`${repairFunctions}
k8s_repair_kubeadm_endpoint`, { MX_TEST_FAILURES: '2' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    '--request-timeout=5s get --raw=/readyz',
    '--request-timeout=3s get --raw=/readyz',
    '--request-timeout=3s get --raw=/readyz'
  ]);
  assert.equal(result.actions, '');
});

test('unchanged control-plane configuration fails closed on persistent outage without recycling etcd or apiserver', () => {
  const result = run(`${repairFunctions}
k8s_repair_kubeadm_endpoint
echo UNEXPECTED_DEPLOY`, { MX_TEST_FAILURES: '20' });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 5);
  assert.equal(result.actions, 'diagnostics\n');
  assert.doesNotMatch(result.stdout, /UNEXPECTED_DEPLOY/);
  assert.doesNotMatch(result.actions, /systemctl|restart static pods|repair-wait/);
});

test('healthy unchanged control-plane configuration needs no retry or recovery action', () => {
  const result = run(`${repairFunctions}
k8s_repair_kubeadm_endpoint`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['--request-timeout=5s get --raw=/readyz']);
  assert.equal(result.actions, '');
});

test('a confirmed certificate configuration change still follows the existing repair and restart path', () => {
  const result = run(`${repairFunctions}
k8s_kubeadm_cert_repair_needed_for_ip() { return 0; }
mkdir() { :; }
k8s_repair_apiserver_cert_if_needed() { echo repair-apiserver-cert >> "$MX_TEST_DIR/actions"; }
k8s_repair_etcd_certs_if_needed() { echo repair-etcd-cert >> "$MX_TEST_DIR/actions"; }
k8s_repair_kubelet_identity_if_needed() { :; }
k8s_repair_kubeadm_endpoint`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
  assert.equal(result.actions, [
    'repair-apiserver-cert', 'repair-etcd-cert', 'systemctl restart kubelet',
    'restart static pods etcd kube-apiserver kube-controller-manager kube-scheduler', 'repair-wait', ''
  ].join('\n'));
});
