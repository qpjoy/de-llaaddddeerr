import assert from 'node:assert/strict'
import test from 'node:test'

import { adapterFor, asText, redactChannel } from '../server/notify/adapters.mjs'
import { deliverPending, enqueueForRun } from '../server/notify/dispatch.mjs'
import { channelWants, composeMessage, resolveTransition } from '../server/notify/events.mjs'
import { MemoryStore } from '../server/store/memory.mjs'

// -- when to say anything -----------------------------------------------------
//
// These are the most important assertions in the file. Getting delivery wrong
// means a message does not arrive; getting *this* wrong means the channel
// becomes noise and everyone mutes it, which is strictly worse than having no
// notifications at all — the dashboard still looks fine while nobody watches.

test('a newly broken task is announced once', () => {
  assert.equal(resolveTransition({ status: 'failed' }, { status: 'passed' }), 'failure')
})

test('a task that is still broken says nothing', () => {
  // The second, third and thirtieth consecutive failure carry no information
  // the dashboard does not already have.
  assert.equal(resolveTransition({ status: 'failed' }, { status: 'failed' }), null)
})

test('recovery is worth exactly one message', () => {
  assert.equal(resolveTransition({ status: 'passed' }, { status: 'failed' }), 'recovery')
  assert.equal(resolveTransition({ status: 'passed' }, { status: 'blocked' }), 'recovery')
  // Green after green is the normal state of a healthy task. Announcing it is
  // how a channel becomes unreadable.
  assert.equal(resolveTransition({ status: 'passed' }, { status: 'passed' }), null)
})

test('the first ever run only speaks up if it is bad news', () => {
  assert.equal(resolveTransition({ status: 'failed' }, null), 'failure')
  assert.equal(resolveTransition({ status: 'blocked' }, null), 'blocked')
  assert.equal(resolveTransition({ status: 'passed' }, null), null)
})

test('infrastructure failures are their own event, and also transition-gated', () => {
  // Separate from `failure` so it can be routed to the ops group instead of the
  // product group — those are different people and different urgencies.
  assert.equal(resolveTransition({ status: 'blocked' }, { status: 'passed' }), 'blocked')
  // A cluster broken for a week must not post every hour for a week.
  assert.equal(resolveTransition({ status: 'blocked' }, { status: 'blocked' }), null)
})

test('an unclaimed desktop run is silent', () => {
  // `expired` means nobody turned their laptop on. That is the queueing design
  // working as intended, not a failure, and alerting on it would make the
  // channel noisy in exactly the situation the design accepts.
  assert.equal(resolveTransition({ status: 'expired' }, { status: 'passed' }), null)
  assert.equal(resolveTransition({ status: 'running' }, { status: 'passed' }), null)
})

// -- what the message says ----------------------------------------------------

const run = {
  id: 'trun_1',
  status: 'failed',
  profile: 'mock',
  totals: { tests: 23, passed: 21, failed: 1, notRun: 1 },
  sourceRef: { ref: 'public', gitSha: 'abcdef1234567890' },
}

test('a failure message answers "how bad, which case, where do I look"', () => {
  const message = composeMessage({
    event: 'failure',
    run,
    task: { name: '罗盘 Web mock · 每晚' },
    app: { slug: 'luopan', displayName: '罗盘' },
    suite: { slug: 'web-mock' },
    cases: [
      { caseId: 'LP-FE-AUTH-001', status: 'failed', title: '未登录跳转', errorText: 'expected 302\n  at auth.cy.ts:9' },
      { caseId: 'LP-FE-HOME-001', status: 'passed', title: '首页' },
    ],
    lastGood: { id: 'trun_0', sourceRef: { gitSha: '1111222233334444' }, finishedAt: '2026-08-31T18:00:00Z' },
    baseUrl: 'http://mxt.internal:30879',
  })

  assert.equal(message.runUrl, 'http://mxt.internal:30879/runs/trun_1')
  assert.equal(message.failedCases.length, 1)
  // One line, not the stack. An alert is a pointer, not a report.
  assert.equal(message.failedCases[0].error, 'expected 302')
  // "It worked here, it fails there" is the single most useful line in an alert.
  assert.equal(message.lastGood.gitSha, '111122223333')
  assert.equal(message.sourceRef.gitSha, 'abcdef123456')
  // A run can be green while quietly skipping half the catalog. Surfacing the
  // count is the whole reason the platform tracks it.
  assert.equal(message.totals.notRun, 1)
})

test('secrets in an error message do not reach the chat group', () => {
  const message = composeMessage({
    event: 'failure',
    run,
    app: { slug: 'x' },
    cases: [
      {
        caseId: 'X-1',
        status: 'failed',
        title: 'login',
        errorText: 'request failed: authorization: Bearer sk-live-0123456789abcdef',
      },
    ],
  })
  assert.ok(!message.failedCases[0].error.includes('sk-live-0123456789abcdef'))
})

test('only the first few failures are listed, and the rest are counted', () => {
  const many = Array.from({ length: 9 }, (_, index) => ({
    caseId: `X-${index}`,
    status: 'failed',
    title: `case ${index}`,
  }))
  const message = composeMessage({ event: 'failure', run, app: {}, cases: many })
  assert.equal(message.failedCases.length, 5)
  assert.equal(message.failedCasesOmitted, 4)
})

// -- adapters -----------------------------------------------------------------

test('the generic webhook signs its body when given a secret', () => {
  const config = adapterFor('webhook').validate({ url: 'https://relay.internal/hook', secret: 's3cret' })
  const request = adapterFor('webhook').build({ title: 'hi', totals: {}, failedCases: [] }, config)
  assert.equal(request.url, 'https://relay.internal/hook')
  assert.match(request.headers['x-mxt-signature'], /^sha256=[0-9a-f]{64}$/u)
})

test('feishu carries its own signature scheme', () => {
  const config = adapterFor('feishu').validate({
    url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc-123',
    secret: 'k',
  })
  const body = JSON.parse(adapterFor('feishu').build({ title: 't', totals: {}, failedCases: [] }, config).body)
  assert.equal(body.msg_type, 'text')
  // 飞书 signs `<timestamp>\n<secret>` and sends the timestamp alongside — an
  // unusual scheme that is easy to get wrong by assuming it looks like others.
  assert.ok(body.timestamp && body.sign)
})

test('a channel url that is not what it claims to be is refused', () => {
  // Pasting a WeCom URL into a Feishu channel would fail silently at delivery
  // time, days later, with nobody watching.
  assert.throws(() => adapterFor('feishu').validate({ url: 'https://example.com/hook' }), /机器人 webhook/u)
  assert.throws(() => adapterFor('wecom').validate({ url: 'https://example.com/hook' }), /群机器人/u)
  assert.throws(() => adapterFor('webhook').validate({ url: 'ftp://x/y' }), /http/u)
  assert.throws(() => adapterFor('webhook').validate({}), /合法的 url/u)
})

test('reading the channel list back does not hand out the credential', () => {
  // A 飞书 bot URL *is* the credential — the token is a path segment — so the
  // whole URL is a secret, not just the `secret` field.
  const redacted = redactChannel({
    id: 'nch_1',
    name: 'QA 群',
    kind: 'feishu',
    config: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/SECRET-TOKEN', secret: 'k' },
  })
  const serialized = JSON.stringify(redacted)
  assert.ok(!serialized.includes('SECRET-TOKEN'))
  assert.ok(!serialized.includes('"k"'))
  assert.equal(redacted.config.urlHost, 'open.feishu.cn')
  assert.equal(redacted.config.signed, true)
})

test('the plain-text rendering is readable without the platform open', () => {
  const text = asText({
    title: '❌ 新失败 · 罗盘 / 每晚',
    taskName: '每晚',
    event: 'failure',
    totals: { tests: 23, passed: 21, failed: 1, notRun: 1 },
    failedCases: [{ caseId: 'LP-FE-AUTH-001', title: '未登录跳转', error: 'expected 302' }],
    failedCasesOmitted: 0,
    sourceRef: { gitSha: 'abcdef123456' },
    lastGood: { gitSha: '111122223333' },
    runUrl: 'http://mxt/runs/trun_1',
  })
  assert.match(text, /21\/23 通过/u)
  assert.match(text, /1 未执行/u)
  assert.match(text, /LP-FE-AUTH-001/u)
  assert.match(text, /上次通过：111122223333/u)
})

// -- the outbox ---------------------------------------------------------------

async function seeded() {
  const store = new MemoryStore()
  const app = await store.createApp({ slug: 'luopan', displayName: '罗盘' })
  const suite = await store.createSuite({
    appId: app.id,
    slug: 'web',
    displayName: 'web',
    engine: 'cypress',
    surface: 'web',
    runnerKind: 'server',
  })
  const task = await store.createTask({
    appId: app.id,
    suiteId: suite.id,
    name: '每晚',
    profile: 'mock',
    track: 'functional',
    scheduleKind: 'cron',
  })
  return { store, app, suite, task }
}

test('a run with no history and a green result queues nothing', async () => {
  const { store, app, suite, task } = await seeded()
  await store.createNotificationChannel({ name: 'QA', kind: 'webhook', config: { url: 'https://x/y' } })
  const passing = await store.createRun({ appId: app.id, suiteId: suite.id, taskId: task.id })
  await store.updateRun(passing.id, { status: 'passed', finishedAt: new Date().toISOString() })
  const queued = await enqueueForRun({
    store,
    run: await store.getRun(passing.id),
    config: {},
    logger: { log() {}, error() {} },
  })
  assert.deepEqual(queued, [])
})

test('only channels that asked for this event and this app are queued', async () => {
  const { store, app, suite, task } = await seeded()
  const other = await store.createApp({ slug: 'other', displayName: 'Other' })
  await store.createNotificationChannel({ name: '全平台运维', kind: 'webhook', config: { url: 'https://o/1' }, events: ['blocked'] })
  await store.createNotificationChannel({ name: '罗盘业务', appId: app.id, kind: 'webhook', config: { url: 'https://o/2' }, events: ['failure'] })
  await store.createNotificationChannel({ name: '别的应用', appId: other.id, kind: 'webhook', config: { url: 'https://o/3' }, events: ['failure'] })
  await store.createNotificationChannel({ name: '停用的', kind: 'webhook', config: { url: 'https://o/4' }, enabled: false })

  const first = await store.createRun({ appId: app.id, suiteId: suite.id, taskId: task.id })
  await store.updateRun(first.id, { status: 'passed', finishedAt: '2026-09-01T00:00:00Z' })
  const second = await store.createRun({ appId: app.id, suiteId: suite.id, taskId: task.id })
  await store.updateRun(second.id, { status: 'failed', finishedAt: '2026-09-01T01:00:00Z' })

  const queued = await enqueueForRun({
    store,
    run: await store.getRun(second.id),
    config: { publicUrl: 'http://mxt' },
    logger: { log() {}, error() {} },
  })
  // Only 罗盘业务: the ops channel wants `blocked`, the other app is not this
  // app, and the disabled one is disabled.
  assert.equal(queued.length, 1)
})

test('a queued notification survives to be delivered, and records its attempt', async () => {
  const { store, app, suite, task } = await seeded()
  const channel = await store.createNotificationChannel({
    name: 'QA',
    kind: 'webhook',
    config: { url: 'https://relay.internal/hook' },
  })
  await store.createNotification({ channelId: channel.id, runId: null, event: 'failure', payload: { title: 't', totals: {}, failedCases: [] } })

  const calls = []
  const delivered = await deliverPending({
    store,
    logger: { log() {}, error() {} },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200, text: async () => '{"code":0}' }
    },
  })
  assert.equal(delivered.length, 1)
  assert.equal(calls[0].url, 'https://relay.internal/hook')
  const [row] = await store.listNotifications({})
  assert.equal(row.status, 'sent')
  assert.ok(row.deliveredAt)
  void app, suite, task
})

test('a 200 with an error code in the body is not a delivery', async () => {
  // Feishu and WeCom both answer 200 and put the failure in the body. Trusting
  // the status line would mark undelivered alerts as sent.
  const { store } = await seeded()
  const channel = await store.createNotificationChannel({
    name: 'QA',
    kind: 'feishu',
    config: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' },
  })
  await store.createNotification({ channelId: channel.id, event: 'failure', payload: { title: 't', totals: {}, failedCases: [] } })
  await deliverPending({
    store,
    logger: { log() {}, error() {} },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"code":19024,"msg":"sign match fail"}' }),
  })
  const [row] = await store.listNotifications({})
  assert.equal(row.status, 'pending')
  assert.equal(row.attempts, 1)
  assert.match(row.lastError, /19024/u)
})

test('delivery gives up visibly rather than retrying forever', async () => {
  const { store } = await seeded()
  const channel = await store.createNotificationChannel({
    name: 'QA',
    kind: 'webhook',
    config: { url: 'https://gone.internal/hook' },
  })
  await store.createNotification({ channelId: channel.id, event: 'failure', payload: { title: 't', totals: {}, failedCases: [] } })
  const failing = async () => {
    throw new Error('ECONNREFUSED')
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await deliverPending({ store, logger: { log() {}, error() {} }, fetchImpl: failing })
  }
  const [row] = await store.listNotifications({})
  // A webhook deleted six months ago should not be a permanent background
  // error, and someone has to be able to see why it stopped.
  assert.equal(row.status, 'failed')
  assert.equal(row.attempts, 4)
  assert.match(row.lastError, /ECONNREFUSED/u)
})

test('channelWants respects scope and enablement', () => {
  const channel = { enabled: true, appId: null, events: ['failure'] }
  assert.equal(channelWants(channel, { event: 'failure', appId: 'a' }), true)
  assert.equal(channelWants(channel, { event: 'blocked', appId: 'a' }), false)
  assert.equal(channelWants({ ...channel, enabled: false }, { event: 'failure', appId: 'a' }), false)
  assert.equal(channelWants({ ...channel, appId: 'b' }, { event: 'failure', appId: 'a' }), false)
})
