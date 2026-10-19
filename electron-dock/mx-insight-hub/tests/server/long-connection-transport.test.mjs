import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { Agent } from 'undici'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import { UpstreamAmbiguousError, UpstreamRejectedError } from '../../server/core/errors.mjs'
import { aggregateStream } from '../../server/data/aggregate-stream.mjs'

const input = { operation: 'raw', body: { platform: 'douyin', keyword: 'fixture', count: 1 }, businessId: 'fixture' }

for (const status of [200, 502]) {
  test(`Night-All releases an unread non-JSON ${status} body without changing its outcome`, async () => {
    let cancelled = 0, calls = 0
    const adapter = new NightAllAdapter({ baseUrl: 'http://synthetic.invalid', fetchImpl: async () => {
      calls++
      return new Response(new ReadableStream({ cancel() { cancelled++ } }), {
        status, headers: { 'content-type': 'text/html', 'x-request-id': 'observed-upstream-id' },
      })
    } })
    await assert.rejects(adapter.legacySearch(input), error => {
      assert.ok(error instanceof (status === 200 ? UpstreamAmbiguousError : UpstreamRejectedError))
      assert.equal(status === 200 ? error.upstreamHttpStatus : error.status, status)
      assert.equal(error.upstreamRequestId, 'observed-upstream-id')
      return true
    })
    assert.equal(cancelled, 1)
    assert.equal(calls, 1, 'cleanup never retries an already sent operation')
  })
}

test('unread-body cleanup cannot replace or delay the original upstream rejection', { timeout: 1000 }, async () => {
  for (const cancel of [() => Promise.reject(new Error('fixture cleanup failure')), () => new Promise(() => {})]) {
    const adapter = new NightAllAdapter({ baseUrl: 'http://synthetic.invalid', fetchImpl: async () =>
      new Response(new ReadableStream({ cancel }), { status: 429, headers: { 'content-type': 'text/html' } }) })
    await assert.rejects(adapter.legacySearch(input), error => error instanceof UpstreamRejectedError && error.status === 429)
  }
})

test('a stalled HTML response cannot occupy the sole upstream connection after rejection', { timeout: 5000 }, async () => {
  let calls = 0
  const server = createServer((_request, response) => {
    calls++
    if (calls === 1) {
      response.writeHead(502, { 'content-type': 'text/html' })
      response.write('unusable response that never finishes')
    } else response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{"ok":true}}')
  })
  const dispatcher = new Agent({ connections: 1 })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const adapter = new NightAllAdapter({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 500,
    fetchImpl: (url, options) => fetch(url, { ...options, dispatcher }) })
  try {
    assert.equal((await adapter.dependencies()).status, 'down')
    assert.equal((await adapter.dependencies()).status, 'up')
    assert.equal(calls, 2)
  } finally {
    await dispatcher.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

function responseFixture() {
  const response = new EventEmitter()
  Object.assign(response, { writableLength: 0, destroyed: false, writes: [],
    writeHead(status, headers) { this.status = status; this.headers = headers },
    flushHeaders() { this.flushed = true },
    write(chunk) { this.writes.push(chunk); return true },
    destroy() { this.destroyed = true; this.emit('close') },
    end() { this.ended = true },
  })
  return response
}

test('SSE heartbeats apply the same slow-reader memory bound even while no source completes', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const response = responseFixture(), stream = aggregateStream(response)
  stream.write('search.started', { requestId: 'fixture' })
  assert.equal(response.flushed, true)
  assert.match(response.writes[0], /^event: search.started\n/)
  t.mock.timers.tick(10_000)
  assert.equal(response.writes.at(-1), ': heartbeat\n\n')
  const delivered = response.writes.length
  response.writableLength = 1024 * 1024 + 1
  t.mock.timers.tick(10_000)
  assert.equal(response.destroyed, true)
  assert.equal(response.writes.length, delivered)
  t.mock.timers.tick(30_000)
  stream.write('search.completed', { get result() { assert.fail('closed delivery must not serialize results') } })
  assert.equal(response.writes.length, delivered)
  stream.end()
})

test('normal SSE can deliver a large complete result without a new per-event size restriction', () => {
  const response = responseFixture(), stream = aggregateStream(response)
  stream.write('search.completed', { data: 'x'.repeat(1024 * 1024 + 1) })
  stream.end()
  assert.equal(response.destroyed, false)
  assert.equal(response.ended, true)
  assert.equal(response.writes.length, 1)
  assert.ok(response.writes[0].length > 1024 * 1024)
})
