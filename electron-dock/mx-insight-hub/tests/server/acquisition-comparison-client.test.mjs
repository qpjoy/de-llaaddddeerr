import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function client() {
  const source = (await readFile(new URL('../../src/api.js', import.meta.url), 'utf8'))
    .replaceAll('import.meta.env', '({})')
    .replace(/from '([^']+)'/g, (_match, path) => `from ${JSON.stringify(new URL(path, new URL('../../src/api.js', import.meta.url)).href)}`)
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

test('comparison browser client preserves GET query and POST body on fixed original Hub routes', async t => {
  const api = await client()
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return Response.json({ data: [], requestId: 'new-request' }, { headers: { 'x-mx-insight-source-mode': 'live' } })
  })
  api.configurePublicApiBase('https://public-hub.example')
  const parameters = { keyword: '旅行 攻略', page: '1', sort_type: 'time_descending', ai_mode: '0' }
  const nativePath = '/api/v1/xiaohongshu/app_v2/search_notes'
  await api.publicDataApi.acquisitionComparison('temporary-key', parameters, 'new-idempotency', nativePath, 'GET')
  const get = calls.at(-1)
  const url = new URL(get.url)
  assert.equal(url.origin, 'https://public-hub.example')
  assert.equal(url.pathname, nativePath)
  assert.deepEqual(Object.fromEntries(url.searchParams), parameters)
  assert.equal(get.options.method, 'GET')
  assert.equal(get.options.body, undefined)
  assert.equal(get.options.headers['idempotency-key'], 'new-idempotency')
  assert.equal(get.options.headers.authorization, 'Bearer temporary-key')
  for (const path of [nativePath, '/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw']) {
    const result = await api.publicDataApi.acquisitionComparison('temporary-key', parameters, 'new-idempotency', path)
    const post = calls.at(-1)
    assert.equal(post.url, `https://public-hub.example${path}`)
    assert.equal(post.options.method, 'POST')
    assert.deepEqual(JSON.parse(post.options.body), parameters)
    assert.equal(result.evidence.requestId, 'new-request')
    assert.equal(result.evidence.sourceMode, 'live')
  }
  const defaults = { keyword: '旅行', page: '', search_id: '', search_session_id: null, sort_type: '', ai_mode: '' }
  await api.publicDataApi.acquisitionComparison('temporary-key', defaults, 'defaults-idempotency', nativePath, 'GET')
  const defaultGet = new URL(calls.at(-1).url)
  assert.deepEqual(Object.fromEntries(defaultGet.searchParams), { keyword: '旅行', page: '', search_id: '', sort_type: '', ai_mode: '' })
  await api.publicDataApi.acquisitionComparison('temporary-key', { ...defaults, page: null }, 'defaults-idempotency', nativePath, 'POST')
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { ...defaults, page: null })
  const count = calls.length
  for (const [path, method] of [['https://untrusted.invalid', 'POST'], ['/api/v1/data/search?other=true', 'POST'], ['/api/v1/data/search', 'GET'], [nativePath, 'DELETE']]) {
    assert.throws(() => api.publicDataApi.acquisitionComparison('temporary-key', parameters, 'new-idempotency', path, method))
  }
  assert.equal(calls.length, count)
})

test('comparison browser client retains the new failed response, request ID and idempotent evidence', async t => {
  const api = await client()
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'external_platform_rejected', message: 'Rejected' }, requestId: 'new-failed-request' }, {
    status: 502, headers: { 'idempotent-replay': 'true', 'x-mx-insight-source-mode': 'live' },
  }))
  await assert.rejects(api.publicDataApi.acquisitionComparison('temporary-key', { keyword: '旅行' }, 'new-idempotency'), error => {
    assert.equal(error.status, 502)
    assert.equal(error.responseBody.error.code, 'external_platform_rejected')
    assert.equal(error.evidence.requestId, 'new-failed-request')
    assert.equal(error.evidence.idempotentReplay, true)
    return true
  })
})
