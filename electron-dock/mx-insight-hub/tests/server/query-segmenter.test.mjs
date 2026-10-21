import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadCommonConfig } from '@qpjoy/mx-common'
import { createSearch } from '../../server/search/index.mjs'
import { AdvancedSearch } from '../../server/retrieval/search.mjs'

const hanlpConfig = () => loadCommonConfig('mx-insight-hub', {
  MX_COMMON_SEGMENTER: 'hanlp',
  MX_COMMON_HANLP_URL: 'http://hanlp.test:8000',
})

// A tokenizer with the production service's shape: one forward pass at a time,
// each pass costing the same fixed overhead whatever its size.
function singleSlotHanlp({ passMs }) {
  const passes = []
  let chain = Promise.resolve()
  const fetch = async (url, { body }) => {
    const texts = JSON.parse(body).texts ?? [JSON.parse(body).text]
    const turn = chain.then(async () => {
      passes.push(texts.length)
      await sleep(passMs)
    })
    chain = turn
    await turn
    const tokens = texts.map((text) => [`hanlp:${text}`])
    return new Response(JSON.stringify(String(url).endsWith('/batch') ? { batch: tokens } : tokens[0]), { status: 200 })
  }
  return { fetch, passes }
}

async function withFetch(fetch, run) {
  const original = globalThis.fetch
  globalThis.fetch = fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

test('query analysis gets the coalescing segmenter; index writers keep the raw one', async () => {
  const search = await withFetch(async () => new Response('[]'), () => createSearch({
    pool: null,
    config: hanlpConfig(),
    logger: { log() {}, warn() {}, error() {} },
  }))
  assert.notEqual(search.querySegmenter, search.segmenter)
  assert.equal(typeof search.segmenter.segmentBatchWithMeta, 'function')
  assert.equal(typeof search.querySegmenter.stats, 'function')
  assert.equal(search.queries.segmenter, search.querySegmenter)

  // jieba has no per-request overhead to coalesce, so nothing is wrapped.
  const local = createSearch({
    pool: null,
    config: loadCommonConfig('mx-insight-hub', { MX_COMMON_SEGMENTER: 'jieba' }),
    logger: { log() {}, warn() {}, error() {} },
  })
  assert.equal(local.querySegmenter, local.segmenter)
})

test('a burst of distinct queries reaches a single-slot HanLP as a few passes, all verified', async () => {
  const hanlp = singleSlotHanlp({ passMs: 20 })
  await withFetch(hanlp.fetch, async () => {
    const { querySegmenter } = createSearch({
      pool: null,
      config: hanlpConfig(),
      logger: { log() {}, warn() {}, error() {} },
    })
    // One query per millisecond for 200 queries. Sent one request each, a 20 ms
    // pass would need 4 s for the burst and most callers would degrade.
    const pending = []
    for (let index = 0; index < 200; index += 1) {
      const startedAt = performance.now()
      pending.push(querySegmenter.segmentWithMeta(`第${index}个查询`)
        .then((result) => ({ result, latencyMs: performance.now() - startedAt })))
      await sleep(1)
    }
    const outcomes = await Promise.all(pending)

    assert.ok(outcomes.every(({ result }) => result.backendUsed === 'hanlp' && result.degraded === false))
    assert.equal(hanlp.passes.reduce((sum, size) => sum + size, 0), 200)
    assert.ok(hanlp.passes.length <= 60, `expected coalesced passes, got ${hanlp.passes.length}`)
    const slowest = Math.max(...outcomes.map(({ latencyMs }) => latencyMs))
    assert.ok(slowest < 1_000, `slowest query waited ${Math.round(slowest)} ms`)
    assert.equal(querySegmenter.stats().pending, 0)
    assert.equal(querySegmenter.stats().inFlight, 0)
  })
})

test('advanced search terms come from the query segmenter and stay strictly HanLP', async () => {
  const seen = []
  const search = {
    client: {},
    segmenter: {
      async segmentWithMeta() { throw new Error('index writers own this segmenter') },
    },
    querySegmenter: {
      async segmentWithMeta(text, options) {
        seen.push(options)
        return { tokens: ['售后', '困难'], backendUsed: 'hanlp', degraded: false, errorCode: null }
      },
    },
  }
  const advanced = new AdvancedSearch({ pool: null, search, agent: null })
  assert.deepEqual(await advanced.tokens('售后困难'), ['售后', '困难'])
  assert.deepEqual(seen, [{ allowFallback: false }])

  search.querySegmenter.segmentWithMeta = async () => ({
    tokens: [], backendUsed: null, degraded: true, errorCode: 'hanlp_busy',
  })
  const strict = new AdvancedSearch({ pool: null, search, agent: null })
  await assert.rejects(strict.tokens('另一个查询'), (error) => error.code === 'reindex_segmenter_degraded')
})
