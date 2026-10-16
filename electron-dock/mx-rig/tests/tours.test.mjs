import test from 'node:test'
import assert from 'node:assert/strict'
import { PG_IMPLEMENTATION, STEP_ACTIONS, TOURS, TOUR_CONTEXTS, TOUR_STATES, availableTours } from '../apps/web/tours.js'
import { QUESTS } from '../apps/server/system.mjs'

// docs/24: tours are data the workbench walks a person through and the desktop
// smoke replays. What makes one safe to offer is checked here: every tour ends
// at a step the person presses, says up front what it creates, and only asks
// the service questions the runner knows how to answer.

const knownState = (name) => TOUR_STATES.some((entry) => (typeof entry === 'string' ? entry === name : entry.test(name)))
// What {{key}} may name: every tour knows when it started; a context adds its own.
const CONTEXT_KEYS = { null: ['stamp'], 'proving-ground': ['stamp', 'directory', 'origin'] }
const templateKeys = (text) => [...String(text).matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1])

function checkCondition(condition, where, keys) {
  const templated = (text) => templateKeys(text).forEach((key) => assert.ok(keys.includes(key), `${where}: unknown {{${key}}}`))
  if (typeof condition === 'string') return assert.ok(condition.trim(), `${where}: empty selector`)
  assert.equal(typeof condition, 'object', `${where}: a selector or an object`)
  if ('state' in condition) return assert.ok(knownState(condition.state), `${where}: unknown state ${condition.state}`)
  if ('fields' in condition) return
  assert.ok(condition.selector, `${where}: needs a selector`)
  const checks = ['value', 'valueIncludes', 'filled', 'text', 'notText'].filter((key) => key in condition)
  assert.ok(checks.length <= 1, `${where}: one of value, valueIncludes, filled, text, notText`)
  for (const key of checks) if (typeof condition[key] === 'string') templated(condition[key])
}

test('every tour is well formed and ends where the real flow begins', () => {
  assert.equal(new Set(TOURS.map((tour) => tour.id)).size, TOURS.length, 'tour ids are unique')
  for (const tour of TOURS) {
    assert.ok(tour.title && tour.summary && tour.finish, `${tour.id}: title, summary and finish`)
    assert.ok(['viewer', 'operator', 'admin'].includes(tour.role), `${tour.id}: role`)
    assert.ok(Array.isArray(tour.creates), `${tour.id}: creates is a list`)
    const ids = tour.steps.map((step) => step.id)
    assert.equal(new Set(ids).size, ids.length, `${tour.id}: step ids are unique`)
    if (tour.context) assert.ok(TOUR_CONTEXTS.includes(tour.context), `${tour.id}: context ${tour.context}`)
    const keys = CONTEXT_KEYS[tour.context ?? null]
    for (const step of tour.steps) {
      const where = `${tour.id}/${step.id}`
      assert.ok(STEP_ACTIONS.includes(step.action), `${where}: action ${step.action}`)
      assert.ok(step.say?.length > 4, `${where}: says something`)
      assert.ok(typeof step.target === 'string' && step.target.trim(), `${where}: target`)
      if (step.action === 'select') assert.ok(typeof step.value === 'string', `${where}: select needs a value`)
      if (step.action === 'pick') assert.ok(step.until, `${where}: a system dialog is only answered when until says so`)
      if (step.action === 'fill') {
        assert.ok(Array.isArray(step.fields) && step.fields.length, `${where}: fill needs fields`)
        for (const field of step.fields) {
          assert.ok(field.selector && typeof field.value === 'string', `${where}: a field is a selector and a value`)
          for (const key of templateKeys(field.value)) assert.ok(keys.includes(key), `${where}: unknown {{${key}}}`)
        }
      } else assert.equal(step.fields, undefined, `${where}: only fill has fields`)
      if (step.until) checkCondition(step.until, `${where} until`, keys)
      if (step.skipIf) {
        assert.ok('state' in step.skipIf || 'absent' in step.skipIf, `${where}: skipIf is state or absent`)
        if (step.skipIf.state) assert.ok(knownState(step.skipIf.state), `${where}: unknown state`)
      }
    }
    // The person presses the last step; nothing before it is the real flow.
    const finals = tour.steps.filter((step) => step.action === 'final')
    assert.equal(finals.length, 1, `${tour.id}: exactly one final step`)
    assert.equal(tour.steps.at(-1).action, 'final', `${tour.id}: the final step is last`)
    // Writing tours say so before they start; read-only ones write nothing.
    const writes = tour.steps.some((step) => step.writes)
    assert.equal(writes, tour.creates.length > 0, `${tour.id}: creates matches the steps that write`)
    if (writes) assert.notEqual(tour.role, 'viewer', `${tour.id}: a viewer cannot take a tour that writes`)
  }
})

test('the Compass tour builds only what is missing and never runs the smoke itself', () => {
  const tour = TOURS.find((entry) => entry.id === 'compass-web-smoke')
  assert.equal(tour.native, true)
  const building = tour.steps.filter((step) => ['pack', 'directory', 'commit', 'build'].includes(step.id))
  assert.ok(building.every((step) => step.skipIf?.state === 'workspace:luopan'), 'an existing workspace is reused')
  assert.equal(tour.steps.find((step) => step.id === 'directory').action, 'pick', 'the person answers the system dialog')
  const final = tour.steps.at(-1)
  assert.match(final.target, /data-plan-name="罗盘 Web · 主路径冒烟"/)
  assert.ok(!tour.steps.some((step) => step.action !== 'final' && /data-plan-run-now|data-plan-name/.test(step.target)), 'nothing before the final step presses 立即执行')
})

test('tours are offered by end and role', () => {
  const blocked = (options) => Object.fromEntries(availableTours(options).map(({ tour, blocked: why }) => [tour.id, why]))
  assert.deepEqual(blocked({ native: true, role: 'admin' }), { 'compass-web-smoke': null, 'new-project': null, 'read-a-run': null })
  assert.match(blocked({ native: false, role: 'admin' })['new-project'], /桌面端/)
  assert.match(blocked({ native: false, role: 'admin' })['compass-web-smoke'], /桌面端/)
  assert.match(blocked({ native: true, role: 'operator' })['compass-web-smoke'], /管理员/)
  assert.equal(blocked({ native: false, role: 'viewer' })['read-a-run'], null)
})

test('新项目 walks the real path on the proving ground and stops before the run', () => {
  const tour = TOURS.find((entry) => entry.id === 'new-project')
  assert.equal(tour.context, 'proving-ground')
  const step = (id) => tour.steps.find((entry) => entry.id === id)
  // An existing proving-ground project is reused, not registered twice.
  for (const id of ['form', 'register', 'save']) assert.equal(step(id).skipIf?.state, 'app:proving-ground', id)
  assert.equal(step('register').fields.find((field) => field.selector === '#project-source').value, '{{directory}}')
  // The case a person writes is the case the implementation maps.
  const caseId = step('case').fields.find((field) => field.selector === '#case-caseId').value
  const proposal = JSON.parse(PG_IMPLEMENTATION)
  assert.deepEqual(proposal.mappings.map((entry) => entry.caseId), [caseId])
  assert.ok(proposal.files.every((file) => file.content.includes(caseId)), 'a test names the case it proves')
  assert.deepEqual([proposal.engine, proposal.platform], ['playwright', 'web'])
  assert.equal(step('code').fields[0].value, PG_IMPLEMENTATION)
  // One task per walk-through, told apart by when the tour started.
  assert.match(step('goal').fields[0].value, /\{\{stamp\}\}/)
  assert.equal(step('create').until.text, step('goal').fields[0].value)
  assert.equal(tour.steps.at(-1).target, '#repository-run')
  assert.equal(tour.steps.at(-1).action, 'final')
})

test('every quest that offers a tour names one that exists', () => {
  const ids = new Set(TOURS.map((tour) => tour.id))
  const linked = QUESTS.filter((quest) => quest.tour)
  assert.ok(linked.length >= 5)
  for (const quest of linked) {
    assert.ok(Array.isArray(quest.tour) && quest.tour.length, `${quest.id}: tour is a list`)
    for (const id of quest.tour) assert.ok(ids.has(id), `${quest.id}: no tour ${id}`)
  }
})
