import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manage.sh'), 'utf8');
function fn(name) {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(body, name);
  return body;
}
function shell(body) {
  const dir = mkdtempSync(join(tmpdir(), 'mx-migration-outcome-'));
  try {
    const result = spawnSync('bash', ['-c', `set -Eeuo pipefail
say() { echo "$*"; }
die() { echo "$*" >&2; exit 1; }
sleep() { :; }
${body}`], { encoding: 'utf8', env: { ...process.env, CALLS: join(dir, 'calls') }, timeout: 10000 });
    return { ...result, calls: readFileSync(join(dir, 'calls'), 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const [name, replies, state, code] of [
  ['API recovery reveals completed migration', ['error', 'Complete=True'], 'complete', 0],
  ['API stays unavailable', ['error', 'error'], 'unreadable', 2],
  ['pending then API outage', ['', 'error'], 'unreadable', 2],
  ['API recovers but job is still pending', ['error', 'Complete=False'], 'pending', 2],
  ['job reports terminal failure', ['Failed=True'], 'failed', 1],
]) {
  test(name, () => {
    const cases = replies.map((reply, i) => `${i + 1}) ${reply === 'error' ? 'return 1' : `echo '${reply}'`} ;;`).join('\n');
    const result = shell(`
${fn('k8s_wait_job_complete')}
kubectl() {
  echo "$*" >> "$CALLS"
  case "$(wc -l < "$CALLS" | tr -d ' ')" in
    ${cases}
    *) return 99 ;;
  esac
}
rc=0
k8s_wait_job_complete mx-internal-shadow mx-launcher-migrate ${replies.length} || rc=$?
echo "RESULT=$rc:$K8S_JOB_WAIT_STATE"
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`RESULT=${code}:${state}`));
    assert.equal(result.calls.trim().split('\n').length, replies.length);
    for (const call of result.calls.trim().split('\n')) assert.match(call, /^--request-timeout=5s .* get job /);
    assert.doesNotMatch(result.calls, /delete|apply|restart|patch/);
  });
}

test('unreadable job stops API diagnostics and collects host evidence once', () => {
  const result = shell(`
${fn('k8s_job_diagnostics')}
kubectl() { echo "$*" >> "$CALLS"; echo 'connection refused' >&2; return 1; }
k8s_apiserver_failure_diagnostics() { echo HOST_DIAGNOSTICS; }
k8s_job_diagnostics mx-internal-shadow mx-launcher-migrate
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /connection refused/);
  assert.equal(result.stdout.match(/HOST_DIAGNOSTICS/g)?.length, 1);
  assert.equal(result.calls.trim().split('\n').length, 1);
  assert.match(result.calls, /^--request-timeout=5s /);
});

test('a replacement job cannot supply success evidence for the submitted migration', () => {
  const result = shell(`
${fn('k8s_wait_job_complete')}
kubectl() { echo "$*" >> "$CALLS"; printf 'another-uid\\nComplete=True\\n'; }
rc=0
k8s_wait_job_complete mx-internal-shadow mx-launcher-migrate 2 submitted-uid || rc=$?
echo "RESULT=$rc:$K8S_JOB_WAIT_STATE"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESULT=2:replaced/);
  assert.equal(result.calls.trim().split('\n').length, 1);
});

for (const scenario of ['read-error', 'pending', 'complete', 'failed', 'missing', 'invalid-identity', 'delete-error', 'delete-pending', 'create-error', 'empty-create-uid', 'wait-unreadable', 'wait-pending', 'wait-failed']) {
  test(`migration gate: ${scenario}`, () => {
    const existing = scenario === 'missing' ? '' : scenario === 'pending' ? 'previous-uid\n123'
      : scenario === 'invalid-identity' ? 'previous-uid\n\nComplete=True' : 'previous-uid\n123\nComplete=True';
    const result = shell(`
${fn('k8s_run_migration')}
kubectl() {
  echo "$*" >> "$CALLS"
  case "$*" in
    *'get job'*) ${scenario === 'read-error' ? 'return 1' : `printf '%s\\n' '${scenario === 'failed' ? 'previous-uid\n123\nFailed=True' : existing}'`} ;;
    *'delete --raw='*) cat >> "$CALLS"; ${scenario === 'delete-error' ? 'return 1' : ':'} ;;
    *'wait --for=delete'*) ${scenario === 'delete-pending' ? 'return 1' : ':'} ;;
    *'create '*) ${scenario === 'create-error' ? 'return 1' : scenario === 'empty-create-uid' ? ':' : 'echo new-uid'} ;;
    *) return 99 ;;
  esac
}
k8s_wait_job_complete() {
  echo "WAIT $*" >> "$CALLS"
  K8S_JOB_WAIT_STATE=${scenario.startsWith('wait-') ? scenario.slice(5) : 'complete'}
  ${scenario.startsWith('wait-') ? 'return 2' : 'return 0'}
}
k8s_job_diagnostics() { echo DIAGNOSTICS; }
k8s_run_migration mx-internal-shadow /mock/migration.yaml
echo CONTINUE_DEPLOY
`);
    const success = ['complete', 'failed', 'missing'].includes(scenario);
    assert.equal(result.status, success ? 0 : 1, result.stderr);
    if (success) {
      assert.match(result.stdout, /CONTINUE_DEPLOY/);
      assert.equal(result.calls.match(/ create /g)?.length, 1);
      assert.match(result.calls, /WAIT mx-internal-shadow mx-launcher-migrate [0-9]+ new-uid/);
      if (scenario === 'missing') assert.doesNotMatch(result.calls, /delete/);
      else {
        assert.match(result.calls, /delete --raw=\/apis\/batch\/v1\/namespaces\/mx-internal-shadow\/jobs\/mx-launcher-migrate -f -/);
        assert.match(result.calls, /"preconditions":\{"uid":"previous-uid","resourceVersion":"123"\}/);
        assert.match(result.calls, /wait --for=delete job\/mx-launcher-migrate --timeout=60s/);
      }
    } else {
      assert.doesNotMatch(result.stdout, /CONTINUE_DEPLOY/);
      if (['read-error', 'pending', 'invalid-identity'].includes(scenario)) assert.doesNotMatch(result.calls, /delete|create|WAIT/);
      if (['delete-error', 'delete-pending'].includes(scenario)) assert.doesNotMatch(result.calls, /create|WAIT/);
      if (['create-error', 'empty-create-uid'].includes(scenario)) {
        assert.equal(result.calls.match(/ create /g)?.length, 1);
        assert.doesNotMatch(result.calls, /WAIT/);
      }
      if (scenario === 'wait-failed') assert.match(result.stderr, /reported Failed=True/);
      else assert.doesNotMatch(result.stderr, /reported Failed=True|migration job failed/);
    }
  });
}

test('production apply requires migration completion before identity or API rollout', () => {
  const apply = fn('k8s_apply');
  const gate = apply.indexOf('k8s_run_migration "$ns" "$dir/30-migration-job.yaml"');
  assert.ok(gate > 0);
  assert.ok(apply.indexOf('identity-deploy.mjs" apply') > gate);
  assert.ok(apply.indexOf('"$dir/40-internal-api.yaml"') > gate);
  assert.doesNotMatch(apply, /delete job mx-launcher-migrate/);
});
