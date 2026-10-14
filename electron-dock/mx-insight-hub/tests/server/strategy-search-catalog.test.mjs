import assert from 'node:assert/strict'
import test from 'node:test'
import { strategySearchCatalog } from '../../server/data/strategy-search-catalog.mjs'
import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../../server/contracts/night-all-legacy.mjs'
import { canRouteRawSearch } from '../../server/contracts/raw-search.mjs'
import { canRouteDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { normalizeHubSocialRequest } from '../../server/contracts/hub-social.mjs'
import { assertWechatSearchNotRetired } from '../../server/contracts/wechat-search-alias.mjs'

const interfaceById = (catalog, id) => catalog.interfaces.find(row => row.id === id)
const platformById = (catalog, id, platform) => interfaceById(catalog, id).platforms.find(row => row.platform === platform)

test('strategy catalog separates supported operation sets and exposes only the two implemented policy editors', () => {
  const catalog = strategySearchCatalog()
  for (const id of ['crawl', 'user-info']) {
    const group = interfaceById(catalog, id)
    assert.deepEqual(group.platforms.map(row => row.platform), NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS[id])
    assert(group.paths.includes(`/api/v1/night-all/search/${id}`))
    assert.equal(group.platforms.some(row => row.platform === 'telegram'), false)
  }
  assert.equal(platformById(catalog, 'search', 'linkedin'), undefined)
  assert.equal(platformById(catalog, 'user-info', 'reddit'), undefined)
  const editable = catalog.interfaces.flatMap(group => group.platforms.filter(row => row.editable).map(row => `${group.id}:${row.platform}`))
  assert.deepEqual(editable.sort(), ['search:facebook', 'search:instagram'])
  for (const row of catalog.interfaces.flatMap(group => group.platforms)) {
    assert(row.label && row.routeSummary)
    if (!row.editable) assert(row.readOnlyReason)
    assert.equal('ready' in row, false, 'a static catalog cannot promise credential/runtime readiness')
  }
})

test('policy rows preserve provider-specific saved shape without mutating it or inventing a policy', () => {
  const instagramPolicy = { mode: 'priority', primaryProvider: 'justone', fallbackProvider: 'tikhub', revision: 3 }
  const facebookPolicy = { mode: 'auto', monthly_limit: 1000, billing_day: 27, next_recovery_check_at: '2026-10-27T00:00:00Z', revision: 4 }
  const catalog = strategySearchCatalog({ instagramPolicy, facebookPolicy })
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
})

test('Twitter catalog acknowledges the actual split between migrated standard search and complex raw/account compatibility', () => {
  const catalog = strategySearchCatalog()
  assert.equal(canRouteDataSearch({ platform: 'twitter', pageSize: 100 }), true)
  assert.equal(canRouteRawSearch({ platform: 'twitter', pageSize: 20, upstreamBody: { platform: 'twitter', keyword: 'example' } }), true)
  assert.equal(canRouteRawSearch({ platform: 'twitter', pageSize: 100, upstreamBody: { platform: 'twitter', keyword: 'example' } }), false)
  for (const id of ['search', 'crawl', 'user-info']) {
    const row = platformById(catalog, id, 'twitter')
    assert.equal(row.migrationStatus, 'conditional')
    assert.deepEqual(row.providers, ['rapidapi'])
    assert.match(row.routeSummary, /Night-All/)
  }
  assert.throws(() => normalizeHubSocialRequest('crawl', { platform: 'instagram', username: 'example' }), error => error.code === 'social_platform_not_implemented')
  assert.equal(platformById(catalog, 'crawl', 'instagram').migrationStatus, 'night_all')
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
