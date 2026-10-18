import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const probe = new URL('../../server/ops/verify-twitter-query-param.mjs', import.meta.url)

function fixture(t, entryName) {
  const directory = mkdtempSync(join(tmpdir(), 'twitter-halves-entry-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = join(directory, entryName)
  copyFileSync(new URL(`../../server/ops/${entryName}`, import.meta.url), script)
  copyFileSync(probe, join(directory, 'verify-twitter-query-param.mjs'))
  // No cluster, database or network: record only argv and consume local stdin.
  writeFileSync(join(directory, 'kubectl'), '#!/bin/sh\nprintf "%s\\n" "$@"\ncat > "$0.stdin"\n', { mode: 0o755 })
  return { directory, run: args => spawnSync('bash', [script, ...args], { cwd: tmpdir(), encoding: 'utf8',
    env: { PATH: `${directory}:${process.env.PATH}`, MX_TWITTER_QUERY_PARAM_VERIFY: '1' } }) }
}

const podRow = (name = 'mx-insight-hub-admin-test-123', changes = {}) => Object.entries({ name,
  phase: 'Running', deleting: '', ready: 'True', admin: 'true', hostNetwork: 'true', ...changes })
  .map(([key, value]) => `${key}=${value}`).join('\t')

function proxyFixture(t, rows, getStatus = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'twitter-proxy-entry-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = join(directory, 'verify-twitter-query-proxy.sh')
  copyFileSync(new URL('../../server/ops/verify-twitter-query-proxy.sh', import.meta.url), script)
  copyFileSync(probe, join(directory, 'verify-twitter-query-param.mjs'))
  writeFileSync(join(directory, 'kubectl'), `#!/bin/sh
case "$3" in
  get)
    printf '%s\\n' "$@" > "$0.get"
    printf '%s\\n' "$FIXTURE_POD_ROWS"
    exit "$FIXTURE_GET_STATUS"
    ;;
  exec)
    printf '%s\\n' "$@"
    cat > "$0.stdin"
    ;;
  *) exit 98 ;;
esac
`, { mode: 0o755 })
  return { directory, run: args => spawnSync('/bin/bash', [script, ...args], { cwd: tmpdir(), encoding: 'utf8',
    // The host wrapper needs Bash/kubectl only, never a host Node installation.
    env: { PATH: `${directory}:/usr/bin:/bin`, FIXTURE_POD_ROWS: rows,
      FIXTURE_GET_STATUS: String(getStatus), MX_TWITTER_QUERY_PARAM_VERIFY: '1' } }) }
}

test('host-proxy entry inspects readiness and hostNetwork, then pins that exact Pod and sends JavaScript stdin', t => {
  for (const name of ['mx-insight-hub-admin-node-a-123', 'mx-insight-hub-admin-node-b-456']) {
    const f = proxyFixture(t, podRow(name)), result = f.run([])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    const lookup = readFileSync(join(f.directory, 'kubectl.get'), 'utf8').trim().split('\n')
    assert.deepEqual(lookup.slice(0, 8), ['-n', 'mx-insight-hub', 'get', 'pods', '-l',
      'app.kubernetes.io/name=mx-insight-hub-admin', '--field-selector=status.phase=Running', '-o'])
    assert.match(lookup[8], /metadata\.deletionTimestamp/u)
    assert.match(lookup[8], /status\.conditions\[\?\(@\.type=="Ready"\)\]\.status/u)
    assert.match(lookup[8], /status\.containerStatuses\[\?\(@\.name=="admin"\)\]\.ready/u)
    assert.match(lookup[8], /spec\.hostNetwork/u)
    assert.deepEqual(result.stdout.trim().split('\n'), ['-n', 'mx-insight-hub', 'exec', '-i', `pod/${name}`,
      '-c', 'admin', '--', 'env', 'MX_TWITTER_QUERY_PARAM_VERIFY=0', 'node', '--input-type=module', '-', '--case=host-proxy', '--execute'])
    assert.equal(readFileSync(join(f.directory, 'kubectl.stdin'), 'utf8'), readFileSync(probe, 'utf8'))
  }
})

test('host-proxy entry ignores terminating Pods but never guesses among live replicas', t => {
  const rows = [podRow('old-admin-pod', { deleting: '2026-10-18T00:00:00Z' }), podRow('selected-admin-pod')].join('\n')
  const f = proxyFixture(t, rows), result = f.run([])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.split('\n').includes('pod/selected-admin-pod'))
  for (const ambiguous of [[podRow('first'), podRow('second')],
    [podRow('first'), podRow('second', { ready: 'False', admin: 'false' })]]) {
    const duplicate = proxyFixture(t, ambiguous.join('\n')), rejected = duplicate.run([])
    assert.equal(rejected.status, 2)
    assert.equal(rejected.stdout, '')
    assert.match(rejected.stderr, /exactly one/u)
    assert.equal(existsSync(join(duplicate.directory, 'kubectl.stdin')), false)
  }
})

test('host-proxy entry rejects missing, unready, non-host-network or malformed Pod metadata before exec', t => {
  for (const rows of ['', podRow('pending', { phase: 'Pending' }),
    podRow('terminating', { deleting: '2026-10-18T00:00:00Z' }),
    podRow('not-ready', { ready: 'False' }), podRow('no-ready-condition', { ready: '' }),
    podRow('admin-not-ready', { admin: 'false' }), podRow('admin-missing', { admin: '' }),
    podRow('ordinary-pod', { hostNetwork: 'false' }), podRow('default-network', { hostNetwork: '' }),
    'name=only-name', podRow('invalid name'), `${podRow()}\textra=true`]) {
    const f = proxyFixture(t, rows), result = f.run([])
    assert.equal(result.status, 2, rows)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /no diagnostic process was started/u)
    assert.equal(existsSync(join(f.directory, 'kubectl.stdin')), false)
  }
})

test('host-proxy entry stops after a failed Pod lookup, and rejects flags before any cluster lookup', t => {
  const failed = proxyFixture(t, podRow(), 1), result = failed.run([])
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Could not inspect Admin Pods/u)
  assert.equal(existsSync(join(failed.directory, 'kubectl.stdin')), false)
  const f = proxyFixture(t, podRow())
  for (const args of [['--case=control'], ['--proxy=http://different:7788'], ['--execute']]) {
    const rejected = f.run(args)
    assert.equal(rejected.status, 2)
    assert.equal(rejected.stdout, '')
    assert.match(rejected.stderr, /accepts no arguments/u)
    assert.equal(existsSync(join(f.directory, 'kubectl.get')), false)
  }
})

test('host-proxy entry rejects missing or outdated sibling source before any cluster lookup', t => {
  const f = proxyFixture(t, podRow()), source = join(f.directory, 'verify-twitter-query-param.mjs')
  writeFileSync(source, "export const REVISION = 'twitter-query-param-check.v7'\n")
  for (const missing of [false, true]) {
    if (missing) rmSync(source)
    const result = f.run([])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /no cluster request was sent/u)
    assert.equal(existsSync(join(f.directory, 'kubectl.get')), false)
  }
})

for (const [entryName, caseName] of [['verify-twitter-query-halves.sh', 'halves'], ['verify-twitter-query-and.sh', 'english-and'],
  ['verify-twitter-query-groups.sh', 'english-groups'], ['verify-twitter-query-order.sh', 'event-order'],
  ['verify-twitter-query-terms.sh', 'event-terms']]) {
test(`${caseName} entry selects its fixed case and sends JavaScript stdin from any cwd`, t => {
  const f = fixture(t, entryName), result = f.run([])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(result.stdout.trim().split('\n'), ['-n', 'mx-insight-hub', 'exec', '-i',
    'deployment/mx-insight-hub-admin', '-c', 'admin', '--', 'env', 'MX_TWITTER_QUERY_PARAM_VERIFY=0',
    'node', '--input-type=module', '-', `--case=${caseName}`, '--execute'])
  assert.equal(readFileSync(join(f.directory, 'kubectl.stdin'), 'utf8'), readFileSync(probe, 'utf8'))
})

test(`${caseName} entry rejects alternate selections and extra flags before kubectl`, t => {
  const f = fixture(t, entryName)
  for (const args of [['--case=candidate'], ['--case=control'], ['--execute']]) {
    const result = f.run(args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /accepts no arguments/u)
  }
})

test(`${caseName} entry rejects missing or older sibling source before kubectl`, t => {
  const f = fixture(t, entryName), source = join(f.directory, 'verify-twitter-query-param.mjs')
  writeFileSync(source, "export const REVISION = 'twitter-query-param-check.v7'\n")
  for (const missing of [false, true]) {
    if (missing) rmSync(source)
    const result = f.run([])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /no cluster request was sent/u)
  }
})
}
