import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEvent,
  artifactSrc,
  brokenStage,
  clock,
  duration,
  liveModel,
  recordingFor,
  screenshotsFor
} from '../apps/web/run-model.js'
import { routeAction } from '../apps/web/routes.js'
import { MEDIA_SCHEME, mediaResponse, mediaTarget } from '../apps/desktop/run-media.mjs'

// 执行详情 (docs/21 M4): the timeline model, the requests the page makes, and
// how the desktop plays a run's recording without the page holding a token.

const events = [
  { seq: 1, kind: 'run.claimed', payload: { runner: '测试机' } },
  { seq: 2, kind: 'stage', payload: { stage: 'claim', status: 'ok' } },
  { seq: 3, kind: 'stage', payload: { stage: 'launch', status: 'running' } },
  { seq: 4, kind: 'case.started', payload: { caseId: 'PG-001', title: '登录' } },
  { seq: 5, kind: 'step', payload: { caseId: 'PG-001', seq: 1, label: '打开首页', offsetMs: 1200 } },
  { seq: 6, kind: 'case.finished', payload: { caseId: 'PG-001', status: 'passed', durationMs: 3400 } },
  { seq: 7, kind: 'case.finished', payload: { caseId: 'PG-002', status: 'failed', durationMs: 900 } },
  { seq: 8, kind: 'log', payload: { line: 'npx playwright test' } }
]

test('the timeline folds into stages, cases, counts and logs, and a page read twice counts once', () => {
  const model = liveModel()
  for (const event of events) applyEvent(model, event)
  for (const event of events) applyEvent(model, event)
  assert.equal(model.runner, '测试机')
  assert.equal(model.lastSeq, 8)
  // Overtaken stages that never reported did not happen.
  assert.equal(model.stages.get('checkout').status, 'skipped')
  assert.equal(model.stages.get('install').status, 'skipped')
  assert.equal(model.stages.get('launch').status, 'active')
  assert.deepEqual(model.order, ['PG-001', 'PG-002'])
  assert.deepEqual(model.counts, { passed: 1, failed: 1 })
  assert.equal(model.cases.get('PG-001').steps[0].offsetMs, 1200)
  assert.deepEqual(model.logs, ['npx playwright test'])
  assert.equal(brokenStage(model), null)

  applyEvent(model, { seq: 9, kind: 'stage', payload: { stage: 'execute', status: 'failed', detail: '浏览器起不来' } })
  assert.deepEqual(brokenStage(model), ['执行', '浏览器起不来'])
  applyEvent(model, { seq: 10, kind: 'run.finished', payload: { status: 'blocked' } })
  assert.equal(model.finished, 'blocked')
  assert.equal(model.stages.get('archive').status, 'done')
})

test('when the run ends, no stage is left in progress', () => {
  const finished = liveModel()
  applyEvent(finished, { seq: 1, kind: 'stage', payload: { stage: 'claim', status: 'ok' } })
  applyEvent(finished, { seq: 2, kind: 'stage', payload: { stage: 'execute', status: 'running' } })
  applyEvent(finished, { seq: 3, kind: 'run.finished', payload: { status: 'failed' } })
  // Failing tests still ran to the end: the stage finished; one that never reported did not happen.
  assert.equal(finished.stages.get('execute').status, 'done')
  assert.equal(finished.stages.get('upload').status, 'skipped')
  assert.equal(brokenStage(finished), null)

  const blocked = liveModel()
  applyEvent(blocked, { seq: 1, kind: 'stage', payload: { stage: 'launch', status: 'running', detail: '启动浏览器' } })
  applyEvent(blocked, { seq: 2, kind: 'run.finished', payload: { status: 'blocked' } })
  assert.deepEqual(brokenStage(blocked), ['启动', '启动浏览器'])
})

test('a recording is matched to its case the way the report matches it, never by being the only one', () => {
  const artifacts = [{ path: 'videos/auth.spec.ts.webm' }, { path: 'videos/PG-009.webm' }, { path: 'shots/PG-001.png' }]
  assert.equal(recordingFor({ caseId: 'PG-009' }, artifacts).path, 'videos/PG-009.webm')
  assert.equal(recordingFor({ caseId: 'PG-001', specPath: 'e2e\\auth.spec.ts' }, artifacts).path, 'videos/auth.spec.ts.webm')
  assert.equal(
    recordingFor({ caseId: 'PG-003', artifacts: [{ kind: 'video', path: 'videos/PG-009.webm' }] }, artifacts).path,
    'videos/PG-009.webm'
  )
  assert.equal(recordingFor({ caseId: 'PG-004' }, [{ path: 'videos/only.webm' }]), null)

  const shots = screenshotsFor(
    { artifacts: [{ kind: 'screenshot', path: 'shots/PG-001.png' }, { kind: 'screenshot', path: 'shots/missing.png' }] },
    artifacts
  )
  assert.deepEqual(shots.map((entry) => entry.path), ['shots/PG-001.png'])
})

test('durations and recording points read as a person would say them', () => {
  assert.equal(duration(null), '—')
  assert.equal(duration(450), '450 毫秒')
  assert.equal(duration(3400), '3.4 秒')
  assert.equal(duration(125_000), '2 分 5 秒')
  assert.equal(clock(65_400), '01:05.4')
  assert.equal(clock(200), '00:00.2')
  assert.equal(clock(null), '--:--')
})

test('the page asks for a run, its cases, artifacts and timeline, and nothing it cannot name', () => {
  assert.deepEqual(routeAction('run', { id: 'trun_abc123' }), { method: 'GET', path: '/api/v1/runs/trun_abc123', body: undefined })
  assert.equal(routeAction('run-cases', { id: 'trun_abc123' }).path, '/api/v1/runs/trun_abc123/cases')
  assert.equal(routeAction('run-artifacts', { id: 'trun_abc123' }).path, '/api/v1/runs/trun_abc123/artifacts')
  assert.equal(routeAction('run-progress', { id: 'trun_abc123' }).path, '/api/v1/runs/trun_abc123/progress?afterSeq=0')
  assert.equal(
    routeAction('run-progress', { id: 'trun_abc123', afterSeq: 42 }).path,
    '/api/v1/runs/trun_abc123/progress?afterSeq=42'
  )
  assert.deepEqual(routeAction('run-cancel', { id: 'trun_abc123' }), {
    method: 'POST',
    path: '/api/v1/runs/trun_abc123:cancel',
    body: {}
  })
  // 只重跑这条 is the plan's own run, narrowed to one case.
  assert.deepEqual(routeAction('plan-run', { id: 'ttask_abc1', caseFilter: 'PG-001', extra: 1 }).body, { caseFilter: 'PG-001' })

  assert.throws(() => routeAction('run', { id: '../apps' }), /执行标识无效/)
  assert.throws(() => routeAction('run', { id: 'trun_abc123/cases' }), /执行标识无效/)
  assert.throws(() => routeAction('run-progress', { id: 'trun_abc123', afterSeq: '1&x=2' }), /进度位置无效/)
})

test('the desktop names a run file as rig-media:, and only a run recording or image maps to the service', () => {
  const origin = 'http://127.0.0.1:8791'
  const src = artifactSrc('trun_abc123', 'videos/登录 流程.webm', true)
  assert.ok(src.startsWith(`${MEDIA_SCHEME}://run/`))
  assert.equal(mediaTarget(src, origin), `${origin}/api/v1/runs/trun_abc123/artifacts/videos/%E7%99%BB%E5%BD%95%20%E6%B5%81%E7%A8%8B.webm`)
  assert.equal(artifactSrc('trun_abc123', 'videos/a.webm', false), '/api/v1/runs/trun_abc123/artifacts/videos/a.webm')
  assert.equal(mediaTarget('rig-media://run/trun_abc123/shots/a.png', origin), `${origin}/api/v1/runs/trun_abc123/artifacts/shots/a.png`)

  for (const raw of [
    'rig-media://run/trun_abc123/report.html',
    'rig-media://run/trun_abc123/summary.json',
    'rig-media://run/trun_abc123/',
    'rig-media://run/trun_abc123/..%2f..%2fsecrets/a.webm',
    'rig-media://run/trun_abc123/a%2fb.webm',
    'rig-media://run/trun_abc123/%E0%A4%A.webm',
    'rig-media://run/trun_abc123/a.webm?redirect=x',
    'rig-media://elsewhere/trun_abc123/a.webm',
    'rig-media://user:pw@run/trun_abc123/a.webm',
    'https://run/trun_abc123/a.webm',
    'not a url'
  ])
    assert.equal(mediaTarget(raw, origin), null, raw)
  // A tour's recording in 新手引导 (docs/24 M8c), and nothing else under tour/.
  assert.equal(mediaTarget('rig-media://tour/new-project.webm', origin), `${origin}/api/rig/v1/tour-videos/new-project.webm`)
  for (const raw of [
    'rig-media://tour/new-project.mp4',
    'rig-media://tour/new-project',
    'rig-media://tour/../tour-videos.webm',
    'rig-media://tour/a/b.webm',
    'rig-media://tour/New-Project.webm',
    'rig-media://tour/new-project.webm?v=2',
    'rig-media://tour/%2e%2e%2fsecrets.webm'
  ])
    assert.equal(mediaTarget(raw, origin), null, raw)
})

test('a rig-media request carries the member token and the range, and nothing when nobody is signed in', async () => {
  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url, init })
    return new Response('clip', { status: 206, headers: { 'content-range': 'bytes 0-3/4' } })
  }
  const session = { url: 'http://127.0.0.1:8791', token: 'session-token' }
  const request = (url, headers = {}, method = 'GET') => new Request(url, { method, headers })

  const answer = await mediaResponse(request('rig-media://run/trun_abc123/v.webm', { range: 'bytes=0-' }), { session, fetch })
  assert.equal(answer.status, 206)
  assert.equal(seen[0].url, 'http://127.0.0.1:8791/api/v1/runs/trun_abc123/artifacts/v.webm')
  assert.deepEqual(seen[0].init.headers, { authorization: 'Bearer session-token', range: 'bytes=0-' })
  assert.equal(seen[0].init.redirect, 'error')

  // A range that is not a plain byte range is dropped rather than forwarded.
  await mediaResponse(request('rig-media://run/trun_abc123/v.webm', { range: 'items=1-2' }), { session, fetch })
  assert.equal(seen.at(-1).init.headers.range, undefined)

  assert.equal((await mediaResponse(request('rig-media://run/trun_abc123/v.webm'), { session: null, fetch })).status, 404)
  assert.equal((await mediaResponse(request('rig-media://run/trun_abc123/v.html'), { session, fetch })).status, 404)
  assert.equal(
    (await mediaResponse(request('rig-media://run/trun_abc123/v.webm'), { session, fetch: async () => new Response('no', { status: 403 }) })).status,
    403
  )
  assert.equal(
    (await mediaResponse(request('rig-media://run/trun_abc123/v.webm'), { session, fetch: async () => { throw new Error('down') } })).status,
    502
  )
})

test('a long case filter reads as a count on a chip', async () => {
  const { filterLabel } = await import('../apps/web/run-model.js')
  assert.equal(filterLabel('CPS-WEB-AUTH-001'), '只跑 CPS-WEB-AUTH-001')
  assert.equal(filterLabel('A-1, B-2'), '只跑 A-1、B-2')
  assert.equal(filterLabel('A-1,B-2,C-3,D-4'), '只跑 4 条')
})
