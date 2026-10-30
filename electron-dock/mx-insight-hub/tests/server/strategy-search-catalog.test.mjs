import assert from 'node:assert/strict'
import test from 'node:test'
import { strategySearchCatalog } from '../../server/data/strategy-search-catalog.mjs'
import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../../server/contracts/night-all-legacy.mjs'
import { canRouteRawSearch } from '../../server/contracts/raw-search.mjs'
import { canRouteDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { normalizeHubSocialRequest } from '../../server/contracts/hub-social.mjs'
import { normalizeHubSocialCompatRequest } from '../../server/contracts/hub-social-compat.mjs'
import { HUB_SOCIAL_COMPAT_CRAWL_PLATFORMS, HUB_SOCIAL_COMPAT_PROFILE_PLATFORMS } from '../../shared/social-account-contract.mjs'
import { assertWechatSearchNotRetired } from '../../server/contracts/wechat-search-alias.mjs'

const interfaceById = (catalog, id) => catalog.interfaces.find(row => row.id === id)
const platformById = (catalog, id, platform) => interfaceById(catalog, id).platforms.find(row => row.platform === platform)

test('strategy catalog separates supported operation sets and exposes the implemented policy editors', () => {
  const catalog = strategySearchCatalog()
  for (const id of ['crawl', 'user-info']) {
    const group = interfaceById(catalog, id)
    assert.deepEqual(group.platforms.map(row => row.platform), id === 'crawl' ? HUB_SOCIAL_COMPAT_CRAWL_PLATFORMS : HUB_SOCIAL_COMPAT_PROFILE_PLATFORMS)
    assert(group.paths.includes(`/api/v1/night-all/search/${id}`))
    assert.equal(group.platforms.some(row => row.platform === 'telegram'), false)
  }
  assert.equal(platformById(catalog, 'search', 'linkedin'), undefined)
  assert.equal(platformById(catalog, 'user-info', 'reddit').migrationStatus, 'hub_native')
  const editable = catalog.interfaces.flatMap(group => group.platforms.filter(row => row.editable).map(row => `${group.id}:${row.platform}`))
  assert.deepEqual(editable.sort(), ['crawl:facebook', 'search:facebook', 'search:instagram', 'search:twitter', 'user-info:facebook'])
  for (const row of catalog.interfaces.flatMap(group => group.platforms)) {
    assert(row.label && row.routeSummary)
    if (!row.editable) assert(row.readOnlyReason)
    assert.equal('ready' in row, false, 'a static catalog cannot promise credential/runtime readiness')
  }
})

test('policy rows preserve provider-specific saved shape without mutating it or inventing a policy', () => {
  const instagramPolicy = { mode: 'priority', primaryProvider: 'justone', fallbackProvider: 'tikhub', revision: 3 }
  const facebookPolicy = { mode: 'auto', monthly_limit: 1000, billing_day: 27, next_recovery_check_at: '2026-10-27T00:00:00Z', revision: 4 }
  const twitterPolicy = { mode: 'priority', primaryProvider: 'rapidapi', fallbackProvider: 'tikhub', revision: 7 }
  const catalog = strategySearchCatalog({ instagramPolicy, facebookPolicy, twitterPolicy })
  const instagram = platformById(catalog, 'search', 'instagram')
  const facebook = platformById(catalog, 'search', 'facebook')
  assert.deepEqual(instagram.providers, ['justone', 'tikhub'])
  assert.deepEqual(instagram.allowedModes, ['fixed', 'priority', 'paused'])
  assert.deepEqual(facebook.allowedModes, ['auto', 'rapidapi', 'justone', 'paused'])
  assert.deepEqual(instagram.policy, instagramPolicy)
  assert.deepEqual(facebook.policy, facebookPolicy)
  facebook.policy.monthly_limit = 1
  instagram.policy.primaryProvider = 'tikhub'
  assert.equal(facebookPolicy.monthly_limit, 1000)
  assert.equal(instagramPolicy.primaryProvider, 'justone')
  assert.equal(platformById(strategySearchCatalog(), 'search', 'instagram').policy, null)
  const twitter = platformById(catalog, 'search', 'twitter')
  assert.deepEqual(twitter.policy, twitterPolicy)
  assert.deepEqual(twitter.allowedModes, ['fixed', 'priority', 'paused'])
  twitter.policy.primaryProvider = 'tikhub'
  assert.equal(twitterPolicy.primaryProvider, 'rapidapi')
  assert.equal(platformById(strategySearchCatalog(), 'search', 'twitter').policy, null)
})

test('Twitter catalog acknowledges the actual split between migrated standard search and complex raw/account compatibility', () => {
  const catalog = strategySearchCatalog()
  assert.equal(canRouteDataSearch({ platform: 'twitter', pageSize: 100 }), true)
  assert.equal(canRouteRawSearch({ platform: 'twitter', pageSize: 20, upstreamBody: { platform: 'twitter', keyword: 'example' } }), true)
  assert.equal(canRouteRawSearch({ platform: 'twitter', pageSize: 100, upstreamBody: { platform: 'twitter', keyword: 'example' } }), false)
  for (const id of ['search', 'crawl', 'user-info']) {
    const row = platformById(catalog, id, 'twitter')
    assert.equal(row.migrationStatus, id === 'search' ? 'conditional' : 'hub_native')
    assert.deepEqual(row.providers, id === 'search' ? ['rapidapi', 'tikhub'] : ['rapidapi'])
    assert.match(row.routeSummary, /Night-All/)
  }
  const twitter = platformById(catalog, 'search', 'twitter')
  assert.equal(twitter.editable, true)
  assert.match(twitter.routeSummary, /仅适用于 POST \/api\/v1\/data\/search 与 \/api\/v2\/data\/search/)
  assert.match(twitter.routeSummary, /data\/social\/search 与 raw 保持原 RapidAPI/)
  assert.match(twitter.routeSummary, /无游标且尚未取得成功源页.*RapidAPI 明确 HTTP 400.*原条件转 TikHub 一次/)
  assert.match(twitter.routeSummary, /固定模式或 TikHub 优先不启用此400保底/)
  assert.match(twitter.routeSummary, /历史请求按原结果重放，已有分页绑定原供应商/)
  assert.match(twitter.routeSummary, /超时、未知结果、成功响应不可用及其他错误不触发自动切换/)
  assert(interfaceById(catalog, 'search').paths.includes('/api/v2/data/search'))
  assert.throws(() => normalizeHubSocialRequest('crawl', { platform: 'instagram', username: 'example' }), error => error.code === 'social_platform_not_implemented')
  assert.equal(normalizeHubSocialCompatRequest('crawl', { platform: 'instagram', username: 'example' }).platform, 'instagram')
  assert.equal(platformById(catalog, 'crawl', 'instagram').migrationStatus, 'hub_native')
  assert.deepEqual(platformById(catalog, 'crawl', 'instagram').providers, ['tikhub'])
  assert.deepEqual(platformById(catalog, 'user-info', 'facebook').providers, ['justone'])
})

test('WeChat retired compatibility route and Telegram local search are not advertised as Night-All supplier routes', () => {
  const catalog = strategySearchCatalog()
  for (const platform of ['wechat_search', 'wechat_mp']) {
    assert.throws(() => assertWechatSearchNotRetired('raw', { platform }), error => error.code === 'wechat_search_route_retired')
    const row = platformById(catalog, 'search', platform)
    assert.equal(row.migrationStatus, 'hub_native')
    assert.deepEqual(row.providers, ['tikhub'])
    assert.match(row.routeSummary, /410/)
  }
  const telegram = platformById(catalog, 'search', 'telegram')
  assert.equal(telegram.migrationStatus, 'local')
  assert.deepEqual(telegram.providers, [])
  assert.match(telegram.routeSummary, /canonical\/search/)
})

test('Reddit and YouTube catalog separates direct standard searches from retained raw routes', () => {
  const catalog = strategySearchCatalog()
  for (const platform of ['reddit', 'youtube']) {
    const row = platformById(catalog, 'search', platform)
    assert.equal(row.migrationStatus, 'conditional')
    assert.equal(row.editable, false)
    assert.deepEqual(row.providers, ['tikhub'])
    assert.match(row.routeSummary, /POST \/api\/v1\/data\/search.*Hub 直连 TikHub/)
    assert.match(row.routeSummary, /\/api\/v1\/search\/raw 与 \/api\/v1\/night-all\/search\/raw 继续原 Night-All 链路/)
    assert.match(row.routeSummary, /409 search_restart_required/)
    assert.match(row.readOnlyReason, /不代表线上已经部署或实时可用/)
    assert.equal(Object.hasOwn(row, 'ready'), false)
    assert.equal(platformById(catalog, 'crawl', platform).migrationStatus, 'hub_native')
  }
})

test('account social migration and retained legacy operation coverage are documented independently', () => {
  const catalog = strategySearchCatalog()
  for (const platform of ['bilibili', 'douyin', 'kuaishou', 'zhihu']) {
    const search = platformById(catalog, 'search', platform)
    assert.equal(search.migrationStatus, 'hub_native')
    assert.equal(search.editable, false)
    assert.deepEqual(search.providers, ['tikhub'])
    assert.match(search.routeSummary, /关键词批量.*Hub 直连 TikHub/)
    assert.match(search.routeSummary, /不再转交 Night-All/)
    assert.equal(Object.hasOwn(search, 'ready'), false)
    for (const operation of ['crawl', 'user-info']) {
      const account = platformById(catalog, operation, platform)
      if (!NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS[operation].includes(platform)) {
        assert.match(account.routeSummary, /旧兼容入口未声明/)
      } else {
        assert.match(account.routeSummary, /旧 \/search 与 \/night-all\/search 入口仍经 Night-All/)
      }
      assert.equal(account.migrationStatus, 'hub_native')
      assert.equal(account.editable, false)
      assert.match(account.routeSummary, new RegExp(`data/social/${operation}.*由 Hub 执行`))
    }
  }
  const facebook = platformById(catalog, 'search', 'facebook')
  assert.match(facebook.routeSummary, /标准搜索.*有界补齐/)
  assert.match(facebook.routeSummary, /raw 保持既有分页/)
})
