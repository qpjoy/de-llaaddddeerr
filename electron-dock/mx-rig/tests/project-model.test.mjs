import test from 'node:test'
import assert from 'node:assert/strict'
import { checklistSteps, planVerification } from '../apps/web/project-model.js'

// docs/21 M6: a plan is scheduled only after it has been verified, and a new
// project sees how far it is from that, judged from its real state.

const plan = { id: 'tsk_a', name: '冒烟', suiteId: 'ste_web', runsOn: 'any-runner', scheduleKind: 'manual' }
const run = (status, at, extra = {}) => ({ id: `trun_${status}_${at}`, taskId: 'tsk_a', status, queuedAt: at, finishedAt: ['queued', 'pending-runner', 'running'].includes(status) ? null : at, ...extra })

test('a plan is verified by its latest finished run, and only when that passed', () => {
  assert.equal(planVerification(plan, []).state, 'unverified')
  assert.equal(planVerification(plan, [run('passed', '2026-10-06T01:00:00Z')]).state, 'verified')
  assert.equal(planVerification(plan, [run('flaky', '2026-10-06T01:00:00Z')]).state, 'verified')
  // A newer failure takes the verification away again.
  assert.equal(planVerification(plan, [run('passed', '2026-10-06T01:00:00Z'), run('failed', '2026-10-06T02:00:00Z')]).state, 'failed')
  assert.equal(planVerification(plan, [run('blocked', '2026-10-06T02:00:00Z')]).state, 'blocked')
  // Cancelled and expired runs say nothing about the plan.
  assert.equal(planVerification(plan, [run('passed', '2026-10-06T01:00:00Z'), run('cancelled', '2026-10-06T02:00:00Z'), run('expired', '2026-10-06T03:00:00Z')]).state, 'verified')
  const active = planVerification(plan, [run('running', '2026-10-06T04:00:00Z')])
  assert.equal(active.state, 'unverified')
  assert.equal(active.active.status, 'running')
  // Another plan's runs do not count.
  assert.equal(planVerification(plan, [run('passed', '2026-10-06T01:00:00Z', { taskId: 'tsk_b' })]).state, 'unverified')
})

const done = (steps) => Object.fromEntries(steps.map((step) => [step.key, step.done]))

test('a brand-new project has every step ahead of it', () => {
  const steps = checklistSteps({})
  assert.deepEqual(done(steps), { suite: false, cases: false, plan: false, machine: false, verify: false, schedule: false })
  assert.deepEqual(steps.filter((step) => step.required).map((step) => step.key), ['suite', 'plan', 'machine', 'verify'])
})

test('the steps follow the project: suite, plan, a machine, a passed run, then a schedule', () => {
  const suites = [{ id: 'ste_web', engine: 'playwright', displayName: 'Web 冒烟' }, { id: 'ste_proc', engine: 'rig-procedure', displayName: '规程回放' }]
  const runner = { id: 'rnr_1', online: true }
  let steps = checklistSteps({ suites, plans: [plan] })
  assert.deepEqual(done(steps), { suite: true, cases: false, plan: true, machine: false, verify: false, schedule: false })
  assert.match(steps.find((step) => step.key === 'machine').detail, /没有能接手的在线执行机/)

  steps = checklistSteps({ suites, plans: [plan], runners: [runner], runs: [run('failed', '2026-10-06T01:00:00Z')] })
  assert.equal(done(steps).machine, true)
  assert.equal(done(steps).verify, false)
  assert.match(steps.find((step) => step.key === 'verify').detail, /没有通过/)

  steps = checklistSteps({
    suites,
    cases: [{ caseId: 'A-B-C-001' }, { caseId: 'LP-FE-X-001', automationState: 'reference' }],
    plans: [{ ...plan, scheduleKind: 'cron', enabled: true }],
    runners: [runner],
    runs: [run('passed', '2026-10-06T01:00:00Z')]
  })
  assert.deepEqual(done(steps), { suite: true, cases: true, plan: true, machine: true, verify: true, schedule: true })
  assert.equal(steps.find((step) => step.key === 'cases').detail, '用例库有 1 条', 'references are not counted')
})

test('a plan pinned to a machine needs that machine; server plans need none', () => {
  const suites = [{ id: 'ste_web', engine: 'playwright', displayName: 'Web' }]
  const pinned = { ...plan, runsOn: 'pinned-runner', runnerId: 'rnr_mine' }
  assert.equal(done(checklistSteps({ suites, plans: [pinned], runners: [{ id: 'rnr_other', online: true }] })).machine, false)
  assert.equal(done(checklistSteps({ suites, plans: [pinned], runners: [{ id: 'rnr_mine', online: true }] })).machine, true)
  assert.equal(done(checklistSteps({ suites, plans: [{ ...plan, runsOn: 'server' }] })).machine, true)
  // Procedure regression plans are not what this list is about.
  assert.equal(done(checklistSteps({ suites: [{ id: 'ste_proc', engine: 'rig-procedure' }], plans: [{ ...plan, suiteId: 'ste_proc' }] })).plan, false)
})

test('a test repository commit is proved by a passed run that tested it', async () => {
  const { commitVerdict } = await import('../apps/web/project-model.js')
  const commit = 'c'.repeat(40)
  const ran = (status, at, ref) => ({ id: `trun_${at}`, status, queuedAt: at, finishedAt: at, sourceRef: ref })
  assert.equal(commitVerdict([], commit).state, 'unverified')
  assert.equal(commitVerdict([ran('passed', '2026-10-06T01:00:00Z', { gitSha: commit })], commit).state, 'verified')
  // A pack run names the source commit and carries the QA commit as its version.
  assert.equal(commitVerdict([ran('passed', '2026-10-06T01:00:00Z', { gitSha: 'a'.repeat(40), version: `QA ${commit.slice(0, 7)}` })], commit).state, 'verified')
  assert.equal(commitVerdict([ran('passed', '2026-10-06T01:00:00Z', { gitSha: commit }), ran('failed', '2026-10-06T02:00:00Z', { gitSha: commit })], commit).state, 'failed')
  assert.equal(commitVerdict([ran('passed', '2026-10-06T01:00:00Z', { gitSha: 'd'.repeat(40) })], commit).state, 'unverified', 'another commit proves nothing')
})
