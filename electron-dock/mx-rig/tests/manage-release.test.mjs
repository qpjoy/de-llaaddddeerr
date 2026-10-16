import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// docs/25 P2 through scripts/manage.sh: Launcher shows each release secret
// once; `launcher apply` must land it in the Secret mx-rig/mx-rig-release
// (never in an argument, a log line or a leftover file), and `release` must
// hand it to the publishing command through its environment only.

const manage = fileURLToPath(new URL('../scripts/manage.sh', import.meta.url))

// kubectl, as far as these two commands use it, over a JSON file.
const FAKE_KUBECTL = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const file = process.env.FAKE_KUBE_STATE
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { secrets: {} }
fs.appendFileSync(process.env.FAKE_KUBE_LOG, JSON.stringify(args) + '\\n')
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const at = (flag) => args[args.indexOf(flag) + 1]
if (args[0] === 'version' || args[0] === 'apply') process.exit(0)
const name = args[args.indexOf('secret') + (args[args.indexOf('secret') + 1] === 'generic' ? 2 : 1)]
if (args.includes('get') && args.includes('secret')) {
  const secret = state.secrets[name]
  const output = args.find((arg) => arg.startsWith('jsonpath='))
  if (output) {
    const key = /\\.data\\.([A-Z0-9_]+)/.exec(output)?.[1]
    process.stdout.write(secret?.[key] ?? '')
    process.exit(0)
  }
  process.exit(secret ? 0 : 1)
}
if (args.includes('create') && args.includes('secret')) {
  state.secrets[name] = {}
  save()
  process.exit(0)
}
if (args.includes('patch') && args.includes('secret')) {
  const patch = JSON.parse(fs.readFileSync(at('--patch-file'), 'utf8'))
  for (const [key, value] of Object.entries(patch.stringData)) state.secrets[name][key] = Buffer.from(value).toString('base64')
  save()
  process.exit(0)
}
process.exit(1)
`

async function launcher(t) {
  const seen = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
    if (req.url === '/internal/v1/launcher-network/products') return json(200, { products: [] })
    if (req.url === '/internal/v1/app-center/apps/mx-rig' && req.method === 'GET') return json(404, {})
    if (req.url === '/internal/v1/dns/reverse-proxy/routes') return json(200, { routes: [] })
    if (req.url.startsWith('/internal/v1/releases/products/resolve')) return json(200, { identity: { productId: 'mx-rig', packageName: '@qpjoy/mx-rig', channel: 'stable' } })
    if (req.url === '/internal/v1/launcher-network/products/mx-rig') return json(200, { product: { productId: 'mx-rig', serviceVip: '10.88.100.3' } })
    if (req.url === '/internal/v1/app-center/apps/mx-rig')
      return json(200, { app: { appId: 'mx-rig' }, publisher: { credential: { clientId: 'svc_mx-rig_release_publisher', clientSecret: 'mxsa1.publisher-once' } } })
    if (req.url === '/internal/v1/sdk/service-accounts') return json(200, { credential: { clientId: 'svc_mx-rig_release_approver', clientSecret: 'mxsa1.approver-once' } })
    if (req.url === '/internal/v1/sdk/oauth/token') return json(200, { token: { access_token: 'short-lived' } })
    if (req.url.startsWith('/internal/v1/sdk/releases?')) return json(200, { plans: [] })
    json(404, {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}`, seen }
}

function sh(args, env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [manage, ...args], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('launcher apply keeps the once-shown release secrets in their Secret; release reads them back through the environment', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mx-rig-manage-release-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'tmp'))
  // CommonJS, also when npm test keeps temp files inside this ESM package.
  writeFileSync(join(dir, 'bin', 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(join(dir, 'bin', 'kubectl'), FAKE_KUBECTL)
  chmodSync(join(dir, 'bin', 'kubectl'), 0o755)
  const center = await launcher(t)
  const env = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    TMPDIR: join(dir, 'tmp'),
    FAKE_KUBE_STATE: join(dir, 'kube.json'),
    FAKE_KUBE_LOG: join(dir, 'kube.log'),
    MX_LAUNCHER_URL: center.url,
    MX_RIG_PUBLIC_URL: 'http://10.0.0.5:30891',
    MX_RIG_ENV_FILE: join(dir, '.env'),
    MX_LAUNCHER_OPS_TOKEN: 'ops-secret'
  }
  delete env.MX_RIG_RELEASE_HAVE
  const applied = await sh(['launcher', 'apply'], env)
  assert.equal(applied.status, 0, applied.stderr)
  assert.match(applied.stdout, /release credentials kept in mx-rig\/mx-rig-release/)
  const stored = JSON.parse(readFileSync(env.FAKE_KUBE_STATE, 'utf8')).secrets['mx-rig-release']
  const decoded = Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, Buffer.from(value, 'base64').toString()]))
  assert.deepEqual(decoded, {
    MX_RIG_RELEASE_CLIENT_ID: 'svc_mx-rig_release_publisher',
    MX_RIG_RELEASE_CLIENT_SECRET: 'mxsa1.publisher-once',
    MX_RIG_RELEASE_APPROVER_CLIENT_ID: 'svc_mx-rig_release_approver',
    MX_RIG_RELEASE_APPROVER_CLIENT_SECRET: 'mxsa1.approver-once'
  })
  assert.deepEqual(readdirSync(join(dir, 'tmp')), [], 'the hand-off file is gone once stored')
  const kubectl = readFileSync(env.FAKE_KUBE_LOG, 'utf8')
  for (const text of [applied.stdout, applied.stderr, kubectl]) {
    assert.ok(!text.includes('mxsa1.'), 'no secret in output or in a kubectl argument')
    assert.ok(!text.includes('ops-secret'))
  }

  // Applied again: the cluster keeps both, so nothing is issued or rotated.
  const again = await sh(['launcher', 'apply'], env)
  assert.equal(again.status, 0, again.stderr)
  assert.ok(!center.seen.some((call) => call.url.endsWith('/rotate')))
  assert.equal(center.seen.filter((call) => call.url === '/internal/v1/sdk/service-accounts').length, 1)

  const status = await sh(['release', 'status'], { ...env, MX_LAUNCHER_OPS_TOKEN: '' })
  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /no plans yet/)
  const token = center.seen.find((call) => call.url === '/internal/v1/sdk/oauth/token')
  assert.deepEqual([token.body.client_id, token.body.client_secret], ['svc_mx-rig_release_publisher', 'mxsa1.publisher-once'])
  assert.ok(!status.stdout.includes('mxsa1.') && !status.stderr.includes('mxsa1.'))
  assert.ok(existsSync(env.FAKE_KUBE_STATE))
})
