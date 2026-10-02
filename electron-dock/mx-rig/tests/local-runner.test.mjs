import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from '../apps/server/index.mjs'
import { RigClient } from '../packages/runtime/client.mjs'
import { LocalRunner } from '../apps/desktop/local-runner.mjs'

// The desktop's "make this computer a runner": the platform's own runner
// program, registered with the member's session and started as a child.

test('this computer registers, runs, stops politely and unregisters', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-local-runner-'))
  const server = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'runner-admin',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => server.close())
  const client = new RigClient({ url: server.origin, token: 'runner-admin' })
  const runner = new LocalRunner({
    dir: join(state, 'runner'),
    script: fileURLToPath(new URL('../packages/test-platform/bin/mxt-runner.mjs', import.meta.url))
  })
  t.after(() => runner.stop(2_000))

  await assert.rejects(runner.start(), { code: 'runner_unregistered' })
  const registered = await runner.register(client, { name: 'rig-test-box' })
  assert.equal(registered.registered, true)
  assert.equal(registered.name, 'rig-test-box')
  assert.deepEqual(registered.surfaces, ['web', 'electron'])
  const listed = (await client.request('/api/v1/runners')).runners
  assert.ok(listed.some((entry) => entry.id === registered.runnerId && entry.mine))

  const running = await runner.start()
  assert.equal(running.running, true)
  const deadline = Date.now() + 10_000
  while (
    !(await runner.status()).log.some((line) => /等待任务中/.test(line)) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok((await runner.status()).log.some((line) => /等待任务中/.test(line)))

  const began = Date.now()
  const stopped = await runner.stop(10_000)
  assert.equal(stopped.running, false)
  assert.ok(Date.now() - began < 8_000, 'a stop cuts the idle wait short')
  assert.ok(stopped.log.some((line) => /收到停止请求/.test(line)))
  assert.equal(stopped.exited.code, 0, 'it exited on its own, not killed')

  const removed = await runner.remove(client)
  assert.equal(removed.registered, false)
  assert.equal(removed.unregistered, true)
  const after = (await client.request('/api/v1/runners')).runners
  assert.ok(!after.some((entry) => entry.id === registered.runnerId))
})

test('a runner started from a terminal stays up between polls and stops on Ctrl-C', async (t) => {
  const { spawn } = await import('node:child_process')
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-cli-runner-'))
  const server = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'cli-runner-admin',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => server.close())
  const script = fileURLToPath(
    new URL('../packages/test-platform/bin/mxt-runner.mjs', import.meta.url)
  )
  const dir = join(state, 'runner')
  // Registered the desktop's way; started the way a person (or a container) does.
  await new LocalRunner({ dir, script }).register(
    new RigClient({ url: server.origin, token: 'cli-runner-admin' }),
    { name: 'cli-box' }
  )
  const child = spawn(process.execPath, [script, 'watch'], {
    env: { ...process.env, MXT_RUNNER_CONFIG_DIR: dir, MXT_RUNNER_DATA_DIR: join(dir, 'data') },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.kill('SIGKILL'))
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  const deadline = Date.now() + 10_000
  while (!/等待任务中/.test(output) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50))
  // No IPC channel here: only the idle timer keeps the process alive.
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  assert.equal(child.exitCode, null, `the runner exited while idle:\n${output}`)

  const began = Date.now()
  child.kill('SIGINT')
  assert.equal(await exited, 0)
  assert.ok(Date.now() - began < 5_000, 'Ctrl-C cuts the idle wait short')
})

test('plain HTTP reaches a private test server only when the person says so', async () => {
  const { serviceUrl, isPrivateAddress } = await import('../packages/contracts/index.mjs')
  assert.equal(serviceUrl('http://127.0.0.1:8791'), 'http://127.0.0.1:8791')
  assert.throws(() => serviceUrl('http://10.2.3.4:30891'), { code: 'tls_required' })
  assert.equal(serviceUrl('http://10.2.3.4:30891', { privateHttp: true }), 'http://10.2.3.4:30891')
  for (const host of ['172.20.0.9', '192.168.1.10', '100.96.0.2', '[fd00::1]'])
    assert.equal(isPrivateAddress(host), true, host)
  // Public addresses and names stay HTTPS-only, even with the box ticked.
  for (const url of [
    'http://8.8.8.8',
    'http://rig.example.com',
    'http://172.32.0.1',
    'http://999.1.1.1'
  ])
    assert.throws(() => serviceUrl(url, { privateHttp: true }), undefined, url)
  assert.equal(serviceUrl('https://rig.example.com'), 'https://rig.example.com')
  assert.equal(
    new RigClient({ url: 'http://192.168.9.9:8791', token: 't', privateHttp: true }).url,
    'http://192.168.9.9:8791'
  )
})
