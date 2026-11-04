import test from 'node:test'
import assert from 'node:assert/strict'
import { STRATEGY_SEARCH_PATH, STRATEGY_SEARCH_INTERFACES, strategySearchLink,
  instagramStrategyOptions, instagramStrategyUpdate, twitterStrategyOptions, twitterStrategyUpdate, strategyPolicySummary, strategyPolicyEditor } from '../../src/strategy-search-model.js'
import { productCategory } from '../../shared/product-navigation.mjs'
import { productForPath, productForDocs } from '../../shared/product-workbenches.mjs'
import { productAllowed } from '../../shared/product-access.mjs'

const row = { platform: 'instagram', editable: true, providers: ['justone', 'tikhub'], allowedModes: ['fixed', 'priority', 'paused'],
  policy: { mode: 'fixed', primaryProvider: 'justone', fallbackProvider: null, revision: 4 } }
const draft = { mode: 'fixed', primaryProvider: 'justone', reason: '  Reviewed route change  ' }

test('Facebook account editors require an independent saved business policy', () => {
  const account = { platform: 'facebook', editable: true, providers: ['justone'], allowedModes: ['fixed', 'paused'],
    policy: { mode: 'fixed', primaryProvider: 'justone', fallbackProvider: null, revision: 1 } }
  for (const id of ['crawl', 'user-info']) {
    assert.equal(strategyPolicyEditor(id, account), 'facebook-account')
    const paused = strategyPolicySummary(id, { ...account, policy: { ...account.policy, mode: 'paused' } })
    assert.match(paused.title, /暂停/)
    assert.match(paused.description, /已购/)
    for (const invalid of [{ ...account, policy: null }, { ...account, editable: false },
      { ...account, policy: { ...account.policy, primaryProvider: 'rapidapi' } },
      { ...account, policy: { ...account.policy, revision: 0 } }]) assert.equal(strategyPolicyEditor(id, invalid), null)
  }
  assert.equal(strategyPolicyEditor('search', account), null)
})

test('strategy search has its own data-services product and reciprocal documentation', () => {
  assert.equal(productCategory(STRATEGY_SEARCH_PATH).key, 'services')
  assert.equal(productForPath(STRATEGY_SEARCH_PATH).label, '策略搜索')
  assert.equal(productForDocs('/docs/strategy-search').path, STRATEGY_SEARCH_PATH)
  assert.notEqual(productForPath('/data-products/search'), productForPath(STRATEGY_SEARCH_PATH))
  assert.deepEqual(STRATEGY_SEARCH_INTERFACES.map(item => item.id), ['search', 'crawl', 'user-info'])
  assert.ok(STRATEGY_SEARCH_INTERFACES.every(item => item.paths.every(path => /^\/api\/v[12]\//.test(path))))
  assert.ok(STRATEGY_SEARCH_INTERFACES.find(item => item.id === 'search').paths.includes('/api/v2/data/search'))
})

test('strategy search visibility covers account-only platforms without granting unrelated data products', () => {
  assert.equal(productAllowed(STRATEGY_SEARCH_PATH), false)
  for (const platform of ['instagram', 'facebook', 'twitter', 'linkedin', 'wechat_mp', 'wechat_search', 'telegram']) {
    assert.equal(productAllowed(STRATEGY_SEARCH_PATH, [{ platforms: [platform], capabilities: [] }]), true, platform)
  }
  for (const platform of ['ecommerce', 'enterprise', 'ip_risk', 'data_center_saved_records_news', 'unknown']) {
    assert.equal(productAllowed(STRATEGY_SEARCH_PATH, [{ platforms: [platform], capabilities: [] }]), false, platform)
  }
  assert.equal(productAllowed('/data-products/search', [{ platforms: ['linkedin'], capabilities: [] }]), false)
  assert.equal(productAllowed(STRATEGY_SEARCH_PATH, [{ platforms: ['social'], capabilities: ['native.wechat.search.search'] }]), true)
  assert.equal(productAllowed(STRATEGY_SEARCH_PATH, [{ platforms: ['social'], capabilities: [] }]), false)
  assert.equal(productAllowed(STRATEGY_SEARCH_PATH, [{ platforms: ['unknown'], capabilities: ['native.wechat.search.search'] }]), false)
})

test('old platform entry opens the selected business interface and safely encodes its platform', () => {
  const link = strategySearchLink('instagram', 'search')
  assert.equal(link, '#/data-products/strategy-search?view=routing&interface=search&platform=instagram')
  const query = new URLSearchParams(strategySearchLink('instagram&view=interfaces', 'crawl').split('?')[1])
  assert.equal(query.get('platform'), 'instagram&view=interfaces')
  assert.equal(query.get('view'), 'routing')
  assert.equal(query.get('interface'), 'crawl')
})

test('Instagram UI emits revisioned fixed/priority/paused policies with no stale fallback', () => {
  assert.deepEqual(instagramStrategyUpdate(row, draft), { mode: 'fixed', primaryProvider: 'justone', fallbackProvider: null,
    expectedRevision: 4, reason: 'Reviewed route change' })
  for (const primaryProvider of ['justone', 'tikhub']) {
    assert.deepEqual(instagramStrategyUpdate(row, { ...draft, mode: 'priority', primaryProvider }), {
      mode: 'priority', primaryProvider, fallbackProvider: primaryProvider === 'justone' ? 'tikhub' : 'justone', expectedRevision: 4, reason: 'Reviewed route change',
    })
  }
  assert.equal(instagramStrategyUpdate(row, { ...draft, mode: 'paused', fallbackProvider: 'tikhub' }).fallbackProvider, null)
})

test('Instagram UI fails closed when backend editing, provider, mode or revision is absent', () => {
  for (const restricted of [{ ...row, editable: false }, { ...row, platform: 'facebook' }, { ...row, policy: null },
    { ...row, policy: { ...row.policy, revision: null } }, { ...row, policy: { ...row.policy, revision: 0 } }, { ...row, providers: [] }, { ...row, allowedModes: [] }]) {
    assert.throws(() => instagramStrategyUpdate(restricted, draft), /不允许/)
  }
  assert.throws(() => instagramStrategyUpdate(row, { ...draft, primaryProvider: 'rapidapi' }), /不允许/)
  assert.throws(() => instagramStrategyUpdate(row, { ...draft, mode: 'retry_on_400' }), /不允许/)
  assert.deepEqual(instagramStrategyOptions({ ...row, providers: ['justone'] }).modes, ['fixed', 'paused'])
  assert.throws(() => instagramStrategyUpdate({ ...row, providers: ['justone'] }, { ...draft, mode: 'priority' }), /不允许/)
  for (const reason of ['', '  ', 'x'.repeat(1001)]) assert.throws(() => instagramStrategyUpdate(row, { ...draft, reason }), /修改原因/)
})

test('current strategy explains Instagram fixed/priority separately from Facebook quota-first routing', async () => {
  const { strategyPolicySummary } = await import('../../src/strategy-search-model.js')
  const instagram = strategyPolicySummary('search', row)
  assert.equal(instagram.title, '固定 JustOne')
  assert.equal(instagram.editor, 'instagram')
  assert.match(instagram.description, /不自动转到其他供应商/)
  const priority = strategyPolicySummary('search', { ...row, policy: { ...row.policy, mode: 'priority', primaryProvider: 'tikhub', fallbackProvider: 'justone' } })
  assert.equal(priority.title, '优先 TikHub → 保底 JustOne')
  assert.match(priority.description, /尚未派发/)
  const facebook = { platform: 'facebook', editable: true, providers: ['rapidapi', 'justone'], allowedModes: ['auto', 'rapidapi', 'justone', 'paused'], policy: { mode: 'auto', revision: 7 } }
  const auto = strategyPolicySummary('search', facebook)
  assert.equal(auto.title, 'RapidAPI 额度优先 → JustOne 保底')
  assert.equal(auto.editor, 'facebook')
  assert.match(auto.description, /确认 429/)
  assert.equal(strategyPolicySummary('search', { ...facebook, policy: { ...facebook.policy, mode: 'rapidapi' } }).title, '固定 RapidAPI')
  assert.equal(strategyPolicySummary('search', { ...facebook, policy: { ...facebook.policy, mode: 'justone' } }).title, '固定 JustOne')
})

test('unverified pairs and missing policy evidence never expose simulated supplier switches', async () => {
  const { strategyPolicySummary, strategyPolicyEditor } = await import('../../src/strategy-search-model.js')
  assert.equal(strategyPolicyEditor('crawl', row), null)
  assert.equal(strategyPolicySummary('search', { platform: 'twitter', providers: ['rapidapi'], editable: false }).title, '已登记供应商：RapidAPI')
  for (const platform of ['twitter', 'douyin', 'tiktok', 'weibo', 'wechat_search']) {
    const summary = strategyPolicySummary('search', { ...row, platform, editable: false, providers: [platform === 'twitter' ? 'rapidapi' : 'tikhub'] })
    assert.equal(summary.editor, null)
    assert.deepEqual(summary.modes, [])
  }
  assert.equal(strategyPolicySummary('search', { ...row, policy: null }).mode, '策略尚未就绪')
  assert.equal(strategyPolicySummary('search', { platform: 'telegram', migrationStatus: 'local', providers: [] }).title, 'Hub 已收录数据')
  assert.equal(strategyPolicyEditor('search', { platform: 'facebook', editable: true, providers: ['rapidapi', 'justone'], allowedModes: ['auto'], policy: { mode: 'priority', revision: 2 } }), null)
})

const twitterRow = { platform: 'twitter', editable: true, providers: ['rapidapi', 'tikhub'], allowedModes: ['fixed', 'priority', 'paused'],
  policy: { mode: 'priority', primaryProvider: 'rapidapi', fallbackProvider: 'tikhub', revision: 9 } }

test('Twitter strategies use the saved revision, preserve both priority orders and clear unused fallback', () => {
  assert.deepEqual(twitterStrategyOptions(twitterRow), { providers: ['rapidapi', 'tikhub'], modes: ['fixed', 'priority', 'paused'] })
  for (const primaryProvider of ['rapidapi', 'tikhub']) {
    for (const mode of ['fixed', 'priority', 'paused']) {
      assert.deepEqual(twitterStrategyUpdate(twitterRow, { mode, primaryProvider, reason: '  已核实供应商状态  ', fallbackProvider: 'stale' }), {
        mode, primaryProvider, fallbackProvider: mode === 'priority' ? (primaryProvider === 'rapidapi' ? 'tikhub' : 'rapidapi') : null,
        expectedRevision: 9, reason: '已核实供应商状态',
      })
    }
  }
})

test('Twitter editor requires a valid saved policy and does not invent provider choices', () => {
  const draft = { mode: 'priority', primaryProvider: 'rapidapi', reason: 'Reviewed' }
  for (const invalid of [{ ...twitterRow, editable: false }, { ...twitterRow, platform: 'instagram' },
    { ...twitterRow, policy: null }, { ...twitterRow, policy: { ...twitterRow.policy, revision: 0 } },
    { ...twitterRow, providers: ['rapidapi'] }, { ...twitterRow, allowedModes: [] }]) {
    assert.throws(() => twitterStrategyUpdate(invalid, draft), /不允许/)
  }
  for (const invalidDraft of [{ ...draft, mode: 'retry_on_400' }, { ...draft, primaryProvider: 'justone' }]) {
    assert.throws(() => twitterStrategyUpdate(twitterRow, invalidDraft), /不允许/)
  }
  for (const reason of ['', '  ', 'x'.repeat(1001)]) assert.throws(() => twitterStrategyUpdate(twitterRow, { ...draft, reason }), /修改原因/)
  assert.equal(strategyPolicyEditor('search', twitterRow), 'twitter')
  assert.equal(strategyPolicyEditor('search', { ...twitterRow, policy: { ...twitterRow.policy, fallbackProvider: 'rapidapi' } }), null)
  assert.equal(strategyPolicyEditor('search', { ...twitterRow, policy: { ...twitterRow.policy, mode: 'automatic_retry' } }), null)
})

test('Twitter management distinguishes standard-search choices, purchased buffers and read-only account routes', () => {
  const summary = strategyPolicySummary('search', twitterRow)
  assert.equal(summary.title, '优先 RapidAPI → 保底 TikHub')
  assert.match(summary.description, /凭据或操作策略未就绪/)
  assert.match(summary.description, /无游标.*尚未取得成功源页.*RapidAPI 明确返回 HTTP 400.*原条件转 TikHub 一次/)
  assert.match(summary.description, /超时、未知结果、成功响应不可用及其他错误不会触发自动切换/)
  const reverse = strategyPolicySummary('search', { ...twitterRow, policy: { ...twitterRow.policy, primaryProvider: 'tikhub', fallbackProvider: 'rapidapi' } })
  assert.equal(reverse.title, '优先 TikHub → 保底 RapidAPI')
  assert.match(reverse.description, /TikHub 的400、超时、未知结果及成功响应不可用均不触发自动切换/)
  for (const mode of ['fixed', 'paused']) {
    const current = strategyPolicySummary('search', { ...twitterRow, policy: { ...twitterRow.policy, mode, fallbackProvider: null } })
    assert.equal(current.editor, 'twitter')
    if (mode === 'paused') assert.match(current.description, /已有游标.*已购缓冲数据仍可交付/)
    else { assert.equal(current.title, '固定 RapidAPI'); assert.match(current.description, /不自动转到其他供应商/) }
  }
  for (const interfaceId of ['crawl', 'user-info']) {
    const account = strategyPolicySummary(interfaceId, twitterRow)
    assert.equal(account.editor, null)
    assert.equal(account.title, '仅 RapidAPI')
    assert.match(account.description, /不受标准内容搜索策略控制/)
  }
  assert.doesNotMatch(strategyPolicySummary('search', { ...twitterRow, policy: null }).description, /仅使用 RapidAPI/)
})
