import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('../', import.meta.url))
const origins = 'http://10.88.88.88:30891,http://10.88.100.6'
const publicUrl = 'http://192.168.1.2:30891'
const encoded = (value) => Buffer.from(value).toString('base64')

const fakeKubectl = `#!/usr/bin/env node
const fs = require('node:fs')
const assert = require('node:assert/strict')
const args = process.argv.slice(2)
const file = process.env.ORIGIN_TEST_SECRET
if (args[0] === 'apply') {
  if (args.at(-1) !== '-') process.exit(0)
  const yaml = fs.readFileSync(0, 'utf8')
  assert.match(yaml, /name: mx-rig-secrets/)
  assert.match(yaml, /namespace: mx-rig/)
  const data = Object.fromEntries([...yaml.matchAll(/^  (MX_RIG_[A-Z0-9_]+): "([A-Za-z0-9+/=]*)"$/gm)].map((row) => [row[1], row[2]]))
  fs.writeFileSync(file, JSON.stringify(data))
  process.exit(0)
}
assert.deepEqual(args.slice(0, 2), ['-n', 'mx-rig'])
if (args[2] === 'rollout') process.exit(0)
assert.deepEqual(args.slice(2, 5), ['get', 'secret', 'mx-rig-secrets'])
const key = /\\.data\\.(MX_RIG_[A-Z0-9_]+)/.exec(args.at(-1))[1]
process.stdout.write(JSON.parse(fs.readFileSync(file, 'utf8'))[key] ?? '')
`

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mx-rig-origins-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin/package.json'), '{"type":"commonjs"}')
  writeFileSync(join(dir, 'bin/kubectl'), fakeKubectl)
  chmodSync(join(dir, 'bin/kubectl'), 0o755)
  const secretPath = join(dir, 'secret.json')
  writeFileSync(secretPath, JSON.stringify({
    MX_RIG_ADMIN_TOKEN: encoded('fixture-admin'),
    MX_RIG_POSTGRES_PASSWORD: encoded('fixture-password'),
    MX_RIG_SECRET_KEY: encoded('ab'.repeat(32)),
    MX_RIG_LAUNCHER_URL: encoded('http://127.0.0.1:18090')
  }))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^MX_(RIG|LAUNCHER)_/.test(key)) delete env[key]
  Object.assign(env, {
    PATH: `${join(dir, 'bin')}:${env.PATH}`,
    MX_RIG_ENV_FILE: join(dir, '.env'),
    MX_RIG_COMPOSE_ENV: join(dir, 'compose.env'),
    MX_RIG_MANAGE_SOURCE_ONLY: '1',
    MX_RIG_PUBLIC_URL: publicUrl,
    ORIGIN_TEST_DIR: dir,
    ORIGIN_TEST_SECRET: secretPath
  })
  const run = (body, extra = {}) => {
    const result = spawnSync('bash', ['-c', `source "$1"\nRUNTIME_DIR="$ORIGIN_TEST_DIR/runtime"\n${body}`, 'origins-test', join(root, 'scripts/manage.sh')], {
      env: { ...env, ...extra }, encoding: 'utf8'
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  return {
    env, run,
    config: (value) => writeFileSync(env.MX_RIG_ENV_FILE, value === undefined ? '' : `MX_RIG_ALLOWED_ORIGINS='${value}'\n`),
    secret: () => Object.fromEntries(Object.entries(JSON.parse(readFileSync(secretPath, 'utf8'))).map(([key, value]) => [key, Buffer.from(value, 'base64').toString()])),
    compose: () => Object.fromEntries(readFileSync(env.MX_RIG_COMPOSE_ENV, 'utf8').trimEnd().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  }
}

test('Kubernetes origins survive redeploy, accept explicit empty overrides, and reach the server through Rig secrets', async (t) => {
  const f = await fixture(t)
  const deploy = `
single_node() { :; }
resolve_image() { :; }
resolve_data_root() { :; }
resolve_runner_cidrs() { :; }
apply_files() { :; }
prepare_kubernetes
printf 'checksum=%s\\n' "$SECRET_CHECKSUM"
`
  f.config(origins)
  const first = f.run(deploy)
  assert.equal(f.secret().MX_RIG_ALLOWED_ORIGINS, origins)
  assert.equal(f.secret().MX_RIG_PUBLIC_URL, publicUrl)
  f.config(undefined)
  assert.equal(f.run(deploy), first, 'unset retains the list and its rollout checksum')
  assert.equal(f.secret().MX_RIG_ALLOWED_ORIGINS, origins)

  f.config('http://10.88.100.99')
  f.run(deploy, { MX_RIG_ALLOWED_ORIGINS: origins })
  assert.equal(f.secret().MX_RIG_ALLOWED_ORIGINS, origins, 'shell takes precedence over .env')
  const cleared = f.run(deploy, { MX_RIG_ALLOWED_ORIGINS: '' })
  assert.equal(f.secret().MX_RIG_ALLOWED_ORIGINS, '')
  assert.notEqual(cleared, first, 'clearing the list rolls the server')
  f.config(undefined)
  assert.equal(f.run(deploy), cleared, 'a cleared list stays cleared on the next deploy')
  f.run(deploy, { MX_RIG_ALLOWED_ORIGINS: origins })
  f.config('')
  f.run(deploy)
  assert.equal(f.secret().MX_RIG_ALLOWED_ORIGINS, '', 'an empty .env assignment also clears it')
  assert.equal(f.secret().MX_RIG_PUBLIC_URL, publicUrl)

  const deployment = parse(readFileSync(join(root, 'deploy/k8s/internal/30-server.yaml'), 'utf8').split('\n---\n')[0])
  const setting = deployment.spec.template.spec.containers.find((item) => item.name === 'server').env.find((item) => item.name === 'MX_RIG_ALLOWED_ORIGINS')
  assert.deepEqual(setting.valueFrom.secretKeyRef, { name: 'mx-rig-secrets', key: 'MX_RIG_ALLOWED_ORIGINS', optional: true })
})

test('Compose remembers origins including an explicitly cleared list without changing the public URL', async (t) => {
  const f = await fixture(t)
  const up = 'load_env\nensure_compose_env'
  f.config(origins)
  f.run(up)
  assert.equal(f.compose().MX_RIG_ALLOWED_ORIGINS, origins)
  f.config(undefined)
  f.run(up)
  assert.equal(f.compose().MX_RIG_ALLOWED_ORIGINS, origins)
  f.config('http://10.88.100.99')
  f.run(up, { MX_RIG_ALLOWED_ORIGINS: origins })
  assert.equal(f.compose().MX_RIG_ALLOWED_ORIGINS, origins)
  f.run(up, { MX_RIG_ALLOWED_ORIGINS: '' })
  assert.equal(f.compose().MX_RIG_ALLOWED_ORIGINS, '')
  f.config(undefined)
  f.run(up)
  assert.equal(f.compose().MX_RIG_ALLOWED_ORIGINS, '')
  f.run(up, { MX_RIG_ALLOWED_ORIGINS: origins })
  f.config('')
  f.run(up)
  assert.equal(f.compose().MX_RIG_ALLOWED_ORIGINS, '')
  assert.equal(f.compose().MX_RIG_PUBLIC_URL, publicUrl)
  const compose = parse(readFileSync(join(root, 'deploy/compose.yaml'), 'utf8'))
  assert.equal(compose.services.server.environment.MX_RIG_ALLOWED_ORIGINS, '${MX_RIG_ALLOWED_ORIGINS:-}')
})
