import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manage.sh'), 'utf8');
function shellFunction(name) {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(body, `missing function ${name}`);
  // The tests run on a desktop. Simulate the local kubeadm host marker without
  // creating or altering /etc/kubernetes or the caller's kubeconfig.
  return body.replace('[ -f /etc/kubernetes/manifests/kube-apiserver.yaml ] || return 0', ':');
}
function run(script, env = {}) {
  return spawnSync('bash', ['-c', `set -Eeuo pipefail
say() { printf '%s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
sleep() { :; }
${script}`], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10000 });
}

test('ready Flannel still updates a stale API address, preserves images and skips the second update', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-flannel-test-'));
  try {
    const result = run(`
${shellFunction('k8s_detect_lan_ip')}
${shellFunction('k8s_is_usable_lan_ip')}
${shellFunction('k8s_repair_flannel_apiserver_env')}
${shellFunction('k8s_repair_flannel_cni')}
${shellFunction('k8s_wait_flannel_subnet_env')}
k8s_flannel_subnet_ready() { return 0; }
k8s_flannel_daemonset_ready() { return 0; }
k8s_patch_flannel_pod_cidr() { K8S_FLANNEL_POD_CIDR_PATCHED=0; }
k8s_flannel_diagnostics() { echo diagnostics; }
kubectl() {
  printf '%s\\n' "$*" >> "$MX_TEST_DIR/calls"
  case "$*" in
    *get*--ignore-not-found*) echo daemonset.apps/kube-flannel-ds ;;
    *get*jsonpath*)
      if [ -f "$MX_TEST_DIR/updated" ]; then
        echo KUBERNETES_SERVICE_HOST=10.22.33.44
      else
        echo KUBERNETES_SERVICE_HOST=192.168.1.4
      fi
      echo KUBERNETES_SERVICE_PORT=6443 ;;
    *--raw=/readyz*) echo ok ;;
    *'get daemonset kube-flannel-ds -o json'*) echo '{"kind":"DaemonSet"}' ;;
    *'set env'*) touch "$MX_TEST_DIR/updated" ;;
    *'rollout status'*) return 0 ;;
    *) echo "unexpected kubectl call" >&2; return 97 ;;
  esac
}
k8s_repair_flannel_cni
k8s_repair_flannel_cni
`, { MX_TEST_DIR: dir, MX_K8S_ENDPOINT_BACKUP_DIR: dir, MX_K8S_APISERVER_ADVERTISE_ADDRESS: '10.22.33.44',
      MX_K8S_FLANNEL_APISERVER_HOST: '', MX_K8S_FLANNEL_APISERVER_PORT: '', MX_K8S_FLANNEL_DIRECT_APISERVER: '1',
      MX_K8S_REPAIR_FLANNEL: '1', MX_K8S_FLANNEL_IMAGE_REPOSITORY: '', K8S_FLANNEL_IMAGE_REPOSITORY: '' });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    assert.equal(calls.split('\n').filter(l => l.includes('set env')).length, 1);
    assert.match(calls, /KUBERNETES_SERVICE_HOST=10\.22\.33\.44 KUBERNETES_SERVICE_PORT=6443/);
    assert.doesNotMatch(calls, /apply|set image|rollout restart/);
    assert.equal(calls.split('\n').filter(l => l.includes('rollout status')).length, 2);
    const backups = readdirSync(dir).filter(f => f.startsWith('mx-flannel-endpoint-'));
    assert.equal(backups.length, 1);
    assert.equal(statSync(join(dir, backups[0])).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, backups[0], 'daemonset-before.json')).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Flannel sync failure and missing subnet lease stop recovery instead of reporting success', () => {
  for (const failure of ['sync', 'subnet']) {
    const result = run(`
${shellFunction('k8s_repair_flannel_cni')}
k8s_patch_flannel_pod_cidr() { K8S_FLANNEL_POD_CIDR_PATCHED=0; }
kubectl() { echo daemonset.apps/kube-flannel-ds; }
k8s_repair_flannel_apiserver_env() { ${failure === 'sync' ? 'return 29' : ':'}; }
k8s_wait_flannel_subnet_env() { return 1; }
k8s_flannel_diagnostics() { echo diagnostics; }
k8s_repair_flannel_cni
echo UNEXPECTED_SUCCESS
`, { MX_K8S_REPAIR_FLANNEL: '1', MX_K8S_FLANNEL_IMAGE_REPOSITORY: '', K8S_FLANNEL_IMAGE_REPOSITORY: '' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_SUCCESS/);
    if (failure === 'subnet') assert.match(result.stderr, /did not create/);
  }
});

test('API Service verification uses the discovered IP, keeps TLS on and bypasses proxies', () => {
  const result = run(`
${shellFunction('k8s_append_no_proxy_entries')}
${shellFunction('k8s_require_api_service_ready')}
kubectl() {
  case "$*" in
    *'get service kubernetes'*) echo 10.96.0.1 ;;
    *)
      [[ "$*" == *'--server=https://10.96.0.1:443'* ]] || return 1
      [[ "$*" == *'--insecure-skip-tls-verify=false'* ]] || return 1
      [[ "$*" == *'--request-timeout=5s get --raw=/readyz'* ]] || return 1
      [[ "$NO_PROXY" == 'localhost,10.96.0.1' ]] || return 1
      [[ "$no_proxy" == '127.0.0.1,10.96.0.1' ]] ;;
  esac
}
k8s_require_api_service_ready
`, { NO_PROXY: 'localhost', no_proxy: '127.0.0.1', MX_K8S_API_SERVICE_WAIT_ATTEMPTS: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Service forwarding and TLS check OK/);
});

test('a running kube-proxy with broken Service forwarding cannot pass the network gate', () => {
  const result = run(`
${shellFunction('k8s_append_no_proxy_entries')}
${shellFunction('k8s_require_api_service_ready')}
${shellFunction('k8s_recover_cluster_network')}
k8s_repair_kube_proxy_endpoint() { echo kube-proxy-rollout-ready; }
k8s_repair_flannel_cni() { echo flannel-ready; }
kubectl() {
  case "$*" in
    *'get service kubernetes'*) echo 192.168.240.1 ;;
    *--raw=/readyz*) return 1 ;;
    *) echo kube-proxy-Running ;;
  esac
}
k8s_recover_cluster_network
echo UNEXPECTED_BUILD
`, { MX_K8S_API_SERVICE_WAIT_ATTEMPTS: '2' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not ready: 2\/2/);
  assert.match(result.stderr, /API Service is unreachable/);
  assert.doesNotMatch(result.stdout, /UNEXPECTED_BUILD/);
});

test('production gates run before repair/build, and DNS waits until runtime images are preloaded', () => {
  const deploy = source.match(/    deploy\|cycle\)\n([\s\S]*?)\n    apply\)/)[1];
  const ordered = ['internal_production_predeploy_gate', 'k8s_repair_kubeadm_endpoint',
    'k8s_preflight_secret_bundle', 'k8s_recover_cluster_network', 'shadow_image_build',
    'k8s_preload_runtime_images', 'k8s_apply internal-shadow'];
  let previous = -1;
  for (const call of ordered) {
    const pos = deploy.indexOf(call);
    assert.ok(pos > previous, `${call} must follow the previous gate`);
    previous = pos;
  }
  const apply = shellFunction('k8s_apply');
  assert.ok(apply.indexOf('k8s_recover_cluster_network') < apply.indexOf('k8s_recover_cluster_dns'));
  assert.ok(apply.indexOf('k8s_recover_cluster_dns') < apply.indexOf('k8s_ensure_secret_bundle'));
});

test('repair-network runs only control-plane/network recovery and no MX deployment or credentials', () => {
  const body = source.match(/    repair-network\)\n([\s\S]*?)\n      ;;/)[1];
  assert.doesNotMatch(body, /k8s_apply|secret|postgres|migration|shadow_image|reinit/);
  const result = run(`
k8s_repair_kubeadm_endpoint() { echo control-plane; }
k8s_require_apiserver_ready() { echo direct-api; }
k8s_recover_cluster_network() { echo service-network; }
k8s_recover_cluster_dns() { echo dns; }
${body}
`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').slice(0, 4), ['control-plane', 'direct-api', 'service-network', 'dns']);
});
