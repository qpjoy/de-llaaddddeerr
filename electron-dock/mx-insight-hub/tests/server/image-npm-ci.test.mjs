import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('../../scripts/image-npm-ci.sh', import.meta.url))
const mirror = 'https://registry.npmmirror.com'
const official = 'https://registry.npmjs.org'
const custom = 'https://packages.example.test'

function install(t, { available, registry, args = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-image-npm-ci-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = join(dir, 'calls')
  writeFileSync(log, '')
  writeFileSync(join(dir, 'npm'), `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] !== 'ci') process.exit(1)
const option = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1)
  ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const registry = new URL(option('--registry') ?? process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org').href
require('node:fs').appendFileSync(process.env.TEST_CALL_LOG, JSON.stringify({ registry, omit: option('--omit') }) + '\\n')
process.exit(registry === process.env.TEST_AVAILABLE ? 0 : 1)
`, { mode: 0o755 })
  const result = spawnSync('sh', [helper, ...args], { cwd: dir, timeout: 10000, encoding: 'utf8',
    env: { PATH: dir + ':/usr/bin:/bin', TEST_CALL_LOG: log, TEST_AVAILABLE: available ? new URL(available).href : '',
      ...(registry ? { NPM_REGISTRY: registry } : {}) } })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { status: result.status, registries: calls.map(call => call.registry), omitted: calls.map(call => call.omit) }
}

for (const [name, registry, available, expected, production = false] of [
  ['default mirror succeeds', undefined, mirror, [mirror]],
  ['default mirror fails and official registry succeeds', undefined, official, [mirror, official], true],
  ['both default registries fail', undefined, undefined, [mirror, official]],
  ['explicit registry succeeds', custom, custom, [custom], true],
  ['explicit registry fails with no fallback', custom, undefined, [custom]],
]) {
  test(`image npm ci: ${name}`, t => {
    const { status, registries, omitted } = install(t, { registry, available, args: production ? ['--omit=dev'] : [] })
    assert.deepEqual(registries, expected.map(value => new URL(value).href))
    assert.deepEqual(omitted, expected.map(() => production ? 'dev' : undefined))
    assert.equal(status === 0, Boolean(available))
  })
}
