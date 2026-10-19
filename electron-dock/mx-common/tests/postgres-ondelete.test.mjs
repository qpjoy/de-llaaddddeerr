import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// The shared database is OnDelete: a template change never restarts it, and
// `kubectl rollout status` refuses that strategy, so readiness is the Pods.
const manage = readFileSync(new URL('../scripts/manage.sh', import.meta.url), 'utf8')
const manifest = readFileSync(new URL('../deploy/k8s/common/10-postgres.yaml', import.meta.url), 'utf8')
const fn = name => {
  const body = manage.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm'))?.[0]
  assert.ok(body, name); return body
}

function ready(kind, state, rollout = 0) {
  const result = spawnSync('bash', ['-c', `set -Eeuo pipefail
NAMESPACE=mx-common
sleep() { :; }
${fn('workload_ready')}
${fn('wait_workload')}
kubectl() {
  echo "$*" >&2
  case "$*" in
    *jsonpath=*) echo '${state}' ;;
    *'rollout status'*) return ${rollout} ;;
    *) return 37 ;;
  esac
}
wait_workload ${kind} mx-common-postgres 0
`], { encoding: 'utf8', timeout: 10000 })
  return result
}

test('an OnDelete StatefulSet is ready when all replicas are Ready, without a rollout', () => {
  const result = ready('statefulset', 'OnDelete|1|1')
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /rollout|delete|restart|patch/)
})

test('an OnDelete StatefulSet without Ready replicas is not ready', () => {
  assert.equal(ready('statefulset', 'OnDelete||1').status, 1)
  assert.equal(ready('statefulset', 'OnDelete|0|0').status, 1)
})

test('RollingUpdate StatefulSets and Deployments keep the rollout check', () => {
  // Ready replicas alone are not enough here: the rollout result decides.
  assert.equal(ready('statefulset', 'RollingUpdate|1|1', 0).status, 0)
  assert.equal(ready('statefulset', 'RollingUpdate|1|1', 1).status, 1)
  assert.equal(ready('deployment', '', 1).status, 1)
})

test('the shared database manifest is OnDelete and readiness uses the strategy-aware check', () => {
  assert.match(manifest, /updateStrategy:\n\s+type: OnDelete/)
  assert.match(manifest, /limits:\n\s+cpu: "16"\n\s+memory: 48Gi/)
  assert.match(fn('wait_ready'), /if workload_ready "\$kind" "\$name"; then/)
  assert.doesNotMatch(manage, /rollout status statefulset\/mx-common-postgres/)
})
