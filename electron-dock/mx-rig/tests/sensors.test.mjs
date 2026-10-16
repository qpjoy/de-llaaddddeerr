import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  SENSORS,
  Sensors,
  mergeSignals,
  pathPattern,
  plainUrl,
  scrub,
  secretParams,
  signalSchema,
  summarizeSignals
} from '../packages/runtime/sensors.mjs'
import { reportRun, withoutSensing } from '../packages/runtime/procedure.mjs'
import { replay } from '../apps/server/procedure-routes.mjs'
import { replayFrames } from '../packages/runtime/replay.mjs'

// 自动检查项: leads read on every step, with no model and no assertion. The
// pure parts here; the proving ground (proving-ground.test.mjs) shows them
// finding real defects in a real browser.

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0ZXIifQ.c2lnbmF0dXJlLXZhbHVl'

test('places fold ids, addresses lose their query, text loses anything shaped like a token', () => {
  assert.equal(pathPattern('http://a.test/items/42?x=1'), 'http://a.test/items/:id')
  assert.equal(pathPattern('http://a.test/u/9f86d081884c7d659a2feaa0c55ad015/edit'), 'http://a.test/u/:id/edit')
  assert.equal(pathPattern('not a url'), '')
  assert.equal(plainUrl(`http://a.test/items?token=${JWT}#x`), 'http://a.test/items')
  assert.equal(plainUrl('nope'), null)
  const cleaned = scrub(`登录失败 ${JWT} key=${'a'.repeat(40)} /api/reports/summary/export-data`)
  assert.doesNotMatch(cleaned, /eyJ/)
  assert.doesNotMatch(cleaned, /a{40}/)
  assert.match(cleaned, /\/api\/reports\/summary\/export-data/, 'a long path is not a token')
  assert.equal(scrub('x'.repeat(10), 5).length, 5)
})

test('a credential in an address is named, never repeated', () => {
  assert.deepEqual(secretParams(`http://a.test/items?token=${JWT}&page=2`), ['token'])
  assert.deepEqual(secretParams(`http://a.test/cb#access_token=abc&state=1`), ['#access_token'])
  assert.deepEqual(secretParams(`http://a.test/x?ref=${JWT}`), ['ref'], 'a JWT under any name')
  assert.deepEqual(secretParams('http://a.test/items?page=2&q=token'), [])
})

/** Just enough of Playwright's request/response/page for the sensors' listeners. */
function fakeRequest({ url, type = 'xhr', method = 'GET', failure = null, took = null }) {
  return {
    url: () => url,
    method: () => method,
    resourceType: () => type,
    failure: () => (failure ? { errorText: failure } : null),
    timing: () => ({ responseEnd: took ?? -1 })
  }
}

function session(options = {}) {
  const context = new EventEmitter()
  const page = new EventEmitter()
  page.url = () => 'http://app.test/reports'
  page.mainFrame = () => 'main'
  const sensors = new Sensors({ slowRequestMs: 100, ...options })
  sensors.attachContext(context)
  sensors.attachPage(page)
  return { context, page, sensors }
}

test('network, console and page errors become signals, one per signature, counted', () => {
  const { context, page, sensors } = session()
  sensors.at(2)
  const failing = fakeRequest({ url: 'http://app.test/api/items/7?q=1' })
  context.emit('request', failing)
  context.emit('response', { request: () => failing, status: () => 500 })
  const again = fakeRequest({ url: 'http://app.test/api/items/8' })
  context.emit('request', again)
  context.emit('response', { request: () => again, status: () => 502 })
  context.emit('requestfinished', fakeRequest({ url: 'http://app.test/api/kpi', took: 250 }))
  page.emit('pageerror', new Error('Cannot read properties of null (reading "map")\n    at render'))
  page.emit('console', { type: () => 'error', text: () => '图表配置解析失败' })
  // Covered by the network sensors with their status: not repeated here.
  page.emit('console', { type: () => 'error', text: () => 'Failed to load resource: the server responded with a status of 500' })
  page.emit('console', { type: () => 'warning', text: () => '只是警告' })

  const signals = sensors.take()
  // /items/7 and /items/8 failing are one endpoint failing twice.
  assert.deepEqual(
    signals.map((signal) => signal.sensor),
    ['http_error', 'slow_request', 'page_error', 'console_error']
  )
  assert.equal(signals[0].url, 'http://app.test/api/items/7', 'no query in the record')
  assert.equal(signals[0].step, 2)
  assert.equal(sensors.all()[0].count, 2)
  assert.equal(signals[1].evidence.durationMs, 250)
  assert.match(signals[2].title, /Cannot read properties of null/)
  assert.doesNotMatch(signals[2].title, /at render/, 'the first line only')
  for (const signal of signals) assert.equal(signalSchema.safeParse(signal).success, true, JSON.stringify(signal))
  assert.equal(sensors.take().length, 0, 'taken once')

  // The same failure again is counted on the signal it already made.
  context.emit('response', { request: () => failing, status: () => 500 })
  assert.equal(sensors.take().length, 0)
  assert.equal(sensors.all()[0].count, 3)
  const metrics = sensors.metrics()
  assert.equal(metrics.requests.count, 2)
  assert.equal(metrics.requests.slow, 1)
  assert.equal(metrics.requests.p95Ms, 250)
})

test('what the station stopped, what a navigation cancelled and what happens after closing are not the page failing', () => {
  const { context, sensors } = session()
  const outside = fakeRequest({ url: 'http://elsewhere.test/', type: 'document', failure: 'net::ERR_FAILED' })
  sensors.refuse(outside)
  context.emit('requestfailed', outside)
  context.emit('requestfailed', fakeRequest({ url: 'http://app.test/api/x', failure: 'net::ERR_ABORTED' }))
  context.emit('requestfailed', fakeRequest({ url: 'http://app.test/logo.png', type: 'image', failure: 'net::ERR_FAILED' }))
  assert.equal(sensors.take().length, 0)
  context.emit('requestfailed', fakeRequest({ url: 'http://app.test/api/x', failure: 'net::ERR_CONNECTION_RESET' }))
  assert.equal(sensors.take()[0].sensor, 'request_failed')
  sensors.stop()
  const late = fakeRequest({ url: 'http://app.test/api/y' })
  context.emit('response', { request: () => late, status: () => 500 })
  assert.equal(sensors.take().length, 0)
})

test('a page that will not answer is skipped, not waited for', async () => {
  const { page, sensors } = session()
  page.evaluate = () => new Promise(() => {})
  const started = Date.now()
  await sensors.probe(page)
  assert.ok(Date.now() - started < 3000)
  assert.equal(sensors.take().length, 0)
  // And a double with no evaluate at all is simply not probed.
  await sensors.probe({ url: () => 'http://x/' })
})

test('signals from many steps merge by signature and count up to a limit', () => {
  const a = { sensor: 'http_error', severity: 'error', signature: 's1', count: 1, title: 'a', label: '接口失败' }
  const b = { sensor: 'console_error', severity: 'warn', signature: 's2', count: 2, title: 'b', label: '控制台报错' }
  const merged = mergeSignals([a], [{ ...a, count: 3 }, b])
  assert.deepEqual(merged.map((signal) => [signal.signature, signal.count]), [['s1', 4], ['s2', 2]])
  assert.equal(a.count, 1, 'inputs untouched')
  assert.equal(mergeSignals([], [a, b], 1).length, 1)
  assert.deepEqual(summarizeSignals(merged).bySeverity, { error: 1, warn: 1, notice: 0 })
  assert.equal(Object.keys(SENSORS).length, 13)
})

test('a replay record with signals is what the service accepts; an older service gets it without them', async () => {
  const signal = {
    sensor: 'http_error',
    label: '接口失败',
    severity: 'error',
    title: 'GET /api/items 返回 500',
    url: 'http://app.test/api/items',
    step: 3,
    count: 1,
    at: new Date().toISOString(),
    signature: 'http_error|http://app.test/api/items|GET #',
    evidence: { method: 'GET', status: 500, type: 'xhr' }
  }
  const run = {
    procedureId: 'prc_aaaaaaaaaaaaaaaaaa',
    runId: 'fire-1',
    revision: 1,
    verdict: 'passed',
    repairable: false,
    failedStep: null,
    failure: null,
    steps: [{ index: 0, do: 'open', text: '打开 /items', note: null, status: 'passed', durationMs: 5, signals: [signal] }],
    signals: [signal],
    metrics: {
      pages: [{ url: 'http://app.test/items', lcpMs: 120, cls: 0, longTasks: 0, domContentLoadedMs: 40, loadMs: 60 }],
      requests: { count: 1, failed: 0, slow: 0, p50Ms: 12, p95Ms: 12, maxMs: 12 }
    },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 5,
    station: 'desktop'
  }
  assert.equal(replay.safeParse(run).success, true, JSON.stringify(replay.safeParse(run).error?.issues))

  // An older service: strict, and knows nothing of signals.
  const legacy = replay.omit({ signals: true, metrics: true }).extend({
    steps: replay.shape.steps.element.omit({ signals: true }).array()
  })
  const sent = []
  const send = async (body) => {
    sent.push(body)
    const parsed = legacy.safeParse(body)
    if (!parsed.success) throw new Error(`请求参数无效（${parsed.error.issues[0].path.join('.')}: Unrecognized key: "signals"）`)
    return { ok: true }
  }
  assert.deepEqual(await reportRun(send, run), { ok: true })
  assert.equal(sent.length, 2)
  assert.equal(sent[1].signals, undefined)
  assert.equal(sent[1].steps[0].signals, undefined)
  assert.deepEqual(withoutSensing(run).steps[0].text, '打开 /items')
  // Any other refusal is not hidden behind a retry.
  await assert.rejects(
    reportRun(async () => {
      throw new Error('revision mismatch')
    }, run),
    /revision mismatch/
  )
})

test('the replay keeps each step’s signals for its track', () => {
  const frames = replayFrames([
    { kind: 'tool_start', data: { tool: 'browser_open', args: { url: 'http://x/' } } },
    {
      kind: 'tool_result',
      data: {
        result: {
          screenshot: 'm/1.png',
          frame: { label: '打开 http://x/' },
          signals: [{ sensor: 'console_error', severity: 'warn', title: '控制台报错：x', signature: 's' }]
        }
      }
    },
    { kind: 'tool_start', data: { tool: 'browser_click', args: { ref: 'e1' } } },
    { kind: 'tool_result', data: { result: { screenshot: 'm/2.png', frame: { label: '点击' } } } }
  ])
  assert.deepEqual(frames.map((frame) => frame.signals.length), [1, 0])
})
