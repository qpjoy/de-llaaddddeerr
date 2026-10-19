import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const projects = [
  ['mx-launcher', 'launcher', 'mx-launcher', 'MX_LAUNCHER_BUILD_PROXY', ['ops', 'internal-production', 'deploy']],
  ['mx-insight-hub', 'hub', 'mx-insight-hub', 'MX_INSIGHT_BUILD_PROXY', ['ops', 'internal-production', 'deploy']],
  ['mx-dataport', 'dataport', 'mx-dataport', 'MX_HARBOR_BUILD_PROXY', ['ops', 'internal-production', 'deploy']],
  ['mx-device', 'device', 'mx-base/mx-device', 'MX_DEVICE_BUILD_PROXY', ['deploy']],
  ['mx-pay', 'pay', 'mx-base/mx-pay', 'MX_PAY_BUILD_PROXY', ['deploy']],
  ['mx-rig', 'rig', 'mx-rig', 'MX_RIG_BUILD_PROXY', ['deploy']],
]

const recorder = `const fs = require('node:fs')
const path = require('node:path')
const keys = ['PROXY', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'MX_K8S_OS_HOSTNAME', 'MX_K8S_APISERVER_ADVERTISE_ADDRESS', 'MX_SHADOW_BUILDKIT_KEEP_STORAGE',
  'MX_SHADOW_BUILDKIT_PRUNE_UNTIL', 'MX_INSIGHT_SYNC_LAUNCHER', 'MX_SMOKE_DATA',
  'MX_LAUNCHER_BUILD_PROXY', 'MX_INSIGHT_BUILD_PROXY', 'MX_HARBOR_BUILD_PROXY',
  'MX_DEVICE_BUILD_PROXY', 'MX_PAY_BUILD_PROXY', 'MX_RIG_BUILD_PROXY']
if (process.env.FIXTURE_HANDLE_TERM === '1') {
  process.on('SIGTERM', () => fs.writeFileSync(process.env.FIXTURE_SIGNAL_SEEN, 'SIGTERM'))
}
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2),
  env: Object.fromEntries(keys.map(key => [key, process.env[key] ?? null])) }) + '\\n')
const finish = () => process.exit(Number(process.env.FIXTURE_CHILD_EXIT || 0))
if (process.env.FIXTURE_BLOCK_PROJECT === path.basename(process.cwd())) {
  fs.writeFileSync(process.env.FIXTURE_BLOCK_PID, String(process.pid))
  const deadline = Date.now() + 8000
  const timer = setInterval(() => {
    if (fs.existsSync(process.env.FIXTURE_RELEASE)) { clearInterval(timer); finish() }
    if (Date.now() > deadline) process.exit(98)
  }, 20)
} else finish()
`

const kube = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FIXTURE_TOOLS, JSON.stringify({ tool: 'kubectl', args }) + '\\n')
if (process.env.FIXTURE_KUBE_FAIL && args.some(arg => arg.includes(process.env.FIXTURE_KUBE_FAIL))) {
  console.error('fixture cluster unreachable'); process.exit(42)
}
if (args.includes('current-context')) console.log('fixture-context')
else if (args.some(arg => arg.includes('/readyz'))) console.log('[+]etcd ok\\n[+]etcd-readiness ok\\nreadyz check passed')
else if (args.includes('get') && (args.includes('nodes') || args.includes('node'))) {
  const conditions = process.env.FIXTURE_NODE_CONDITIONS ? JSON.parse(process.env.FIXTURE_NODE_CONDITIONS) : [
    { type: 'Ready', status: 'True' }, { type: 'DiskPressure', status: 'False' },
    { type: 'MemoryPressure', status: 'False' }, { type: 'PIDPressure', status: 'False' }
  ]
  console.log(JSON.stringify({ items: [{ metadata: { name: 'mx-internal-server' }, status: { conditions } }] }))
} else if (args.some(arg => arg.includes('kube-system'))) console.log('fixture-cluster-uid')
else console.log('fixture workload Running')
`

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mx unified manage ')))
  t.after(async () => {
    const pidFile = join(root, 'blocked-child.pid')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      if (alive(pid)) process.kill(pid, 'SIGKILL')
      const deadline = Date.now() + 5000
      while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(alive(pid), false, 'the fixture must not leave a running orphan')
    }
    rmSync(root, { recursive: true, force: true })
  })
  cpSync(new URL('../scripts/', import.meta.url), join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'record.cjs'), recorder)
  for (const directory of [...projects.map(project => project[2]), 'mx-common', 'mx-base/mx-move']) {
    mkdirSync(join(root, directory, 'scripts'), { recursive: true })
    writeFileSync(join(root, directory, 'scripts/manage.sh'), '#!/bin/bash\nexec "$FIXTURE_NODE" "$FIXTURE_RECORDER" "$@"\n')
  }
  writeFileSync(join(root, 'bin/kubectl'), kube, { mode: 0o755 })
  for (const command of ['docker', 'crictl', 'curl', 'ssh', 'systemctl']) {
    writeFileSync(join(root, 'bin', command), '#!/bin/sh\nprintf "unexpected tool %s\\n" "$0" >> "$FIXTURE_TOOLS"\nexit 97\n', { mode: 0o755 })
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MX_|PROXY$|https?_proxy$|HTTPS?_PROXY$|ALL_PROXY$|all_proxy$|NO_PROXY$|no_proxy$|BASH_ENV$|ENV$|TMPDIR$)/.test(key)))
  Object.assign(env, {
    PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
    FIXTURE_NODE: process.execPath, FIXTURE_RECORDER: join(root, 'record.cjs'),
    FIXTURE_CALLS: join(root, 'calls.jsonl'), FIXTURE_TOOLS: join(root, 'tools.jsonl'),
    FIXTURE_RELEASE: join(root, 'release'), FIXTURE_SIGNAL_SEEN: join(root, 'signal-seen'),
    FIXTURE_BLOCK_PID: join(root, 'blocked-child.pid'),
    MX_MANAGE_STATE_DIR: join(root, 'state'),
  })
  const argv = args => [join(root, 'scripts/manage.sh'), ...args]
  const run = (args, overrides = {}) => spawnSync('bash', argv(args), {
    cwd: tmpdir(), env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
  })
  const calls = () => existsSync(env.FIXTURE_CALLS) ? readFileSync(env.FIXTURE_CALLS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const tools = () => existsSync(env.FIXTURE_TOOLS) ? readFileSync(env.FIXTURE_TOOLS, 'utf8') : ''
  return { root, env, argv, run, calls, tools }
}

function success(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`)
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

test('list and every deployment plan are offline and do not create management state', t => {
  const f = fixture(t)
  const listed = f.run(['list'])
  success(listed)
  for (const [name, alias] of projects) {
    assert.match(listed.stdout, new RegExp(name))
    success(f.run(['plan', alias], { PROXY: '127.0.0.1:7788' }))
  }
  assert.deepEqual(f.calls(), [])
  assert.equal(f.tools(), '')
  assert.equal(existsSync(f.env.MX_MANAGE_STATE_DIR), false)
})

test('each selected project uses its own directory, exact deployment argv and shared proxy mapping', t => {
  const f = fixture(t)
  for (const [name, alias, directory, proxy, args] of projects) {
    success(f.run(['deploy', alias], { PROXY: '127.0.0.1:7788' }))
    const call = f.calls().at(-1)
    assert.equal(call.cwd, join(f.root, directory), name)
    assert.deepEqual(call.args, args, name)
    assert.equal(call.env[proxy], 'http://127.0.0.1:7788', name)
    if (name === 'mx-dataport') assert.equal(call.env.MX_INSIGHT_BUILD_PROXY, 'http://127.0.0.1:7788')
    if (['mx-launcher', 'mx-device', 'mx-pay'].includes(name)) assert.equal(call.env.TMPDIR, '/data/tmp')
    if (name === 'mx-insight-hub') {
      assert.equal(call.env.MX_INSIGHT_SYNC_LAUNCHER, '0')
      assert.equal(call.env.MX_SMOKE_DATA, '0')
    }
  }
  assert.equal(f.calls().length, projects.length)
})

test('Launcher defaults preserve the supplied production parameters and accept explicit overrides', t => {
  const f = fixture(t)
  const defaults = { TMPDIR: '/data/tmp', MX_K8S_OS_HOSTNAME: 'mx-internal-server',
    MX_K8S_APISERVER_ADVERTISE_ADDRESS: '192.168.1.2', MX_SHADOW_BUILDKIT_KEEP_STORAGE: '2GB',
    MX_SHADOW_BUILDKIT_PRUNE_UNTIL: '24h' }
  success(f.run(['deploy', 'mx-launcher']))
  for (const [key, value] of Object.entries(defaults)) assert.equal(f.calls().at(-1).env[key], value, key)
  const overrides = { TMPDIR: '/custom/tmp', MX_K8S_OS_HOSTNAME: 'another-node',
    MX_K8S_APISERVER_ADVERTISE_ADDRESS: '192.168.1.8', MX_SHADOW_BUILDKIT_KEEP_STORAGE: '3GB',
    MX_SHADOW_BUILDKIT_PRUNE_UNTIL: '48h' }
  success(f.run(['deploy', 'launcher'], overrides))
  for (const [key, value] of Object.entries(overrides)) assert.equal(f.calls().at(-1).env[key], value, key)
})

test('absent PROXY preserves legacy settings while an explicit value or empty value overrides them', t => {
  const f = fixture(t)
  const legacy = { MX_HARBOR_BUILD_PROXY: 'http://old-proxy:7789', MX_INSIGHT_BUILD_PROXY: 'http://fallback:7790' }
  success(f.run(['deploy', 'dataport'], legacy))
  assert.equal(f.calls().at(-1).env.MX_HARBOR_BUILD_PROXY, legacy.MX_HARBOR_BUILD_PROXY)
  assert.equal(f.calls().at(-1).env.MX_INSIGHT_BUILD_PROXY, legacy.MX_INSIGHT_BUILD_PROXY)
  for (const proxy of ['', 'https://proxy.example:7788']) {
    success(f.run(['deploy', 'dataport'], { ...legacy, PROXY: proxy }))
    assert.equal(f.calls().at(-1).env.MX_HARBOR_BUILD_PROXY, proxy)
    assert.equal(f.calls().at(-1).env.MX_INSIGHT_BUILD_PROXY, proxy)
  }
})

test('invalid proxy destinations fail before tools, state or child scripts are used', t => {
  const f = fixture(t)
  for (const proxy of ['*:7788', '0.0.0.0:7788', '[::]:7788', 'http://127.0.0.1', 'http://127.0.0.1:0',
    'http://127.0.0.1:65536', 'http://127.0.0.1:7788/path', 'http://127.0.0.1:7788?x=1',
    'http://127.0.0.1:7788#fragment', 'http://bad host:7788', 'socks5://127.0.0.1:7788']) {
    assert.notEqual(f.run(['deploy', 'launcher'], { PROXY: proxy }).status, 0, proxy)
  }
  assert.deepEqual(f.calls(), [])
  assert.equal(f.tools(), '')
  assert.equal(existsSync(f.env.MX_MANAGE_STATE_DIR), false)
})

test('plans redact proxy credentials', t => {
  const f = fixture(t)
  const result = f.run(['plan', 'pay'], { PROXY: 'http://proxy-user:private-password@127.0.0.1:7788' })
  success(result)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /proxy-user|private-password/)
  assert.deepEqual(f.calls(), [])
})

test('Hub refuses inherited settings that could synchronize Launcher or create smoke data', t => {
  const f = fixture(t)
  for (const overrides of [{ MX_INSIGHT_SYNC_LAUNCHER: '1' }, { MX_SMOKE_DATA: '1' }]) {
    assert.notEqual(f.run(['deploy', 'hub'], overrides).status, 0)
  }
  assert.deepEqual(f.calls(), [])
  assert.equal(f.tools(), '')
})

test('unsupported commands, extra arguments and all-project deployment never reach child scripts', t => {
  const f = fixture(t)
  for (const args of [['deploy'], ['deploy', 'all'], ['deploy', 'common'], ['deploy', '../mx-launcher'],
    ['deploy', 'launcher', '--force'], ['plan', 'missing'], ['restart', 'launcher'], ['etcd', 'migrate']]) {
    assert.notEqual(f.run(args).status, 0, args.join(' '))
  }
  assert.deepEqual(f.calls(), [])
  assert.equal(f.tools(), '')
})

test('failed Kubernetes preflight prevents deployment, and Device does not use Kubernetes', t => {
  const f = fixture(t)
  assert.notEqual(f.run(['deploy', 'pay'], { FIXTURE_KUBE_FAIL: '/readyz' }).status, 0)
  assert.deepEqual(f.calls(), [])
  const before = f.tools()
  success(f.run(['deploy', 'device']))
  assert.equal(f.tools(), before)
  assert.equal(f.calls().at(-1).cwd, join(f.root, 'mx-base/mx-device'))
})

test('node pressure or missing Ready blocks Kubernetes deployment before the project script', t => {
  const f = fixture(t)
  const healthy = [
    { type: 'Ready', status: 'True' }, { type: 'DiskPressure', status: 'False' },
    { type: 'MemoryPressure', status: 'False' }, { type: 'PIDPressure', status: 'False' },
  ]
  const conditions = [
    ...['DiskPressure', 'MemoryPressure', 'PIDPressure'].map(type => healthy.map(condition =>
      condition.type === type ? { ...condition, status: 'True' } : condition)),
    healthy.filter(condition => condition.type !== 'Ready'),
  ]
  for (const value of conditions) {
    const result = f.run(['deploy', 'pay'], { FIXTURE_NODE_CONDITIONS: JSON.stringify(value) })
    assert.notEqual(result.status, 0, JSON.stringify(value))
  }
  assert.deepEqual(f.calls(), [])
})

test('Kubernetes status bypasses legacy scripts; aggregate status continues and reports UNKNOWN', t => {
  const f = fixture(t)
  success(f.run(['status', 'launcher']))
  assert.deepEqual(f.calls(), [])
  const result = f.run(['status'], { FIXTURE_KUBE_FAIL: 'mx-pay' })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /UNKNOWN/)
  for (const [name] of projects) assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(name))
  assert.match(`${result.stdout}\n${result.stderr}`, /mx-common/)
  assert.deepEqual(f.calls().map(call => call.args), [['status']])
})

test('etcd status only forwards the existing read-only status command', t => {
  const f = fixture(t)
  success(f.run(['etcd', 'status']))
  assert.equal(f.calls().length, 1)
  assert.equal(f.calls()[0].cwd, join(f.root, 'mx-base/mx-move'))
  assert.deepEqual(f.calls()[0].args, ['etcd', 'status'])
})

test('deployment returns the original failure status and releases its lock for a later deployment', t => {
  const f = fixture(t)
  assert.equal(f.run(['deploy', 'device'], { FIXTURE_CHILD_EXIT: '37' }).status, 37)
  success(f.run(['deploy', 'device']))
  assert.equal(f.calls().length, 2)
})

test('concurrent deployments are rejected until the running child exits', async t => {
  const f = fixture(t)
  const child = spawn('bash', f.argv(['deploy', 'device']), {
    env: { ...f.env, FIXTURE_BLOCK_PROJECT: 'mx-device' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const completed = new Promise(resolve => child.once('close', status => resolve(status)))
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const deadline = Date.now() + 5000
  while (!f.calls().length && Date.now() < deadline && child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(f.calls().length, 1, stderr)
  const second = f.run(['deploy', 'pay'])
  assert.notEqual(second.status, 0)
  assert.equal(f.calls().length, 1, 'the rejected deploy never reaches its child script')
  writeFileSync(f.env.FIXTURE_RELEASE, '')
  assert.equal(await completed, 0, stderr)
  success(f.run(['deploy', 'device']))
  assert.equal(f.calls().length, 2)
})

test('deployment records are private and never persist proxy credentials', t => {
  const f = fixture(t)
  success(f.run(['deploy', 'device'], { PROXY: 'http://proxy-user:private-password@127.0.0.1:7788' }))
  assert.equal(statSync(f.env.MX_MANAGE_STATE_DIR).mode & 0o777, 0o700)
  const inspect = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const stat = statSync(path)
      if (stat.isDirectory()) inspect(path)
      else {
        assert.equal(stat.mode & 0o077, 0, path)
        assert.doesNotMatch(readFileSync(path, 'utf8'), /proxy-user|private-password/)
      }
    }
  }
  inspect(f.env.MX_MANAGE_STATE_DIR)
})

test('SIGTERM is forwarded while the deployment lock remains held until the child exits', async t => {
  const f = fixture(t)
  const child = spawn('bash', f.argv(['deploy', 'device']), {
    env: { ...f.env, FIXTURE_BLOCK_PROJECT: 'mx-device', FIXTURE_HANDLE_TERM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const completed = new Promise(resolve => child.once('close', status => resolve(status)))
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const startedDeadline = Date.now() + 5000
  while (!f.calls().length && Date.now() < startedDeadline && child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(f.calls().length, 1, output)
  child.kill('SIGTERM')
  const signalDeadline = Date.now() + 5000
  while (!existsSync(f.env.FIXTURE_SIGNAL_SEEN) && Date.now() < signalDeadline && child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(existsSync(f.env.FIXTURE_SIGNAL_SEEN), true, output)
  assert.equal(child.exitCode, null, 'manager waits for the existing child to exit')
  assert.notEqual(f.run(['deploy', 'device']).status, 0)
  assert.equal(f.calls().length, 1, 'a second deployment cannot overlap the terminating one')
  writeFileSync(f.env.FIXTURE_RELEASE, '')
  assert.equal(await completed, 143, output)
  success(f.run(['deploy', 'device']))
})

test('a surviving child retains the deployment lock after the dispatcher is killed', async t => {
  const f = fixture(t)
  const dispatcher = spawn('bash', f.argv(['deploy', 'device']), {
    env: { ...f.env, FIXTURE_BLOCK_PROJECT: 'mx-device' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  dispatcher.stdout.on('data', chunk => { output += chunk })
  dispatcher.stderr.on('data', chunk => { output += chunk })
  const exited = new Promise(resolve => dispatcher.once('exit', (code, signal) => resolve({ code, signal })))
  const closed = new Promise(resolve => dispatcher.once('close', resolve))
  t.after(async () => {
    if (dispatcher.exitCode === null && dispatcher.signalCode === null) dispatcher.kill('SIGKILL')
    await closed
  })
  const startDeadline = Date.now() + 5000
  while (!existsSync(f.env.FIXTURE_BLOCK_PID) && Date.now() < startDeadline && dispatcher.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(existsSync(f.env.FIXTURE_BLOCK_PID), true, output)
  const pid = Number(readFileSync(f.env.FIXTURE_BLOCK_PID, 'utf8'))
  dispatcher.kill('SIGKILL')
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' })
  assert.equal(alive(pid), true, 'the existing deployment child survived its dispatcher')
  assert.notEqual(f.run(['deploy', 'device']).status, 0)
  assert.equal(f.calls().length, 1, 'inherited lock prevents an overlapping deployment')
  writeFileSync(f.env.FIXTURE_RELEASE, '')
  await closed
  const exitDeadline = Date.now() + 5000
  while (alive(pid) && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(alive(pid), false, 'the released mock child exited before the next deploy')
  success(f.run(['deploy', 'device']))
  assert.equal(f.calls().length, 2)
})
