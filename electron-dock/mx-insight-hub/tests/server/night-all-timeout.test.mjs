import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import { loadConfig } from '../../server/config.mjs'

const envelope = {
  data: {
    contractVersion: 'night-all.data-search.v1',
    platform: 'kuaishou', query: 'synthetic', items: [],
    pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: 0, hasMore: false, nextCursor: null, cursorType: 'none' },
    status: 'ok', warnings: [],
    meta: { capability: 'search_posts', capabilityStatus: 'ready', paginationMode: 'cursor',
      sourceProvider: 'tikhub', endpointId: 'synthetic', providerCalls: 1, durationMs: 34601 },
  },
  requestId: 'synthetic-request', traceId: 'synthetic-trace',
}

// Real response-body parsing with a synthetic transport: no network or paid calls.
function transport({ headersAt, bodyAfterHeaders = 0 }) {
  const state = { calls: 0, signal: null }
  state.fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => {
    state.calls += 1
    state.signal = signal
    const aborted = () => reject(new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', aborted, { once: true })
    setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      if (signal.aborted) return
      const stream = new ReadableStream({
        start(controller) {
          const abortBody = () => controller.error(new DOMException('aborted', 'AbortError'))
          signal.addEventListener('abort', abortBody, { once: true })
          setTimeout(() => {
            signal.removeEventListener('abort', abortBody)
            if (signal.aborted) return
            controller.enqueue(new TextEncoder().encode(JSON.stringify(envelope)))
            controller.close()
          }, bodyAfterHeaders)
        },
      })
      resolve(new Response(stream, { headers: { 'content-type': 'application/json' } }))
    }, headersAt)
  })
  return state
}

for (const mode of ['standalone adapter', 'runtime config']) {
  function adapterFor(fetchImpl) {
    const options = mode === 'runtime config' ? loadConfig({
      MX_INSIGHT_LISTENER_MODE: 'public', MX_INSIGHT_STORE: 'memory',
      MX_INSIGHT_API_KEY_PEPPER: 'synthetic-pepper-long-enough-for-config',
      NIGHT_ALL_BASE_URL: 'http://night-all.invalid',
    }).nightAll : { baseUrl: 'http://night-all.invalid' }
    return new NightAllAdapter({ ...options, fetchImpl })
  }
  const search = adapter => adapter.search({
    body: { platform: 'kuaishou', query: 'synthetic', pageSize: 20 }, businessId: 'synthetic-business',
  })

  test(`${mode}: accepts the incident's 34.601-second upstream duration`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const upstream = transport({ headersAt: 34600, bodyAfterHeaders: 1 })
    const pending = search(adapterFor(upstream.fetchImpl))
    t.mock.timers.tick(34600)
    await Promise.resolve()
    assert.equal(upstream.signal.aborted, false)
    t.mock.timers.tick(1)
    const result = await pending
    assert.deepEqual(result.raw, envelope)
    t.mock.timers.tick(60000)
    assert.equal(upstream.signal.aborted, false, 'successful completion clears the deadline')
    assert.equal(upstream.calls, 1)
  })

  test(`${mode}: one 60-second deadline includes time spent reading the body`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const upstream = transport({ headersAt: 45000, bodyAfterHeaders: 20000 })
    const pending = assert.rejects(search(adapterFor(upstream.fetchImpl)), { name: 'UpstreamAmbiguousError' })
    t.mock.timers.tick(45000)
    await Promise.resolve()
    t.mock.timers.tick(14999)
    assert.equal(upstream.signal.aborted, false)
    t.mock.timers.tick(1)
    await pending
    assert.equal(upstream.signal.aborted, true)
    assert.equal(upstream.calls, 1, 'an ambiguous dispatch is not automatically retried')
  })

  test(`${mode}: waiting for headers also stops at 60 seconds`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const upstream = transport({ headersAt: 61000 })
    const pending = assert.rejects(search(adapterFor(upstream.fetchImpl)), { name: 'UpstreamAmbiguousError' })
    t.mock.timers.tick(59999)
    assert.equal(upstream.signal.aborted, false)
    t.mock.timers.tick(1)
    await pending
    assert.equal(upstream.calls, 1)
  })
}
