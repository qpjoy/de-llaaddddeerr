import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const directory = dirname(fileURLToPath(import.meta.url));
const manage = readFileSync(join(directory, 'manage.sh'), 'utf8');
const recovery = readFileSync(join(directory, 'k8s-production-recovery.sh'), 'utf8');
function fn(name, source = recovery) {
  const result = source.match(new RegExp(`^${name}\\(\\) [({]\\n[\\s\\S]*?^[})]$`, 'm'))?.[0];
  assert.ok(result, name); return result;
}
function shell(body, env = {}) {
  return spawnSync('bash', ['-c', `set -Eeuo pipefail
say() { echo "$*"; }
die() { echo "$*" >&2; exit 1; }
sleep() { :; }
${body}`], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10000 });
}

test('CRI verification checks actual image ID; containerd tag presence alone cannot pass', () => {
  for (const visible of [true, false]) {
    const result = shell(`
${fn('k8s_verify_cri_image')}
docker() { echo sha256:expected; }
k8s_crictl() { echo '{"status":{"id":"sha256:${visible ? 'expected' : 'wrong'}"}}'; }
df() { :; }
k8s_verify_cri_image postgres:16-alpine
`, { K8S_PRODUCTION_RECOVERY: '1' });
    assert.equal(result.status, visible ? 0 : 1);
    assert.match(visible ? result.stdout : result.stderr, visible ? /CRI verified/ : /CRI cannot see/);
  }
});

test('rollout retries a locally cached missing image once, without recreating the Pod/PVC', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mx-cri-retry-'));
  try {
    const result = shell(`
${fn('k8s_reimport_missing_workload_images')}
${fn('k8s_rollout_status', manage)}
k8s_workload_generation_stale() { return 1; }
k8s_crictl() { return 1; }
docker() { echo sha256:expected; }
containerd_import_docker_image() { echo "import $1" >> "$CALLS"; }
kubectl() {
  echo "$*" >> "$CALLS"
  case "$*" in
    *' get '*) echo postgres:16-alpine ;;
    *'rollout status'*) [ -f "$CALLS.ready" ] || { touch "$CALLS.ready"; return 1; } ;;
    *) return 37 ;;
  esac
}
k8s_rollout_status mx-internal-shadow statefulset mx-internal-postgres 1s
`, { K8S_PRODUCTION_RECOVERY: '1', CALLS: join(temp, 'calls') });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(join(temp, 'calls'), 'utf8');
    assert.equal(calls.match(/rollout status/g).length, 2);
    assert.equal(calls.match(/import postgres/g).length, 1);
    assert.doesNotMatch(calls, /delete|apply|patch|restart/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('a failed Docker export in conditional recovery stops import and removes its temporary archive', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mx-import-failure-'));
  try {
    const result = shell(`
${fn('containerd_import_docker_image', manage)}
docker() { [ "$1" != save ]; }
ctr() { :; }
k8s_ctr() { echo UNEXPECTED_IMPORT; }
containerd_ensure_image_refs() { echo UNEXPECTED_REFS; }
if containerd_import_docker_image postgres:16-alpine; then echo UNEXPECTED_SUCCESS; fi
`, { TMPDIR: temp });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /UNEXPECTED/);
    const files = spawnSync('ls', ['-A', temp], { encoding: 'utf8' });
    assert.equal(files.stdout, '');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('production host/identity/credential gates precede network, images and migrations', () => {
  const deploy = manage.match(/    deploy\|cycle\)\n([\s\S]*?)\n    apply\)/)[1];
  assert.match(deploy, /export MX_INTERNAL_REQUIRED_LOGIN_PROVIDERS="\$\{MX_INTERNAL_REQUIRED_LOGIN_PROVIDERS:-local-password,feishu\}"/);
  const ordered = ['internal_production_predeploy_gate', 'k8s_prepare_production_host', 'k8s_repair_kubeadm_endpoint',
    'k8s_recover_production_node', 'k8s_production_recovery_state restore', 'k8s_production_recovery_state checkpoint',
    'k8s_preflight_secret_bundle', 'k8s_local_pvs preflight', 'k8s_recover_cluster_network', 'k8s_require_production_node_ready',
    'k8s_production_disk_preflight', 'shadow_image_build', 'k8s_apply internal-shadow', 'k8s_production_auth_smoke', 'deploy OK'];
  let previous = -1;
  for (const call of ordered) {
    const index = deploy.indexOf(call); assert.ok(index > previous, call); previous = index;
  }
  for (const failedStage of ['k8s_prepare_production_host', 'k8s_recover_production_node', 'k8s_production_recovery_state', 'k8s_production_disk_preflight']) {
    const prefix = deploy.slice(0, deploy.indexOf('      MX_SHADOW_REFRESH_QP_TUNNEL_CLI_STRICT='));
    const mocks = ['ops_internal_production_plan', 'launcher_with_build_proxy', 'k8s_prepare_production_host',
      'k8s_repair_kubeadm_endpoint', 'k8s_require_apiserver_ready', 'k8s_recover_production_node', 'k8s_production_recovery_state',
      'k8s_preflight_secret_bundle', 'k8s_release_oss_secret_dry_run', 'k8s_local_pvs', 'k8s_recover_cluster_network',
      'k8s_require_production_node_ready', 'k8s_production_disk_preflight', 'k8s_namespace', 'k8s_manifest_dir']
      .map(name => `${name}() { ${name === failedStage ? 'return 24' : ':'}; }`).join('\n');
    const result = shell(`${mocks}\n${prefix}\necho UNEXPECTED_BUILD`);
    assert.equal(result.status, 24);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_BUILD/);
  }
});

test('post-deploy check cannot pass when required Feishu runtime configuration is disabled', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mx-login-readiness-'));
  try {
    writeFileSync(join(temp, 'k8s-recovery-state.mjs'), `
import { spawnSync } from 'node:child_process';
export function run(command, args, input) {
  if (args.includes('get')) return JSON.stringify({data:{token:Buffer.from('private-token').toString('base64')}});
  if (!args.includes('exec') || input !== 'private-token') throw new Error();
  const program = args[args.indexOf('-e')+1];
  const mock = 'globalThis.fetch = async (url) => ({status:200,ok:true,body:{cancel:async()=>{}},json:async()=>({config:{enabled:process.env.FEISHU_READY === "true"}})});';
  const child = spawnSync(process.execPath, ['-e', mock + program], {input,encoding:'utf8'});
  if (child.status !== 0) throw new Error();
  return child.stdout;
}`);
    for (const [required, enabled, expected] of [
      ['local-password,feishu', 'true', 0], ['local-password,feishu', 'false', 1], ['local-password', 'false', 0]
    ]) {
      const result = shell(`${fn('k8s_production_auth_smoke')}\nk8s_namespace() { echo mx-internal-shadow; }\nk8s_production_auth_smoke`,
        { SCRIPT_DIR: temp, MX_INTERNAL_REQUIRED_LOGIN_PROVIDERS: required, FEISHU_READY: enabled });
      assert.equal(result.status, expected, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /private-token/);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('reboot-lost Flannel lease gets one bounded Flannel restart only in production recovery', () => {
  let source = fn('k8s_repair_flannel_cni', manage).replace('[ -f /etc/kubernetes/manifests/kube-apiserver.yaml ] || return 0', ':');
  const result = shell(`
${source}
k8s_patch_flannel_pod_cidr() { K8S_FLANNEL_POD_CIDR_PATCHED=0; }
k8s_repair_flannel_apiserver_env() { :; }
k8s_wait_flannel_subnet_env() { n=$((n+1)); [ "$n" = 2 ]; }
k8s_flannel_diagnostics() { echo UNEXPECTED_DIAGNOSTICS; }
kubectl() { echo "$*"; }
n=0
k8s_repair_flannel_cni
`, { K8S_PRODUCTION_RECOVERY: '1', MX_K8S_REPAIR_FLANNEL: '1', MX_K8S_FLANNEL_IMAGE_REPOSITORY: '', K8S_FLANNEL_IMAGE_REPOSITORY: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/rollout restart/g).length, 1);
  assert.doesNotMatch(result.stdout, /UNEXPECTED|set image/);
});
