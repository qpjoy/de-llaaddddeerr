import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(new URL('./manage.sh', import.meta.url), 'utf8');
function shellFunction(name) {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(body, `missing function ${name}`);
  return body;
}

function restart(env = {}) {
  const script = [
    'set -Eeuo pipefail',
    'say() { printf "%s\\n" "$*"; }',
    'need_kubectl() { :; }',
    'k8s_namespace() { echo mx-internal-shadow; }',
    'k8s_workload_generation_stale() { return 1; }',
    'k8s_reimport_missing_workload_images() { return 1; }',
    'kubectl() {',
    '  printf "%s\\n" "$*"',
    '  case "$*" in',
    '    *"rollout restart deployment/mx-launcher-internal") return 0 ;;',
    '    *"rollout status deployment/mx-launcher-internal"*)',
    '      if [ "$MX_TEST_ROLLOUT_FAILURE" = 1 ]; then',
    '        echo "1 old replicas are pending termination" >&2; return 1',
    '      fi',
    '      if [ "$MX_TEST_ROLLOUT_FAILURE" = api ]; then',
    '        echo "Unable to connect to the server" >&2; return 1',
    '      fi',
    '      # Model a healthy rollout that converges after four minutes.',
    '      case "$*" in *--timeout=600s|*--timeout=900s) return 0 ;; esac',
    '      echo "timed out waiting for the condition" >&2; return 1 ;;',
    '    *) echo "unexpected kubectl call: $*" >&2; return 97 ;;',
    '  esac',
    '}',
    shellFunction('k8s_rollout_status'),
    shellFunction('k8s_restart_internal_api'),
    'k8s_restart_internal_api internal-shadow',
    'echo ROLLOUT_CONFIRMED'
  ].join('\n');
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, MX_K8S_INTERNAL_API_ROLLOUT_TIMEOUT: '', MX_TEST_ROLLOUT_FAILURE: '', ...env }
  });
}

test('a slow healthy Internal API rollout can converge beyond the former 180s window', () => {
  const result = restart();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rollout status deployment\/mx-launcher-internal --timeout=600s/);
  assert.match(result.stdout, /ROLLOUT_CONFIRMED/);
});

test('Internal API rollout honors an explicit wait budget', () => {
  const result = restart({ MX_K8S_INTERNAL_API_ROLLOUT_TIMEOUT: '900s' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--timeout=900s/);
});

test('a shorter configured budget still fails if rollout has not completed', () => {
  const result = restart({ MX_K8S_INTERNAL_API_ROLLOUT_TIMEOUT: '90s' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /--timeout=90s/);
  assert.doesNotMatch(result.stdout, /ROLLOUT_CONFIRMED/);
});

test('pending old replicas and unreadable API state cannot be reported as rollout success', () => {
  for (const failure of ['1', 'api']) {
    const result = restart({ MX_TEST_ROLLOUT_FAILURE: failure });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /ROLLOUT_CONFIRMED/);
    assert.equal(result.stdout.match(/rollout status/g)?.length, 1);
  }
});
