import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const manage = fileURLToPath(new URL('../scripts/manage.sh', import.meta.url))
const ready = 'pod-uid-a||Running|True|true|2026-11-18T01:00:00Z|containerd://postgres-a|10'
const terminating = ready.replace('||Running', '|2026-11-18T01:01:00Z|Running')
const secret = 'synthetic-container-only-password'
const program = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process')
const root = process.env.TEST_FIXTURE, scenario = JSON.parse(process.env.TEST_SCENARIO)
const name = path.basename(process.argv[1]), args = process.argv.slice(2)
function count(key) {
  const file = path.join(root, key + '.count')
  let n = 0
  try { n = Number(fs.readFileSync(file, 'utf8')) } catch {}
  fs.writeFileSync(file, String(n + 1)); return n
}
function pick(values, n, fallback) { return values?.[Math.min(n, values.length - 1)] ?? fallback }
function trace(value) { fs.appendFileSync(path.join(root, 'trace'), JSON.stringify(value) + '\\n') }
if (name === 'kubectl') {
  trace({ name, args })
  if (args.includes('get') && args.includes('pod')) {
    const state = pick(scenario.metadata, count('metadata'), ${JSON.stringify(ready)})
    if (state === 'error') process.exit(1)
    process.stdout.write(state); process.exit(0)
  }
  if (args.includes('get') && args.includes('secret')) {
    process.stdout.write(Buffer.from('TestPassword').toString('base64')); process.exit(0)
  }
  if (args.includes('create') && args.includes('secret')) { process.stdout.write('{}'); process.exit(0) }
  if (args.includes('apply')) { fs.readFileSync(0); process.exit(0) }
  if (!args.includes('exec')) process.exit(94)
  const cmd = args.slice(args.indexOf('--') + 1)
  const containerEnv = { ...process.env, TEST_EXEC_PHASE: args.includes('-i') ? 'actual' : 'probe' }
  delete containerEnv.PGPASSWORD; delete containerEnv.PGOPTIONS
  if (scenario.postgresPassword === null) delete containerEnv.POSTGRES_PASSWORD
  else containerEnv.POSTGRES_PASSWORD = scenario.postgresPassword ?? ${JSON.stringify(secret)}
  // Only the actual SQL exec has -i: the readiness probe cannot consume stdin.
  const answer = cp.spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8',
    input: args.includes('-i') ? fs.readFileSync(0) : undefined,
    env: containerEnv })
  process.stdout.write(answer.stdout || ''); process.stderr.write(answer.stderr || '')
  process.exit(answer.status ?? 97)
}
if (name === 'pg_isready') {
  const probe = process.env.TEST_EXEC_PHASE === 'probe'
  trace({ name, args, probe })
  process.exit(probe ? pick(scenario.probeTcp, count('tcp'), 0) : scenario.finalReadyExit ?? 0)
}
if (name === 'psql') {
  const probe = process.env.TEST_EXEC_PHASE === 'probe'
  trace({ name, args, probe, passwordSet: process.env.PGPASSWORD !== undefined,
    connectTimeout: process.env.PGCONNECT_TIMEOUT, options: process.env.PGOPTIONS ?? null })
  if (probe) {
    if (process.env.PGPASSWORD !== undefined) process.exit(95)
    const answer = pick(scenario.probes, count('probe'), 't')
    if (answer === 'shutdown') { process.stderr.write('FATAL: database system is shutting down\\n'); process.exit(2) }
    process.stdout.write(answer + '\\n'); process.exit(0)
  }
  const input = fs.readFileSync(0, 'utf8')
  fs.appendFileSync(path.join(root, 'sql-input'), input)
  count('sql')
  if (scenario.sqlExit) { process.stderr.write('synthetic SQL failure\\n'); process.exit(scenario.sqlExit) }
  if (args.includes('-Atc')) process.stdout.write('t|t\\n')
  else if (scenario.sqlOutput) process.stdout.write(scenario.sqlOutput)
  process.exit(0)
}
process.exit(98)
`

function fixture(t, scenario = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mx-common-provision-ready-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const name of ['kubectl', 'psql', 'pg_isready']) writeFileSync(join(directory, name), program, { mode: 0o755 })
  return (body = 'psql_super mx_common', input = '') => {
    const result = spawnSync('bash', ['-c', `source "$1"
sleep() { SECONDS=$((SECONDS + $1)); }
${body}`, '_', manage], { encoding: 'utf8', input, timeout: 30000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_FIXTURE: directory,
        TEST_SCENARIO: JSON.stringify(scenario), MX_COMMON_PROVISION_WAIT_TIMEOUT: String(scenario.timeout ?? 20) } })
    const read = name => { try { return readFileSync(join(directory, name), 'utf8') } catch { return '' } }
    result.trace = read('trace').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    result.sqlInput = read('sql-input')
    result.sqlCalls = Number(read('sql.count') || 0)
    assert.equal(result.error, undefined, result.error?.message)
    assert.ok(!result.stdout.includes(secret), 'container password must not appear in stdout')
    assert.ok(!result.stderr.includes(secret), 'container password must not appear in stderr')
    return result
  }
}

test('provision readiness checks TCP plus socket SQL and stable Pod identity without consuming SQL stdin', t => {
  const sql = "DO $$ BEGIN RAISE NOTICE '完整输入'; END $$;\nSELECT 7;\n"
  const result = fixture(t, { sqlOutput: 'SQL result only\n' })('psql_super mx_common', sql)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'SQL result only\n')
  assert.equal(result.sqlInput, sql)
  assert.equal(result.sqlCalls, 1)
  const reads = result.trace.filter(call => call.name === 'kubectl' && call.args.includes('get'))
  assert.equal(reads.length, 2)
  for (const read of reads) {
    assert.ok(read.args.includes('mx-common-postgres-0'))
    assert.ok(read.args.some(arg => /^--request-timeout=[1-5]s$/.test(arg)))
    assert.match(read.args.join(' '), /deletionTimestamp.*containerID.*restartCount/)
  }
  const probe = result.trace.find(call => call.name === 'psql' && call.probe)
  assert.equal(probe.passwordSet, false)
  assert.equal(probe.connectTimeout, '3')
  assert.equal(probe.options, '-c statement_timeout=3000')
  for (const arg of ['-w', '-X']) assert.ok(probe.args.includes(arg))
  assert.equal(probe.args.includes('-h'), false)
  const tcp = result.trace.find(call => call.name === 'pg_isready' && call.probe)
  for (const arg of ['-h', '127.0.0.1', '-t', '3']) assert.ok(tcp.args.includes(arg))
  assert.match(probe.args.at(-1), /NOT pg_is_in_recovery\(\).*transaction_read_only.*default_transaction_read_only/)
  const actual = result.trace.find(call => call.name === 'psql' && !call.probe)
  assert.equal(actual.passwordSet, false)
  assert.equal(actual.options, null)
  assert.equal(actual.args.includes('-h'), false, 'existing socket administrative auth is retained')
  const actualExec = result.trace.find(call => call.name === 'kubectl' && call.args.includes('-i'))
  assert.ok(actualExec.args.includes('mx-common-postgres-0'))
  assert.ok(actualExec.args.includes('postgres'))
  assert.equal(actualExec.args.some(arg => arg.startsWith('--request-timeout')), false, 'DDL has no new request timeout')
  assert.equal(result.trace.some(call => call.name === 'kubectl' && call.args.some(arg => ['delete', 'patch', 'rollout', 'scale'].includes(arg))), false)
})

test('shutdown and recovery/read-only probes retry only the read-only gate before SQL', t => {
  const result = fixture(t, { probes: ['shutdown', 'f', 't'], sqlOutput: 'ready\n' })()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.sqlCalls, 1)
  assert.equal(result.trace.filter(call => call.name === 'psql' && call.probe).length, 3)
  assert.equal(result.stdout, 'ready\n')
  assert.match(result.stderr, /waiting for mx-common-postgres-0\/postgres/)
})

test('terminating, unready and nonrunning containers never qualify even with old ready counts', t => {
  for (const state of [terminating, ready.replace('|True|true|', '|False|true|'), ready.replace('|True|true|', '|True|false|'),
    ready.replace('|Running|', '|Pending|'), ready.replace('|2026-11-18T01:00:00Z|', '||'), 'error']) {
    const result = fixture(t, { metadata: [state], timeout: 1 })()
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.sqlCalls, 0)
    assert.equal(result.trace.some(call => call.name === 'psql'), false)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /this provisioning statement was not sent; earlier statements may have completed/)
  }
})

test('UID, container ID and restart changes across a successful probe require a new stable probe', t => {
  for (const changed of [ready.replace('pod-uid-a', 'pod-uid-b'), ready.replace('postgres-a', 'postgres-b'), ready.replace('|10', '|11')]) {
    const result = fixture(t, { metadata: [ready, changed, changed, changed] })()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.sqlCalls, 1)
    assert.equal(result.trace.filter(call => call.name === 'psql' && call.probe).length, 2)
    assert.equal(result.trace.filter(call => call.name === 'kubectl' && call.args.includes('get')).length, 4)
  }
})

test('persistent shutdown or read-only state times out with empty stdout and no provisioning statement', t => {
  for (const probe of ['shutdown', 'f']) {
    const result = fixture(t, { probes: [probe], timeout: 1 })()
    assert.equal(result.status, 1)
    assert.equal(result.sqlCalls, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /did not become ready for provisioning in 1s/)
  }
})

test('actual SQL exit 2 or 3 is returned once with complete stdin and is never replayed', t => {
  for (const code of [2, 3]) {
    const sql = 'CREATE EXTENSION IF NOT EXISTS vector;\nSELECT 1;\n'
    const result = fixture(t, { sqlExit: code })('psql_super mx_insight_hub', sql)
    assert.equal(result.status, code, result.stderr)
    assert.equal(result.sqlCalls, 1)
    assert.equal(result.sqlInput, sql)
    assert.equal(result.trace.filter(call => call.name === 'psql' && call.probe).length, 1)
  }
})

test('a last-moment TCP readiness failure sends no SQL and does not retry execution', t => {
  const result = fixture(t, { finalReadyExit: 1 })('psql_super mx_common', 'SELECT 42;\n')
  assert.equal(result.status, 2)
  assert.equal(result.sqlCalls, 0)
  assert.equal(result.trace.filter(call => call.name === 'kubectl' && call.args.includes('-i')).length, 1)
})

test('missing or stale POSTGRES_PASSWORD does not change existing socket authentication', t => {
  for (const postgresPassword of [null, 'stale-container-password']) {
    const result = fixture(t, { postgresPassword })()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.sqlCalls, 1)
    assert.equal(result.trace.filter(call => call.name === 'psql').every(call => !call.passwordSet), true)
    const execs = result.trace.filter(call => call.name === 'kubectl' && call.args.includes('exec'))
    assert.equal(execs.some(call => /POSTGRES_PASSWORD|PGPASSWORD/.test(call.args.join(' '))), false)
  }
})

test('TCP unavailability blocks provisioning even when socket SQL would succeed', t => {
  const result = fixture(t, { probeTcp: [1], probes: ['t'], timeout: 1 })()
  assert.equal(result.status, 1)
  assert.equal(result.sqlCalls, 0)
  assert.equal(result.trace.some(call => call.name === 'psql'), false)
  assert.equal(result.stdout, '')
})

test('provision keeps stdout as one DSN and gates each SQL call without rotating retained credentials', t => {
  const result = fixture(t)('need() { :; }; resolve_host_data_root() { :; }; cmd_provision mx-insight-hub TestPassword')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'postgres://mx_insight_hub:TestPassword@mx-common-postgres.mx-common.svc.cluster.local:5432/mx_insight_hub\n')
  assert.equal(result.sqlCalls, 5)
  assert.equal(result.trace.filter(call => call.name === 'psql' && call.probe).length, 5)
  assert.match(result.sqlInput, /CREATE EXTENSION IF NOT EXISTS pg_trgm/)
  assert.match(result.sqlInput, /ALTER SCHEMA public OWNER TO mx_insight_hub/)
})

test('invalid readiness timeouts fail without metadata, credentials or SQL requests', t => {
  for (const timeout of ['0', '-1', 'nope', '3601', '99999999999999999999999']) {
    const result = fixture(t, { timeout })()
    assert.equal(result.status, 1)
    assert.equal(result.trace.length, 0)
    assert.equal(result.stdout, '')
  }
})

test('positive decimal readiness timeouts accept leading zeroes without octal arithmetic', t => {
  const result = fixture(t, { timeout: '0008' })()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.sqlCalls, 1)
})
