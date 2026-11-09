import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SMOKE_CASES, standardEngines, validateSmokeCases } from '../../scripts/collect-acceptance.mjs'
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
