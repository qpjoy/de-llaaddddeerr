import assert from 'node:assert/strict'
import test from 'node:test'
import { strategySearchGuide } from '../../server/data/strategy-search-guide.mjs'
import { publicDocsHtmlForPath } from '../../server/public-docs.mjs'

test('the authenticated product documentation includes account-only access and denies unrelated scopes', () => {
  const html = publicDocsHtmlForPath('/docs/strategy-search', { tenant: true,
    scopes: [{ platforms: ['linkedin'], capabilities: [] }] })
  assert.ok(html)
  const main = html.match(/<main>([\s\S]*?)<\/main>/)?.[1]
  assert.match(main, /linkedin/)
  assert.match(main, /\/search\/user-info/)
  assert.doesNotMatch(main, /\/api\/v1\/data\/search|instagram|twitter/i)
  for (const scopes of [[], [{ platforms: ['enterprise'], capabilities: [] }]]) {
    assert.equal(publicDocsHtmlForPath('/docs/strategy-search', { tenant: true, scopes }), null)
  }
})

test('Instagram tenant guide stays inside existing platform scope without supplier or configuration details', () => {
  const scopes = [{ platforms: ['instagram'], capabilities: [] }]
  const before = structuredClone(scopes)
  const html = strategySearchGuide(scopes)
  assert.match(html, /instagram/)
  assert.match(html, /\/api\/v1\/data\/search/)
  assert.match(html, /\/api\/v1\/night-all\/search\/raw/)
  assert.doesNotMatch(html, /twitter|facebook|xiaohongshu|linkedin|telegram|微信/i)
  assert.doesNotMatch(html, /rapidapi|tikhub|justone|primaryProvider|fallbackProvider|api_7968|monthly_limit|采购/i)
  assert.match(html, /不会新增权限/)
  assert.deepEqual(scopes, before)
})

test('account-only LinkedIn documentation has no standard content-search example', () => {
  const html = strategySearchGuide([{ platforms: ['linkedin'], capabilities: [] }])
  assert.match(html, /linkedin/)
  assert.match(html, /\/search\/crawl/)
  assert.match(html, /\/search\/user-info/)
  assert.doesNotMatch(html, /\/search\/raw|\/api\/v1\/data\/search|示例关键词/)
  assert.doesNotMatch(html, /twitter|instagram|facebook|tikhub|justone|rapidapi/i)
})

test('Xiaohongshu operation scopes are not unioned across Keys and cannot imply ungranted operations', () => {
  const html = strategySearchGuide([{ platforms: ['xiaohongshu'], capabilities: ['social.users.resolve'] }])
  assert.match(html, /\/search\/user-info/)
  assert.doesNotMatch(html, /\/search\/crawl|\/search\/raw|\/api\/v1\/data\/search/)
  const split = strategySearchGuide([
    { platforms: ['xiaohongshu'], capabilities: [] },
    { platforms: [], capabilities: ['social.posts.search', 'social.users.posts', 'social.users.resolve'] },
  ])
  assert.doesNotMatch(split, /xiaohongshu|POST \/api\/v1/)
  assert.doesNotMatch(strategySearchGuide([]), /instagram|twitter|POST \/api\/v1/)
})

test('guide distinguishes standard and raw parsing and does not promise paid retry or 400 fallback', () => {
  const html = strategySearchGuide([{ platforms: ['instagram'], capabilities: [] }])
  assert.match(html, /data\.items/)
  assert.match(html, /data\.pageInfo/)
  assert.match(html, /data\.raw_info/)
  assert.match(html, /data\.raw_data/)
  assert.match(html, /JSON 字符串/)
  assert.match(html, /不能与标准接口的数组字段互换/)
  assert.match(html, /不承诺 400 或任何已派发请求失败后自动切换/)
  assert.match(html, /只读核查请求状态与账本/)
  assert.match(html, /幂等回放有有效窗口/)
  assert.match(html, /不能将超时后反复 POST/)
})
