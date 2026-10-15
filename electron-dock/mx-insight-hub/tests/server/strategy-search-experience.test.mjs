import test from 'node:test'
import assert from 'node:assert/strict'
import { strategySearchPlatforms, strategySearchBody, strategyPageInfo, uncertainStrategySearch, safeStrategyUrl } from '../../src/strategy-search-experience-model.js'
import { strategyAccountPlatforms, strategyAccountBody, strategyOperationPath, strategyResultMatches } from '../../src/strategy-search-experience-model.js'

const access = { platforms: ['tiktok', 'social', 'xiaohongshu', 'telegram'], capabilities: ['native.wechat.search.search'] }
const platforms = strategySearchPlatforms(access)

test('strategy platform cards follow effective Key grants and independent operation scopes', () => {
  assert.deepEqual(platforms.map(row => row.platform), ['telegram', 'tiktok', 'wechat_search', 'wechat_mp'])
  assert.equal(strategySearchPlatforms({ platforms: ['wechat_mp'], capabilities: [] }).length, 0)
  assert.equal(strategySearchPlatforms({ platforms: ['social'], capabilities: [] }).length, 0)
  assert.ok(strategySearchPlatforms(null).some(row => row.platform === 'tiktok'))
  assert.ok(!strategySearchPlatforms(null).some(row => row.platform === 'linkedin'))
})

test('visual search sends one fixed platform with an unchanged continuation and no guessed controls', () => {
  const form = { platform: 'tiktok', query: '  关键词  ', pageSize: 20 }
  assert.deepEqual(strategySearchBody(form, platforms), { platform: 'tiktok', query: '关键词', pageSize: 20, type: 'stable' })
  assert.deepEqual(strategySearchBody(form, platforms, 'opaque-value'), { platform: 'tiktok', query: '关键词', pageSize: 20, type: 'stable', cursor: 'opaque-value' })
  for (const draft of [{ ...form, platform: 'all' }, { ...form, platform: 'xiaohongshu' }, { ...form, query: '' }, { ...form, query: 'x'.repeat(501) }, { ...form, pageSize: 0 }, { ...form, pageSize: 1.5 }]) assert.throws(() => strategySearchBody(draft, platforms))
})

test('WeChat uses documented items mode and native continuation without categories-as-hits', () => {
  assert.deepEqual(strategySearchBody({ platform: 'wechat_mp', query: '能源', pageSize: 20 }, platforms), {
    platform: 'wechat_mp', query: '能源', pageSize: 20, type: 'stable', params: { raw: false },
  })
  assert.throws(() => strategySearchBody({ platform: 'wechat_mp', query: '能源', pageSize: 10 }, platforms))
  assert.equal(strategyPageInfo({ endpoint: 'wechat.search.search', data: { continue_flag: 1, cursor: 'cursor' } }).hasMore, true)
  assert.equal(strategyPageInfo({ endpoint: 'wechat.search.search', data: { categories: [{ name: 'article' }], continue_flag: 1 } }).hasMore, false)
  assert.equal(strategyPageInfo({ endpoint: 'wechat.search.search', data: { continue_flag: 1, no_more: true, cursor: 'cursor' } }).hasMore, false)
  const pageInfo = { hasMore: true, nextCursor: 'opaque' }
  assert.equal(strategyPageInfo({ data: { pageInfo } }), pageInfo)
})

test('unknown transport and pending outcomes stay blocked instead of purchasing through retry expiration', () => {
  for (const error of [new Error('network'), { code: 'request_in_progress', responseBody: {} }, { code: 'external_platform_outcome_unknown', responseBody: {} }]) assert.equal(uncertainStrategySearch(error), true)
  assert.equal(uncertainStrategySearch({ code: 'platform_not_granted', responseBody: { error: {} } }), false)
  assert.equal(uncertainStrategySearch({ code: 'external_platform_rejected', responseBody: { error: {} } }), false)
})

test('result links accept only credential-free HTTP(S) sources', () => {
  assert.equal(safeStrategyUrl('https://example.test/post?id=1'), 'https://example.test/post?id=1')
  for (const value of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'https://user:pass@example.test', '/relative']) assert.equal(safeStrategyUrl(value), null)
})

test('Facebook photo landing detection requires the known host and exact HTML endpoint', async () => {
  const { isFacebookPhotoPage } = await import('../../src/strategy-search-experience-model.js')
  for (const url of ['https://facebook.com/photo.php?fbid=1', 'https://m.facebook.com/photo.php?fbid=1']) assert.equal(isFacebookPhotoPage(url), true)
  for (const url of ['https://facebook.com.evil.test/photo.php', 'https://facebook.com/photo.jpg',
    'https://user:pass@facebook.com/photo.php', 'javascript:alert(1)', null]) assert.equal(isFacebookPhotoPage(url), false)
})

test('debugger and product share a durable identity cell through navigation and credential renewal', async () => {
  const { createStrategySearchCell, recordStrategyAttempt, strategyRequestFingerprint } = await import('../../src/strategy-search-experience-model.js')
  const session = new Map(), identity = 'original-key-id'
  session.set(identity, createStrategySearchCell('tiktok'))
  const cell = session.get(identity), input = { method: 'POST', path: '/api/v1/data/search', body: { platform: 'tiktok', query: '能源', pageSize: 20 } }
  let revisions = 0
  const unsubscribe = cell.subscribe(() => revisions++)
  recordStrategyAttempt(cell, { input, idempotencyKey: 'original-intent', state: 'sending' })
  assert.equal(session.get(identity).getSnapshot().busy, true)
  recordStrategyAttempt(session.get(identity), { input, idempotencyKey: 'original-intent', state: 'failed', error: new Error('network failed') })
  const attempt = cell.getSnapshot().attempts.get(strategyRequestFingerprint(input))
  assert.equal(attempt.state, 'uncertain')
  assert.equal(attempt.idempotencyKey, 'original-intent')
  assert.equal(cell.getSnapshot().busy, false)
  assert.equal(revisions, 2)
  // A remounted view reads the original lock from the App-owned map.
  assert.equal(session.get(identity).getSnapshot().attempts.values().next().value.state, 'uncertain')
  recordStrategyAttempt(cell, { input, idempotencyKey: 'original-intent', state: 'received', requestId: 'recorded-request' })
  assert.equal(attempt.state, 'received')
  assert.equal(attempt.requestId, 'recorded-request')
  unsubscribe()
})

test('read-only resolution requires original request identity and the correct persisted WeChat scope', async () => {
  const { strategyOutcomeMatches } = await import('../../src/strategy-search-experience-model.js')
  const wechat = { body: { platform: 'wechat_mp' }, requestId: 'original' }
  const received = { id: 'original', status: 'committed', platform: 'social', capability: 'native.wechat.search.search' }
  assert.equal(strategyOutcomeMatches(wechat, received), true)
  assert.equal(strategyOutcomeMatches(wechat, { ...received, capability: 'native.wechat.mp.article_detail' }), false)
  assert.equal(strategyOutcomeMatches(wechat, { ...received, platform: 'wechat_mp' }), false)
  for (const status of ['reserved', 'unknown', 'missing']) assert.equal(strategyOutcomeMatches(wechat, { ...received, status }), false)
  assert.equal(strategyOutcomeMatches(wechat, { ...received, id: 'other' }), false)
  assert.equal(strategyOutcomeMatches({ body: { platform: 'tiktok' } }, { id: 'original', status: 'released', platform: 'tiktok' }), true)
  assert.equal(strategyOutcomeMatches({ body: { platform: 'tiktok' } }, { ...received, platform: 'instagram' }), false)
})

test('debugger attempt storage survives view remount and explicit new-request removal uses that same Map', async () => {
  const { createStrategySearchCell } = await import('../../src/strategy-search-experience-model.js')
  const session = new Map([['key', createStrategySearchCell('tiktok')]])
  const beforeNavigation = session.get('key').getSnapshot().consoleAttempts
  const fingerprint = JSON.stringify(['key', { method: 'POST', path: '/api/v1/data/search', body: { platform: 'tiktok', query: '能源' } }])
  beforeNavigation.set(fingerprint, { key: 'original-idempotency-key' })
  session.get('key').update({ busy: false })
  const afterNavigation = session.get('key').getSnapshot().consoleAttempts
  assert.equal(afterNavigation, beforeNavigation)
  assert.equal(afterNavigation.get(fingerprint).key, 'original-idempotency-key')
  afterNavigation.delete(fingerprint)
  assert.equal(beforeNavigation.has(fingerprint), false)
})

test('failed search ledger identity comes from explicit details rather than the HTTP correlation ID', async () => {
  const { strategyFailureRequestId } = await import('../../src/strategy-search-experience-model.js')
  assert.equal(strategyFailureRequestId({ requestId: 'http-only' }), null)
  assert.equal(strategyFailureRequestId({ requestId: 'http-only', details: { requestId: 'ledger' } }), 'ledger')
  assert.equal(strategyFailureRequestId({ responseBody: { error: { details: { requestId: 'ledger-body' } } } }), 'ledger-body')
  assert.equal(strategyFailureRequestId({ details: { requestId: { unexpected: true } } }), null)
})

test('account composer uses explicit operation grants, legacy identity aliases and large logical page caps', () => {
  const access = { platforms: ['twitter', 'linkedin'], capabilities: ['social.content.crawl'] }
  const platforms = strategyAccountPlatforms(access, 'crawl')
  assert.deepEqual(platforms.map(row => row.platform), ['twitter', 'linkedin'])
  assert.equal(strategyAccountPlatforms(access, 'user-info').length, 0)
  const body = strategyAccountBody('crawl', { platform: 'twitter', accountField: 'user_id', account: ' ui_batch_019 ', pageSize: 500 }, platforms, 'opaque-cursor')
  assert.deepEqual(body, { platform: 'twitter', user_id: 'ui_batch_019', pageSize: 500, cursor: 'opaque-cursor' })
  assert.equal(strategyOperationPath('crawl'), '/api/v1/data/social/crawl')
  assert.equal(strategyOperationPath('user-info'), '/api/v1/data/social/user-info')
  assert.throws(() => strategyAccountBody('crawl', { platform: 'twitter', account: 'example', pageSize: 501 }, platforms))
  assert.throws(() => strategyAccountBody('crawl', { platform: 'instagram', account: 'example', pageSize: 20 }, platforms))
  const profiles = strategyAccountPlatforms({ ...access, capabilities: ['social.profile.get'] }, 'user-info')
  assert.deepEqual(strategyAccountBody('user-info', { platform: 'linkedin', account: 'example' }, profiles), { platform: 'linkedin', username: 'example' })
})

test('account continuation belongs to its exact endpoint and account, not merely the platform', () => {
  const input = { method: 'POST', path: strategyOperationPath('crawl'), body: { platform: 'twitter', username: 'example', pageSize: 500 } }
  const result = { identity: 'same-key', input: { ...input, body: { ...input.body, cursor: 'first-cursor' } } }
  assert.equal(strategyResultMatches(result, 'same-key', input), true)
  assert.equal(strategyResultMatches(result, 'same-key', { ...input, path: strategyOperationPath('user-info') }), false)
  assert.equal(strategyResultMatches(result, 'same-key', { ...input, body: { ...input.body, username: 'other' } }), false)
  assert.equal(strategyResultMatches(result, 'different-key', input), false)
  const page = { hasMore: true, nextCursor: 'continue-even-when-empty' }
  assert.equal(strategyPageInfo({ data: { items: [], page } }), page)
})
