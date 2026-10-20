import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const directory = dirname(fileURLToPath(import.meta.url));
const library = join(directory, 'k8s-control-plane.sh');
const manage = readFileSync(join(directory, 'manage.sh'), 'utf8');

function shell(body, env = {}) {
  return spawnSync('bash', ['-c', `set -Eeuo pipefail
say() { printf '%s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
sleep() { :; }
exec 3>&2
source "$MX_TEST_LIBRARY"
kubectl() {
  case "$*" in
    'config view --minify -o jsonpath={.clusters[0].cluster.server}')
      printf '%s' "$MX_TEST_SERVER" ;;
    '--request-timeout=5s get --raw=/readyz')
      printf 'probe NO_PROXY=%s no_proxy=%s KUBECONFIG=%s\\n' "$NO_PROXY" "$no_proxy" "$KUBECONFIG" >&3 ;;
    *) echo "unexpected kubectl: $*" >&2; return 97 ;;
  esac
}
${body}`], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, MX_TEST_LIBRARY: library,
      MX_TEST_SERVER: 'https://10.22.33.44:6443', KUBECONFIG: '/test/selected-context',
      MX_K8S_CONFIGURE_NO_PROXY: '1', MX_K8S_APISERVER_PREFLIGHT_ATTEMPTS: '1',
      MX_K8S_APISERVER_PREFLIGHT_TIMEOUT: '5s', NO_PROXY: 'existing.upper', no_proxy: 'existing.lower',
      MX_K8S_APISERVER_ADVERTISE_ADDRESS: '192.168.1.2',
      MX_K8S_POD_CIDR: '10.244.0.0/16', MX_K8S_SERVICE_CIDR: '10.96.0.0/12', ...env }
  });
}

test('sourceable preflight preserves the caller directory, trap and environment until invoked', () => {
  const result = shell(`
before_dir="$PWD"
trap ':' EXIT
before_trap="$(trap -p EXIT)"
source "$MX_TEST_LIBRARY"
[ "$PWD" = "$before_dir" ]
[ "$(trap -p EXIT)" = "$before_trap" ]
[ "$NO_PROXY" = existing.upper ]
[ "$KUBECONFIG" = /test/selected-context ]
echo SOURCE_ONLY
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'SOURCE_ONLY');
  assert.equal(result.stderr, '');
});

test('preflight bypasses the selected API host in the caller and preserves build proxies and context', () => {
  const result = shell(`
k8s_require_apiserver_ready
k8s_require_apiserver_ready
printf 'upper=%s\\nlower=%s\\nhttp=%s\\nhttps=%s\\nall=%s\\nbuild=%s\\nconfig=%s\\n' \\
  "$NO_PROXY" "$no_proxy" "$HTTP_PROXY" "$HTTPS_PROXY" "$ALL_PROXY" "$MX_LAUNCHER_BUILD_PROXY" "$KUBECONFIG"
`, { HTTP_PROXY: 'http://proxy:7788', HTTPS_PROXY: 'http://proxy:7788',
    ALL_PROXY: 'socks5://proxy:7789', MX_LAUNCHER_BUILD_PROXY: 'http://build-proxy:7790' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight current kube-apiserver https:\/\/10\.22\.33\.44:6443/);
  assert.doesNotMatch(result.stdout + result.stderr, /192\.168\.1\.2(?:,|:|\s)/);
  for (const [label, original] of [['upper', 'existing.upper'], ['lower', 'existing.lower']]) {
    const entries = result.stdout.match(new RegExp(`^${label}=(.*)$`, 'm'))[1].split(',');
    assert.equal(entries[0], original);
    assert.equal(entries.filter(value => value === '10.22.33.44').length, 1);
    assert.ok(entries.includes('10.244.0.0/16'));
    assert.ok(entries.includes('10.96.0.0/12'));
  }
  assert.match(result.stderr, /probe NO_PROXY=.*10\.22\.33\.44.*no_proxy=.*10\.22\.33\.44/);
  assert.match(result.stdout, /http=http:\/\/proxy:7788\nhttps=http:\/\/proxy:7788\nall=socks5:\/\/proxy:7789\nbuild=http:\/\/build-proxy:7790\nconfig=\/test\/selected-context/);
});

test('DNS and bracketed IPv6 kubeconfig hosts enter NO_PROXY without a port', () => {
  for (const [server, host] of [['https://api.cluster.test:7443', 'api.cluster.test'], ['https://[fd00::123]:6443', 'fd00::123']]) {
    const result = shell('k8s_require_apiserver_ready\nprintf "entries=%s\\n" "$NO_PROXY"', { MX_TEST_SERVER: server });
    assert.equal(result.status, 0, result.stderr);
    const entries = result.stdout.match(/^entries=(.*)$/m)[1].split(',');
    assert.ok(entries.includes(host));
    assert.ok(!entries.includes(server));
  }
});

test('NO_PROXY opt-out preserves both caller values while still checking the selected endpoint', () => {
  const result = shell('k8s_require_apiserver_ready', { MX_K8S_CONFIGURE_NO_PROXY: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /probe NO_PROXY=existing.upper no_proxy=existing.lower KUBECONFIG=\/test\/selected-context/);
  assert.doesNotMatch(result.stdout, /NO_PROXY includes/);
});

test('invalid budgets fail before requests instead of permitting unlimited waits', () => {
  for (const env of [
    { MX_K8S_APISERVER_PREFLIGHT_ATTEMPTS: '0' },
    { MX_K8S_APISERVER_PREFLIGHT_ATTEMPTS: '-1' },
    { MX_K8S_APISERVER_PREFLIGHT_ATTEMPTS: 'bad' },
    { MX_K8S_APISERVER_PREFLIGHT_TIMEOUT: '0' },
    { MX_K8S_APISERVER_PREFLIGHT_TIMEOUT: '0s' },
    { MX_K8S_APISERVER_PREFLIGHT_TIMEOUT: 'bad' }
  ]) {
    const result = shell('k8s_require_apiserver_ready\necho UNEXPECTED_BUILD', env);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /probe NO_PROXY|UNEXPECTED_BUILD/);
  }
});

test('unusable kubeconfig endpoints fail closed without printing URL credentials', () => {
  for (const server of ['', 'file:///etc/kubernetes/admin.conf', 'https://user:private-token@cluster:6443', 'https://cluster:6443?token=private-token']) {
    const result = shell('k8s_require_apiserver_ready\necho UNEXPECTED_BUILD', { MX_TEST_SERVER: server });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /private-token|UNEXPECTED_BUILD|probe NO_PROXY/);
  }
});

test('endpoint-repair wait refreshes bypass after kubeconfig changes to a different private address', () => {
  const wait = manage.match(/^k8s_wait_apiserver_after_endpoint_repair\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(wait);
  const result = shell(`
${wait}
k8s_apiserver_endpoint_healthy() {
  case ",$NO_PROXY," in *,10.55.66.77,*) return 0 ;; esac
  return 1
}
k8s_apiserver_failure_diagnostics() { echo UNEXPECTED_FAILURE; }
k8s_configure_proxy_bypass
MX_TEST_SERVER=https://10.55.66.77:6443
k8s_wait_apiserver_after_endpoint_repair 10.55.66.77
`, { MX_K8S_APISERVER_REPAIR_WAIT_ATTEMPTS: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kube-apiserver endpoint is healthy/);
  assert.doesNotMatch(result.stdout, /UNEXPECTED_FAILURE/);
});

test('production deploy selects the local admin context before its first proxy endpoint read', () => {
  const dispatch = manage.match(/^ops_internal_production\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(dispatch);
  for (const action of ['deploy', 'cycle']) {
    const result = shell(`
${dispatch}
ops_internal_production_plan() { :; }
launcher_with_build_proxy() { "$@"; }
internal_production_predeploy_gate() { echo PREDEPLOY_GATE; }
k8s_prepare_production_host() { export KUBECONFIG=/etc/kubernetes/admin.conf; echo HOST_CONTEXT_SELECTED; }
kubectl() {
  [ "$KUBECONFIG" = /etc/kubernetes/admin.conf ] || { echo EARLY_CONTEXT_READ >&3; return 97; }
  [ "$1" = config ] || return 98
  echo https://10.22.33.44:6443
}
k8s_repair_kubeadm_endpoint() { echo ENDPOINT_REPAIR_NEXT; exit 0; }
ops_internal_production ${action}
`, { KUBECONFIG: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.indexOf('PREDEPLOY_GATE') < result.stdout.indexOf('HOST_CONTEXT_SELECTED'));
    assert.ok(result.stdout.indexOf('HOST_CONTEXT_SELECTED') < result.stdout.indexOf('NO_PROXY includes'));
    assert.ok(result.stdout.indexOf('NO_PROXY includes') < result.stdout.indexOf('ENDPOINT_REPAIR_NEXT'));
    assert.doesNotMatch(result.stderr, /EARLY_CONTEXT_READ/);
  }
});

test('explicit kubeadm reinit dispatch can run its existing recovery path without a current kubeconfig', () => {
  const dispatch = manage.match(/^ops_internal_production\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(dispatch);
  for (const action of ['reinit-kubeadm', 'reinit']) {
    const result = shell(`
${dispatch}
kubectl() { echo UNEXPECTED_EARLY_CONTEXT_READ >&3; return 97; }
ops_internal_production_reinit_kubeadm() { echo EXPLICIT_REINIT_HANDLER; }
ops_internal_production ${action}
`, { KUBECONFIG: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'EXPLICIT_REINIT_HANDLER');
    assert.equal(result.stderr, '');
  }
});

test('Launcher diagnostic command checks only the existing context without entering deployment or recovery', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mx-control-plane-command-'));
  try {
    writeFileSync(join(temp, 'kubectl'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MX_TEST_CALLS"
case "$*" in
  'config view --minify -o jsonpath={.clusters[0].cluster.server}') printf 'https://api.test:6443' ;;
  '--request-timeout=5s get --raw=/readyz')
    [[ ",$NO_PROXY," == *,api.test,* ]] || exit 91
    [[ ",$no_proxy," == *,api.test,* ]] || exit 92
    [ "$KUBECONFIG" = /test/selected-context ] || exit 93
    exit 0 ;;
  *) exit 97 ;;
esac
`);
    chmodSync(join(temp, 'kubectl'), 0o755);
    const result = spawnSync('bash', [join(directory, 'manage.sh'), 'ops', 'internal-production', 'control-plane-preflight'], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: `${temp}:${process.env.PATH}`,
        MX_TEST_CALLS: join(temp, 'calls'), MX_K8S_APISERVER_PREFLIGHT_TIMEOUT: '5s',
        KUBECONFIG: '/test/selected-context', NO_PROXY: '', no_proxy: '',
        MX_K8S_CONFIGURE_NO_PROXY: '1', MX_K8S_APISERVER_PREFLIGHT_ATTEMPTS: '1' }
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(join(temp, 'calls'), 'utf8').trim().split('\n');
    assert.equal(calls.filter(call => call.includes('get --raw=/readyz')).length, 1);
    assert.ok(calls.every(call => call.startsWith('config view --minify ') || call === '--request-timeout=5s get --raw=/readyz'));
    assert.match(result.stdout, /preflight current kube-apiserver https:\/\/api\.test:6443/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
