import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repo = fileURLToPath(new URL('../', import.meta.url))

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mx-manage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['scripts', 'src', 'bin']) await mkdir(join(root, dir))
  for (const file of ['scripts/manage.sh', 'src/mounts.mjs', 'package.json']) {
    await copyFile(join(repo, file), join(root, file))
  }
  // A metadata command must not stat the NAS even when it is configured.
  await writeFile(join(root, 'guard.sh'), `
function [() {
  if builtin [ -n "$MX_STATIC_NAS_PATH" ]; then
    case "$*" in *"$MX_STATIC_NAS_PATH"*)
      if builtin [ "$1" = -d ] || builtin [ "$1" = -e ] || builtin [ "$1" = -f ]; then
        echo "unexpected NAS filesystem probe" >&2
        exit 91
      fi ;;
    esac
  fi
  builtin [ "$@"
}
`)
  await writeFile(join(root, 'bin/docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AUDIT_COMMAND_LOG"\n', { mode: 0o755 })
  await writeFile(join(root, 'bin/curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const env = {
    ...process.env,
    PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
    BASH_ENV: join(root, 'guard.sh'), AUDIT_COMMAND_LOG: join(root, 'commands.log'),
    MX_STATIC_DATA_PATH: join(root, 'data'), MX_STATIC_STATE_PATH: join(root, 'state'),
    MX_STATIC_SECRETS_PATH: join(root, 'secrets'),
    MX_STATIC_UID: String(process.getuid()), MX_STATIC_GID: String(process.getgid()),
    MX_STATIC_NAS_PATH: join(root, 'unmounted-nas'), MX_STATIC_NAS_VOLUME_ID: 'fixture-nas',
  }
  const run = (command, overrides = {}) => spawnSync('bash', [join(root, 'scripts/manage.sh'), command], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
  })
  const commands = async () => (await readFile(env.AUDIT_COMMAND_LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  return { run, commands }
}

test('status and doctor do not probe a configured but unavailable NAS path', async t => {
  const f = await fixture(t)
  for (const action of ['status', 'doctor']) {
    const result = f.run(action)
    assert.equal(result.status, 0, result.stderr)
  }
  assert.ok((await f.commands()).some(line => line.includes('ps --format')))
})

test('storage and detach work after the NAS configuration has been removed', async t => {
  const f = await fixture(t)
  for (const action of ['storage', 'detach']) {
    const result = f.run(action, { MX_STATIC_NAS_PATH: '', MX_STATIC_NAS_VOLUME_ID: '' })
    assert.equal(result.status, 0, result.stderr)
  }
  const calls = await f.commands()
  assert.ok(calls.some(line => line.endsWith('src/archive-control.mjs status')))
  const detach = calls.findIndex(line => line.endsWith('src/archive-control.mjs detach'))
  const stop = calls.findIndex(line => line.includes('stop -t 10 archive'))
  assert.ok(detach >= 0 && stop > detach)
})

test('core deployment leaves the independent archive and other build caches alone', async t => {
  const f = await fixture(t)
  const result = f.run('deploy')
  assert.equal(result.status, 0, result.stderr)
  const calls = await f.commands()
  assert.ok(calls.some(line => line.endsWith('writer reader') && line.includes(' up ')))
  const stop = calls.findIndex(line => line.endsWith(' stop writer reader'))
  const migration = calls.findIndex(line => line.endsWith('node src/migrate.mjs'))
  assert.ok(stop >= 0 && migration > stop)
  assert.ok(calls.every(line => !line.includes('--remove-orphans') && !line.includes('builder prune')))
  assert.ok(calls.every(line => !/\b(stop|rm|down)\b.*\barchive\b/.test(line)))
})

test('attach rejects an unmounted NAS before changing the control queue or containers', async t => {
  const f = await fixture(t)
  const result = f.run('attach')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /already mounted NFS/)
  assert.deepEqual(await f.commands(), [])
})
