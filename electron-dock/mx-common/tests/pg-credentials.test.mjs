import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const manage = fileURLToPath(new URL('../scripts/manage.sh', import.meta.url))
const fixture = { username: 'synthetic@role', password: 'test%:/?#@ +', database: 'fixture/data' }

function command(t) {
  const bin = mkdtempSync(join(tmpdir(), 'mx-common-credentials-'))
  t.after(() => rmSync(bin, { recursive: true, force: true }))
  // Only the one authorized read succeeds; a provision/rotation would fail.
  writeFileSync(join(bin, 'kubectl'), `#!/bin/sh
[ "$*" = "-n mx-common get secret mx-common-db-mx-insight-hub -o json" ] || exit 93
printf '%s' "$TEST_SECRET"
exit "$TEST_EXIT"
`, { mode: 0o755 })
  return (args, fields = fixture, status = 0) => {
    const data = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Buffer.from(v).toString('base64')]))
    return spawnSync('bash', [manage, 'pg-credentials', ...args], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_SECRET: JSON.stringify({ data }), TEST_EXIT: String(status) },
    })
  }
}

test('reads one retained Secret and encodes reserved URI characters for loopback clients', t => {
  const run = command(t)
  const json = run(['mx-insight-hub'])
  assert.equal(json.status, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout), { host: '127.0.0.1', port: 2345, ...fixture })
  const dsn = run(['mx-insight-hub', '--dsn'])
  assert.equal(dsn.status, 0, dsn.stderr)
  const uri = new URL(dsn.stdout.trim())
  assert.equal(uri.host, '127.0.0.1:2345')
  assert.equal(decodeURIComponent(uri.username), fixture.username)
  assert.equal(decodeURIComponent(uri.password), fixture.password)
  assert.equal(decodeURIComponent(uri.pathname.slice(1)), fixture.database)
})

test('invalid requests and failed reads emit no credential or partial connection details', t => {
  const run = command(t)
  for (const result of [
    run(['mx-insight-hub'], fixture, 1),
    run(['mx-insight-hub'], { username: fixture.username, password: fixture.password }),
    run(['mx-insight-hub'], { ...fixture, username: 'mx_common' }),
    run(['mx-common']), run(['--all']), run(['mx-insight-hub', '--wrong']),
  ]) {
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.ok(!result.stderr.includes(fixture.password))
    assert.ok(!result.stderr.includes(Buffer.from(fixture.password).toString('base64')))
  }
})
