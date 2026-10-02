import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('./manage.sh', import.meta.url), 'utf8');
function shellFunction(name) {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(body, `missing ${name}`); return body;
}
function run(script, env = {}) {
  return spawnSync('bash', ['-c', `set -Eeuo pipefail\nsay() { echo "$*"; }\ndie() { echo "$*" >&2; exit 1; }\n${script}`], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000 });
}

test('ensure uses the current workspace and initial LAN address, with opt-out and explicit overrides', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-deploy-executor-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'node'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$TEST_ARGS"\nexit "${TEST_INSTALL_EXIT:-0}"\n'); chmodSync(join(bin, 'node'), 0o700);
  const script = `${shellFunction('service_operations_ensure')}\nuname() { echo Linux; }\nid() { echo 0; }\nk8s_detect_lan_ip() { echo 192.168.1.2; }\nservice_operations_ensure`;
  const env = { PATH: `${bin}:${process.env.PATH}`, ROOT: '/srv/mx project/electron-dock/mx-launcher', TEST_ARGS: join(dir, 'args'), MX_SERVICE_OPERATIONS_INSTALL: '1', MX_SERVICE_OPERATIONS_BIND: '', MX_SERVICE_OPERATIONS_PORT: '' };
  let result = run(script, env); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(env.TEST_ARGS, 'utf8').trim().split('\n'), ['/srv/mx project/electron-dock/mx-launcher/server/scripts/service-operations-install.mjs', '--workspace', '/srv/mx project/electron-dock', '--connect-k8s', '--default-bind', '192.168.1.2']);
  result = run(script, { ...env, MX_SERVICE_OPERATIONS_BIND: '192.168.1.8', MX_SERVICE_OPERATIONS_PORT: '19300' }); assert.equal(result.status, 0);
  assert.match(readFileSync(env.TEST_ARGS, 'utf8'), /--bind\n192\.168\.1\.8\n--port\n19300/);
  result = run(script, { ...env, MX_SERVICE_OPERATIONS_INSTALL: '0', TEST_INSTALL_EXIT: '42' }); assert.equal(result.status, 0); assert.match(result.stdout, /retain existing/);
  result = run(script, { ...env, TEST_INSTALL_EXIT: '42' }); assert.equal(result.status, 42);
  result = run(script, { ...env, MX_SERVICE_OPERATIONS_INSTALL: 'yes' }); assert.equal(result.status, 1);
});

test('production deploy ensures executor before build and API rollout; failure stops deployment', () => {
  const operations = [
    'ops_internal_production_plan', 'k8s_configure_proxy_bypass', 'internal_production_predeploy_gate',
    'k8s_prepare_production_host', 'k8s_repair_kubeadm_endpoint', 'k8s_require_apiserver_ready', 'k8s_recover_production_node',
    'k8s_production_recovery_state', 'k8s_preflight_secret_bundle', 'k8s_release_oss_secret_dry_run', 'k8s_local_pvs',
    'k8s_recover_cluster_network', 'k8s_require_production_node_ready', 'k8s_production_disk_preflight', 'identity_prepare_for_deploy',
    'shadow_image_build', 'shadow_image_import_containerd', 'k8s_preload_runtime_images', 'k8s_apply', 'k8s_restart_internal_api',
    'native_host_runner_install', 'ops_local_platform_apply_native_host_runner_url', 'k8s_apply_internal_gateway',
    'k8s_rollout_status', 'k8s_status', 'k8s_gateway_smoke', 'k8s_db_summary', 'ops_insight_hub', 'k8s_production_auth_smoke'
  ];
  const stubs = operations.map(name => `${name}() { echo CALL:${name}; }`).join('\n');
  const script = `${shellFunction('ops_internal_production')}\n${stubs}\nk8s_namespace() { echo mx-internal-shadow; }\nk8s_manifest_dir() { echo /fixture; }\nlauncher_with_build_proxy() { "$@"; }\nservice_operations_ensure() { echo CALL:service_operations_ensure; return "${'${TEST_ENSURE_EXIT:-0}'}"; }\nops_internal_production deploy`;
  const env = { MX_INTERNAL_PRODUCTION_NATIVE_HOST_RUNNER_INSTALL: '0', MX_INSIGHT_HUB_DEPLOY: '0', K8S_INTERNAL_API_RESTARTED: '0' };
  let result = run(script, env); assert.equal(result.status, 0, result.stderr);
  const ensure = result.stdout.indexOf('CALL:service_operations_ensure');
  assert.ok(ensure > result.stdout.indexOf('CALL:k8s_production_disk_preflight'));
  assert.ok(result.stdout.indexOf('CALL:shadow_image_build') > ensure);
  assert.ok(result.stdout.indexOf('CALL:k8s_apply\n') > ensure);
  result = run(script, { ...env, TEST_ENSURE_EXIT: '29' }); assert.equal(result.status, 29);
  assert.doesNotMatch(result.stdout, /CALL:shadow_image_build|CALL:k8s_apply\n/);
});
