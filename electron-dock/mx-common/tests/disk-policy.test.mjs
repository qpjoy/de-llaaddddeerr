import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { diskPolicy, diskPolicyUpdate, matchesDiskPolicy } from '../scripts/elasticsearch-disk-policy.mjs'

const run = promisify(execFile)
const manage = fileURLToPath(new URL('../scripts/manage.sh', import.meta.url))
const prefix = 'cluster.routing.allocation.disk.'

test('disk protection precedes 20GiB kubelet eviction and only owns named disk keys', () => {
  const update = diskPolicyUpdate()
  const free = ['low', 'high', 'flood_stage'].map((name) => parseInt(diskPolicy[`${prefix}watermark.${name}`]))
  assert.ok(free[0] > free[1] && free[1] > free[2] && free[2] > 20)
  assert.equal(update.persistent[`${prefix}threshold_enabled`], true)
  assert.ok(Object.keys(update.persistent).every((key) => key.startsWith(prefix)))
  assert.ok(Object.values(update.transient).every((value) => value === null))
  assert.equal(matchesDiskPolicy({ persistent: diskPolicy, transient: {} }), true)
  assert.equal(matchesDiskPolicy({ persistent: diskPolicy, transient: { [`${prefix}threshold_enabled`]: false } }), false)
  assert.equal(matchesDiskPolicy({ persistent: { ...diskPolicy, [`${prefix}watermark.high.max_headroom`]: '150gb' } }), false)
})

// Run the real shell transport with a bounded kubectl fake. It accepts only
// localhost ES cluster-settings GET/PUT; any rollout, deletion or reindex fails.
async function fixture(t, { mode = 'normal', current = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mx-es-policy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'settings.json'), JSON.stringify(current))
  await writeFile(join(dir, 'calls.jsonl'), '')
  await writeFile(join(dir, 'kubectl'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.POLICY_TEST_DIR
const mode = process.env.POLICY_TEST_MODE
const args = process.argv.slice(2)
const method = args[args.indexOf('-X') + 1]
const url = args[args.length - 1]
if (!args.includes('exec') || !args.includes('statefulset/mx-common-elasticsearch') || !args.includes('curl')
    || !url.startsWith('http://127.0.0.1:9200/_cluster/settings') || !['GET','PUT'].includes(method)) process.exit(91)
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({method,url}) + '\\n')
const file = path.join(dir, 'settings.json')
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
if (method === 'GET') {
  if (mode === 'get-fails') process.exit(22)
  console.log(JSON.stringify(state))
} else {
  const body = JSON.parse(fs.readFileSync(0, 'utf8'))
  fs.writeFileSync(path.join(dir, 'body.json'), JSON.stringify(body))
  if (mode === 'put-fails') process.exit(22)
  if (mode !== 'stale-readback') for (const scope of ['persistent','transient']) {
    state[scope] ||= {}
    for (const [key,value] of Object.entries(body[scope])) {
      if (value === null) delete state[scope][key]
      else state[scope][key] = value
    }
  }
  fs.writeFileSync(file, JSON.stringify(state))
  console.log(mode === 'malformed-ack' ? '<html>error</html>' : JSON.stringify({acknowledged: mode !== 'unacknowledged'}))
}
`, { mode: 0o755 })
  const invoke = () => run('bash', ['-c', 'source "$1"; ensure_elasticsearch_disk_policy', '_', manage], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, POLICY_TEST_DIR: dir, POLICY_TEST_MODE: mode },
  })
  const calls = async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  return { dir, invoke, calls }
}

test('live reconcile clears stale overrides, preserves unrelated settings and becomes read-only on repeat', async (t) => {
  const f = await fixture(t, { current: {
    persistent: { [`${prefix}watermark.low`]: '85%', 'indices.recovery.max_bytes_per_sec': '40mb' },
    transient: { [`${prefix}watermark.low`]: '90%', [`${prefix}threshold_enabled`]: 'false', 'cluster.routing.allocation.enable': 'all' },
  } })
  assert.match((await f.invoke()).stdout, /watermarks verified/)
  const state = JSON.parse(await readFile(join(f.dir, 'settings.json'), 'utf8'))
  assert.ok(matchesDiskPolicy(state))
  assert.equal(state.persistent['indices.recovery.max_bytes_per_sec'], '40mb')
  assert.equal(state.transient['cluster.routing.allocation.enable'], 'all')
  await f.invoke()
  assert.deepEqual((await f.calls()).map((c) => c.method), ['GET', 'PUT', 'GET', 'GET'])
})

for (const mode of ['get-fails', 'put-fails', 'unacknowledged', 'malformed-ack', 'stale-readback']) {
  test(`disk policy does not report success after ${mode}`, async (t) => {
    const f = await fixture(t, { mode })
    await assert.rejects(f.invoke, (error) => {
      assert.notEqual(error.code, 0)
      assert.doesNotMatch(error.stdout, /watermarks verified/)
      return true
    })
  })
}

test('ensure reconciles disk policy before waiting for red-cluster recovery and reports policy failure', async () => {
  const shell = `source "$1"
    # This fixture tests disk-policy ordering; storage identity has separate
    # filesystem/Kubernetes tests and must never inspect the host running it.
    need() { :; }; resolve_host_data_root() { :; }; storage_preflight() { :; }; ensure_vm_max_map_count() { :; }
    check_storage_headroom() { :; }; report_capacity() { :; }; report_image_readiness() { :; }
    kubectl() { :; }; ensure_secret() { :; }; ensure_storage() { :; }; apply_manifests() { :; }
    allow_client_namespace() { :; }; wait_ready() { :; }; ensure_snapshot_policy() { :; }
    health_json() { printf '{}'; }; sleep() { echo unexpected-sleep; return 1; }
    policy_done=0
    es_is_healthy() { [ "$policy_done" = 1 ]; }
    mode="$2"
    ensure_elasticsearch_disk_policy() { [ "$mode" != failure ] || return 1; policy_done=1; echo policy-applied; }
    MX_COMMON_HANLP_ENABLED=0 cmd_ensure`
  const result = await run('bash', ['-c', shell, '_', manage, 'success'])
  assert.match(result.stdout, /policy-applied[\s\S]*shared data plane healthy/)
  assert.doesNotMatch(result.stdout, /unexpected-sleep/)
  await assert.rejects(run('bash', ['-c', shell, '_', manage, 'failure']), (error) => {
    assert.match(error.stderr, /disk policy was NOT verified/)
    assert.doesNotMatch(error.stdout, /shared data plane healthy/)
    return true
  })
})
