import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function client() {
  const source = (await readFile(new URL('../../src/api.js', import.meta.url), 'utf8'))
    .replaceAll('import.meta.env', '({})')
    .replace(/from '([^']+)'/g, (_match, path) => `from ${JSON.stringify(new URL(path, new URL('../../src/api.js', import.meta.url)).href)}`)
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

test('Hub limit control reads and saves only the Admin route with the original CAS revision', async t => {
  const { adminApi } = await client()
  const calls = [], controller = new AbortController()
  const apiKeyId = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
  const state = { apiKeyId, source: 'legacy', hubRateLimitExempt: null, effectiveExempt: false, inheritedQuotaExempt: true, revision: 0, updatedAt: null }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return Response.json({ data: state })
  })
  assert.deepEqual(await adminApi.keyHubLimits('synthetic-admin-token', apiKeyId, { signal: controller.signal }), state)
  const body = { hubRateLimitExempt: true, revision: 0, reason: 'Synthetic test change' }
  await adminApi.saveKeyHubLimits('synthetic-admin-token', apiKeyId, body)
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.url, `/internal/v1/admin/api-keys/${apiKeyId}/hub-limits`)
    assert.equal(call.options.headers['x-mx-insight-admin-token'], 'synthetic-admin-token')
    assert.equal(call.options.headers.authorization, undefined)
  }
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.body, undefined)
  assert.equal(calls[0].options.signal, controller.signal)
  assert.equal(calls[1].options.method, 'PUT')
  assert.deepEqual(JSON.parse(calls[1].options.body), body)
})

test('Hub limit control preserves revision conflict details without automatically retrying', async t => {
  const { adminApi } = await client()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ error: { code: 'api_key_hub_limits_changed', message: 'Configuration changed', details: { revision: 2 } } }, { status: 409 })
  })
  await assert.rejects(adminApi.saveKeyHubLimits('synthetic-admin-token', 'key', { hubRateLimitExempt: false, revision: 1, reason: 'Synthetic test change' }), error => {
    assert.equal(error.status, 409)
    assert.equal(error.code, 'api_key_hub_limits_changed')
    assert.equal(error.details.revision, 2)
    return true
  })
  assert.equal(calls, 1)
})
