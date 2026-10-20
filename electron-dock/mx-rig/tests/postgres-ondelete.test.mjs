import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// The Rig database is OnDelete; switching an existing RollingUpdate StatefulSet
// must change only its strategy, before the template is applied.
const manage = readFileSync(new URL('../scripts/manage.sh', import.meta.url), 'utf8')
const manifest = readFileSync(new URL('../deploy/k8s/internal/15-postgres.yaml', import.meta.url), 'utf8')
const fn = name => {
  const body = manage.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm'))?.[0]
  assert.ok(body, name); return body
}

function run(body, state, getFails = false) {
  return spawnSync('bash', ['-c', `set -Eeuo pipefail
say() { echo "$*"; }
sleep() { :; }
kube() {
  echo "CALL $*" >&2
  case "$*" in
    'get statefulset mx-rig-postgres '*) ${getFails ? 'return 1' : `printf '%s' "${state}"`} ;;
    'patch statefulset mx-rig-postgres --type=json '*) ;;
    'get pod/mx-rig-postgres-0') ;;
    'wait --for=condition=Ready pod/mx-rig-postgres-0 '*) ;;
    *) return 37 ;;
  esac
}
${fn('switch_postgres_to_ondelete')}
${fn('wait_postgres_pod')}
${body}
`], { encoding: 'utf8', timeout: 10000 })
}

test('an existing RollingUpdate database switches only its strategy', () => {
  const switched = run('switch_postgres_to_ondelete', 'RollingUpdate')
  assert.equal(switched.status, 0, switched.stderr)
  assert.match(switched.stderr, /patch statefulset mx-rig-postgres --type=json -p \[\{"op":"replace","path":"\/spec\/updateStrategy","value":\{"type":"OnDelete"\}\}\]/)
  for (const state of ['OnDelete', '']) assert.doesNotMatch(run('switch_postgres_to_ondelete', state).stderr, /patch/)
  assert.equal(run('switch_postgres_to_ondelete', '', true).status, 1)
})

test('the database is awaited through its Pod, not a rollout', () => {
  const waited = run('wait_postgres_pod', 'OnDelete')
  assert.equal(waited.status, 0, waited.stderr)
  assert.match(waited.stderr, /wait --for=condition=Ready pod\/mx-rig-postgres-0/)
  assert.doesNotMatch(manage, /rollout status statefulset\/mx-rig-postgres/)
  assert.match(manifest, /updateStrategy:\n\s+type: OnDelete/)
  assert.match(manage, /switch_postgres_to_ondelete \|\| die/)
})
