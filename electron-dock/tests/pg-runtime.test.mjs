import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const tool = new URL('../scripts/pg_runtime.py', import.meta.url).pathname
const manage = new URL('../scripts/manage.py', import.meta.url).pathname

// A stateful fake cluster: StatefulSet/Pod JSON, the Pod resize subresource
// and psql reached through `kubectl exec`. Every call is logged.
const fakeKubectl = `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FIXTURE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
let stdin = ''
try { stdin = fs.readFileSync(0, 'utf8') } catch {}
state.calls.push({ args, stdin })
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const fail = (message) => { save(); process.stderr.write(message + '\\n'); process.exit(1) }
const at = (flag) => args[args.indexOf(flag) + 1]
if (args.includes('get')) {
  const kind = args[args.indexOf('get') + 1], name = args[args.indexOf('get') + 2]
  const object = kind === 'statefulset' ? state.sts[name] : state.pods[name]
  if (!object) fail('Error from server (NotFound): ' + kind + ' ' + name)
  save(); process.stdout.write(JSON.stringify(object)); process.exit(0)
}
if (args.includes('patch')) {
  if (state.rejectResize) fail('The Pod "x" is invalid: resize is not supported')
  const pod = state.pods[args[args.indexOf('pod') + 1]]
  const change = JSON.parse(at('-p')).spec.containers[0]
  if (!args.includes('--dry-run=server')) {
    const spec = pod.spec.containers.find(c => c.name === change.name)
    spec.resources = { ...spec.resources, ...change.resources }
    const status = pod.status.containerStatuses.find(c => c.name === change.name)
    status.resources = JSON.parse(JSON.stringify(spec.resources))
  }
  save(); process.exit(0)
}
if (args.includes('exec')) {
  if (stdin.includes('json_build_object')) {
    const names = [...stdin.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    const settings = Object.entries(state.settings).filter(([name]) => names.includes(name))
      .map(([name, row]) => ({ name, ...row }))
    save(); process.stdout.write(JSON.stringify({ settings, pendingRestart: state.pendingRestart }) + '\\n'); process.exit(0)
  }
  for (const match of stdin.matchAll(/ALTER SYSTEM SET ([a-z_]+) = '([^']+)';/g)) {
    state.settings[match[1]].auto = match[2]
    state.settings[match[1]].setting = match[2]
  }
  save(); process.stdout.write('t\\n'); process.exit(0)
}
fail('unexpected kubectl call: ' + args.join(' '))
`

function resources(cpu, memory) {
  return { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu, memory } }
}

function cluster({ templateCpu = '4', templateMemory = '4Gi', podCpu = '1000m', podMemory = '1Gi',
  updateRevision = 'pg-rev-1', podRevision = 'pg-rev-1' } = {}) {
  return {
    calls: [],
    pendingRestart: [],
    sts: { 'mx-internal-postgres': {
      spec: { updateStrategy: { type: 'OnDelete' }, template: { spec: { containers: [
        { name: 'postgres', resources: resources(templateCpu, templateMemory) }] } } },
      status: { updateRevision } } },
    pods: { 'mx-internal-postgres-0': {
      metadata: { labels: { 'controller-revision-hash': podRevision } },
      spec: { containers: [{ name: 'postgres', resources: resources(podCpu, podMemory) }] },
      status: { conditions: [], containerStatuses: [{ name: 'postgres', restartCount: 3,
        resources: resources(podCpu, podMemory) }] } } },
    settings: {
      max_wal_size: { setting: '1024', unit: 'MB', context: 'sighup', source: 'default', enumvals: null, auto: null },
      wal_compression: { setting: 'off', unit: null, context: 'superuser', source: 'default',
        enumvals: ['pglz', 'zstd', 'on', 'off'], auto: null },
      track_io_timing: { setting: 'on', unit: null, context: 'superuser', source: 'default', enumvals: null, auto: null },
      shared_buffers: { setting: '16384', unit: '8kB', context: 'postmaster', source: 'default', enumvals: null, auto: null },
      work_mem: { setting: '32768', unit: 'kB', context: 'user', source: 'command line', enumvals: null, auto: null },
    },
  }
}

function fixture(t, state, settings = { max_wal_size: '2GB', wal_compression: ['lz4', 'pglz'],
  track_io_timing: 'on', shared_buffers: '512MB', work_mem: '64MB' }) {
  const root = mkdtempSync(join(tmpdir(), 'mx pg runtime '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/kubectl'), fakeKubectl, { mode: 0o755 })
  writeFileSync(join(root, 'state.json'), JSON.stringify(state))
  writeFileSync(join(root, 'profiles.json'), JSON.stringify({
    targets: { 'mx-launcher': { namespace: 'mx-internal-shadow', statefulset: 'mx-internal-postgres',
      container: 'postgres', settings } },
    projects: { 'mx-launcher': ['mx-launcher'] },
  }))
  const run = (...args) => spawnSync('python3', ['-I', tool, ...args, '--profiles', join(root, 'profiles.json'),
    '--summary', join(root, 'summary.json')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, FIXTURE_STATE: join(root, 'state.json'),
      KUBECONFIG: join(root, 'kubeconfig') },
  })
  const read = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
  const summary = () => JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8')).targets[0]
  return { run, read, summary, root }
}

const mutating = call => ['delete', 'rollout', 'scale', 'apply', 'replace', 'create'].some(verb => call.args.includes(verb))
  || (call.args.includes('patch') && !call.args.includes('resize'))

test('apply resizes the running Pod in place and writes only reload-level settings', t => {
  const f = fixture(t, cluster())
  const result = f.run('apply', 'mx-launcher')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const report = f.summary()
  assert.equal(report.resources.status, 'resized')
  assert.deepEqual(report.resources.after, { 'requests.cpu': '100m', 'requests.memory': '256Mi', 'limits.cpu': '4', 'limits.memory': '4Gi' })
  assert.deepEqual(report.settings.changed.map(c => [c.name, c.to]), [['max_wal_size', '2GB'], ['wal_compression', 'pglz']])
  assert.deepEqual(report.settings.skipped.map(s => s.name), ['shared_buffers', 'work_mem'])
  const state = f.read()
  assert.equal(state.pods['mx-internal-postgres-0'].status.containerStatuses[0].restartCount, 3)
  assert.equal(state.settings.track_io_timing.auto, null, 'an already effective unitless value is not rewritten')
  const resizes = state.calls.filter(c => c.args.includes('resize'))
  assert.deepEqual(resizes.map(c => c.args.includes('--dry-run=server')), [true, false], 'server dry-run precedes the resize')
  const alter = state.calls.find(c => c.stdin.includes('ALTER SYSTEM'))
  assert.match(alter.stdin, /SELECT pg_reload_conf\(\);/)
  assert.doesNotMatch(alter.stdin, /shared_buffers|work_mem/)
  assert.equal(state.calls.some(mutating), false, 'never deletes, restarts, scales or edits workloads')
})

test('a second apply with nothing changed performs no writes', t => {
  const f = fixture(t, cluster())
  assert.equal(f.run('apply', 'mx-launcher').status, 0)
  const before = f.read().calls.length
  assert.equal(f.run('apply', 'mx-launcher').status, 0)
  const second = f.read().calls.slice(before)
  assert.equal(second.some(c => c.args.includes('patch')), false)
  assert.equal(second.some(c => c.stdin.includes('ALTER SYSTEM')), false)
  assert.equal(f.summary().resources.status, 'in-sync')
  assert.equal(f.summary().settings.status, 'in-sync')
})

test('status is read-only and reports what apply would change', t => {
  const f = fixture(t, cluster())
  assert.equal(f.run('status', 'mx-launcher').status, 0)
  const state = f.read()
  assert.equal(state.calls.some(c => c.args.includes('patch') || c.stdin.includes('ALTER SYSTEM')), false)
  assert.equal(f.summary().resources.status, 'resize-needed')
  assert.equal(f.summary().settings.status, 'changes-needed')
})

test('a rejected resize is reported without retry or restart while settings still apply', t => {
  const f = fixture(t, { ...cluster(), rejectResize: true })
  const result = f.run('apply', 'mx-launcher')
  assert.equal(result.status, 0)
  assert.equal(f.summary().resources.status, 'resize-rejected')
  assert.match(f.summary().resources.detail, /not supported/)
  assert.equal(f.summary().settings.status, 'applied')
  const state = f.read()
  assert.equal(state.calls.filter(c => c.args.includes('resize')).length, 1, 'only the dry-run was attempted')
  assert.equal(state.calls.some(mutating), false)
})

test('a template revision waiting under OnDelete is reported, never rolled out', t => {
  const f = fixture(t, cluster({ templateCpu: '1', templateMemory: '1Gi', updateRevision: 'pg-rev-2' }), {})
  assert.equal(f.run('apply', 'mx-launcher').status, 0)
  assert.equal(f.summary().templatePending, true)
  assert.equal(f.summary().resources.status, 'in-sync', '1 CPU equals 1000m')
  assert.match(f.run('status', 'mx-launcher').stdout, /不会自动重启/)
  assert.equal(f.read().calls.some(mutating), false)
})

test('unreachable workloads and invalid profiles fail without touching the database', t => {
  const missing = cluster()
  delete missing.pods['mx-internal-postgres-0']
  const f = fixture(t, missing)
  assert.equal(f.run('apply', 'mx-launcher').status, 2)
  assert.match(f.summary().errors[0], /NotFound/)
  assert.equal(f.read().calls.some(c => c.args.includes('exec') || c.args.includes('patch')), false)

  const g = fixture(t, cluster(), { max_wal_size: "2GB'; DROP TABLE x; --" })
  const result = g.run('apply', 'mx-launcher')
  assert.equal(result.status, 2)
  assert.equal(g.read().calls.some(c => c.stdin.includes('ALTER SYSTEM')), false)
})

test('the unified entry exposes db status/apply and requires a project for apply', () => {
  const env = { ...process.env, MX_MANAGE_STATE_DIR: mkdtempSync(join(tmpdir(), 'mx db state ')) }
  const apply = spawnSync('python3', ['-I', manage, 'db', 'apply'], { encoding: 'utf8', env })
  assert.equal(apply.status, 1)
  assert.match(apply.stdout, /db apply 需要指定项目/)
  const device = spawnSync('python3', ['-I', manage, 'db', 'status', 'device'], { encoding: 'utf8', env })
  assert.equal(device.status, 1)
  assert.match(device.stdout, /没有声明数据库运行配置/)
  const help = spawnSync('python3', ['-I', manage, 'help'], { encoding: 'utf8', env })
  assert.match(help.stdout, /db apply <项目>/)
})

test('the shipped profiles reference real targets and declare only reload-level parameters', () => {
  const profiles = JSON.parse(readFileSync(new URL('../scripts/postgres-runtime.json', import.meta.url), 'utf8'))
  const restartLevel = ['shared_buffers', 'max_connections', 'wal_buffers', 'shared_preload_libraries', 'max_worker_processes', 'wal_level']
  for (const [name, target] of Object.entries(profiles.targets)) {
    for (const key of Object.keys(target.settings)) assert.equal(restartLevel.includes(key), false, name + ' ' + key)
  }
  for (const targets of Object.values(profiles.projects)) for (const target of targets) assert.ok(profiles.targets[target])
  // mx-common's command-line parameters stay in its manifest.
  assert.equal(Object.keys(profiles.targets['mx-common'].settings).some(key =>
    ['effective_cache_size', 'work_mem', 'maintenance_work_mem', 'random_page_cost'].includes(key)), false)
})
