// The key-health rule is what the API Keys page shows instead of making an
// operator guess why a call was rejected. It is plain logic, so it is tested
// directly rather than through the React tree.

import assert from 'node:assert/strict'
import test from 'node:test'
import { apiKeyHealth, consumerHealth } from '../../src/key-health.js'

const activeKey = (overrides = {}) => ({
  status: 'active',
  effectiveStatus: 'active',
  expiresAt: new Date(Date.now() + 180 * 86_400_000).toISOString(),
  ...overrides,
})

test('a healthy key reports no issues', () => {
  const health = apiKeyHealth(activeKey(), { quota: [], blockedOperations: [] })
  assert.equal(health.level, 'healthy')
  assert.deepEqual(health.issues, [])
})

test('an expired key is blocked and names rotation as the fix', () => {
  const health = apiKeyHealth(activeKey({ effectiveStatus: 'expired' }), null)
  assert.equal(health.level, 'blocked')
  assert.equal(health.issues[0].text, 'Key 已过期')
  assert.match(health.issues[0].action, /轮换/u)
})

test('an imminent expiry warns before the key stops working', () => {
  const health = apiKeyHealth(
    activeKey({ expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }),
    null,
  )
  assert.equal(health.level, 'warn')
  assert.equal(health.issues[0].text, '3 天后过期')
})

test('a spent window blocks, and points at the layer that actually binds', () => {
  const health = apiKeyHealth(activeKey(), {
    quota: [{
      scope: 'ecommerce',
      binding: { limitScope: 'api_key', limit: 50, remaining: 0 },
    }],
  })
  assert.equal(health.level, 'blocked')
  assert.match(health.issues[0].text, /额度已用完/u)
  assert.match(health.issues[0].action, /这把 Key/u)

  const consumerBound = apiKeyHealth(activeKey(), {
    quota: [{ scope: 'ecommerce', binding: { limitScope: 'consumer', limit: 50, remaining: 0 } }],
  })
  // Same symptom, different owner: the action must not send someone to change
  // the key when the consumer ceiling is what rejected the call.
  assert.match(consumerBound.issues[0].action, /调用者额度/u)
})

test('a nearly spent window warns without claiming the key is blocked', () => {
  const health = apiKeyHealth(activeKey(), {
    quota: [{ scope: 'ecommerce', binding: { limitScope: 'consumer', limit: 100, remaining: 5 } }],
  })
  assert.equal(health.level, 'warn')
  assert.match(health.issues[0].text, /剩余 5\/100/u)
})

test('a blocked operation is reported as an operator action, not a key fault', () => {
  const health = apiKeyHealth(activeKey(), {
    blockedOperations: [{ operation: 'ecommerce.products.search', effectiveState: 'blocked' }],
  })
  assert.equal(health.level, 'blocked')
  assert.match(health.issues[0].action, /管理员/u)
})

test('an unlabelled operation still reads as itself', () => {
  const health = apiKeyHealth(activeKey(), {
    blockedOperations: [{ operation: 'ecommerce.products.search', effectiveState: 'paused' }],
  })
  assert.match(health.issues[0].text, /ecommerce\.products\.search/u)
  // A paused operation is a deliberate state, so the action reports it rather
  // than sending someone to debug upstream preconditions that are all fine.
  assert.match(health.issues[0].action, /paused/u)
})

test('each cause is reported separately, because each has a different fix', () => {
  const health = apiKeyHealth(
    activeKey({ expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }),
    {
      quota: [{ scope: 'ecommerce', binding: { limitScope: 'consumer', limit: 50, remaining: 0 } }],
      blockedOperations: [{ operation: 'social.accounts.search', effectiveState: 'blocked' }],
    },
  )
  assert.equal(health.issues.length, 3)
  assert.equal(health.level, 'blocked')
})

// The list renders this rule with no overview while the drawer renders it with
// one. If the reduced evidence ever produced a *different* verdict about the
// key itself, the two views would contradict each other on screen.
test('the list view never contradicts the drawer on what both can see', () => {
  for (const key of [
    activeKey(),
    activeKey({ effectiveStatus: 'expired' }),
    activeKey({ effectiveStatus: 'revoked' }),
    activeKey({ expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }),
  ]) {
    const listView = apiKeyHealth(key, null)
    const drawerView = apiKeyHealth(key, { quota: [], blockedOperations: [] })
    assert.deepEqual(listView, drawerView)
  }
})

test('the drawer may escalate a key the list called healthy', () => {
  const key = activeKey()
  assert.equal(apiKeyHealth(key, null).level, 'healthy')
  // Not a contradiction: the list simply cannot see quota, which is why the
  // list chip is a nudge and the drawer is the verdict.
  assert.equal(
    apiKeyHealth(key, {
      quota: [{ scope: 'ecommerce', binding: { limitScope: 'consumer', limit: 50, remaining: 0 } }],
    }).level,
    'blocked',
  )
})

// ---- the shared (consumer-wide) layer ----

test('a healthy consumer reports nothing', () => {
  const health = consumerHealth({
    quota: [{ scope: 'ecommerce', limit: 100, used: 1, remaining: 99, windowSeconds: 60 }],
    blockedOperations: [],
    keys: { total: 3, active: 3, expiringSoon: 0, unusable: 0 },
  })
  assert.equal(health.level, 'healthy')
  assert.deepEqual(health.issues, [])
})

test('a spent shared window says explicitly that another key will not help', () => {
  const health = consumerHealth({
    quota: [{ scope: 'ecommerce', limit: 50, used: 50, remaining: 0, windowSeconds: 60 }],
    keys: { total: 2, active: 2, expiringSoon: 0, unusable: 0 },
  })
  assert.equal(health.level, 'blocked')
  assert.match(health.issues[0].text, /共享额度已用完/u)
  assert.match(health.issues[0].action, /提高该调用者额度/u)
})

test('a blocked operation is reported once for the consumer, not once per key', () => {
  const health = consumerHealth({
    blockedOperations: [{ operation: 'ecommerce.products.search', effectiveState: 'blocked' }],
    keys: { total: 7, active: 7, expiringSoon: 0, unusable: 0 },
  })
  assert.equal(health.issues.length, 1)
  assert.match(health.issues[0].detail, /所有 Key/u)
})

test('keys nearing expiry are surfaced as a rollup', () => {
  const health = consumerHealth({ keys: { total: 5, active: 5, expiringSoon: 2, unusable: 0 } })
  assert.equal(health.level, 'warn')
  assert.match(health.issues[0].text, /2 把 Key 即将过期/u)
})

test('missing evidence produces no issues rather than invented ones', () => {
  // The page renders an explicit "could not read" state for this case; the
  // rule must not quietly report a healthy consumer from an empty payload.
  assert.deepEqual(consumerHealth(null).issues, [])
  assert.deepEqual(consumerHealth({}).issues, [])
})

// A scope appears twice in the same card: once in the issue line and once in
// the quota meter beside it. If the rule named it differently from the page,
// one card would call the same limit both "xiaohongshu" and "小红书".
test('scopes are named by the caller, not by the rule', () => {
  const scopeLabel = (entry) => (entry.scope === 'xiaohongshu' ? '小红书' : entry.scope)

  const shared = consumerHealth({
    quota: [{ scopeType: 'platform', scope: 'xiaohongshu', limit: 50, used: 47, remaining: 3, windowSeconds: 3600 }],
  }, { scopeLabel })
  assert.match(shared.issues[0].text, /^小红书 共享额度剩余 3\/50$/u)

  const perKey = apiKeyHealth(activeKey(), {
    quota: [{
      scopeType: 'platform',
      scope: 'xiaohongshu',
      binding: { limitScope: 'consumer', limit: 50, remaining: 0 },
    }],
  }, { scopeLabel })
  assert.match(perKey.issues[0].text, /^小红书 窗口额度已用完$/u)
})

test('without a resolver a scope still reads as its raw key', () => {
  // The default must stay lossless: a caller that does not know a scope's
  // display name is better off showing the key than showing nothing.
  const health = consumerHealth({
    quota: [{ scopeType: 'platform', scope: 'xiaohongshu', limit: 50, used: 50, remaining: 0, windowSeconds: 60 }],
  })
  assert.match(health.issues[0].text, /^xiaohongshu 共享额度已用完$/u)
})

// A suspended tenant is the one state where every other number on the page is
// simultaneously accurate and beside the point: quota unspent, keys active,
// operations ready -- and not one call can get through.
test('a suspended tenant is reported, and leads', () => {
  const health = consumerHealth({
    tenant: { id: 't1', name: 'T', status: 'suspended' },
    quota: [{ scopeType: 'platform', scope: 'xiaohongshu', limit: 50, used: 0, remaining: 50, windowSeconds: 60 }],
    blockedOperations: [],
    keys: { total: 3, active: 3, expiringSoon: 0, unusable: 0 },
  })
  assert.equal(health.level, 'blocked')
  assert.equal(health.issues[0].text, '租户已停用')
  assert.match(health.issues[0].detail, /全部 Key 都会被拒绝/u)
})

test('an active tenant adds no issue of its own', () => {
  const health = consumerHealth({
    tenant: { id: 't1', name: 'T', status: 'active' },
    quota: [],
    keys: { total: 1, active: 1, expiringSoon: 0, unusable: 0 },
  })
  assert.equal(health.level, 'healthy')
})

// A spent procurement budget is the one blocker that readiness cannot see: the
// operation stays configured, priced, released and "可调用" while every unbilled
// call is refused. It therefore needs its own sentence and its own fix.
test('an exhausted budget is reported as a budget problem, not a readiness one', () => {
  const health = consumerHealth({
    blockedOperations: [{
      operation: 'ecommerce.products.search',
      effectiveState: 'active',
      reason: 'budget_exhausted',
      budget: { budgetMinor: 1000, spentMinor: 1000, remainingMinor: 0, exhausted: true },
    }],
  })
  assert.equal(health.level, 'blocked')
  assert.match(health.issues[0].text, /月度上游预算已用完/u)
  assert.match(health.issues[0].action, /外部数据平台/u)
  // The distinction matters: sending someone to check upstream prerequisites
  // when the prerequisites are all fine wastes the exact time this view saves.
  assert.doesNotMatch(health.issues[0].action, /前置条件/u)
})

test('a not-ready operation keeps its own wording', () => {
  const health = consumerHealth({
    blockedOperations: [{ operation: 'ecommerce.products.search', effectiveState: 'blocked', reason: 'not_ready' }],
  })
  assert.match(health.issues[0].text, /当前不可调用/u)
  assert.match(health.issues[0].action, /前置条件/u)
})

test('a nearly spent budget warns before the first rejection', () => {
  const health = consumerHealth({
    budgetWarnings: [{
      operation: 'ecommerce.products.search',
      budget: { budgetMinor: 1000, spentMinor: 950, remainingMinor: 50, exhausted: false },
    }],
  })
  assert.equal(health.level, 'warn')
  assert.match(health.issues[0].text, /即将用完/u)
})
