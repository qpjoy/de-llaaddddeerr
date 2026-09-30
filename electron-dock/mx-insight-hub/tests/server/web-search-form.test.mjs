import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWebSearchBody, matchingSearchProviders } from '../../src/web-search-form.js'
import { WEB_SEARCH_PROVIDERS } from '../../shared/web-search.mjs'
import { normalizeWebSearch, providerSupports } from '../../server/web-search/contract.mjs'
const form = { query: ' 人工智能 ', provider: '', types: ['web'], limits: { web: 10, image: 30, video: 10 }, sites: '', from: '', to: '', recency: '', edition: 'standard' }
test('search product forms conform to server contracts and select the same compatible channels', () => {
  for (const patch of [{}, { provider: 'tavily' }, { types: ['video', 'web', 'image'] }, { sites: 'Example.COM，example.com test.cn', recency: 'week' }, { from: '2026-09-01', to: '2026-09-30' }, { edition: 'lite' }, { limits: { ...form.limits, web: 50 } }]) {
    const body = buildWebSearchBody({ ...form, ...patch }), normalized = normalizeWebSearch(body)
    const expected = WEB_SEARCH_PROVIDERS.filter(provider => (!body.provider || provider.key === body.provider) && providerSupports(provider, normalized))
    assert.deepEqual(matchingSearchProviders(WEB_SEARCH_PROVIDERS, body), expected)
  }
})
test('search form rejects invalid ranges and does not silently drop incompatible parameters', () => {
  for (const patch of [{ query: ' ' }, { query: 'a\0b' }, { types: [] }, { sites: 'https://example.com/path' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-09-01' }, { from: '2026-09-01', to: '2026-09-02', recency: 'week' }, { types: ['image'], sites: 'example.com' }, { limits: { web: 1.5 } }]) assert.throws(() => buildWebSearchBody({ ...form, ...patch }))
  assert.deepEqual(matchingSearchProviders(WEB_SEARCH_PROVIDERS, buildWebSearchBody({ ...form, provider: 'tavily', sites: 'example.com' })), [])
  assert.deepEqual(matchingSearchProviders(WEB_SEARCH_PROVIDERS.filter(provider => provider.key !== 'baidu'), buildWebSearchBody({ ...form, types: ['image'] })), [])
})
test('equivalent forms keep a stable request fingerprint and explicit provider selection remains distinct', () => {
  assert.equal(JSON.stringify(buildWebSearchBody({ ...form, sites: 'Example.COM, test.cn', types: ['web', 'image'] })), JSON.stringify(buildWebSearchBody({ ...form, sites: 'test.cn example.com example.com', types: ['image', 'web'] })))
  assert.notEqual(JSON.stringify(buildWebSearchBody(form)), JSON.stringify(buildWebSearchBody({ ...form, provider: 'baidu' })))
})
