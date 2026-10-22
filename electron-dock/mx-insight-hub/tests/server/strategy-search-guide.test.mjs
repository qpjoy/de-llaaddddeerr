import assert from 'node:assert/strict'
import test from 'node:test'
import { strategySearchGuide } from '../../server/data/strategy-search-guide.mjs'
import { publicDocsHtmlForPath, tenantOpenApiDocument, tenantDocumentPathAllowed } from '../../server/public-docs.mjs'

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
  assert.match(twitter, /不再设置每次 Hub 请求默认 3 次的补页调用上限/)
  assert.match(twitter, /15 个上游页和 15 个公开页/)
  assert.match(twitter, /旧 raw 与旧 crawl 转发入口未新增此补页行为/)
  assert.match(twitter, /params\.category=Latest/)
  assert.match(twitter, /params\.filters.*2048/)
  assert.match(twitter, /params\.includeTimestamp.*默认 false/)
  assert.match(twitter, /query.*仍必填.*不支持只传 filters/)
  assert.match(twitter, /People 返回账号/)
  assert.match(twitter, /原生 count 已不再受支持/)
  assert.match(twitter, /不接受 params\.count 或 params\.cursor/)
  assert.match(twitter, /旧游标及历史重放保留原条件与排序/)
  assert.match(twitter, /twitter_search_parameters_unsupported/)
  assert.doesNotMatch(twitter, /最多请求 50 条/)
  assert.doesNotMatch(twitter, /Facebook|Instagram|rapidapi|justone|tikhub/i)
  const facebook = strategySearchGuide([{ platforms: ['facebook'], capabilities: [] }])
  assert.match(facebook, /不再设置每次 Hub 请求默认 3 次的补页派发上限/)
  assert.match(facebook, /15 个上游页／公开页/)
  assert.match(facebook, /其他已派发失败或未知结果不会为补齐而重试/)
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
  assert.match(html,/标准搜索余量优先、跨页去重，不再设置每请求默认 3 次的补页派发上限/)
  assert.match(html,/15 个上游页／公开页/)
  assert.match(html,/显式附采参数会在采购前拒绝/)
  assert.doesNotMatch(html,/douyin|kuaishou|zhihu|Twitter|Facebook|tikhub|rapidapi|justone/i)
})

test('Reddit and YouTube standard direct guide is scoped and does not migrate raw or promise old cursor conversion', () => {
  for (const platform of ['reddit', 'youtube']) {
    const scopes = [{ platforms: [platform], capabilities: [] }]
    const html = strategySearchGuide(scopes)
    assert.match(html, /标准内容搜索直连/)
    assert.match(html, new RegExp(`${platform} 的新 <code>POST /api/v1/data/search`))
    assert.match(html, /data\.contractVersion=night-all\.data-search\.v1/)
    assert.match(html, /两个 raw 入口.*继续原链路/)
    assert.match(html, /标准请求继续拒绝 <code>params<\/code>/)
    assert.match(html, /15 个上游页和 15 个公开页/)
    assert.match(html, /409 search_restart_required/)
    assert.match(html, /新的 Idempotency-Key 从首页重启；不要自动重启/)
    assert.match(html, /其他无效游标或参数返回 400/)
    assert.doesNotMatch(html, /POST \/api\/v1\/data\/social\/crawl|tikhub|rapidapi|justone|详情附采已启用/i)
    assert.doesNotMatch(html, new RegExp(platform === 'reddit' ? 'youtube' : 'reddit', 'i'))
  }
})

test('new account docs require same-scope platform and operation and narrow debugger schemas to authorized platforms', () => {
  const scopes = [{ platforms: ['linkedin', 'bilibili'], capabilities: ['social.content.crawl'] }]
  const before = structuredClone(scopes)
  const document = tenantOpenApiDocument(scopes)
  const entry = document.paths['/data/social/crawl'].post
  assert.deepEqual(entry.requestBody.content['application/json'].schema.properties.platform.enum, ['bilibili', 'linkedin'])
  assert.equal(entry.requestBody.content['application/json'].example.platform, 'bilibili')
  assert.equal(entry.requestBody.content['application/json'].schema.properties.businessId.deprecated, true)
  const response = entry.responses['200'].content['application/json'].schema
  assert.equal(response.properties.data.properties.raw_data.type, 'string')
  assert.equal(response.properties.data.properties.items.type, 'array')
  assert.deepEqual(response.properties.data.properties.pageInfo.properties.nextCursor.type, ['string', 'null'])
  assert.equal(document.paths['/data/social/user-info'], undefined)
  assert.equal(tenantDocumentPathAllowed('/data/social/crawl', [
    { platforms: ['linkedin'], capabilities: [] }, { platforms: [], capabilities: ['social.content.crawl'] },
  ]), false)
  const html = strategySearchGuide(scopes)
  assert.match(html, /POST \/api\/v1\/data\/social\/crawl/)
  assert.match(html, /social\.content\.crawl/)
  assert.match(html, /page_size/)
  assert.match(html, /不能把整个 raw_data 字符串当作一条内容/)
  assert.match(html, /短页、空页或 partial 都应检查游标/)
  assert.doesNotMatch(html, /POST \/api\/v1\/data\/social\/user-info|Twitter \/ X|instagram/i)
  assert.deepEqual(scopes, before)
})

test('account profile docs are independently authorized and leave old compatibility documentation intact', () => {
  const scopes = [{ platforms: ['twitter'], capabilities: ['social.profile.get'] }]
  const html = strategySearchGuide(scopes)
  assert.match(html, /POST \/api\/v1\/data\/social\/user-info/)
  assert.doesNotMatch(html, /POST \/api\/v1\/data\/social\/crawl/)
  assert.match(html, /\/api\/v1\/night-all\/search\/crawl/)
  assert.match(html, /username\/usernames\/userId\/userIds\/user_id\/uid 及 params 中对应账号别名使用相同规则/)
  assert.match(html, /裸纯数字字符串按 1–19 位平台 ID 查询/)
  assert.match(html, /纯数字用户名须加 @，或通过 url\/urls 字段提交主页 URL/)
  assert.match(html, /历史精确回执保持原响应/)
  assert.match(html, /429 不等于分页耗尽/)
  const document = tenantOpenApiDocument(scopes)
  assert.deepEqual(document.paths['/data/social/user-info'].post['x-mx-platform-options'], ['twitter'])
  const identifiers = document.paths['/data/social/user-info'].post.requestBody.content['application/json'].schema.properties
  assert.match(identifiers.username.description, /纯数字字符串按账号 ID 查询（1–19 位）/)
  assert.match(identifiers.usernames.description, /@12345 表示数字用户名；主页 URL 请使用 url\/urls 字段/)
  assert.match(identifiers.userId.description, /与 username 相同/)
  assert.match(identifiers.params.description, /screen_name\/screenName/)
  assert.equal(document.paths['/data/social/crawl'], undefined)
})
