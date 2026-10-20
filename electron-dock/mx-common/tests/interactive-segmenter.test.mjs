import assert from 'node:assert/strict'
import test from 'node:test'
import { HanlpSegmenter, interactiveSegmenter } from '../src/segmenter/index.mjs'

const jieba = {
  calls: 0,
  async segmentWithMeta(text) {
    this.calls += 1
    return { tokens: [`jieba:${text}`], backendUsed: 'jieba', degraded: false, errorCode: null }
  },
}

// A HanLP service whose answers the test releases by hand, so "in flight" is a
// state the test controls rather than a race it hopes to win.
function controlledHanlp({ status = 200 } = {}) {
  const requests = []
  const fetchImpl = (url, { body, signal }) => new Promise((resolve, reject) => {
    const texts = JSON.parse(body).texts
    const request = {
      url: String(url),
      texts,
      answer: () => resolve(new Response(
        status === 200 ? JSON.stringify({ batch: texts.map((text) => [`hanlp:${text}`]) }) : 'tokenizer is busy',
        { status },
      )),
    }
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    requests.push(request)
  })
  const hanlp = new HanlpSegmenter({
    url: 'http://hanlp:8000',
    fetchImpl,
    fallbackSegmenter: Object.create(jieba, { calls: { value: 0, writable: true } }),
    logger: { warn() {} },
  })
  return { hanlp, requests }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
async function until(predicate) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await tick()
  assert.ok(predicate(), 'condition was never reached')
}

test('queries arriving while a pass is in flight leave together as the next batch', async () => {
  const { hanlp, requests } = controlledHanlp()
  const segmenter = interactiveSegmenter(hanlp, { maxInFlight: 1 })

  const first = segmenter.segmentWithMeta('吴恩达')
  await until(() => requests.length === 1)
  const burst = Array.from({ length: 10 }, (_, index) => segmenter.segmentWithMeta(`查询${index}`))
  await tick()
  // Nothing else reaches the single-slot service while it is busy.
  assert.equal(requests.length, 1)

  requests[0].answer()
  await until(() => requests.length === 2)
  assert.equal(requests[1].texts.length, 10)
  assert.match(requests[1].url, /\/tokenize\/batch$/)
  requests[1].answer()

  assert.deepEqual((await first).tokens, ['hanlp:吴恩达'])
  const results = await Promise.all(burst)
  assert.deepEqual(results.map((result) => result.tokens[0]), Array.from({ length: 10 }, (_, i) => `hanlp:查询${i}`))
  assert.ok(results.every((result) => result.backendUsed === 'hanlp' && result.degraded === false))
  assert.equal(segmenter.stats().batches, 2)
})

test('identical queries share one slot and verified answers are served from cache', async () => {
  const { hanlp, requests } = controlledHanlp()
  const segmenter = interactiveSegmenter(hanlp)

  const same = [segmenter.segmentWithMeta('人工智能'), segmenter.segmentWithMeta('人工智能')]
  await until(() => requests.length === 1)
  assert.deepEqual(requests[0].texts, ['人工智能'])
  requests[0].answer()
  const [left, right] = await Promise.all(same)
  assert.deepEqual(left, right)

  // Callers own their result; mutating one must not corrupt the cache.
  left.tokens.push('mutated')
  const cached = await segmenter.segmentWithMeta('人工智能')
  assert.deepEqual(cached.tokens, ['hanlp:人工智能'])
  assert.equal(requests.length, 1)
  assert.equal(segmenter.stats().cacheHits, 1)
  assert.equal(segmenter.stats().joined, 1)
})

test('cached answers expire, and degraded answers are never cached', async () => {
  let clock = 0
  const busy = controlledHanlp({ status: 503 })
  const failing = interactiveSegmenter(busy.hanlp)
  const first = failing.segmentWithMeta('大模型')
  await until(() => busy.requests.length === 1)
  busy.requests[0].answer()
  assert.equal((await first).degraded, true)
  const second = failing.segmentWithMeta('大模型')
  await until(() => busy.requests.length === 2)
  busy.requests[1].answer()
  await second

  const { hanlp, requests } = controlledHanlp()
  const segmenter = interactiveSegmenter(hanlp, { cacheTtlMs: 1_000, now: () => clock })
  const warm = segmenter.segmentWithMeta('大模型')
  await until(() => requests.length === 1)
  requests[0].answer()
  await warm
  clock = 1_000
  const expired = segmenter.segmentWithMeta('大模型')
  await until(() => requests.length === 2)
  requests[1].answer()
  assert.equal((await expired).backendUsed, 'hanlp')
})

test('a caller past its budget degrades like HanLP would, and unsent work is dropped', async () => {
  const { hanlp, requests } = controlledHanlp()
  const segmenter = interactiveSegmenter(hanlp, { maxInFlight: 1, waitMs: 20, strictWaitMs: 20, requestTimeoutMs: 60_000 })

  const blocker = segmenter.segmentWithMeta('占位')
  await until(() => requests.length === 1)
  const [soft, strict] = await Promise.all([
    segmenter.segmentWithMeta('等不到'),
    segmenter.segmentWithMeta('严格等不到', { allowFallback: false }),
  ])
  assert.deepEqual(soft.tokens, ['jieba:等不到'])
  assert.equal(soft.backendUsed, 'jieba')
  assert.equal(soft.degraded, true)
  assert.equal(soft.errorCode, 'hanlp_busy')
  // A strict caller never receives fallback tokens it would have to reject.
  assert.deepEqual(strict, {
    tokens: [], backendUsed: null, degraded: true, errorCode: 'hanlp_busy',
    errorDetail: 'tokenizer did not answer within 20 ms',
  })

  // Nobody waits for those texts any more, so the service never sees them.
  requests[0].answer()
  await blocker
  await tick()
  assert.equal(requests.length, 1)
  assert.equal(segmenter.stats().dropped, 2)
  assert.equal(segmenter.stats().pending, 0)
})

test('an answer that arrives after its caller gave up still warms the cache', async () => {
  const { hanlp, requests } = controlledHanlp()
  const segmenter = interactiveSegmenter(hanlp, { waitMs: 10 })

  const late = await (async () => {
    const pending = segmenter.segmentWithMeta('迟到')
    await until(() => requests.length === 1)
    return pending
  })()
  assert.equal(late.degraded, true)
  requests[0].answer()
  await tick()
  const later = await segmenter.segmentWithMeta('迟到')
  assert.equal(later.backendUsed, 'hanlp')
  assert.equal(requests.length, 1)
})

test('a full queue sheds immediately instead of holding the request', async () => {
  const { hanlp, requests } = controlledHanlp()
  const segmenter = interactiveSegmenter(hanlp, { maxInFlight: 1, maxPending: 1, waitMs: 60_000 })

  const blocker = segmenter.segmentWithMeta('占位')
  await until(() => requests.length === 1)
  const queued = segmenter.segmentWithMeta('排队')
  await tick()
  const started = Date.now()
  const shed = await segmenter.segmentWithMeta('满了')
  assert.ok(Date.now() - started < 1_000)
  assert.equal(shed.errorCode, 'hanlp_busy')
  assert.equal(shed.errorDetail, 'tokenizer queue is full')
  assert.equal(segmenter.stats().shed, 1)

  requests[0].answer()
  await until(() => requests.length === 2)
  assert.deepEqual(requests[1].texts, ['排队'])
  requests[1].answer()
  await Promise.all([blocker, queued])
})

test('tokenizer errors keep their code and detail for both caller kinds', async () => {
  const { hanlp, requests } = controlledHanlp({ status: 503 })
  const segmenter = interactiveSegmenter(hanlp)

  const both = [segmenter.segmentWithMeta('服务'), segmenter.segmentWithMeta('服务', { allowFallback: false })]
  await until(() => requests.length === 1)
  requests[0].answer()
  const [soft, strict] = await Promise.all(both)
  assert.equal(soft.backendUsed, 'jieba')
  assert.equal(soft.errorCode, 'hanlp_http_error')
  assert.match(soft.errorDetail, /503: tokenizer is busy/)
  assert.deepEqual(strict.tokens, [])
  assert.equal(strict.backendUsed, null)
  assert.equal(strict.errorCode, 'hanlp_http_error')
})

test('a batch is bounded by text volume as well as count', async () => {
  const { hanlp, requests } = controlledHanlp()
  const segmenter = interactiveSegmenter(hanlp, { maxInFlight: 1, maxBatchChars: 10 })

  const blocker = segmenter.segmentWithMeta('占位')
  await until(() => requests.length === 1)
  const texts = ['一二三四五六', '七八九十甲乙', '丙丁']
  const pending = texts.map((text) => segmenter.segmentWithMeta(text))
  await tick()
  requests[0].answer()
  await until(() => requests.length === 2)
  assert.deepEqual(requests[1].texts, ['一二三四五六'])
  requests[1].answer()
  await until(() => requests.length === 3)
  assert.deepEqual(requests[2].texts, ['七八九十甲乙', '丙丁'])
  requests[2].answer()
  await Promise.all([blocker, ...pending])
})

test('the interactive batch uses its own short request timeout', async () => {
  const { hanlp } = controlledHanlp()
  const started = Date.now()
  const [result] = await hanlp.segmentBatchWithMeta(['超时'], { allowFallback: false, timeoutMs: 5 })
  assert.ok(Date.now() - started < 5_000)
  assert.equal(result.errorCode, 'hanlp_timeout')
  assert.deepEqual(result.tokens, [])
})

test('a strict batch on a tokenizer without /tokenize/batch computes no fallback', async () => {
  const fallback = { calls: 0, async segmentWithMeta() { this.calls += 1; return { tokens: ['x'], backendUsed: 'jieba' } } }
  const hanlp = new HanlpSegmenter({
    url: 'http://hanlp:8000',
    fetchImpl: async (url) => new Response('', { status: String(url).endsWith('/batch') ? 404 : 503 }),
    fallbackSegmenter: fallback,
    logger: { warn() {} },
  })
  const [result] = await hanlp.segmentBatchWithMeta(['旧服务'], { allowFallback: false })
  assert.equal(result.degraded, true)
  assert.equal(result.backendUsed, null)
  assert.equal(fallback.calls, 0)
})

test('a segmenter without a batch API is returned unchanged', () => {
  const plain = { async segmentWithMeta() { return { tokens: [], backendUsed: 'jieba' } } }
  assert.equal(interactiveSegmenter(plain), plain)
})
