// Optional real-PostgreSQL coverage. No DSN is accepted: every connection uses
// a fresh /tmp cluster's private Unix socket, with TCP listening disabled.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { access, appendFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const sqlFile = fileURLToPath(new URL('../../scripts/night-all-saved-records-source-indexes.sql', import.meta.url))
const categories = ['automotive', 'finance', 'forum', 'hotspot', 'local_news', 'media',
  'news', 'other', 'recruitment', 'research', 'social', 'technology', 'web', 'tender']
const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
  !/^PG/u.test(key) && !/(?:DATABASE_URL|DSN)$/u.test(key)
)))

async function localPostgresBin() {
  const candidates = [...(process.env.PATH || '').split(delimiter),
    ...['/opt/homebrew/opt', '/usr/local/opt'].flatMap(root => (
      ['postgresql', 'postgresql@16', 'postgresql@17', 'postgresql@18'].map(name => join(root, name, 'bin'))
    )),
    ...['16', '17', '18'].map(version => `/usr/lib/postgresql/${version}/bin`),
    '/Applications/Postgres.app/Contents/Versions/latest/bin', '/usr/local/pgsql/bin']
  for (const directory of new Set(candidates.filter(Boolean))) {
    try {
      await Promise.all(['postgres', 'initdb', 'pg_ctl', 'psql'].map(name => access(join(directory, name), constants.X_OK)))
      const version = execFileSync(join(directory, 'postgres'), ['--version'], { encoding: 'utf8', env: childEnvironment })
      if (Number(version.match(/PostgreSQL\) (\d+)/u)?.[1]) >= 16) return directory
    } catch { /* Try the next locally installed bundle; never install or download. */ }
  }
  return null
}

const bin = await localPostgresBin()
const skip = !bin ? 'Local PostgreSQL 16+ initdb/pg_ctl/psql unavailable; real concurrent-index test not executed'
  : process.platform === 'win32' ? 'This isolated-cluster test requires Unix sockets'
    : process.getuid?.() === 0 ? 'initdb cannot run as root; use an unprivileged local test account' : false

test('real PostgreSQL: source index maintenance waits beyond 2s and repairs a managed invalid concurrent build', {
  skip, timeout: 120_000,
}, async (t) => {
  const root = await mkdtemp('/tmp/mx-cic-')
  const data = join(root, 'data')
  const socket = join(root, 'socket')
  const user = 'crawler_index_test'
  const database = 'agent_data_crawler_platform'
  const children = new Set()
  let initialized = false
  let startAttempted = false

  function startPsql(args, { input, db = database } = {}) {
    const child = spawn(join(bin, 'psql'), ['-X', '-w', '-h', socket, '-p', '55432', '-U', user,
      '-d', db, '-v', 'ON_ERROR_STOP=1', ...args], { env: childEnvironment, timeout: 60_000 })
    children.add(child)
    const state = { child, stdout: '', stderr: '', settled: false }
    child.stdout.on('data', chunk => { state.stdout += chunk.toString() })
    child.stderr.on('data', chunk => { state.stderr += chunk.toString() })
    state.done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => {
        children.delete(child)
        state.settled = true
        resolve({ code, stdout: state.stdout, stderr: state.stderr })
      })
    })
    if (input !== undefined) child.stdin.end(input)
    return state
  }

  async function sql(query, { db = database } = {}) {
    const result = await startPsql(['-qAt', '-c', query], { input: '', db }).done
    assert.equal(result.code, 0, result.stderr)
    return result
  }

  async function waitUntil(check, label) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await check()) return
      await delay(50)
    }
    assert.fail(`Timed out waiting for ${label}`)
  }

  async function holdWriter(category) {
    const session = startPsql(['-qAt'])
    session.child.stdin.write(`BEGIN; UPDATE public.saved_records_${category} SET last_seen_at = clock_timestamp() WHERE id = 1; SELECT 'WRITER_HELD';\n`)
    await waitUntil(() => {
      assert.equal(session.settled, false, session.stderr)
      return session.stdout.includes('WRITER_HELD')
    }, 'isolated writer transaction')
    return async () => {
      session.child.stdin.end('COMMIT;\n')
      const result = await session.done
      assert.equal(result.code, 0, result.stderr)
    }
  }

  async function assertInvalid(category) {
    const result = await sql(`SELECT indisvalid, indislive, pg_get_indexdef(indexrelid)
      FROM pg_index WHERE indexrelid = 'public.saved_records_${category}_last_seen_at_id_uidx'::regclass`)
    assert.match(result.stdout, /^f\|t\|CREATE UNIQUE INDEX /u)
    assert.match(result.stdout, /USING btree \(last_seen_at, id\)/u)
    t.diagnostic(`Actual invalid-index evidence: ${result.stdout.trim()}`)
  }

  async function oldTimeout(category) {
    const started = Date.now()
    // Feed separate psql statements; multiple commands in one -c string would
    // itself create an implicit transaction, where CONCURRENTLY is forbidden.
    const result = await startPsql(['-e', '-qAt'], { input: `SET lock_timeout = '2s';\nSET statement_timeout = '15s';
      CREATE UNIQUE INDEX CONCURRENTLY saved_records_${category}_last_seen_at_id_uidx
      ON public.saved_records_${category} (last_seen_at, id);\n` }).done
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /lock timeout/u)
    assert.ok(Date.now() - started >= 1_800, 'the old command should wait for its 2s lock timeout')
    t.diagnostic(`Actual old command output:\n${result.stdout}${result.stderr}`)
    await assertInvalid(category)
  }

  async function runMaintenanceWhileBlocked(category, releaseWriter, expectedCommand) {
    const run = startPsql(['-f', sqlFile], { input: '' })
    await waitUntil(async () => {
      assert.equal(run.settled, false, run.stderr || run.stdout)
      const progress = await sql(`SELECT phase FROM pg_stat_progress_create_index
        WHERE relid = 'public.saved_records_${category}'::regclass`)
      return /waiting for writers|waiting for old snapshots/u.test(progress.stdout)
    }, 'actual maintenance command to reach its concurrent-index wait')
    await delay(2_300)
    assert.equal(run.settled, false, `Maintenance failed while the writer was still held:\n${run.stderr}`)
    await releaseWriter()
    const result = await run.done
    assert.equal(result.code, 0, result.stderr)
    assert.ok(result.stdout.includes(expectedCommand), 'psql must echo the actual generated maintenance command')
    assert.match(result.stdout, /all supported Night-All saved_records source indexes are ready/u)
    t.diagnostic(`Actual maintenance output:\n${result.stdout.split('\n').filter(line => (
      /^(?:CREATE UNIQUE INDEX CONCURRENTLY|REINDEX INDEX CONCURRENTLY|CREATE INDEX$|REINDEX$|all supported)/u.test(line)
    )).join('\n')}`)
    const ready = await sql(`SELECT indisvalid AND indisready AND indislive
      FROM pg_index WHERE indexrelid = 'public.saved_records_${category}_last_seen_at_id_uidx'::regclass`)
    assert.equal(ready.stdout.trim(), 't')
  }

  try {
    await mkdir(socket, { mode: 0o700 })
    execFileSync(join(bin, 'initdb'), ['-D', data, '-U', user, '--auth=trust', '--no-locale', '--encoding=UTF8'], {
      env: childEnvironment, stdio: 'pipe', timeout: 30_000,
    })
    initialized = true
    await appendFile(join(data, 'postgresql.conf'), `\nlisten_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\nport = 55432\nshared_buffers = '16MB'\nmax_connections = 10\n`)
    startAttempted = true
    execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '20', 'start'], {
      env: childEnvironment, stdio: 'pipe', timeout: 25_000,
    })
    await sql(`CREATE DATABASE ${database}`, { db: 'postgres' })
    const isolation = await sql("SELECT current_setting('listen_addresses'), current_setting('unix_socket_directories'), current_setting('data_directory'), current_database()")
    const [listenAddress, socketPath, dataPath, databaseName] = isolation.stdout.trim().split('|')
    assert.equal(listenAddress, '')
    assert.equal(await realpath(socketPath), await realpath(socket))
    assert.equal(await realpath(dataPath), await realpath(data))
    assert.equal(databaseName, database)
    await sql(`CREATE TABLE public.saved_records (source_type varchar NOT NULL, id int NOT NULL, last_seen_at timestamptz NOT NULL, PRIMARY KEY (source_type, id)) PARTITION BY LIST (source_type);
      ${categories.map(category => `CREATE TABLE public.saved_records_${category} PARTITION OF public.saved_records FOR VALUES IN ('${category}'); INSERT INTO public.saved_records VALUES ('${category}', 1, clock_timestamp());`).join('\n')}`)

    const releaseOldWriter = await holdWriter('automotive')
    await oldTimeout('automotive')
    await releaseOldWriter()
    await sql('DROP INDEX public.saved_records_automotive_last_seen_at_id_uidx')
    await runMaintenanceWhileBlocked('automotive', await holdWriter('automotive'),
      'CREATE UNIQUE INDEX CONCURRENTLY saved_records_automotive_last_seen_at_id_uidx')

    await sql('DROP INDEX public.saved_records_research_last_seen_at_id_uidx')
    const releaseRepairWriter = await holdWriter('research')
    await oldTimeout('research')
    await runMaintenanceWhileBlocked('research', releaseRepairWriter,
      'REINDEX INDEX CONCURRENTLY public.saved_records_research_last_seen_at_id_uidx')
  } finally {
    for (const child of children) child.kill('SIGTERM')
    if (initialized && startAttempted) {
      // This data path was created by this test. Never stop an existing server.
      execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', '-t', '10', 'stop'], {
        env: childEnvironment, stdio: 'pipe', timeout: 15_000,
      })
    }
    await rm(root, { recursive: true, force: true })
  }
})
