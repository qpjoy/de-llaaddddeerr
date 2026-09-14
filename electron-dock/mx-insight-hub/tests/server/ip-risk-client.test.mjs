import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Execute the real browser client with only Vite's env expression substituted.
// A mocked transport checks the outgoing URL, rather than the debugger preview.
async function client() {
  const source = (await readFile(new URL('../../src/api.js', import.meta.url), 'utf8'))
    .replaceAll('import.meta.env', '({})')
    .replace("'../shared/source-catalog-visibility.mjs'", JSON.stringify(new URL('../../shared/source-catalog-visibility.mjs', import.meta.url).href))
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

test('IP browser client sends complete Hub paths on same-origin and split Public API deployments', async t => {
  const api = await client()
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return Response.json({ data: { status: 'success' }, requestId: 'mock-request' })
  })
  for (const origin of ['', 'https://public-hub.example']) {
    api.configurePublicApiBase(origin)
    for (const [name, path, body] of [
      ['ipRisk', '/api/v1/data/ip/risk', { ip: '1.1.1.1' }],
      ['ipRiskBatch', '/api/v1/data/ip/risk/batch', { ips: ['1.1.1.1', '8.8.8.8'] }],
    ]) {
      await api.publicDataApi[name]('mock-hub-key', body, { idempotencyKey: 'ip-client-test-001' })
      const call = calls.at(-1)
      assert.equal(call.url, origin + path)
      assert.equal(call.options.method, 'POST')
      assert.equal(call.options.headers.authorization, 'Bearer mock-hub-key')
      assert.equal(call.options.headers['idempotency-key'], 'ip-client-test-001')
      assert.deepEqual(JSON.parse(call.options.body), body)
    }
  }
  assert.equal(calls.length, 4)
})
