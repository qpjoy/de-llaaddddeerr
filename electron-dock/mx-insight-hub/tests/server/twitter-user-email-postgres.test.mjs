// Native PostgreSQL test for the Twitter user-email dictionary. Runs only with
// MX_INSIGHT_TEST_DATABASE_URL; it creates and drops its own database.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { ServerFileReader } from '../../server/ingest/external/server-files.mjs'
import { TwitterUserEmailStore, versionTables } from '../../server/data/twitter-user-email/store.mjs'
import { TwitterUserEmailEngine } from '../../server/data/twitter-user-email/engine.mjs'
import { TwitterUserEmailSearch } from '../../server/data/twitter-user-email/search.mjs'
import { normalizeSearchRequest } from '../../server/data/twitter-user-email/contract.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const PARTITIONS = 4

function fixture() {
  const pairs = []
  for (let i = 0; i < 1500; i += 1) {
    const domain = ['gmail.com', 'yahoo.com', 'Example.ORG', 'mail.ru'][i % 4]
    pairs.push([`user${i}_${['alpha', 'bravo', 'charlie'][i % 3]}`, `${['al', 'bo', 'cy'][i % 3]}${i}@${domain}`])
  }
  pairs.push(['JohnSmith', 'john.smith@gmail.com'])
  pairs.push(['johnsmith', 'jsmith@yahoo.com'])
  pairs.push(['Shared', 'shared@x.io'])
  pairs.push(['Other', 'shared@x.io'])
  // Quarantined: no @, empty name, NUL.
  pairs.push(['broken', 'not-an-email'])
  pairs.push(['', 'empty@x.io'])
  pairs.push(['nul\u0000name', 'n@x.io'])
  const body = pairs.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
  // A duplicate key repeats an exact pair: one mapping, dup_count 2.
  body.push(`${JSON.stringify('JohnSmith')}:${JSON.stringify('john.smith@gmail.com')}`)
  body.push('"numeric":42')
  return { text: `{${body.join(',\n')}}\n`, sourcePairs: body.length }
}

async function setup(t) {
  const admin = new pg.Pool({ connectionString, max: 2 })
  const database = `mx_tue_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await admin.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`)
  const url = new URL(connectionString)
  url.pathname = `/${database}`
  const pool = new pg.Pool({ connectionString: url.toString(), max: 6 })
  await pool.query(await readFile(new URL('../../migrations/178_twitter_user_email_dictionary.sql', import.meta.url), 'utf8'))
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tue-')))
  const reader = await ServerFileReader.create({ roots: [{ rootId: 'test-root', path: root }] })
  const store = new TwitterUserEmailStore(pool, { partitions: PARTITIONS })
  t.after(async () => {
    await pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  })
  return { pool, root, reader, store }
}

function engineFor(ctx, overrides = {}) {
  return new TwitterUserEmailEngine({
    pool: ctx.pool, store: ctx.store, fileReader: ctx.reader, logger: process.env.TUE_DEBUG ? console : { log() {}, error() {} },
    batchPairs: 97, chunkBytes: 1024, targetRowsPerSecond: 1e9, shaBytesPerSecond: 1e12,
    sleep: async () => {}, ...overrides,
  })
}

async function startVersion(ctx, relativePath, expectedSha256) {
  const file = await ctx.reader.inspectLargeLocator({ rootId: 'test-root', relativePath })
  return ctx.store.createVersion({ file, expectedSha256, createdBy: 'test' })
}

const context = { tenant: { id: randomUUID() }, consumer: { id: randomUUID() }, apiKey: { id: randomUUID() } }

test('imports, deduplicates, publishes and searches the dictionary', { skip: !connectionString }, async t => {
  const ctx = await setup(t)
  const { text, sourcePairs } = fixture()
  await writeFile(join(ctx.root, 'users.json'), text)
  const sha = createHash('sha256').update(text).digest('hex')
  const created = await startVersion(ctx, 'users.json', sha)

  // Pause after the third batch commit, then resume from the checkpoint.
  let commits = 0
  const engine = engineFor(ctx, { afterBatch: async () => { commits += 1; if (commits === 3) await ctx.store.requestPause(created.id) } })
  assert.equal(await engine.runOpenVersion(), 'paused')
  const paused = await ctx.store.version(created.id)
  assert.equal(paused.run_state, 'paused')
  assert.equal(paused.stage, 'importing')
  assert.ok(Number(paused.pairs_read) > 0 && Number(paused.pairs_read) < sourcePairs)
  await ctx.store.requestResume(created.id)
  assert.equal(await engine.runOpenVersion(), 'ready')

  const ready = await ctx.store.version(created.id)
  assert.equal(ready.source_sha256, sha)
  assert.equal(Number(ready.pairs_read), sourcePairs)
  assert.equal(Number(ready.pairs_quarantined), 4)
  assert.deepEqual(ready.quarantine_reasons, { missing_at: 1, empty_username: 1, nul_character: 1, non_string_value: 1 })
  assert.equal(Number(ready.pairs_loaded), sourcePairs - 4)
  assert.equal(Number(ready.duplicate_pairs), 1)
  assert.equal(Number(ready.unique_mappings), sourcePairs - 5)
  const tables = versionTables(created.id, PARTITIONS)
  assert.equal((await ctx.pool.query(`SELECT to_regclass('${tables.stage}') AS t`)).rows[0].t, null)
  const indexes = await ctx.pool.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'account_dictionary' AND tablename LIKE $1`, [`mappings_v${created.id}_p%`])
  assert.equal(indexes.rows[0].n, PARTITIONS * 4)

  await ctx.store.publish(created.id, { publishedBy: 'test' })
  const search = new TwitterUserEmailSearch({ pool: ctx.pool, store: ctx.store, hmacKey: 'k'.repeat(32) })
  const run = body => search.search(context, normalizeSearchRequest(body))

  const exact = await run({ query: 'JohnSmith' })
  assert.deepEqual(exact.items.map(item => [item.username, item.email, item.matchType]),
    [['JohnSmith', 'jo***@gmail.com', 'exact'], ['johnsmith', 'js***@yahoo.com', 'case_insensitive']])
  assert.equal(exact.items[0].sourceRecords, 2)

  const reverse = await run({ mode: 'email', query: 'SHARED@X.IO', reveal: true })
  assert.deepEqual(reverse.items.map(item => item.username).sort(), ['Other', 'Shared'])
  assert.equal(reverse.items[0].email, 'shared@x.io')
  assert.equal(reverse.items[0].matchType, 'case_insensitive')

  // Source value was cy2@Example.ORG: domain is case-folded, local part matched case-insensitively.
  const domainCase = await run({ mode: 'email', query: 'CY2@example.org' })
  assert.deepEqual(domainCase.items.map(item => [item.username, item.matchType]), [['user2_charlie', 'case_insensitive']])

  const prefix = await run({ mode: 'prefix', query: 'user14', limit: 5 })
  assert.equal(prefix.items.length, 5)
  assert.ok(prefix.items.every(item => item.username.startsWith('user14')))
  const sorted = prefix.items.map(item => item.username.toLowerCase())
  assert.deepEqual(sorted, [...sorted].sort())

  const localPrefix = await run({ mode: 'prefix', field: 'email_local', query: 'cy1', domain: 'yahoo.com' })
  assert.ok(localPrefix.items.length > 0 && localPrefix.items.every(item => item.domain === 'yahoo.com'))

  const contains = await run({ mode: 'contains', query: 'charl', limit: 7 })
  assert.equal(contains.items.length, 7)
  assert.ok(contains.items.every(item => item.username.includes('charl')))

  const fuzzy = await run({ mode: 'fuzzy', query: 'jonsmith' })
  assert.ok(fuzzy.items.some(item => item.username.toLowerCase() === 'johnsmith'))
  assert.ok(fuzzy.items.every(item => item.similarity >= 0.45))

  const noDomain = await run({ query: 'JohnSmith', domain: 'nowhere.example' })
  assert.equal(noDomain.items.length, 0)

  await assert.rejects(run({ mode: 'contains', query: 'a.b.c.d' }), error => error.code === 'query_too_broad')

  // Audit keeps an HMAC and counts, never the query text.
  const audit = await ctx.pool.query('SELECT query_hmac, outcome, revealed_count FROM account_dictionary.access_events')
  assert.ok(audit.rows.length >= 9)
  assert.ok(audit.rows.every(row => /^[0-9a-f]{64}$/.test(row.query_hmac)))
  assert.ok(audit.rows.some(row => row.revealed_count === 2))
  assert.ok(audit.rows.some(row => row.outcome === 'too_broad'))
  assert.ok(!JSON.stringify(audit.rows).includes('JohnSmith'))
})

test('a second version publishes, rolls back, and old data is dropped', { skip: !connectionString }, async t => {
  const ctx = await setup(t)
  await writeFile(join(ctx.root, 'a.json'), '{"A":"a@x.io","B":"b@x.io"}')
  await writeFile(join(ctx.root, 'b.json'), '{"A":"a2@x.io"}')
  await writeFile(join(ctx.root, 'c.json'), '{"C":"c@x.io"}')
  const engine = engineFor(ctx)
  const search = new TwitterUserEmailSearch({ pool: ctx.pool, store: ctx.store, hmacKey: 'k'.repeat(32) })
  const find = async () => (await search.search(context, normalizeSearchRequest({ query: 'A', reveal: true }))).items.map(item => item.email)

  const v1 = await startVersion(ctx, 'a.json', null)
  const outcome = await engine.runOpenVersion()
  assert.equal(outcome, 'ready', JSON.stringify((await ctx.store.version(v1.id))))
  await ctx.store.publish(v1.id, { publishedBy: 'test' })
  assert.deepEqual(await find(), ['a@x.io'])

  const v2 = await startVersion(ctx, 'b.json', null)
  await assert.rejects(startVersion(ctx, 'b.json', null), error => error.code === 'dictionary_version_open')
  assert.equal(await engine.runOpenVersion(), 'ready')
  await ctx.store.publish(v2.id, { publishedBy: 'test' })
  search.cached = null
  assert.deepEqual(await find(), ['a2@x.io'])

  await ctx.store.rollback({ rolledBackBy: 'test' })
  search.cached = null
  assert.deepEqual(await find(), ['a@x.io'])
  await ctx.store.rollback({ rolledBackBy: 'test' })

  const v3 = await startVersion(ctx, 'c.json', null)
  assert.equal(await engine.runOpenVersion(), 'ready')
  await ctx.store.publish(v3.id, { publishedBy: 'test' })
  await engine.cleanup()
  const dropped = await ctx.store.version(v1.id)
  assert.ok(dropped.data_dropped_at)
  assert.equal((await ctx.pool.query(`SELECT to_regclass('account_dictionary.mappings_v${v1.id}') AS t`)).rows[0].t, null)
  assert.ok(!(await ctx.store.version(v2.id)).data_dropped_at)
})

test('discard, changed source and SHA mismatch stop safely', { skip: !connectionString }, async t => {
  const ctx = await setup(t)
  const { text } = fixture()
  await writeFile(join(ctx.root, 'users.json'), text)

  const wrong = await startVersion(ctx, 'users.json', '0'.repeat(64))
  assert.equal(await engineFor(ctx).runOpenVersion(), 'failed')
  assert.equal((await ctx.store.version(wrong.id)).error_code, 'source_sha256_mismatch')
  await ctx.store.requestDiscard(wrong.id)
  assert.equal((await ctx.store.version(wrong.id)).stage, 'discarded')

  const created = await startVersion(ctx, 'users.json', null)
  let commits = 0
  const engine = engineFor(ctx, { afterBatch: async () => { commits += 1; if (commits === 2) await ctx.store.requestPause(created.id) } })
  assert.equal(await engine.runOpenVersion(), 'paused')
  // Modify the file after the version started: resume must refuse it.
  const future = new Date(Date.now() + 60_000)
  await utimes(join(ctx.root, 'users.json'), future, future)
  await ctx.store.requestResume(created.id)
  assert.equal(await engine.runOpenVersion(), 'failed')
  assert.equal((await ctx.store.version(created.id)).error_code, 'source_changed')

  const discarded = await ctx.store.requestDiscard(created.id)
  assert.equal(discarded.stage, 'discarded')
  const tables = versionTables(created.id, PARTITIONS)
  assert.equal((await ctx.pool.query(`SELECT to_regclass('${tables.stage}') AS t`)).rows[0].t, null)
  assert.equal(Number((await ctx.pool.query('SELECT count(*) FROM account_dictionary.quarantine WHERE version_id = $1', [created.id])).rows[0].count), 0)
})

const pgError = (code, message) => Object.assign(new Error(message), { code })
const SHM_FULL = () => pgError('53100', 'could not resize shared memory segment "/PostgreSQL.1" to 209715200 bytes: No space left on device')

test('shared-memory exhaustion is retried from the checkpoint without double counting', { skip: !connectionString }, async t => {
  const ctx = await setup(t)
  const { text, sourcePairs } = fixture()
  await writeFile(join(ctx.root, 'users.json'), text)
  const created = await startVersion(ctx, 'users.json', null)
  let commits = 0
  const waits = []
  const seen = []
  const engine = engineFor(ctx, {
    retryDelaysMs: [30, 60],
    sleep: async ms => { waits.push(ms) },
    // Two failures in a row with no progress between them use the budget of 2.
    afterBatch: async () => {
      commits += 1
      if (commits === 2 || commits === 3) {
        seen.push((await ctx.store.version(created.id)).error_code)
        throw SHM_FULL()
      }
    },
  })
  assert.equal(await engine.runOpenVersion(), 'ready')
  assert.deepEqual(seen, [null, 'database_shared_memory_full'])
  assert.deepEqual(waits.filter(ms => ms >= 30), [30, 60])
  const ready = await ctx.store.version(created.id)
  assert.equal(ready.run_state, 'done')
  assert.equal(ready.error_code, null)
  // The failed batches were already committed: resuming must not re-read them.
  assert.equal(Number(ready.pairs_read), sourcePairs)
  assert.equal(Number(ready.unique_mappings), sourcePairs - 5)
})

test('a full disk fails at once and an exhausted retry budget asks for the operator', { skip: !connectionString }, async t => {
  const ctx = await setup(t)
  const { text } = fixture()
  await writeFile(join(ctx.root, 'users.json'), text)

  const disk = await startVersion(ctx, 'users.json', null)
  let waits = 0
  const diskEngine = engineFor(ctx, {
    retryDelaysMs: [30],
    sleep: async ms => { if (ms >= 30) waits += 1 },
    afterBatch: async () => { throw pgError('53100', 'could not extend file "base/1/2": No space left on device') },
  })
  assert.equal(await diskEngine.runOpenVersion(), 'failed')
  assert.equal(waits, 0)
  const failed = await ctx.store.version(disk.id)
  assert.equal(failed.error_code, 'database_disk_full')
  assert.doesNotMatch(failed.error_message, /base\/1\/2/)
  await ctx.store.requestDiscard(disk.id)

  const shm = await startVersion(ctx, 'users.json', null)
  const shmEngine = engineFor(ctx, { retryDelaysMs: [30, 60], afterBatch: async () => { throw SHM_FULL() } })
  // Every retry commits one more batch, but the hook throws before the step
  // is acknowledged, so there is no progress and the budget runs out.
  assert.equal(await shmEngine.runOpenVersion(), 'failed')
  const exhausted = await ctx.store.version(shm.id)
  assert.equal(exhausted.run_state, 'failed')
  assert.equal(exhausted.error_code, 'database_shared_memory_full')
  assert.doesNotMatch(exhausted.error_message, /retry/)
  // 继续 clears the error and the next pass completes.
  await ctx.store.requestResume(shm.id)
  assert.equal(await engineFor(ctx).runOpenVersion(), 'ready')
})

// Clients from this pool reject the first statement matching `predicate`.
function poolFailingOnce(pool, predicate, error) {
  let armed = true
  const bind = (target, prop) => (typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop])
  return new Proxy(pool, {
    get(target, prop) {
      if (prop !== 'connect') return bind(target, prop)
      return async () => {
        const client = await target.connect()
        return new Proxy(client, {
          get(inner, name) {
            if (name !== 'query') return bind(inner, name)
            return (sql, ...rest) => {
              if (armed && typeof sql === 'string' && predicate(sql)) { armed = false; return Promise.reject(error) }
              return inner.query(sql, ...rest)
            }
          },
        })
      }
    },
  })
}

test('a VACUUM that hits /dev/shm during the build resumes at the same partition step', { skip: !connectionString }, async t => {
  const ctx = await setup(t)
  const { text, sourcePairs } = fixture()
  await writeFile(join(ctx.root, 'users.json'), text)
  const created = await startVersion(ctx, 'users.json', null)
  const waits = []
  const engine = engineFor(ctx, {
    pool: poolFailingOnce(ctx.pool, sql => sql.startsWith('VACUUM'), SHM_FULL()),
    retryDelaysMs: [30],
    sleep: async ms => { waits.push(ms) },
  })
  assert.equal(await engine.runOpenVersion(), 'ready')
  assert.deepEqual(waits, [30])
  const ready = await ctx.store.version(created.id)
  assert.equal(ready.error_code, null)
  assert.equal(Number(ready.unique_mappings), sourcePairs - 5)
  const tables = versionTables(created.id, PARTITIONS)
  for (let k = 0; k < PARTITIONS; k += 1) {
    const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'account_dictionary' AND tablename = $1`, [tables.leafName(k)])
    assert.equal(rows[0].n, 4, `partition ${k} keeps exactly its four indexes`)
  }
})
