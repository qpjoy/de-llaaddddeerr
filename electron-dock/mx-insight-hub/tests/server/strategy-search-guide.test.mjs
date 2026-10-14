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

test('platform-scoped guides describe bounded Twitter and Facebook filling without leaking other scopes', () => {
  const twitter = strategySearchGuide([{ platforms: ['twitter'], capabilities: [] }])
  assert.match(twitter, /Twitter 标准分页/)
  assert.match(twitter, /剩余 4 条/)
  assert.match(twitter, /最多 3 次上游调用/)
  assert.match(twitter, /15 个上游页和 15 个公开页/)
  assert.match(twitter, /旧 raw、social、crawl 接口未新增此补页行为/)
  assert.doesNotMatch(twitter, /Facebook|Instagram|rapidapi|justone|tikhub/i)
  const facebook = strategySearchGuide([{ platforms: ['facebook'], capabilities: [] }])
  assert.match(facebook, /一次 Hub 请求最多 3 次实际派发/)
  assert.match(facebook, /params\.startTime\/endTime/)
  assert.match(facebook, /不代表所有旧分页都能无缝续接/)
  assert.doesNotMatch(facebook, /Twitter|Instagram|最多 3 次上游调用|rapidapi|justone|tikhub/i)
  for (const html of [twitter, facebook]) {
    assert.match(html, /已取得的 0 与未提供的 null/)
    assert.match(html, /包括此前的空结果或失败/)
    assert.match(html, /不从正文生成标题/)
  }
})

test('WeChat-only strategy guide documents the existing unified response without granting old live access', () => {
  const scopes = [{ platforms: ['social'], capabilities: ['native.wechat.search.search'] }]
  const before = structuredClone(scopes)
  const html = publicDocsHtmlForPath('/docs/strategy-search', { tenant: true, scopes })
  assert.ok(html)
  const main = html.match(/<main>([\s\S]*?)<\/main>/)?.[1]
  assert.match(main, /POST \/api\/v1\/data\/search/)
  assert.match(main, /POST \/api\/v1\/data\/wechat\/search\/search/)
  assert.match(main, /wechat_search|wechat_mp/)
  assert.match(main, /contractVersion\/endpoint\/data\/meta\/requestId/)
  assert.match(main, /params\.raw=false/)
  assert.match(main, /data\.items/)
  assert.match(main, /data\.categories/)
  assert.match(main, /data\.continue_flag/)
  assert.match(main, /data\.cursor/)
  assert.match(main, /永久幂等重放/)
  assert.match(main, /410 wechat_search_route_retired/)
  assert.doesNotMatch(main, /instagram|twitter|facebook|tikhub|justone|rapidapi/i)
  assert.deepEqual(scopes, before)
  for (const denied of [
    [{ platforms: ['wechat_search', 'wechat_mp'], capabilities: [] }],
    [{ platforms: ['social'], capabilities: ['native.wechat.search.search-videos'] }],
    [{ platforms: ['social'], capabilities: [] }, { platforms: [], capabilities: ['native.wechat.search.search'] }],
  ]) assert.doesNotMatch(strategySearchGuide(denied), /<h2>微信搜索<\/h2>|POST \/api\/v1\/data\/wechat\/search\/search/)
})


test('four-platform migration guide is scoped and distinguishes keyword search from account and enrichment operations', () => {
  const html = strategySearchGuide([{platforms:['bilibili'],capabilities:[]}])
  assert.match(html,/关键词搜索直连/)
  assert.match(html,/bilibili 的新关键词搜索由 Hub 执行/)
  assert.match(html,/标准搜索余量优先、跨页去重、每请求最多 3 次上游派发/)
  assert.match(html,/显式附采参数会在采购前拒绝/)
  assert.doesNotMatch(html,/douyin|kuaishou|zhihu|Twitter|Facebook|tikhub|rapidapi|justone/i)
})
