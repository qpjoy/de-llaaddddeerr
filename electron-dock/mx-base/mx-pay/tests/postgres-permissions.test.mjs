import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { databaseResources } from '../scripts/postgres.mjs'

const installationID = 'a'.repeat(32)
const systemIdentifier = '7692887654783164433'
const mountRoot = '/mx-pay/mx-pay/postgres'
const mode = file => statSync(file).mode & 0o7777
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mx-pay-permissions-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const data = join(root, 'volume'), pgdata = join(data, 'pgdata'), bin = join(root, 'bin')
  mkdirSync(join(pgdata, 'base'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(data, '.installation-id'), installationID, { mode: 0o640 })
  writeFileSync(join(pgdata, 'PG_VERSION'), '16\n', { mode: 0o660 })
  const evidence = join(pgdata, 'base', 'retained-data')
  writeFileSync(evidence, 'original payment data\n', { mode: 0o660 })
  const sibling = join(data, 'unrelated')
  mkdirSync(sibling)
  for (const directory of [data, pgdata, join(pgdata, 'base'), sibling]) chmodSync(directory, 0o2770)
  // Linux must reproduce the exact production mode. Some macOS filesystems
  // remove setgid from unprivileged chmod; still exercise group-write there.
  const initialMode = mode(pgdata)
  assert.equal(initialMode & 0o777, 0o770)
  if (process.platform === 'linux') assert.equal(initialMode, 0o2770)
  const mountinfo = join(root, 'mountinfo')
  const setMountRoot = value => writeFileSync(mountinfo,
    `36 20 8:1 ${value} /var/lib/postgresql/data rw,relatime - xfs /dev/test-volume rw\n`)
  setMountRoot(mountRoot)
  const started = join(root, 'postgres-started')
  writeFileSync(join(bin, 'pg_controldata'), `#!/bin/sh
set -eu
test "$#" = 1 && test "$1" = "$PGDATA"
if [ -n "\${MX_PAY_TEST_MOVE_DATA_TO:-}" ]; then
  mv -- "$PGDATA" "$MX_PAY_TEST_MOVE_DATA_TO"
fi
printf 'Database system identifier: %s\\n' "$MX_PAY_TEST_SYSTEM_ID"
`, { mode: 0o700 })
  writeFileSync(join(bin, 'postgres'), `#!/bin/sh
set -eu
printf 'started\\n' > "$MX_PAY_TEST_STARTED"
`, { mode: 0o700 })
  const container = databaseResources({ localPath: data, volumeMountRoot: mountRoot, systemIdentifier }, { installationID })
    .items.find(item => item.kind === 'StatefulSet').spec.template.spec.containers[0]
  // Run the production shell command against disposable paths; only PostgreSQL
  // binaries are substituted. The shell, chmod and filesystem are real.
  const script = container.command[2]
    .replaceAll('/var/lib/postgresql/data/.installation-id', quote(join(data, '.installation-id')))
    .replaceAll('/proc/self/mountinfo', quote(mountinfo))
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LC_ALL: 'C', PGDATA: pgdata,
    MX_PAY_EXPECTED_MOUNT_ROOT: mountRoot, MX_PAY_TEST_SYSTEM_ID: systemIdentifier,
    MX_PAY_TEST_STARTED: started, MX_PAY_TEST_MOVE_DATA_TO: '' }
  const untouched = [data, join(data, '.installation-id'), join(pgdata, 'PG_VERSION'), join(pgdata, 'base'), evidence, sibling]
  const originalModes = untouched.map(mode)
  return { root, data, pgdata, started, env, setMountRoot, initialMode, paths: [pgdata, ...untouched],
    run: () => spawnSync('sh', ['-ec', script], { env, encoding: 'utf8', timeout: 10000 }),
    assertOtherPathsUnchanged: () => {
      assert.deepEqual(untouched.map(mode), originalModes, 'must not recursively chmod or change the volume root')
      assert.equal(readFileSync(evidence, 'utf8'), 'original payment data\n')
    },
  }
}

test('verified PostgreSQL restart fixes only fsGroup-writable PGDATA to 0700', t => {
  const f = fixture(t)
  assert.equal(mode(f.pgdata), f.initialMode)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(mode(f.pgdata), 0o700)
  assert.equal(readFileSync(f.started, 'utf8'), 'started\n')
  f.assertOtherPathsUnchanged()
  // Repeated startup must remain safe once permissions already match.
  const repeated = f.run()
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.equal(mode(f.pgdata), 0o700)
  f.assertOtherPathsUnchanged()
})

for (const [name, corrupt, expectedError] of [
  ['installation identity', f => writeFileSync(join(f.data, '.installation-id'), 'b'.repeat(32)), /identity missing\/changed/],
  ['PostgreSQL version', f => writeFileSync(join(f.pgdata, 'PG_VERSION'), '15\n'), /identity missing\/changed/],
  ['database base directory', f => rmSync(join(f.pgdata, 'base'), { recursive: true }), /identity missing\/changed/],
  ['PostgreSQL system identifier', f => { f.env.MX_PAY_TEST_SYSTEM_ID = '7692887654783164434' }, /identity missing\/changed/],
  ['volume mount identity', f => f.setMountRoot('/wrong-payment-volume'), /mount changed/],
]) {
  test(`invalid ${name} refuses startup before changing permissions`, t => {
    const f = fixture(t)
    corrupt(f)
    const retained = f.paths.filter(existsSync)
    const modesBefore = retained.map(mode)
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, expectedError)
    assert.deepEqual(retained.map(mode), modesBefore)
    assert.equal(existsSync(f.started), false)
  })
}

test('a real chmod failure prevents PostgreSQL from starting', t => {
  const f = fixture(t)
  const moved = join(f.data, 'retained-pgdata')
  // Simulate disappearance between successful identity checks and chmod. This
  // makes real chmod fail without needing root, foreign ownership or a fake chmod.
  f.env.MX_PAY_TEST_MOVE_DATA_TO = moved
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /chmod/)
  assert.equal(existsSync(f.started), false)
  assert.equal(existsSync(f.pgdata), false)
  assert.equal(mode(moved), f.initialMode)
  assert.equal(mode(f.data), f.initialMode)
  assert.equal(readFileSync(join(moved, 'base', 'retained-data'), 'utf8'), 'original payment data\n')
})
