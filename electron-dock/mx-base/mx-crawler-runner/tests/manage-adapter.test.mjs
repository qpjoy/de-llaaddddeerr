import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// scripts/manage.sh is what the unified electron-dock entry calls
// (`deploy runner`): `deploy` must mean the full rollout, everything else
// passes through to deploy.sh, and the normalized proxy reaches it unchanged.
const here = dirname(fileURLToPath(import.meta.url))

test('the unified-entry adapter maps deploy to deploy.sh all and passes the rest through', t => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-adapter-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  copyFileSync(join(here, '..', 'scripts', 'manage.sh'), join(dir, 'manage.sh'))
  writeFileSync(join(dir, 'deploy.sh'), 'printf "%s|%s|%s\\n" "$*" "${PROXY-unset}" "${MX_INSIGHT_BUILD_PROXY-unset}" >> "$CALLS"\n')
  const calls = join(dir, 'calls')
  const run = (args, env = {}) => spawnSync('bash', [join(dir, 'manage.sh'), ...args], { env: { PATH: process.env.PATH, CALLS: calls, ...env }, encoding: 'utf8' })
  assert.equal(run(['deploy'], { PROXY: 'http://127.0.0.1:7788', MX_INSIGHT_BUILD_PROXY: 'http://127.0.0.1:7788' }).status, 0)
  assert.equal(run(['status']).status, 0)
  assert.equal(run(['build']).status, 0)
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
    'all|http://127.0.0.1:7788|http://127.0.0.1:7788',
    'health|unset|unset',
    'build|unset|unset',
  ])
})
