import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The Launcher database StatefulSet is OnDelete: template changes must never
// restart it, and `kubectl rollout status` refuses that strategy.
const directory = dirname(fileURLToPath(import.meta.url));
const manage = readFileSync(join(directory, 'manage.sh'), 'utf8');
const fn = name => {
  const body = manage.match(new RegExp(`^${name}\\(\\) [({]\\n[\\s\\S]*?^[})]$`, 'm'))?.[0];
  assert.ok(body, name); return body;
};
const manifest = readFileSync(join(directory, '../deploy/k8s/internal-shadow/20-postgres.yaml'), 'utf8');

function wait(strategy, podAppearsAfter = 0) {
  const temp = mkdtempSync(join(tmpdir(), 'mx-pg-ready-'));
  try {
    const result = spawnSync('bash', ['-c', `set -Eeuo pipefail
sleep() { :; }
${fn('k8s_postgres_ready')}
k8s_rollout_status() { echo "rollout $*" >> "$CALLS"; }
kubectl() {
  echo "$*" >> "$CALLS"
  case "$*" in
    *'jsonpath={.spec.updateStrategy.type}'*) echo "${strategy}" ;;
    *' get pod/mx-internal-postgres-0'*) n=$(cat "$CALLS.n" 2>/dev/null || echo 0); echo $((n + 1)) > "$CALLS.n"; [ "$n" -ge ${podAppearsAfter} ] ;;
    *' wait --for=condition=Ready pod/mx-internal-postgres-0'*) ;;
    *) return 37 ;;
  esac
}
k8s_postgres_ready mx-internal-shadow mx-internal-postgres 30
`], { encoding: 'utf8', env: { ...process.env, CALLS: join(temp, 'calls') }, timeout: 10000 });
    return { status: result.status, stderr: result.stderr, calls: readFileSync(join(temp, 'calls'), 'utf8') };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

test('OnDelete PostgreSQL waits for the existing Pod to be Ready without a rollout', () => {
  const result = wait('OnDelete', 2);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /wait --for=condition=Ready pod\/mx-internal-postgres-0/);
  assert.doesNotMatch(result.calls, /rollout|delete|restart|scale|patch/);
});

test('other strategies keep the original rollout wait', () => {
  const result = wait('RollingUpdate');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /^rollout mx-internal-shadow statefulset mx-internal-postgres 30s$/m);
});

test('a Pod that never appears fails the wait instead of hanging', () => {
  assert.equal(wait('OnDelete', 1000).status, 1);
});

test('the manifest keeps the database across template changes and lifts the 1 CPU / 1Gi cap', () => {
  assert.match(manifest, /updateStrategy:\n\s+type: OnDelete/);
  assert.match(manifest, /limits:\n\s+cpu: "4"\n\s+memory: 4Gi/);
  assert.match(manage, /if ! k8s_postgres_ready "\$ns" mx-internal-postgres 180; then/);
});

function switchStrategy(strategy, getFails = false) {
  const temp = mkdtempSync(join(tmpdir(), 'mx-pg-switch-'));
  try {
    const result = spawnSync('bash', ['-c', `set -Eeuo pipefail
say() { echo "$*"; }
${fn('k8s_postgres_switch_to_ondelete')}
kubectl() {
  printf '%s\\n' "$*" >> "$CALLS"
  case "$*" in
    *' get statefulset mx-internal-postgres '*) ${getFails ? 'return 1' : `printf '%s' "${strategy}"`} ;;
    *' patch statefulset mx-internal-postgres --type=json '*) ;;
    *) return 37 ;;
  esac
}
k8s_postgres_switch_to_ondelete mx-internal-shadow mx-internal-postgres
`], { encoding: 'utf8', env: { ...process.env, CALLS: join(temp, 'calls') }, timeout: 10000 });
    return { status: result.status, calls: readFileSync(join(temp, 'calls'), 'utf8') };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

test('an existing RollingUpdate database switches only its strategy before the template is applied', () => {
  const result = switchStrategy('RollingUpdate');
  assert.equal(result.status, 0);
  assert.match(result.calls, /patch statefulset mx-internal-postgres --type=json -p \[\{"op":"replace","path":"\/spec\/updateStrategy","value":\{"type":"OnDelete"\}\}\]/);
  assert.doesNotMatch(result.calls, /apply|delete|rollout|template/);
  for (const strategy of ['OnDelete', '']) {
    const untouched = switchStrategy(strategy);
    assert.equal(untouched.status, 0);
    assert.doesNotMatch(untouched.calls, /patch/);
  }
  assert.equal(switchStrategy('', true).status, 1);
  assert.match(manage, /k8s_postgres_switch_to_ondelete "\$ns" mx-internal-postgres \\\n\s+\|\| die/);
});
