import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { enqueueJobsAtomically } from '../../server/ingest/external/atomic-enqueue.mjs'
import { ContentSearchStateStore } from '../../server/external-platforms/content-search-store.mjs'
import { SocialSearchStateStore, SOCIAL_SEARCH_STATE_VERSION } from '../../server/external-platforms/social-search-store.mjs'
import { pinTwitterSearchFallback } from '../../server/external-platforms/twitter-search-fallback.mjs'
import { commitFacebookFillDelivery } from '../../server/external-platforms/facebook-search-store.mjs'
import { TIKHUB_CONTENT_SEARCH_VERSION } from '../../server/contracts/tikhub-content-search.mjs'

function failedTransaction(rollbackFails) {
  const original = Object.assign(new Error('statement cancelled'), { code: '57014' })
  const rollback = new Error('rollback connection failure')
  const commands = []
  let releasedWith
  return { original, rollback, commands, get releasedWith() { return releasedWith },
    pool: { connect: async () => ({
      query: async sql => {
        commands.push(sql)
        if (sql === 'ROLLBACK') { if (rollbackFails) throw rollback; return { rows: [] } }
        if (sql !== 'BEGIN') throw original
        return { rows: [] }
      },
      release: error => { releasedWith = error },
    }) },
  }
}
function deliveryInput() {
  const input = { tenantId: randomUUID(), consumerId: randomUUID(), apiKeyId: randomUUID(),
    path: '/api/v1/data/search', scopeHash: 'a'.repeat(64), capturedAt: new Date().toISOString(),
    sourceMode: 'live', usageUnitsActual: 0, responseBody: {} }
  input.delivery = { ...input, usageRequestId: randomUUID(), fingerprint: 'b'.repeat(64) }
  input.sources = [{ callId: randomUUID(), bodySize: 1, rowsHash: 'c'.repeat(64),
    expected: { provider: 'tikhub', operation: 'test', endpointKey: 'test', endpointVersion: 'v1', contractVersion: 'v1' } }]
  input.manifest = { version: TIKHUB_CONTENT_SEARCH_VERSION, scopeHash: input.scopeHash,
    deliveredIds: [[]], state: { jobs: [{ query: 'fixture', providerPage: 1, upstreamPages: 0, started: false, done: false }] } }
  return input
}

for (const rollbackFails of [false, true]) {
  test(`data transaction cleanup preserves the original failure and ${rollbackFails ? 'discards a failed rollback' : 'reuses a clean rollback'}`, async t => {
    for (const kind of ['ingest', 'enqueue', 'content', 'social', 'twitter', 'facebook']) {
      await t.test(kind, async () => {
        const f = failedTransaction(rollbackFails)
        const provider = { providerKey: 'tikhub', pool: f.pool, usageStore: {} }
        const input = deliveryInput()
        let operation
        if (kind === 'ingest') operation = () => new PostgresStore(f.pool).ingestExternalRecords({
          datasetId: 'fixture', platform: 'twitter', connectorId: 'fixture', sourceId: randomUUID(),
          importRunId: randomUUID(), records: [{}],
        })
        if (kind === 'enqueue') operation = () => enqueueJobsAtomically({ pool: f.pool,
          enqueue: async () => { throw f.original } }, [{ queue: 'fixture', payload: {} }])
        if (kind === 'content') operation = () => new ContentSearchStateStore(provider, { platform: 'twitter' }).commitDelivery(input)
        if (kind === 'social') {
          input.path = '/api/v1/data/social/crawl'
          input.manifest.version = SOCIAL_SEARCH_STATE_VERSION
          operation = () => new SocialSearchStateStore({ tikhub: provider }, { platform: 'twitter' }).commitDelivery(input)
        }
        if (kind === 'twitter') operation = () => pinTwitterSearchFallback({ usageStore: { pool: f.pool },
          delivery: input.delivery, callId: randomUUID() })
        if (kind === 'facebook') {
          Object.assign(input, { query: 'fixture', pageSize: 20, type: 'stable', startDate: '2026-10-01', endDate: '2026-10-02' })
          input.delivery.operation = 'social.facebook.search'
          input.lineage = { version: 'facebook-fill.v1', scopeHash: input.scopeHash, startDate: input.startDate,
            endDate: input.endDate, upstreamPages: 1 }
          Object.assign(input.sources[0], { providerKey: 'rapidapi', bodySha256: 'd'.repeat(64), capturedAt: input.capturedAt })
          input.responseBody = { data: { platform: 'facebook', query: input.query, pageInfo: { pageSize: 20 }, items: [] } }
          operation = () => commitFacebookFillDelivery({ pool: f.pool }, input)
        }
        await assert.rejects(operation, error => kind === 'enqueue' ? error.code === 'atomic_enqueue_failed' : error === f.original)
        assert.equal(f.commands.at(-1), 'ROLLBACK')
        assert.equal(f.commands.includes('COMMIT'), false)
        assert.equal(f.releasedWith, rollbackFails ? f.rollback : kind === 'ingest' || kind === 'enqueue' ? null : undefined)
      })
    }
  })
}
