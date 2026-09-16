import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import {
  CHAPTERS,
  QUESTS,
  SIGNALS,
  SYSTEM_VERSION,
  evaluateSystem,
  isNewer,
  levelFor,
  systemFacts
} from '../apps/server/system.mjs'
import { SystemProgress } from '../apps/server/system-progress.mjs'

const EMPTY = systemFacts({})

async function fixture(t, { root, env = {} } = {}) {
  const state = root ?? (await mkdtemp(join(tmpdir(), 'mx-rig-system-')))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'test-only-rig-secret',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: state,
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts'),
      ...env
    },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const api = async (path, body, headers = { authorization: 'Bearer test-only-rig-secret' }) => {
    const response = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  return { runtime, api, state }
}

test('an untouched deployment has every quest open and nothing claimed', () => {
  const state = evaluateSystem({ facts: EMPTY })
  assert.equal(state.version, SYSTEM_VERSION)
  assert.equal(state.quests.length, QUESTS.length)
  assert.ok(state.quests.every((quest) => quest.status === 'open'))
  assert.equal(state.level.level, 1)
  assert.equal(state.level.xp, 0)
  assert.deepEqual(state.claimable, [])
  // The first thing to do is the first main-line quest, not a side quest.
  assert.equal(state.next, QUESTS[0].id)
  assert.equal(state.chapters.length, CHAPTERS.length)
  // Every quest explains itself: a detail line that says what state is missing.
  assert.ok(state.quests.every((quest) => quest.detail.length > 0))
})

test('quests are verified against platform state, and say where the state came from', () => {
  const facts = systemFacts({
    apps: [{ id: 'app_1', slug: 'compass' }],
    tasks: [{ id: 'tsk_1' }],
    runners: [
      { id: 'r1', online: true },
      { id: 'r2', online: false }
    ],
    runs: [{ status: 'passed' }, { status: 'blocked' }],
    missions: [
      {
        mode: 'workflow',
        testRunId: 'trun_1',
        status: 'completed',
        events: [{ kind: 'approved' }, { kind: 'tool_start', data: { tool: 'tests_run' } }]
      }
    ],
    config: {},
    signals: {}
  })
  assert.equal(facts.runnersOnline, 1)
  assert.equal(facts.runnersRegistered, 2)
  assert.equal(facts.judgedRuns, 1)
  assert.equal(facts.blockedRuns, 1)
  assert.equal(facts.dispatchedMissions, 1)
  assert.equal(facts.approvals, 1)
  assert.equal(facts.browserActions, 0)
  const state = evaluateSystem({ facts })
  const byId = new Map(state.quests.map((quest) => [quest.id, quest]))
  for (const id of [
    'onboard-app',
    'build-plan',
    'runner-online',
    'first-dispatch',
    'first-verdict'
  ])
    assert.equal(byId.get(id).status, 'claimable', id)
  assert.equal(byId.get('onboard-app').evidence, 'platform')
  assert.match(byId.get('runner-online').detail, /在线 1\/2/)
  // A signal-evidence quest cannot be satisfied by platform state alone.
  assert.equal(byId.get('open-run-report').status, 'open')
  assert.equal(byId.get('open-run-report').evidence, 'signal')
  const reported = evaluateSystem({
    facts: systemFacts({ signals: { opened_run_report: '2026-09-16T00:00:00.000Z' } })
  })
  assert.equal(reported.quests.find((quest) => quest.id === 'open-run-report').status, 'claimable')
})

test('only claimed quests move XP, and a claim survives the state regressing', () => {
  const facts = systemFacts({ apps: [{ id: 'a' }], tasks: [{ id: 't' }] })
  const unclaimed = evaluateSystem({ facts })
  assert.equal(unclaimed.level.xp, 0)
  const claimed = evaluateSystem({ facts, progress: { claimed: ['onboard-app'] } })
  const reward = QUESTS.find((quest) => quest.id === 'onboard-app').reward.xp
  assert.equal(claimed.level.xp, reward)
  // The app gets archived; the lesson was still learned.
  const after = evaluateSystem({ facts: EMPTY, progress: { claimed: ['onboard-app'] } })
  assert.equal(after.level.xp, reward)
  assert.equal(after.quests.find((quest) => quest.id === 'onboard-app').status, 'claimed')
  assert.equal(after.quests.find((quest) => quest.id === 'onboard-app').done, false)
})

test('levels are thresholds, and the top band shows a full bar rather than an empty one', () => {
  assert.equal(levelFor(0).level, 1)
  assert.equal(levelFor(0).progress, 0)
  const mid = levelFor(140)
  assert.equal(mid.level, 2)
  assert.ok(mid.nextAt > 140)
  const top = levelFor(100_000)
  assert.equal(top.nextAt, null)
  assert.equal(top.progress, 1)
})

test('a newer catalogue version is announced, an older one is not', () => {
  assert.equal(isNewer('0.7', '0.6'), true)
  assert.equal(isNewer('0.10', '0.6'), true)
  assert.equal(isNewer('0.6', '0.6'), false)
  assert.equal(isNewer('0.6', '0.7'), false)
  // Every shipped quest is new to someone who has never opened the page.
  const cold = evaluateSystem({ facts: EMPTY })
  assert.equal(cold.newQuests.length, QUESTS.length)
  const caught = evaluateSystem({ facts: EMPTY, progress: { seenVersion: SYSTEM_VERSION } })
  assert.deepEqual(caught.newQuests, [])
  // A version bump makes exactly the new quests visible as new.
  const future = [
    ...QUESTS,
    {
      ...QUESTS[0],
      id: 'future-quest',
      since: '0.9',
      verify: () => ({ done: false, detail: '—' })
    }
  ]
  const upgraded = evaluateSystem({
    facts: EMPTY,
    catalogue: future,
    progress: { seenVersion: SYSTEM_VERSION }
  })
  assert.deepEqual(upgraded.newQuests, ['future-quest'])
})

test('the progress store refuses unknown names and writes nothing twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-progress-'))
  const file = join(root, 'system-progress.json')
  const store = await new SystemProgress(file).init()
  await assert.rejects(() => store.signal('someone', 'made_up'), /未知的界面上报/)
  await assert.rejects(() => store.claim('someone', 'made-up-quest', true), /任务不存在/)
  await assert.rejects(() => store.claim('someone', 'onboard-app', false), /还没有完成，无法领取/)
  const first = await store.signal('someone', SIGNALS[0])
  assert.equal(first.changed, true)
  const again = await store.signal('someone', SIGNALS[0])
  assert.equal(again.changed, false)
  assert.equal(first.entry.signals[SIGNALS[0]], again.entry.signals[SIGNALS[0]])
  await store.claim('someone', 'onboard-app', true)
  // Reloaded from disk, not from memory: progress has to outlive a restart.
  const reopened = await new SystemProgress(file).init()
  assert.deepEqual(reopened.get('someone').claimed, ['onboard-app'])
  assert.equal(reopened.get('nobody').claimed.length, 0)
})

test('the system API verifies on the server and never trusts the request', async (t) => {
  const { api, state } = await fixture(t)
  const first = await api('/api/rig/v1/system')
  assert.equal(first.status, 200)
  assert.equal(first.body.system.version, SYSTEM_VERSION)
  assert.equal(first.body.system.level.xp, 0)
  // Claiming something that has not happened is refused, with its own code.
  const early = await api('/api/rig/v1/system/claim', { questId: 'onboard-app' })
  assert.equal(early.status, 409)
  assert.equal(early.body.error.code, 'quest_unverified')
  assert.equal((await api('/api/rig/v1/system/claim', { questId: 'nope' })).status, 404)

  assert.equal(
    (
      await api('/api/v1/apps', {
        slug: 'rig-system',
        displayName: 'System tutorial',
        surfaces: ['web']
      })
    ).status,
    201
  )
  const ready = await api('/api/rig/v1/system')
  const quest = ready.body.system.quests.find((entry) => entry.id === 'onboard-app')
  assert.equal(quest.status, 'claimable')
  assert.match(quest.detail, /已有 1 个应用/)
  const claimed = await api('/api/rig/v1/system/claim', { questId: 'onboard-app' })
  assert.equal(claimed.status, 200)
  assert.equal(claimed.body.system.level.xp, quest.reward.xp)
  // Idempotent: a double click is not a double reward.
  const twice = await api('/api/rig/v1/system/claim', { questId: 'onboard-app' })
  assert.equal(twice.body.system.level.xp, quest.reward.xp)

  const signalled = await api('/api/rig/v1/system/signal', { signal: 'opened_tools' })
  assert.equal(signalled.status, 200)
  assert.equal(
    signalled.body.system.quests.find((entry) => entry.id === 'tool-boundary').status,
    'claimable'
  )
  assert.equal((await api('/api/rig/v1/system/signal', { signal: 'nope' })).status, 400)

  const seen = await api('/api/rig/v1/system/seen', { version: SYSTEM_VERSION })
  assert.deepEqual(seen.body.system.newQuests, [])

  // Same state directory, new service: the tutorial remembers.
  const second = await fixture(t, { root: state })
  const reloaded = await second.api('/api/rig/v1/system')
  assert.equal(reloaded.body.system.level.xp, quest.reward.xp)
  assert.equal(reloaded.body.system.seenVersion, SYSTEM_VERSION)
})

test('the tutorial is readable by a viewer and grants no capability', async (t) => {
  const { api, runtime } = await fixture(t)
  const original = runtime.kernel.identity.resolve
  runtime.kernel.identity.resolve = async (token, source) =>
    token === 'viewer-token' ? { id: 'viewer', role: 'viewer' } : original(token, source)
  const viewer = { authorization: 'Bearer viewer-token' }
  assert.equal((await api('/api/rig/v1/system', undefined, viewer)).status, 200)
  assert.equal(
    (await api('/api/rig/v1/system/signal', { signal: 'hud_opened' }, viewer)).status,
    200
  )
  // Progress is progress. Starting work still needs operator, and a level does
  // not change that.
  assert.equal(
    (await api('/api/rig/v1/missions', { mode: 'agent', goal: 'x' }, viewer)).status,
    403
  )
  assert.equal((await api('/api/rig/v1/dispatch:plan', { text: '跑一下' }, viewer)).status, 403)
})
