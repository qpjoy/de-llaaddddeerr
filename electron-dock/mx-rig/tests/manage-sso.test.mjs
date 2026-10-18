import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from '../apps/server/index.mjs'

// docs/25 P4 in deployment: the profile Launcher's registration writes on the
// Internal host goes into the Secret mx-rig/mx-rig-sso, checked first, and is
// never printed; a profile the server cannot use turns SSO off, not the server.

const manage = fileURLToPath(new URL('../scripts/manage.sh', import.meta.url))
const SECRET = 'mxsa1.client-secret-never-printed'
const profile = (overrides = {}) =>
  JSON.stringify({
    appId: 'mx-rig',
    origin: 'https://rig.minsight-ai.com',
    issuer: 'https://auth.minsight-ai.com/identity',
    clientId: 'mx-rig-web',
    clientSecret: SECRET,
    audience: 'mx-rig',
    sessionKey: randomBytes(32).toString('base64url'),
    ...overrides
  })

const FAKE_KUBECTL = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const state = process.env.FAKE_KUBE_STATE
const log = (entry) => fs.appendFileSync(process.env.FAKE_KUBE_LOG, JSON.stringify(entry) + '\\n')
if (args[0] === 'create') {
  // --dry-run=client -o yaml: print the Secret the way kubectl would.
  const from = args.find((arg) => arg.startsWith('--from-file=')).split('=').slice(2).join('=')
  log({ args })
  process.stdout.write('apiVersion: v1\\nkind: Secret\\nmetadata:\\n  name: mx-rig-sso\\n  namespace: mx-rig\\ndata:\\n  profile.json: ' + fs.readFileSync(from).toString('base64') + '\\n')
  process.exit(0)
}
if (args[0] === 'apply') {
  const yaml = fs.readFileSync(0, 'utf8')
  log({ args, applied: /name: mx-rig-sso/.test(yaml) })
  fs.writeFileSync(state, /profile\\.json: (\\S+)/.exec(yaml)[1])
  process.exit(0)
}
log({ args })
if (args.includes('get') && args.includes('mx-rig-sso')) process.stdout.write(fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : '')
`

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mx-rig-manage-sso-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(join(dir, 'bin', 'kubectl'), FAKE_KUBECTL)
  chmodSync(join(dir, 'bin', 'kubectl'), 0o755)
  const identity = join(dir, 'identity')
  mkdirSync(join(identity, 'public'), { recursive: true })
  mkdirSync(join(identity, 'private'), { recursive: true })
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^MX_(RIG|LAUNCHER)_/.test(key)) delete env[key]
  Object.assign(env, {
    PATH: `${join(dir, 'bin')}:${env.PATH}`,
    MX_RIG_MANAGE_SOURCE_ONLY: '1',
    MX_RIG_LAUNCHER_IDENTITY_DIR: identity,
    FAKE_KUBE_STATE: join(dir, 'secret.b64'),
    FAKE_KUBE_LOG: join(dir, 'kubectl.log')
  })
  const run = (extra = {}) => spawnSync('bash', ['-c', 'source "$1"\nresolve_sso_profile\nprintf "sso=%s\\n" "$SSO_CHECKSUM"', 'sso-test', manage], { env: { ...env, ...extra }, encoding: 'utf8' })
  const write = (where, content, mode = 0o600) => {
    const file = join(identity, where, 'mx-rig.json')
    writeFileSync(file, content)
    chmodSync(file, mode)
    return file
  }
  return { dir, identity, run, write, kubectl: () => (existsSync(env.FAKE_KUBE_LOG) ? readFileSync(env.FAKE_KUBE_LOG, 'utf8') : ''), stored: () => Buffer.from(readFileSync(env.FAKE_KUBE_STATE, 'utf8'), 'base64').toString() }
}

test('deploy finds the registration, checks it, keeps it in its Secret, and never prints it', async (t) => {
  const f = await fixture(t)
  const off = f.run()
  assert.equal(off.status, 0, off.stderr)
  assert.match(off.stdout, /browser SSO: off/)
  assert.match(off.stdout, /sso=none/)
  const file = f.write('public', profile())
  const on = f.run()
  assert.equal(on.status, 0, on.stderr)
  assert.match(on.stdout, /browser SSO: on at https:\/\/rig\.minsight-ai\.com/)
  assert.equal(f.stored(), readFileSync(file, 'utf8'), 'the Secret holds the file as it is')
  const checksum = /sso=([0-9a-f]{64})/.exec(on.stdout)?.[1]
  assert.ok(checksum, 'a new profile rolls the server')
  for (const text of [on.stdout, on.stderr, f.kubectl()]) assert.ok(!text.includes(SECRET), 'the client secret is never printed or passed as an argument')
  // The file gone from the host: the Secret already there is kept, with the same checksum.
  const { rmSync } = await import('node:fs')
  rmSync(file)
  const kept = f.run()
  assert.match(kept.stdout, /already in mx-rig\/mx-rig-sso/)
  assert.equal(/sso=([0-9a-f]{64})/.exec(kept.stdout)?.[1], checksum, 'no rollout when nothing changed')
})

test('a profile that is not private, not mx-rig, or ambiguous stops the deploy', async (t) => {
  const f = await fixture(t)
  f.write('public', profile(), 0o644)
  const loose = f.run()
  assert.notEqual(loose.status, 0)
  assert.match(loose.stderr, /not usable/)
  f.write('public', profile({ appId: 'mx-pay' }))
  assert.match(f.run().stderr, /not usable/)
  f.write('public', profile())
  f.write('private', profile())
  const both = f.run()
  assert.notEqual(both.status, 0)
  assert.match(both.stderr, /choose one with MX_RIG_SSO_SOURCE/)
  const chosen = f.run({ MX_RIG_SSO_SOURCE: join(f.identity, 'private', 'mx-rig.json') })
  assert.equal(chosen.status, 0, chosen.stderr)
  assert.ok(!f.kubectl().includes(SECRET))
})

test('a profile the server cannot use leaves SSO off and the server up', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mx-rig-badsso-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'profile.json')
  writeFileSync(file, profile())
  chmodSync(file, 0o644)
  const runtime = await start(
    { MX_RIG_ADMIN_TOKEN: 'test-only-rig-secret', MX_RIG_HOST: '127.0.0.1', MX_RIG_PORT: '0', MX_RIG_STORE: 'memory', MX_RIG_STATE_DIR: dir, MX_RIG_ARTIFACTS_DIR: join(dir, 'artifacts'), MX_RIG_SSO_PROFILE: file },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const methods = await (await fetch(`${runtime.origin}/api/rig/v1/auth-methods`)).json()
  assert.deepEqual(methods, { sso: { enabled: false }, password: true })
  // Made private, it is used at the next start.
  chmodSync(file, 0o600)
  const again = await start(
    { MX_RIG_ADMIN_TOKEN: 'test-only-rig-secret', MX_RIG_HOST: '127.0.0.1', MX_RIG_PORT: '0', MX_RIG_STORE: 'memory', MX_RIG_STATE_DIR: dir, MX_RIG_ARTIFACTS_DIR: join(dir, 'artifacts'), MX_RIG_SSO_PROFILE: file },
    { schedule: false }
  )
  t.after(() => again.close())
  assert.deepEqual(await (await fetch(`${again.origin}/api/rig/v1/auth-methods`)).json(), { sso: { enabled: true, origin: 'https://rig.minsight-ai.com' }, password: true })
})
