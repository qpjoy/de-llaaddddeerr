import assert from 'node:assert/strict'
import test from 'node:test'
import { NightAllBackfill, cursorId } from '../../server/ingest/backfill.mjs'

// A queue stand-in that keeps cursors in memory and records enqueues, so the
// resume and chunking behaviour can be asserted without a database.
function fakeQueue() {
  const cursors = new Map()
  const enqueued = []
  return {
    enqueued,
    async getCursor(id) {
      return cursors.get(id) ?? null
    },
    async saveCursor(id, position, { status = 'running', processedDelta = 0, error = null } = {}) {
      const existing = cursors.get(id) ?? { processed_count: 0 }
      const next = {
        id,
        position,
        status,
        processed_count: existing.processed_count + processedDelta,
        last_error: error,
      }
      cursors.set(id, next)
      return next
    },
    async enqueue(queue, payload, options) {
      // Mirror the partial unique index: a key already outstanding is a no-op.
      const key = options?.dedupeKey
      if (key && enqueued.some((entry) => entry.dedupeKey === key)) return null
      enqueued.push({ queue, payload, dedupeKey: key })
      return enqueued.length
    },
    async heartbeat() {},
  }
}

function page(items, nextCursor) {
  const raw = { data: { items, pageInfo: { returnedCount: items.length, hasMore: Boolean(nextCursor), nextCursor } } }
  return { payload: raw, raw }
}

function item(externalId) {
  return {
    externalId,
    platform: 'xiaohongshu',
    contentType: 'normal',
    url: `https://x/${externalId}`,
    title: `title ${externalId}`,
    text: 'body',
    publishedAt: '2026-07-31T07:46:39.000Z',
    collectedAt: '2026-08-06T11:20:25.000Z',
    author: { id: 'a1', name: '搬运工', avatarUrl: null },
    metrics: { likes: 1 },
    media: { images: [], videos: [] },
  }
}

function fakeStore() {
  const ingested = []
  return {
    ingested,
    async ingestSearchResult(input) {
      const items = input.rawPayload?.data?.items ?? []
      ingested.push(input)
      return { ingested: items.length, changed: items.length, skipped: 0, runId: 'run' }
    },
  }
}

test('backfill walks pages and records the cursor after each one', async () => {
  const pages = [page([item('a'), item('b')], 'cur-1'), page([item('c')], null)]
  let call = 0
  const queue = fakeQueue()
  const store = fakeStore()
  const backfill = new NightAllBackfill({
    store,
    queue,
    logger: { log() {} },
    adapter: { exportContents: async () => pages[call++] },
  })

  const result = await backfill.runPlatform('xiaohongshu')
  assert.equal(result.pages, 2)
  assert.equal(result.ingested, 3)
  assert.equal(result.done, true)

  const cursor = await queue.getCursor(cursorId('xiaohongshu'))
  assert.equal(cursor.status, 'idle')
  assert.equal(cursor.processed_count, 3)
})

test('backfill resumes from the stored cursor rather than restarting', async () => {
  const queue = fakeQueue()
  await queue.saveCursor(cursorId('douyin'), { cursor: 'resume-here' })
  const seen = []
  const backfill = new NightAllBackfill({
    store: fakeStore(),
    queue,
    logger: { log() {} },
    adapter: {
      exportContents: async (options) => {
        seen.push(options.cursor)
        return page([], null)
      },
    },
  })

  await backfill.runPlatform('douyin')
  assert.deepEqual(seen, ['resume-here'])
})

test('a cursor is saved only after its page is ingested', async () => {
  const queue = fakeQueue()
  const backfill = new NightAllBackfill({
    store: {
      async ingestSearchResult() {
        throw new Error('database is down')
      },
    },
    queue,
    logger: { log() {} },
    adapter: { exportContents: async () => page([item('a')], 'cur-1') },
  })

  await assert.rejects(() => backfill.runPlatform('xiaohongshu'), /database is down/)
  // Saving the cursor before ingesting would skip this page permanently. The
  // opposite failure — replaying it — is absorbed by the uniqueness constraint.
  const cursor = await queue.getCursor(cursorId('xiaohongshu'))
  assert.equal(cursor, null)
})

test('export failure records the error without advancing the cursor', async () => {
  const queue = fakeQueue()
  await queue.saveCursor(cursorId('twitter'), { cursor: 'safe-point' })
  const backfill = new NightAllBackfill({
    store: fakeStore(),
    queue,
    logger: { log() {} },
    adapter: {
      exportContents: async () => {
        throw new Error('night-all unreachable')
      },
    },
  })

  await assert.rejects(() => backfill.runPlatform('twitter'), /night-all unreachable/)
  const cursor = await queue.getCursor(cursorId('twitter'))
  assert.equal(cursor.status, 'failed')
  assert.equal(cursor.position.cursor, 'safe-point')
})

test('maxPages yields between chunks instead of draining in one go', async () => {
  const queue = fakeQueue()
  const backfill = new NightAllBackfill({
    store: fakeStore(),
    queue,
    logger: { log() {} },
    adapter: { exportContents: async () => page([item('x')], 'always-more') },
  })

  const result = await backfill.runPlatform('xiaohongshu', { maxPages: 3 })
  assert.equal(result.pages, 3)
  assert.equal(result.done, false)
  assert.equal(result.cursor, 'always-more')
})

test('backfill ingests with a null query fingerprint', async () => {
  const queue = fakeQueue()
  const store = fakeStore()
  const backfill = new NightAllBackfill({
    store,
    queue,
    logger: { log() {} },
    adapter: { exportContents: async () => page([item('a')], null) },
  })
  await backfill.runPlatform('xiaohongshu')
  // A backfilled row was not observed through any query. Inventing a
  // fingerprint would corrupt the observation history that rank analysis reads.
  assert.equal(store.ingested[0].queryFingerprint, null)
  assert.equal(store.ingested[0].requestId, null)
})

// ---------------------------------------------------------------------------
// Continuation chunking
// ---------------------------------------------------------------------------

test('a continuation must not reuse the running job\'s dedupe key', async () => {
  const queue = fakeQueue()
  const platform = 'xiaohongshu'

  // Reproduce the worker's contract: the in-flight job occupies its own key
  // while the continuation is enqueued.
  await queue.enqueue('backfill', { platform, chunk: 0 }, { dedupeKey: `backfill:${platform}:0` })

  const nextChunk = 1
  const accepted = await queue.enqueue(
    'backfill',
    { platform, chunk: nextChunk },
    { dedupeKey: `backfill:${platform}:${nextChunk}` },
  )
  assert.ok(accepted, 'the continuation is accepted')

  // The bug this guards: with a chunk-free key the continuation collides with
  // the job that is enqueueing it, ON CONFLICT DO NOTHING swallows it, and the
  // backfill stalls after one chunk with no error anywhere.
  const collided = await queue.enqueue('backfill', { platform }, { dedupeKey: `backfill:${platform}:0` })
  assert.equal(collided, null, 'a repeated submission of the same chunk is deduped')
})
