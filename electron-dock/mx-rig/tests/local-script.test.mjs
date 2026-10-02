import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { readFile, stat, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 本机一键体验: `bash scripts/manage.sh local …` on a machine with nothing set
// up. Answers can be typed, piped, or taken as defaults; the service starts
// in the background, says where it is, and stops.

const root = fileURLToPath(new URL('../', import.meta.url))
const script = join(root, 'scripts/local.mjs')

function run(args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, CI: '', MX_RIG_MODEL_API_KEY: '', MX_RIG_LOCAL_MODEL_BASE_URL: '', ...env }
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('exit', (code) => resolve({ code, output }))
    child.stdin.end(input)
  })
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('init asks once, keeps the answers to itself, and the service comes up and goes down', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'mx-rig-local-'))
  const env = { MX_RIG_LOCAL_HOME: home }
  const port = await freePort()
  t.after(() => run(['down'], { env }))

  // Typed (here piped) one per line: LAN no, a port, no database, a model.
  const answers = ['n', String(port), '', 'https://llm.example.invalid/v1', 'fixture-model', 'sk-only-in-local-env', ''].join('\n')
  const init = await run(['init', '--no-start', '--no-browser'], { input: answers, env })
  assert.equal(init.code, 0, init.output)
  assert.match(init.output, /配置已写入/)
  const file = join(home, 'local.env')
  const values = Object.fromEntries(
    (await readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => /^[A-Z]/.test(line))
      .map((line) => line.split(/=(.*)/s).slice(0, 2))
  )
  assert.equal(values.MX_RIG_PORT, String(port))
  assert.equal(values.MX_RIG_HOST, '127.0.0.1')
  assert.equal(values.MX_RIG_LOCAL_MODEL_NAME, 'fixture-model')
  assert.equal(values.MX_RIG_MODEL_API_KEY, 'sk-only-in-local-env')
  assert.match(values.MX_RIG_ADMIN_TOKEN, /^[A-Za-z0-9_-]{24,}$/, 'generated, not asked')
  assert.match(values.MX_RIG_SECRET_KEY, /^[a-f0-9]{64}$/)
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.ok(!init.output.includes(values.MX_RIG_ADMIN_TOKEN), 'the generated password is not printed')

  // Running init again keeps every answer when the person just presses Enter.
  const again = await run(['init', '--no-start', '--no-browser', '--yes'], { env })
  assert.equal(again.code, 0, again.output)
  assert.match(await readFile(file, 'utf8'), new RegExp(`MX_RIG_ADMIN_TOKEN=${values.MX_RIG_ADMIN_TOKEN}`))

  const up = await run(['up'], { env })
  assert.equal(up.code, 0, up.output)
  assert.match(up.output, new RegExp(`http://127\\.0\\.0\\.1:${port}/rig/`))
  assert.match(up.output, /模型已配置：fixture-model/)
  const health = await fetch(`http://127.0.0.1:${port}/healthz`)
  assert.equal(health.status, 200)
  const config = await (
    await fetch(`http://127.0.0.1:${port}/api/rig/v1/config`, { headers: { authorization: `Bearer ${values.MX_RIG_ADMIN_TOKEN}` } })
  ).json()
  assert.equal(config.model.configured, true)
  assert.equal(config.model.name, 'fixture-model')

  const status = await run(['status'], { env })
  assert.match(status.output, /服务：运行中/)
  assert.match(status.output, /模型：fixture-model/)
  assert.equal((await run(['token'], { env })).output.trim(), values.MX_RIG_ADMIN_TOKEN)
  assert.match((await run(['up'], { env })).output, /已经在运行/, 'starting twice starts once')

  const down = await run(['down'], { env })
  assert.match(down.output, /服务已停止/)
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) }))
  assert.match((await run(['status'], { env })).output, /服务：没有运行/)
})

test('a bad answer is refused, and help says what there is', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mx-rig-local-'))
  const refused = await run(['init', '--no-start', '--no-browser'], { input: 'n\n99999\n', env: { MX_RIG_LOCAL_HOME: home } })
  assert.equal(refused.code, 1)
  assert.match(refused.output, /端口无效：99999/)
  const help = await run(['help'])
  assert.match(help.output, /local init/)
  assert.match(help.output, /local desktop/)
})

test('manage.sh hands local over to the same script', { skip: process.platform === 'win32' }, async () => {
  const output = await new Promise((resolve) =>
    execFile('bash', [join(root, 'scripts/manage.sh'), 'local', 'help'], (error, stdout) => resolve(error ? String(error) : stdout))
  )
  assert.match(output, /MX Rig 本机体验/)
})
