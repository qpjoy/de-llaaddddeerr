// mxq.jobs keeps done rows for 14 days, then the ingest worker deletes them in
// paced primary-key batches. Pending, running and dead rows always stay.

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import {
  pruneDoneJobsBatch,
  pruneDoneJobsPass,
  retentionPauseMs,
  runJobRetention,
} from '../../server/ingest/job-retention.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const native = { skip: connectionString ? false : 'Requires a disposable migrated MX_INSIGHT_TEST_DATABASE_URL' }

test('pause is the longest of the floor, four times the batch duration and the byte budget', () => {
  const hour = 3_600_000
  assert.equal(retentionPauseMs({ durationMs: 10, payloadBytes: 0 }), 2_000)
  assert.equal(retentionPauseMs({ durationMs: 1_500, payloadBytes: 0 }), 6_000)
  // 1 GiB per hour: deleting 1/360 GiB earns a 10 s pause.
  assert.equal(retentionPauseMs({ durationMs: 10, payloadBytes: 1024 ** 3 / 360 }), 10_000)
  assert.equal(retentionPauseMs({ durationMs: 0, payloadBytes: 500, minPauseMs: 0, payloadBytesPerHour: 1_000 }), hour / 2)
})

async function fixture(t) {
  const pool = new pg.Pool({ connectionString, statement_timeout: 20_000 })
  const queue = `retention-test:${randomUUID()}`
  t.after(async () => {
    await pool.query('DELETE FROM mxq.jobs WHERE queue LIKE $1', [`${queue}%`])
    await pool.end()
  })
  // Rows are inserted in the order given, so ids follow it like creation time does.
  async function insert(rows) {
    const ids = []
    for (const row of rows) {
      const { rows: [inserted] } = await pool.query(
        `INSERT INTO mxq.jobs (queue, payload, status, created_at, completed_at)
         VALUES ($1, $2, $3, now() - make_interval(days => $4),
                 CASE WHEN $3 = 'done' THEN now() - make_interval(days => $5) END)
         RETURNING id`,
        [
          `${queue}${row.queueSuffix ?? ''}`,
          { blob: row.payloadBytes ? randomBytes(row.payloadBytes).toString('base64') : null },
          row.status,
          row.createdDaysAgo,
          row.completedDaysAgo ?? row.createdDaysAgo,
        ],
      )
      ids.push(Number(inserted.id))
    }
    return ids
  }
  const remaining = async (ids) => new Set((await pool.query(
    'SELECT id FROM mxq.jobs WHERE id = ANY($1::bigint[])', [ids],
  )).rows.map((row) => Number(row.id)))
  return { pool, queue, insert, remaining }
}

test('a pass deletes only expired done rows, in every queue, and keeps everything else', native, async (t) => {
  const { pool, insert, remaining } = await fixture(t)
  const old = { createdDaysAgo: 20 }
  const expired = await insert([
    { status: 'done', ...old }, { status: 'done', ...old }, { status: 'done', ...old },
    { status: 'done', ...old, queueSuffix: ':other-queue' }, { status: 'done', ...old, queueSuffix: ':other-queue' },
  ])
  const kept = await insert([
    { status: 'pending', ...old },
    { status: 'running', ...old },
    { status: 'dead', ...old },
    // Created long ago but only finished yesterday: still inside the window.
    { status: 'done', createdDaysAgo: 20, completedDaysAgo: 1 },
  ])
  const recent = await insert([{ status: 'done', createdDaysAgo: 0 }, { status: 'done', createdDaysAgo: 0 }])

  const pass = await pruneDoneJobsPass(pool, { afterId: expired[0] - 1, minPauseMs: 0, wait: async () => {} })
  assert.equal(pass.deleted, expired.length)
  assert.equal(pass.cursor, recent[0] - 1, 'the pass stops where rows created inside the window begin')
  const left = await remaining([...expired, ...kept, ...recent])
  for (const id of expired) assert.equal(left.has(id), false)
  for (const id of [...kept, ...recent]) assert.equal(left.has(id), true)
})

test('batches take at most 200 rows in primary-key order and pause by payload bytes', native, async (t) => {
  const { pool, insert } = await fixture(t)
  const expired = await insert(Array.from({ length: 450 }, () => ({ status: 'done', createdDaysAgo: 20, payloadBytes: 3_000 })))
  const [recent] = await insert([{ status: 'done', createdDaysAgo: 0 }])

  const first = await pruneDoneJobsBatch(pool, { afterId: expired[0] - 1 })
  assert.equal(first.scanned, 200)
  assert.equal(first.deleted, 200)
  assert.equal(first.lastId, expired[199])
  assert.equal(first.firstRecentId, null)
  assert.ok(first.payloadBytes > 200 * 3_000, 'deleted payload is measured from stored sizes')

  const { rows: [{ bytes }] } = await pool.query(
    'SELECT sum(pg_column_size(payload))::bigint AS bytes FROM mxq.jobs WHERE id = ANY($1::bigint[])',
    [expired.slice(200, 400)],
  )
  const pauses = []
  const budget = 3_600 * 1_000_000 // 1 MB per second
  const pass = await pruneDoneJobsPass(pool, {
    afterId: first.lastId, minPauseMs: 0, payloadBytesPerHour: budget,
    wait: async (ms) => { pauses.push(ms) },
  })
  assert.equal(pass.batches, 2)
  assert.equal(pass.deleted, 250)
  assert.equal(pass.cursor, recent - 1)
  assert.equal(pauses.length, 1, 'no pause after the batch that reaches the window')
  assert.ok(pauses[0] >= Math.ceil(Number(bytes) / 1_000), `pause ${pauses[0]} ms covers ${bytes} bytes at 1 MB/s`)
})

test('a row held by another session makes the batch give up after the 1 s lock timeout', native, async (t) => {
  const { pool, insert, remaining } = await fixture(t)
  const [locked] = await insert([{ status: 'done', createdDaysAgo: 20 }])
  await insert([{ status: 'done', createdDaysAgo: 0 }])
  // A separate connection, so the fixture's pool.end() never waits on it.
  const holder = new pg.Client({ connectionString })
  await holder.connect()
  t.after(() => holder.end())
  await holder.query('BEGIN')
  await holder.query('SELECT id FROM mxq.jobs WHERE id = $1 FOR UPDATE', [locked])

  const startedAt = Date.now()
  await assert.rejects(pruneDoneJobsBatch(pool, { afterId: locked - 1 }), (error) => error.code === '55P03')
  const waited = Date.now() - startedAt
  assert.ok(waited >= 900 && waited < 5_000, `gave up after ${waited} ms`)
  assert.equal((await remaining([locked])).has(locked), true)

  await holder.query('ROLLBACK')
  assert.equal((await pruneDoneJobsBatch(pool, { afterId: locked - 1 })).deleted, 1)
})

test('the worker loop runs a pass and stops promptly on abort, also while waiting', native, async (t) => {
  const { pool, insert, remaining } = await fixture(t)
  const [expired] = await insert([{ status: 'done', createdDaysAgo: 20 }])
  await insert([{ status: 'done', createdDaysAgo: 0 }])

  const idle = new AbortController()
  const startedIdle = Date.now()
  const waiting = runJobRetention({ pool, signal: idle.signal, initialDelayMs: 60_000 })
  setTimeout(() => idle.abort(), 20)
  await waiting
  assert.ok(Date.now() - startedIdle < 1_000, 'abort ends the initial delay')

  const logs = []
  const controller = new AbortController()
  // Other files' recent jobs sit below this row in the shared test database,
  // so start where this test's rows begin.
  const running = runJobRetention({
    pool, signal: controller.signal, afterId: expired - 1, initialDelayMs: 0, passIntervalMs: 60_000, minPauseMs: 0,
    logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line) },
  })
  const deadline = Date.now() + 10_000
  while ((await remaining([expired])).has(expired) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal((await remaining([expired])).has(expired), false, 'the first pass deleted the expired row')
  const abortedAt = Date.now()
  controller.abort()
  await running
  assert.ok(Date.now() - abortedAt < 1_000, 'abort ends the wait between passes')
  assert.ok(logs.some((line) => /job retention: deleted \d+ done job/.test(line)), logs.join('\n'))
})
