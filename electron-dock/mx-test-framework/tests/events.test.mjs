import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'
import {
  RUN_EVENT_CAP,
  RunEventBus,
  normalizeRunEvent,
  normalizeRunEvents,
} from '../server/events/run-events.mjs'
import { MemoryStore } from '../server/store/memory.mjs'

// Live progress: docs/25. The run page's whole problem was that a run had two
// visible moments and nothing in between, so what these tests protect is that
// the in-between exists, is bounded, is redacted, and ends.

const ADMIN_TOKEN = 'test-admin-token'
let base
let runtime

const api = async (method, path, { body, token = ADMIN_TOKEN } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

/** Read a whole SSE response — the server closes it once the run is over. */
async function readStream(path, { token = ADMIN_TOKEN, lastEventId = null } = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}),
    },
  })
  const text = await response.text()
  const frames = []
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n')
    const kind = lines.find((line) => line.startsWith('event: '))?.slice(7)
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6)
    const id = lines.find((line) => line.startsWith('id: '))?.slice(4)
    if (kind && data) frames.push({ kind, id: id ? Number(id) : null, data: JSON.parse(data) })
  }
  return { status: response.status, headers: response.headers, frames }
}

before(async () => {
  const config = loadConfig({
    MXT_STORE: 'memory',
    MXT_ADMIN_TOKEN: ADMIN_TOKEN,
    MXT_PORT: '0',
    MXT_ARTIFACTS_DIR: '.runtime/test-artifacts',
  })
  runtime = await start(config, { schedule: false })
  base = `http://127.0.0.1:${runtime.port}`
})

after(async () => {
  await runtime.close()
})

test('an unknown kind is dropped rather than stored', () => {
  assert.equal(normalizeRunEvent({ kind: 'run.hacked', payload: {} }), null)
  assert.equal(normalizeRunEvent(null), null)
  assert.equal(normalizeRunEvent({ kind: 'step' })?.kind, 'step')
  // A bad entry costs its own event, not the batch around it.
  const batch = normalizeRunEvents([{ kind: 'step' }, { kind: 'nope' }, { kind: 'log' }])
  assert.deepEqual(batch.map((event) => event.kind), ['step', 'log'])
})

test('a runner is not trusted: labels and log lines are redacted', () => {
  const step = normalizeRunEvent({
    kind: 'step',
    label: 'login with password=hunter2 at https://user:pw@example.com/x?token=abc',
  })
  assert.ok(!step.payload.label.includes('hunter2'))
  assert.ok(!step.payload.label.includes('token=abc'))

  const log = normalizeRunEvent({ kind: 'log', line: 'Authorization: Bearer sk-live-1234567890' })
  assert.ok(!log.payload.line.includes('sk-live-1234567890'))

  // Newlines would break the timeline's layout, and a step label is one line.
  assert.ok(!normalizeRunEvent({ kind: 'step', label: 'a\nb' }).payload.label.includes('\n'))
})

test('a runner clock that is wildly wrong is ignored, a plausible one is kept', () => {
  const now = new Date('2026-09-02T10:00:00Z')
  const skewed = normalizeRunEvent({ kind: 'log', line: 'x', at: '1999-01-01T00:00:00Z' }, { now })
  assert.equal(skewed.at, now.toISOString())

  const close = new Date('2026-09-02T09:59:58Z').toISOString()
  assert.equal(normalizeRunEvent({ kind: 'log', line: 'x', at: close }, { now }).at, close)
})

test('the store numbers events itself and reports what it dropped', async () => {
  const store = new MemoryStore()
  const first = await store.appendRunEvents('trun_x', [
    { kind: 'log', payload: { line: 'a' } },
    { kind: 'log', payload: { line: 'b' } },
  ])
  assert.deepEqual(first.events.map((event) => event.seq), [1, 2])

  const second = await store.appendRunEvents('trun_x', [{ kind: 'log', payload: { line: 'c' } }])
  assert.equal(second.events[0].seq, 3)

  // The cap is not silent: the caller learns how many were refused.
  const capped = await store.appendRunEvents('trun_x', [{ kind: 'log' }, { kind: 'log' }], { cap: 4 })
  assert.equal(capped.events.length, 1)
  assert.equal(capped.dropped, 1)

  assert.deepEqual(
    (await store.listRunEvents('trun_x', { afterSeq: 2 })).map((event) => event.seq),
    [3, 4],
  )
})

test('a subscriber that throws does not stop the others', () => {
  const bus = new RunEventBus()
  const seen = []
  bus.subscribe('trun_x', () => {
    throw new Error('this listener is gone')
  })
  const off = bus.subscribe('trun_x', (events) => seen.push(...events))
  assert.equal(bus.publish('trun_x', [{ seq: 1 }]), 2)
  assert.equal(seen.length, 1)
  off()
  assert.equal(bus.count('trun_x'), 1)
})

// -- over HTTP ---------------------------------------------------------------

let runId
let runnerToken
let runToken

test('setting up an app, a suite, a task and a runner', async () => {
  await api('POST', '/api/v1/apps', { body: { slug: 'live', displayName: '实时 demo' } })
  await api('POST', '/api/v1/apps/live/suites', {
    body: {
      slug: 'live-web',
      displayName: 'Web 主轨',
      engine: 'cypress',
      surface: 'web',
      runnerKind: 'local',
      command: ['pnpm', 'e2e:run:mock'],
    },
  })
  const task = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'live',
      suite: 'live-web',
      name: '实时进度',
      targetUrl: 'https://live.example.internal',
      schedule: { kind: 'manual' },
    },
  })
  assert.equal(task.status, 201)
  const run = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`, { body: {} })
  assert.equal(run.status, 202)
  runId = run.body.run.id

  const runner = await api('POST', '/runner/v1/runners:register', {
    body: { name: '测试机', kind: 'local', os: 'windows', engines: ['cypress'], surfaces: ['web'] },
  })
  assert.equal(runner.status, 201)
  runnerToken = runner.body.token
})

test('claiming writes the first two events without the runner reporting anything', async () => {
  const claim = await api('POST', '/runner/v1/runs:claim', { token: runnerToken, body: {} })
  assert.equal(claim.status, 200)
  assert.equal(claim.body.runId, runId)
  runToken = claim.body.runToken

  const stored = await runtime.store.listRunEvents(runId)
  assert.deepEqual(stored.map((event) => event.kind), ['run.claimed', 'stage'])
  assert.equal(stored[0].payload.runner, '测试机')
  assert.equal(stored[1].payload.stage, 'claim')
})

test('a runner posts progress with its run-scoped token', async () => {
  const posted = await api(`POST`, `/runner/v1/runs/${runId}/events`, {
    token: runToken,
    body: {
      events: [
        { kind: 'stage', stage: 'checkout', status: 'ok' },
        { kind: 'case.started', caseId: 'LP-FE-AUTH-001', title: '登录跳转' },
        { kind: 'step', caseId: 'LP-FE-AUTH-001', seq: 1, label: '打开受保护页面' },
        { kind: 'nonsense' },
      ],
    },
  })
  assert.equal(posted.status, 202)
  assert.equal(posted.body.accepted, 3)

  // Someone else's token cannot write to this run's timeline.
  const stranger = await api('POST', `/runner/v1/runs/${runId}/events`, {
    token: 'mxt-run-not-a-real-token',
    body: { events: [{ kind: 'log', line: 'x' }] },
  })
  assert.equal(stranger.status, 403)
})

test('finishing the run closes the stream and refuses later progress', async () => {
  const complete = await api('POST', `/runner/v1/runs/${runId}:complete`, {
    token: runToken,
    body: {
      exitCode: 0,
      summary: {
        schemaVersion: 2,
        runId,
        app: 'live',
        status: 'passed',
        totals: { tests: 1, passed: 1 },
        cases: [{ caseId: 'LP-FE-AUTH-001', status: 'passed', durationMs: 1200 }],
      },
    },
  })
  assert.equal(complete.status, 200)

  // A finished run has a finished timeline; a straggling batch must not extend
  // it past the end of the run.
  const late = await api('POST', `/runner/v1/runs/${runId}/events`, {
    token: runnerToken,
    body: { events: [{ kind: 'log', line: 'too late' }] },
  })
  assert.equal(late.status, 409)

  const stream = await readStream(`/api/v1/runs/${runId}/events`)
  assert.equal(stream.status, 200)
  assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  // Buffering by a proxy would deliver a "live" timeline in one lump at the end.
  assert.equal(stream.headers.get('x-accel-buffering'), 'no')

  const kinds = stream.frames.map((frame) => frame.kind)
  assert.deepEqual(kinds, [
    'run.claimed',
    'stage',
    'stage',
    'case.started',
    'step',
    'run.finished',
    'end',
  ])
  assert.equal(stream.frames.at(-1).data.status, 'passed')
  // Every frame but the terminator carries the resume point.
  assert.deepEqual(
    stream.frames.slice(0, -1).map((frame) => frame.id),
    [1, 2, 3, 4, 5, 6],
  )

  const tail = await readStream(`/api/v1/runs/${runId}/events?lastEventId=4`)
  assert.deepEqual(tail.frames.map((frame) => frame.kind), ['step', 'run.finished', 'end'])
})

test('the stream needs the same credentials the run does', async () => {
  const response = await fetch(`${base}/api/v1/runs/${runId}/events`)
  assert.equal(response.status, 401)
  await response.text()
})

test('the cap leaves room for the notice that says it was reached', async () => {
  const store = new MemoryStore()
  const bulk = Array.from({ length: RUN_EVENT_CAP + 50 }, () => ({ kind: 'log', payload: { line: 'x' } }))
  const first = await store.appendRunEvents('trun_cap', bulk, { cap: RUN_EVENT_CAP - 1 })
  assert.equal(first.events.length, RUN_EVENT_CAP - 1)
  assert.equal(first.dropped, 51)
  const notice = await store.appendRunEvents('trun_cap', [{ kind: 'log', payload: { line: 'truncated' } }], {
    cap: RUN_EVENT_CAP,
  })
  assert.equal(notice.events.length, 1)
  assert.equal(await store.countRunEvents('trun_cap'), RUN_EVENT_CAP)
})
