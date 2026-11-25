import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SMOKE_CASES, hasListing, selectSmokeCases, standardEngines, validateSmokeCases } from '../../scripts/collect-acceptance.mjs'
import { COLLECT_CAPABILITIES, COLLECT_RUNNER_SLOTS } from '../../shared/collect-engines.mjs'
import { capabilityDefinition } from '../../server/collect/catalog.mjs'

// The deployment acceptance script derives its engine set and smoke cases
// from the catalog; these checks keep the three in step.
test('standard engines cover every capability route exactly once, each on a kind that serves it', () => {
  const engines = standardEngines()
  const seen = new Map()
  for (const engine of engines) {
    for (const route of engine.routes) {
      const key = `${route.capability}:${route.routeKey}`
      assert.ok(!seen.has(key), `${key} bound twice (${seen.get(key)} and ${engine.id})`)
      seen.set(key, engine.id)
      assert.ok(capabilityDefinition(route.capability).kinds.includes(engine.kind), `${key} on ${engine.kind}`)
    }
  }
  const expected = COLLECT_CAPABILITIES.flatMap(capability => (capability.routeBy ? capability.routes.map(route => `${capability.key}:${route.key}`) : [`${capability.key}:`]))
  assert.deepEqual([...seen.keys()].sort(), expected.sort())
  assert.deepEqual(engines.filter(engine => engine.kind === 'runner').map(engine => engine.slotRef).sort(), Object.keys(COLLECT_RUNNER_SLOTS).sort())
  assert.ok(engines.every(engine => /^[a-z0-9][a-z0-9.-]{2,63}$/.test(engine.id)))
  assert.ok(engines.filter(engine => engine.kind === 'runner').every(engine => engine.routes.length > 0 && engine.credentialProvider === 'collect-runner'))
})

test('smoke cases pass API validation; every route has one; paid ones are marked', () => {
  const normalized = validateSmokeCases()
  assert.equal(normalized.length, SMOKE_CASES.length)
  const covered = new Set(normalized.map(({ definition, item }) => `${definition.key}:${item.routeKey}`))
  const free = COLLECT_CAPABILITIES.filter(capability => !capability.kinds.includes('apify') && !capability.kinds.includes('shodan'))
  for (const capability of free) {
    for (const routeKey of capability.routeBy ? capability.routes.map(route => route.key) : ['']) assert.ok(covered.has(`${capability.key}:${routeKey}`), `no smoke case for ${capability.key}:${routeKey}`)
  }
  for (const item of SMOKE_CASES) {
    const kinds = capabilityDefinition(item.capability).kinds
    assert.equal(Boolean(item.paid), kinds.includes('apify') || kinds.includes('shodan'), item.capability)
  }
})

test('Facebook Marketplace and Craigslist smoke checks require a matching selection and paid opt-in', () => {
  const only = 'collect.ecommerce.fbmarketplace.search, classifieds.craigslist, '
  const cases = selectSmokeCases({ only, 'include-paid': true })
  assert.deepEqual(cases.map(item => [item.capability, item.input.maxItems]), [
    ['collect.ecommerce.fbmarketplace.search', 1],
    ['collect.classifieds.craigslist.search', 1],
  ])
  for (const options of [{}, { 'include-paid': true }]) {
    assert.ok(selectSmokeCases(options).every(item => !cases.includes(item)))
  }
  for (const options of [{ only }, { only: 'bad-prefix', 'include-paid': true }, { only: ', ' },
    { only: 'collect.ecommerce.shopify.search,collect.classifieds.typo', 'include-paid': true }]) {
    assert.throws(() => selectSmokeCases(options), /no smoke cases selected/)
  }
})

test('a positive marketplace smoke case needs an actual product in the delivered payload', () => {
  const result = (item, dataStatus = 'success') => ({ dataStatus, payload: { items: item ? [item] : [] } })
  assert.ok(hasListing(result({ id: '1', marketplace_listing_title: 'Guitar' }), 'marketplace_listing_title'))
  assert.ok(hasListing(result({ id: 2, title: 'Bicycle' }), 'title'))
  for (const invalid of [null, result(null, 'no_data'), result({ id: '', title: 'Bicycle' }),
    result({ id: 2, title: ' ' }), result({ id: 2, title: 'Bicycle' }, 'partial')]) {
    assert.equal(hasListing(invalid, 'title'), false)
  }
})
