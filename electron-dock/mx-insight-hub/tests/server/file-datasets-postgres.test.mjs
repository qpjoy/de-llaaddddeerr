// Native PostgreSQL test for the 邮箱库 / 手机号库 file datasets. Runs only with
// MX_INSIGHT_TEST_DATABASE_URL; it creates and drops its own database.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { ServerFileReader } from '../../server/ingest/external/server-files.mjs'
import { FileDatasetEngine, runDictionaryWorker } from '../../server/data/file-datasets/engine.mjs'
import { createFileDatasetServices } from '../../server/data/file-datasets/services.mjs'
import { versionTables } from '../../server/data/file-datasets/store.mjs'
import { normalizeEmailSearchRequest } from '../../server/data/email-directory/contract.mjs'
import { normalizePhoneSearchRequest } from '../../server/data/phone-directory/contract.mjs'
import { versionProgress } from '../../server/data/file-datasets/pipeline.mjs'
import { buildZip } from '../fixtures/zip-writer.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const context = { tenant: { id: randomUUID() }, consumer: { id: randomUUID() }, apiKey: { id: randomUUID() } }

async function setup(t) {
  const admin = new pg.Pool({ connectionString, max: 2 })
  const database = `mx_fds_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await admin.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`)
  const url = new URL(connectionString)
  url.pathname = `/${database}`
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 })
  for (const name of ['178_twitter_user_email_dictionary.sql', '180_file_datasets_email_phone.sql']) {
    await pool.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fds-')))
  const reader = await ServerFileReader.create({ roots: [{ rootId: 'test-root', path: root }] })
  const services = createFileDatasetServices({ pool, hmacKey: 'test-pepper-at-least-32-bytes-long!!', serverFileReader: reader, admin: true })
  t.after(async () => {
    await pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  })
  return { pool, root, reader, ...services }
}

function engineFor(ctx, key, overrides = {}) {
  return new FileDatasetEngine({
    pool: ctx.pool, store: ctx.stores[key], fileReader: ctx.reader, logger: process.env.TUE_DEBUG ? console : { log() {}, error() {} },
    batchPairs: 97, chunkBytes: 1024, targetRowsPerSecond: 1e9, shaBytesPerSecond: 1e12, sleep: async () => {}, ...overrides,
  })
}

async function start(ctx, key, relativePath) {
  await ctx.pipelines[key].configure({ rootId: 'test-root', relativePath, expectedSha256: null }, { updatedBy: 'test' })
  return ctx.pipelines[key].action({ action: 'start' }, { by: 'test' })
}

function emailFixture() {
  const lines = []
  for (let i = 0; i < 900; i += 1) lines.push(`user${i}.${['alpha', 'bravo', 'charlie'][i % 3]}@${['gmail.com', 'example.org', 'Yahoo.com'][i % 3]}`)
  lines.push('John.Smith@gmail.com', 'john.smith@gmail.com', 'John.Smith@gmail.com') // case variant + exact duplicate
  lines.push('  padded@example.org  \r') // trimmed, CRLF
  lines.push('', 'not-an-email', 'bad local@example.org') // quarantined
  return { text: `${lines.join('\n')}\n`, lines: lines.length }
}

test('邮箱库: import pauses and resumes, then every search mode reads the published version', { skip: !connectionString }, async t => {
  const ctx = await setup(t)
  const { text, lines } = emailFixture()
  await writeFile(join(ctx.root, 'email_only.txt'), text)
  const created = await start(ctx, 'email-directory', 'email_only.txt')
  let commits = 0
  const engine = engineFor(ctx, 'email-directory', { afterBatch: async () => { commits += 1; if (commits === 3) await ctx.stores['email-directory'].requestPause(created.id) } })
  assert.equal(await engine.runOpenVersion(), 'paused')
  await ctx.stores['email-directory'].requestResume(created.id)
  assert.equal(await engine.runOpenVersion(), 'ready')

  const ready = await ctx.stores['email-directory'].version(created.id)
  assert.equal(Number(ready.pairs_read), lines)
  assert.deepEqual(ready.quarantine_reasons, { empty_line: 1, missing_at: 1, invalid_local: 1 })
  assert.equal(Number(ready.duplicate_pairs), 1)
  assert.equal(Number(ready.unique_mappings), lines - 3 - 1)
  assert.equal(ready.partition_count, 4)
  // Lines datasets keep the raw line, not a key/value pair.
  const quarantine = await ctx.pool.query('SELECT reason, convert_from(key_raw, \'UTF8\') AS line, value_raw FROM account_dictionary.quarantine WHERE version_id = $1 ORDER BY ordinal', [created.id])
  assert.deepEqual(quarantine.rows.map(row => [row.reason, row.line, row.value_raw]), [['empty_line', '', null], ['missing_at', 'not-an-email', null], ['invalid_local', 'bad local@example.org', null]])
  await ctx.pipelines['email-directory'].publish({ versionId: created.id }, { by: 'test' })

  const search = ctx.searches['email-directory']
  const run = body => search.search(context, normalizeEmailSearchRequest(body))
  const exact = await run({ query: 'john.smith@GMAIL.COM' })
  assert.deepEqual(exact.items.map(item => [item.email, item.matchType]), [['john.smith@gmail.com', 'exact'], ['John.Smith@gmail.com', 'case_insensitive']])
  assert.equal(exact.items[1].sourceRecords, 2)
  assert.equal((await run({ query: 'padded@example.org' })).items[0].email, 'padded@example.org')
  assert.equal((await run({ query: 'nobody@example.org' })).items.length, 0)
  assert.equal((await run({ query: 'user1.bravo@nowhere.test' })).items.length, 0)

  const prefix = await run({ mode: 'prefix', query: 'user12', domain: 'example.org', limit: 50 })
  assert.ok(prefix.items.length > 0 && prefix.items.every(item => item.email.startsWith('user12') && item.domain === 'example.org'))

  // Domain listing pages through every address exactly once, in order.
  const listed = []
  let after
  let pagesRead = 0
  do {
    const page = await run({ mode: 'domain', query: 'yahoo.com', limit: 50, ...(after ? { after } : {}) })
    listed.push(...page.items.map(item => item.email))
    after = page.meta.nextCursor
    pagesRead += 1
  } while (after)
  assert.equal(listed.length, 300)
  assert.equal(new Set(listed).size, 300)
  assert.ok(pagesRead >= 6)
  assert.deepEqual(listed, [...listed].sort())

  const contains = await run({ mode: 'contains', query: 'charl', limit: 50 })
  assert.equal(contains.items.length, 50)
  assert.ok(contains.items.every(item => item.email.includes('charl')))
  const fuzzy = await run({ mode: 'fuzzy', query: 'jon.smith' })
  assert.equal(fuzzy.items[0].matchType, 'similar')
  assert.match(fuzzy.items[0].email, /^john\.smith@gmail\.com$/i)
  const masked = await run({ query: 'John.Smith@gmail.com', reveal: false })
  assert.equal(masked.items[0].email, 'Jo***@gmail.com')

  const metadata = await search.metadata()
  assert.equal(metadata.version.addresses, Number(ready.unique_mappings))
  const audit = await ctx.pool.query("SELECT DISTINCT dataset_key FROM account_dictionary.access_events")
  assert.deepEqual(audit.rows.map(row => row.dataset_key), ['email-directory'])
})

test('手机号库: formatted duplicates merge and exact / prefix / suffix read index ranges', { skip: !connectionString }, async t => {
  const ctx = await setup(t)
  const lines = []
  for (let i = 0; i < 700; i += 1) lines.push(`+1415${String(5550000 + i).padStart(7, '0')}`)
  for (let i = 0; i < 200; i += 1) lines.push(`+44207${String(9460000 + i).padStart(7, '0')}`)
  lines.push('+1 (415) 555-0007') // same number as an earlier line
  lines.push('+0', '+00020877653002349889', 'call me') // quarantined
  await writeFile(join(ctx.root, 'phone_only.txt'), `${lines.join('\n')}\n`)
  const created = await start(ctx, 'phone-directory', 'phone_only.txt')
  assert.equal(await engineFor(ctx, 'phone-directory').runOpenVersion(), 'ready')
  const ready = await ctx.stores['phone-directory'].version(created.id)
  assert.deepEqual(ready.quarantine_reasons, { phone_length: 2, invalid_phone: 1 })
  assert.equal(Number(ready.unique_mappings), 900)
  assert.equal(Number(ready.duplicate_pairs), 1)
  // No trigram sample for phones.
  assert.equal(Number((await ctx.pool.query('SELECT count(*) FROM account_dictionary.trigram_stats WHERE version_id = $1', [created.id])).rows[0].count), 0)
  await ctx.pipelines['phone-directory'].publish({ versionId: created.id }, { by: 'test' })

  const search = ctx.searches['phone-directory']
  const run = body => search.search(context, normalizePhoneSearchRequest(body))
  const exact = await run({ query: '+1 415-555-0007' })
  assert.deepEqual(exact.items, [{ phone: '+14155550007', phoneMasked: false, matchType: 'exact', sourceRecords: 2 }])
  assert.equal((await run({ query: '+1 415 555 9999' })).items.length, 0)

  const prefixed = []
  let after
  do {
    const page = await run({ mode: 'prefix', query: '+44 20', limit: 50, ...(after ? { after } : {}) })
    prefixed.push(...page.items.map(item => item.phone))
    after = page.meta.nextCursor
  } while (after)
  assert.equal(prefixed.length, 200)
  assert.ok(prefixed.every(phone => phone.startsWith('+4420')))
  assert.deepEqual(prefixed, [...prefixed].sort())

  const suffixed = []
  after = undefined
  do {
    const page = await run({ mode: 'suffix', query: '0123', limit: 1, ...(after ? { after } : {}) })
    suffixed.push(...page.items.map(item => item.phone))
    after = page.meta.nextCursor
  } while (after)
  assert.deepEqual(suffixed.sort(), ['+14155550123', '+442079460123'])
  assert.equal((await run({ mode: 'suffix', query: '0123', reveal: false })).items[0].phone.includes('*'), true)
})

test('one worker runs datasets in turn; a discard elsewhere is not blocked by the running dataset', { skip: !connectionString }, async t => {
  const ctx = await setup(t)
  await writeFile(join(ctx.root, 'emails.txt'), 'a@x.io\nb@x.io\nc@y.io\n')
  await writeFile(join(ctx.root, 'phones.txt'), '+14155550123\n+14155550124\n')
  const email = await start(ctx, 'email-directory', 'emails.txt')
  const phone = await start(ctx, 'phone-directory', 'phones.txt')
  assert.equal(await ctx.stores['twitter-user-email'].openVersion(), null)

  // While the e-mail dataset is locked by "a worker", a phone discard drops at once.
  const holder = await ctx.pool.connect()
  await holder.query('SELECT pg_advisory_lock($1, $2)', ctx.stores['email-directory'].lock)
  const discarded = await ctx.stores['phone-directory'].requestDiscard(phone.id)
  assert.equal(discarded.stage, 'discarded')
  const pending = await ctx.stores['email-directory'].requestDiscard(email.id)
  assert.equal(pending.stage, 'pending')
  assert.equal(pending.desired_state, 'discard')
  await holder.query('SELECT pg_advisory_unlock($1, $2)', ctx.stores['email-directory'].lock)
  holder.release()

  // The worker loop picks up the pending discard and the next version.
  const second = await start(ctx, 'phone-directory', 'phones.txt').catch(error => error)
  assert.equal(second.code, undefined, String(second.message))
  const controller = new AbortController()
  const engines = ['twitter-user-email', 'email-directory', 'phone-directory'].map(key => engineFor(ctx, key))
  const worker = runDictionaryWorker({ pool: ctx.pool, engines, pollMs: 20, signal: controller.signal, logger: { log() {}, error() {} } })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const rows = (await ctx.pool.query('SELECT id, stage FROM account_dictionary.versions ORDER BY id')).rows
    if (rows.find(row => row.id === email.id)?.stage === 'discarded' && rows.find(row => row.id === second.id)?.stage === 'ready') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  controller.abort()
  await worker
  assert.equal((await ctx.stores['email-directory'].version(email.id)).stage, 'discarded')
  assert.equal((await ctx.stores['phone-directory'].version(second.id)).stage, 'ready')
  const tables = versionTables(email.id, 4)
  assert.equal((await ctx.pool.query(`SELECT to_regclass('${tables.stage}') AS t`)).rows[0].t, null)
})

test('both datasets read in place from one .zip: default entries, pause/resume inside the archive', { skip: !connectionString }, async t => {
  const ctx = await setup(t)
  const { text: emails, lines } = emailFixture()
  const phones = Array.from({ length: 300 }, (_, i) => `+1415${String(5550000 + i).padStart(7, '0')}`).join('\n') + '\n'
  await writeFile(join(ctx.root, 'email-phone.zip'), buildZip([
    { name: 'email_only.txt', data: emails }, { name: 'phone_only.txt', data: phones, method: 0 }, { name: 'README.md', data: 'x' },
  ]))

  // No entry given: each dataset picks its default file inside the archive.
  const configured = await ctx.pipelines['email-directory'].configure({ rootId: 'test-root', relativePath: 'email-phone.zip' }, { updatedBy: 'test' })
  assert.equal(configured.archive.entry.name, 'email_only.txt')
  assert.deepEqual(configured.archive.entries.map(row => row.name), ['email_only.txt', 'phone_only.txt', 'README.md'])
  assert.equal((await ctx.pipelines['phone-directory'].configure({ rootId: 'test-root', relativePath: 'email-phone.zip' }, { updatedBy: 'test' })).dataset.source.entry, 'phone_only.txt')
  // A dataset whose type matches no single entry must be told which one.
  await assert.rejects(ctx.pipelines['twitter-user-email'].configure({ rootId: 'test-root', relativePath: 'email-phone.zip' }, { updatedBy: 'test' }),
    error => error.code === 'archive_entry_required')
  await assert.rejects(ctx.pipelines['email-directory'].configure({ rootId: 'test-root', relativePath: 'email-phone.zip', entry: 'README.md' }, { updatedBy: 'test' }),
    error => error.code === 'unsupported_file_type')

  const created = await ctx.pipelines['email-directory'].action({ action: 'start' }, { by: 'test' })
  assert.equal(created.source.entry, 'email_only.txt')
  assert.equal(created.source.entryBytes, Buffer.byteLength(emails))
  let commits = 0
  const engine = engineFor(ctx, 'email-directory', { afterBatch: async () => { commits += 1; if (commits === 4) await ctx.stores['email-directory'].requestPause(created.id) } })
  assert.equal(await engine.runOpenVersion(), 'paused')
  const paused = await ctx.stores['email-directory'].version(created.id)
  const progress = versionProgress(paused)
  assert.ok(Number(paused.byte_offset) > 0 && Number(paused.byte_offset) < Buffer.byteLength(emails))
  assert.ok(progress.progress.percent > 0 && progress.progress.percent < 1)
  // A new worker resumes from the uncompressed checkpoint.
  await ctx.stores['email-directory'].requestResume(created.id)
  assert.equal(await engineFor(ctx, 'email-directory').runOpenVersion(), 'ready')
  const ready = await ctx.stores['email-directory'].version(created.id)
  assert.equal(Number(ready.pairs_read), lines)
  assert.equal(Number(ready.unique_mappings), lines - 3 - 1)
  await ctx.pipelines['email-directory'].publish({ versionId: created.id }, { by: 'test' })
  const found = await ctx.searches['email-directory'].search(context, normalizeEmailSearchRequest({ query: 'user7.bravo@example.org' }))
  assert.equal(found.items[0].email, 'user7.bravo@example.org')

  const phoneVersion = await ctx.pipelines['phone-directory'].action({ action: 'start' }, { by: 'test' })
  assert.equal(await engineFor(ctx, 'phone-directory').runOpenVersion(), 'ready')
  assert.equal(Number((await ctx.stores['phone-directory'].version(phoneVersion.id)).unique_mappings), 300)

  // Replacing the archive after a version started is refused.
  await ctx.pipelines['email-directory'].configure({ rootId: 'test-root', relativePath: 'email-phone.zip' }, { updatedBy: 'test' })
  const next = await ctx.pipelines['email-directory'].action({ action: 'start' }, { by: 'test' })
  await writeFile(join(ctx.root, 'email-phone.zip'), buildZip([{ name: 'email_only.txt', data: 'other@x.io\n' }]))
  assert.equal(await engineFor(ctx, 'email-directory').runOpenVersion(), 'failed')
  assert.equal((await ctx.stores['email-directory'].version(next.id)).error_code, 'source_changed')
})
