import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('application manager selects one app, preserves credentials/data and reports unavailable contexts honestly', t => {
  const root = mkdtempSync(join(tmpdir(), 'mx-base-manager-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(new URL('../scripts', import.meta.url), join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'mx-static')); mkdirSync(join(root, 'bin'))
  const log = join(root, 'calls')
  writeFileSync(join(root, 'bin/docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_LOG"
[ "$1" = context ] && { echo mock-docker; exit 0; }
[ "$1" = info ] && exit "\${MOCK_OFFLINE:-0}"
case "$*" in *'ps --all --quiet'*) echo container-id;; *'ps --all'*) echo 'writer Up (healthy)';; esac
exit 0
`, { mode: 0o755 })
  writeFileSync(join(root, 'bin/kubectl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_LOG"
[ "$1" = config ] && { echo mock-cluster; exit 0; }
[ "\${MOCK_OFFLINE:-0}" = 1 ] && { echo 'connection unavailable' >&2; exit 1; }
echo 'mx-base-jenkins 0/0'
`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, MOCK_LOG: log,
    MX_STATIC_DATA_PATH: join(root, 'data'), MX_STATIC_STATE_PATH: join(root, 'state') }
  const run = (...args) => spawnSync('bash', [join(root, 'scripts/manage.sh'), ...args], { env, encoding: 'utf8' })
  let result = run('status'); assert.equal(result.status, 0); assert.match(result.stdout, /mock-cluster/); assert.match(result.stdout, /healthy/)
  assert.notEqual(run('deploy').status, 0)
  assert.notEqual(run('deploy', 'all').status, 0)
  result = run('deploy', 'mx-static'); assert.equal(result.status, 0, result.stderr)
  const keys = readFileSync(join(root, 'mx-static/secrets/projects.json'), 'utf8')
  assert.equal(run('deploy', 'mx-static').status, 0)
  assert.equal(readFileSync(join(root, 'mx-static/secrets/projects.json'), 'utf8'), keys)
  assert.equal(run('stop', 'mx-static').status, 0)
  assert.equal(run('stop', 'jenkins').status, 0)
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /up -d --build --wait/); assert.match(calls, /stop --timeout 40/)
  assert.match(calls, /scale deployment\/mx-base-jenkins --replicas=0/)
  assert.doesNotMatch(calls, /down -v|delete namespace|delete pvc/)
  writeFileSync(join(root, 'bin/timeout'), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 })
  writeFileSync(join(root, 'bin/findmnt'), '#!/bin/sh\necho "${MOCK_FS:-ext4}"\n', { mode: 0o755 })
  env.MX_STATIC_NAS_PATH = join(root, 'nas'); env.MX_STATIC_NAS_VOLUME_ID = 'nas-test'
  assert.notEqual(run('attach', 'mx-static').status, 0)
  env.MOCK_FS = 'nfs4'
  const beforeAttach = readFileSync(log, 'utf8').length
  assert.equal(run('attach', 'mx-static').status, 0)
  assert.equal(run('detach', 'mx-static').status, 0)
  const nasCalls = readFileSync(log, 'utf8').slice(beforeAttach)
  assert.match(nasCalls, /--no-deps --force-recreate archive/)
  assert.match(nasCalls, /stop --timeout 2 archive/)
  assert.doesNotMatch(nasCalls, /restart|stop --timeout 40|up.*writer reader/)
  env.MOCK_OFFLINE = '1'
  result = run('status'); assert.match(result.stdout, /UNKNOWN/); assert.doesNotMatch(result.stdout, /NOT DEPLOYED/)
})
