import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const manage = fileURLToPath(new URL('../scripts/manage.sh', import.meta.url))
const token = 'verify-test-token-must-stay-private'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A real loopback listener in place of kubectl's tunnel. curl remains real:
// the test must catch inherited proxy settings and requests to an occupied
// port, not merely check the arguments the shell happened to construct.
const kubectl = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const args = process.argv.slice(2)
const dir = process.env.FAKE_VERIFY_DIR
const append = (name, value) => fs.appendFileSync(path.join(dir, name), JSON.stringify(value) + '\\n')
append('calls.jsonl', args)
if (args.includes('get') && args.includes('secret')) {
  process.stdout.write(Buffer.from(process.env.FAKE_VERIFY_TOKEN).toString('base64'))
  process.exit(0)
}
if (!args.includes('port-forward')) process.exit(1)
const previous = fs.readFileSync(path.join(dir, 'forwards.jsonl'), 'utf8').trim()
append('forwards.jsonl', { pid: process.pid, args })
if (process.env.FAKE_VERIFY_MODE === 'exit-first' && !previous) {
  console.error('error: lost connection to pod during rollout')
  process.exit(1)
}
const mapping = args.find((arg) => /^\\d*:80$/.test(arg))
if (!mapping) process.exit(2)
const server = http.createServer((req, res) => {
  append('requests.jsonl', { url: req.url, authorization: req.headers.authorization ?? null })
  if (req.url === '/readyz') res.statusCode = process.env.FAKE_VERIFY_MODE === 'unready' ? 503 : 200
  else if (req.url === '/api/rig/v1/me' && process.env.FAKE_VERIFY_MODE === 'identity-fails') res.statusCode = 401
  else res.statusCode = req.headers.authorization === 'Bearer ' + process.env.FAKE_VERIFY_TOKEN ? 200 : 401
  res.end('{}')
})
server.on('error', (error) => {
  console.error('Unable to listen on port: ' + error.code + ': address already in use')
  process.exit(1)
})
server.listen(Number(mapping.split(':')[0] || 0), '127.0.0.1', () => {
  console.log('Forwarding from 127.0.0.1:' + server.address().port + ' -> 80')
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`

async function lines(path) {
  const value = await readFile(path, 'utf8').catch(() => '')
  return value.trim() ? value.trim().split('\n').map((line) => JSON.parse(line)) : []
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function fixture(t, mode = 'ready') {
  const dir = await mkdtemp(join(tmpdir(), 'mx-rig-manage-verify-'))
  t.after(async () => {
    for (const { pid } of await lines(join(dir, 'forwards.jsonl'))) {
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
    await rm(dir, { recursive: true, force: true })
  })
  const bin = join(dir, 'bin')
  const temp = join(dir, 'tmp')
  await mkdir(bin)
  await mkdir(temp)
  // npm test uses this ESM repository for temporary files; executable tools
  // without a .cjs extension must still be interpreted as CommonJS.
  await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}\n')
  await writeFile(join(bin, 'kubectl'), kubectl)
  await chmod(join(bin, 'kubectl'), 0o755)
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\nexec /bin/sleep 0.03\n')
  await chmod(join(bin, 'sleep'), 0o755)
  await writeFile(join(dir, 'forwards.jsonl'), '')
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: temp,
    MX_RIG_ENV_FILE: join(dir, '.env'),
    FAKE_VERIFY_DIR: dir,
    FAKE_VERIFY_MODE: mode,
    FAKE_VERIFY_TOKEN: token,
    // Deliberately broken proxies with no bypass inherited from this machine.
    http_proxy: 'http://127.0.0.1:1',
    HTTP_PROXY: 'http://127.0.0.1:1',
    https_proxy: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    all_proxy: 'socks5://127.0.0.1:1',
    ALL_PROXY: 'socks5://127.0.0.1:1',
    no_proxy: '',
    NO_PROXY: ''
  }
  delete env.MX_RIG_VERIFY_PORT
  delete env.MX_RIG_MANAGE_SOURCE_ONLY
  const run = (extra = {}) => new Promise((resolve, reject) => {
    const child = spawn('bash', [manage, 'verify'], { env: { ...env, ...extra } })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`verify timed out: ${stdout}\n${stderr}`))
    }, 15_000)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
  const cleaned = async (result) => {
    const forwards = await lines(join(dir, 'forwards.jsonl'))
    for (let attempt = 0; attempt < 50 && forwards.some(({ pid }) => alive(pid)); attempt++) await pause(20)
    assert.deepEqual(forwards.filter(({ pid }) => alive(pid)), [], 'verification must reap its actual port-forward processes')
    assert.deepEqual(await readdir(temp), [], 'port-forward diagnostics and bearer-header files must be removed')
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(token), 'the admin token must not appear in output')
    assert.ok(!(await readFile(join(dir, 'calls.jsonl'), 'utf8')).includes(token), 'the admin token must not appear in kubectl arguments')
    return forwards
  }
  return { dir, run, cleaned }
}

test('verify bypasses inherited proxies for readiness and both authenticated checks, then cleans up', async (t) => {
  const f = await fixture(t)
  const result = await f.run()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /verified:/)
  const requests = await lines(join(f.dir, 'requests.jsonl'))
  assert.deepEqual(requests, [
    { url: '/readyz', authorization: null },
    { url: '/api/rig/v1/me', authorization: `Bearer ${token}` },
    { url: '/api/v1/runners', authorization: `Bearer ${token}` }
  ])
  const forwards = await f.cleaned(result)
  assert.equal(forwards.length, 1)
  assert.ok(forwards[0].args.includes(':80'), 'kubectl must choose an available local port by default')
  assert.ok(forwards[0].args.includes('--address') && forwards[0].args.includes('127.0.0.1'))
})

test('verify never sends requests or credentials to an occupied explicit port and reports the bind error', async (t) => {
  const f = await fixture(t)
  const seen = []
  const unrelated = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization })
    res.end('{}')
  })
  await new Promise((resolve, reject) => {
    unrelated.once('error', reject)
    unrelated.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => unrelated.close(resolve)))
  const result = await f.run({ MX_RIG_VERIFY_PORT: String(unrelated.address().port) })
  assert.notEqual(result.status, 0)
  assert.deepEqual(seen, [], 'only a confirmed port-forward may receive verification requests')
  assert.match(`${result.stdout}\n${result.stderr}`, /EADDRINUSE|address already in use/)
  assert.match(`${result.stdout}\n${result.stderr}`, /scripts\/manage\.sh (status|logs)|kubectl/)
  const forwards = await f.cleaned(result)
  assert.ok(forwards.length >= 1 && forwards.length <= 5)
})

test('verify reports persistent readiness failure without trying bearer endpoints and closes the forward', async (t) => {
  const f = await fixture(t, 'unready')
  const result = await f.run()
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /503/)
  assert.match(`${result.stdout}\n${result.stderr}`, /ready|readiness/)
  assert.match(`${result.stdout}\n${result.stderr}`, /scripts\/manage\.sh (status|logs)|kubectl/)
  const requests = await lines(join(f.dir, 'requests.jsonl'))
  assert.ok(requests.length > 1 && requests.length <= 45)
  assert.ok(requests.every((request) => request.url === '/readyz' && request.authorization === null))
  await f.cleaned(result)
})

test('verify reports an identity failure, skips the kernel check and cleans up its bearer header and forward', async (t) => {
  const f = await fixture(t, 'identity-fails')
  const result = await f.run()
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /admin sign-in check failed/)
  assert.match(`${result.stdout}\n${result.stderr}`, /401/)
  assert.deepEqual(await lines(join(f.dir, 'requests.jsonl')), [
    { url: '/readyz', authorization: null },
    { url: '/api/rig/v1/me', authorization: `Bearer ${token}` }
  ])
  await f.cleaned(result)
})

test('verify restarts a port-forward lost during rollout and cleans up the replacement', async (t) => {
  const f = await fixture(t, 'exit-first')
  const result = await f.run()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /verified:/)
  const forwards = await f.cleaned(result)
  assert.equal(forwards.length, 2)
  assert.deepEqual((await lines(join(f.dir, 'requests.jsonl'))).map((request) => request.url), [
    '/readyz', '/api/rig/v1/me', '/api/v1/runners'
  ])
})
