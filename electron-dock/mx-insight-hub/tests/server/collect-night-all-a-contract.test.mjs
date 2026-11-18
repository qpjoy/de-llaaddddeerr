import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nightAllAContract } from '../../server/collect/contracts/night-all-a.mjs'
import { projectTiebaSearchResult } from '../../server/ingest/tieba.mjs'

const INPUT = { query: '测试帖子', maxResults: 20, page: 1, maxPages: 1 }
const PARAMS = { query: INPUT.query, max_results: 20, page: 1, max_pages: 1, auth_mode: 'anonymous' }
const ENGINE = { id: 'night-all-a.tieba', kind: 'night_all_a', baseUrl: 'http://100.127.0.1:8100', credentialProvider: null }
const JOB = { id: '00000000-0000-4000-8000-000000000001', input: INPUT, checks: 0 }
const WAITING = { ...JOB, upstreamRef: '42', upstreamState: { taskId: 21, runId: 42 } }
const SESSION = { sessionCookie: 'session-test-value', csrfToken: 'csrf-test-value' }
const FINISHED = '2026-11-18T09:00:00+08:00'
const DEFINITION = {
  nightAllA: { connectorId: 'tieba', capability: 'content.search' },
  taskParameters: input => ({ query: input.query, max_results: input.maxResults, page: input.page, max_pages: input.maxPages, auth_mode: 'anonymous' }),
  projectResult: projectTiebaSearchResult,
}

function result({ complete = true, empty = false } = {}) {
  const items = empty ? [] : [{ record_type: 'tieba.thread', source_id: '123', source_url: 'https://tieba.baidu.com/p/123',
    title: '帖子标题', text: '帖子摘要', author: { id: '5', name: '作者' }, published_at: null,
    metrics: { replies: 0, likes: 1, shares: null }, media: [], attributes: { query: INPUT.query, page: 1, forum: '测试吧' },
    raw: { privateEvidence: 'original payload' } }]
  return { items, metrics: { count: items.length, collection: { requested: INPUT.maxResults, returned: items.length,
    complete, stop_reason: complete ? 'end_of_results' : 'page_limit' } } }
}

const task = extra => ({ id: 21, connector_id: 'tieba', capability: 'content.search', parameters: { ...PARAMS },
  credential_id: null, max_attempts: 1, status: 'scheduled', ...extra })
const run = (status = 'running', extra = {}) => ({ id: 42, task_id: 21, connector_id: 'tieba', capability: 'content.search',
  parameters: { ...PARAMS }, attempt: 1, status, duration_ms: 2345, finished_at: status === 'running' ? null : FINISHED,
  result: status === 'succeeded' ? result() : null,
  metrics: { records: { auto_persisted: true, saved: 1, created: 1, updated: 0 } }, ...extra })

function fakeApi(answers) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = { url: new URL(url), method: init.method || 'GET', headers: init.headers,
      redirect: init.redirect, body: init.body === undefined ? null : JSON.parse(init.body) }
    calls.push(call)
    const answer = typeof answers === 'function' ? answers(call, calls.length) : answers[calls.length - 1]
    if (answer instanceof Error) throw answer
    if (answer instanceof Response) return answer
    assert.ok(answer, `unexpected request ${call.method} ${call.url.pathname}`)
    return Response.json(answer.body, { status: answer.status ?? 200 })
  }
  return { calls, fetchImpl }
}

function context(api, extra = {}) {
  return { engine: ENGINE, job: JOB, definition: DEFINITION, credential: null, fetchImpl: api.fetchImpl,
    runDeadlineAt: new Date(Date.now() + 600_000).toISOString(), ...extra }
}
const accepted = () => ({ status: 202, body: { task: task(), run: run('queued') } })
const refused = code => Object.assign(new TypeError('fetch failed'), { cause: { code } })

test('submits one pinned anonymous search with upstream correlation and durable task/run references', async () => {
  const api = fakeApi([accepted()])
  const answer = await nightAllAContract.start(context(api))
  assert.deepEqual(answer.upstream, { ref: '42', state: { taskId: 21, runId: 42 } })
  assert.equal(api.calls.length, 1)
  const call = api.calls[0]
  assert.equal(call.url.href, 'http://100.127.0.1:8100/api/tasks')
  assert.equal(call.redirect, 'manual')
  assert.deepEqual(call.body.parameters, PARAMS)
  assert.equal(call.body.connector_id, 'tieba')
  assert.equal(call.body.capability, 'content.search')
  assert.equal(call.body.persist_results, true)
  assert.equal(call.body.max_attempts, 1)
  assert.ok(call.body.timeout_seconds > 0 && call.body.timeout_seconds < 600)
  for (const field of ['credential_id', 'platform_id', 'tieba_detail', 'browser_profile_id']) assert.equal(Object.hasOwn(call.body, field), false)
  assert.equal(call.headers['idempotency-key'], JOB.id)
  assert.equal(call.headers['x-request-id'], JOB.id)
  assert.equal(call.headers.cookie, undefined)
})

test('separate session credential accepts stored JSON; malformed sessions fail before dispatch and never fall back', async () => {
  for (const credential of [SESSION, JSON.stringify(SESSION)]) {
    const api = fakeApi([accepted()])
    await nightAllAContract.start(context(api, { credential, engine: { ...ENGINE, credentialProvider: 'tieba-session' } }))
    assert.equal(api.calls[0].headers.cookie, `dq_admin_session=${SESSION.sessionCookie}`)
    assert.equal(api.calls[0].headers['x-csrf-token'], SESSION.csrfToken)
  }
  for (const credential of [null, '', 'not-json', { sessionCookie: 'x' }, { ...SESSION, csrfToken: 'x\r\ny' },
    { ...SESSION, sessionCookie: 'x; BDUSS=wrong' }, { ...SESSION, authorization: 'bad' }]) {
    const api = fakeApi([])
    const answer = await nightAllAContract.start(context(api, { credential, engine: { ...ENGINE, credentialProvider: 'tieba-session' } }))
    assert.equal(answer.outcome.status, 'failed')
    assert.equal(api.calls.length, 0)
    assert.equal(JSON.stringify(answer).includes('BDUSS'), false)
  }
})

test('unreviewed destinations, capabilities, credentials and parameter fields are refused without network calls', async () => {
  for (const baseUrl of ['https://example.com', 'http://100.127.0.1:8100/api', 'http://user:pass@100.127.0.1:8100',
    'http://100.127.0.1:8100/?x=1', 'http://100.127.0.1:8102', 'http://localhost:8100']) {
    assert.throws(() => nightAllAContract.normalizeBaseUrl(baseUrl), { code: 'invalid_engine_base_url' })
    const api = fakeApi([])
    assert.equal((await nightAllAContract.start(context(api, { engine: { ...ENGINE, baseUrl } }))).outcome.status, 'failed')
    assert.equal(api.calls.length, 0)
  }
  assert.equal(nightAllAContract.normalizeBaseUrl('http://100.127.0.1:8101/'), 'http://100.127.0.1:8101')
  assert.throws(() => nightAllAContract.normalizeConfig({ cookies: 'secret' }), { code: 'invalid_engine_config' })
  for (const definition of [
    { ...DEFINITION, nightAllA: { connectorId: 'tieba', capability: 'user.search' } },
    { ...DEFINITION, taskParameters: () => ({ ...PARAMS, credential_id: 1 }) },
    { ...DEFINITION, taskParameters: () => ({ ...PARAMS, auth_mode: 'auto' }) },
  ]) {
    const api = fakeApi([])
    assert.equal((await nightAllAContract.start(context(api, { definition }))).outcome.status, 'failed')
    assert.equal(api.calls.length, 0)
  }
})

test('ambiguous submissions quarantine without resend; definite connection and input rejection do not charge', async () => {
  for (const answer of [new TypeError('lost response'), { status: 502, body: {} }, { status: 302, body: {} },
    { status: 202, body: { task: task(), run: run('queued', { task_id: 99 }) } },
    { status: 202, body: { task: task({ credential_id: 1 }), run: run('queued') } },
    { status: 202, body: { task: task(), run: run('queued', { parameters: { ...PARAMS, query: 'other' } }) } }]) {
    const api = fakeApi([answer])
    const response = await nightAllAContract.start(context(api))
    assert.equal(response.outcome.status, 'unknown')
    assert.equal(response.outcome.quarantine, 'slot')
    assert.equal(response.outcome.charge, false)
    assert.equal(api.calls.length, 1)
  }
  for (const answer of [refused('ECONNREFUSED'), ...[401, 403, 404, 422, 429].map(status => ({ status, body: {} }))]) {
    const api = fakeApi([answer])
    const response = await nightAllAContract.start(context(api))
    assert.equal(response.outcome.status, 'failed')
    assert.equal(response.outcome.charge, false)
    assert.equal(api.calls.length, 1)
  }
})

test('reconciliation without persisted references never submits or guesses an upstream run', async () => {
  const api = fakeApi([])
  for (const job of [JOB, { ...WAITING, upstreamRef: JOB.id }, { ...WAITING, upstreamState: { taskId: 21, runId: '42' } }]) {
    const answer = await nightAllAContract.check(context(api, { job }))
    assert.equal(answer.outcome.error.code, 'collector_run_reference_missing')
    assert.equal(answer.outcome.status, 'unknown')
  }
  assert.equal(api.calls.length, 0)
})

test('checks persist no new references and verify task, run, capability, attempt and exact query identity', async () => {
  for (const changed of [{ id: 43 }, { task_id: 22 }, { connector_id: 'tieba-native' }, { capability: 'user.search' },
    { attempt: 2 }, { parameters: { ...PARAMS, auth_mode: 'cookie' } }, { status: 'unrecognized' }]) {
    const api = fakeApi([{ body: run('succeeded', changed) }])
    const answer = await nightAllAContract.check(context(api, { job: WAITING }))
    assert.equal(answer.outcome.status, 'unknown')
    assert.equal(answer.outcome.error.code, 'collector_run_identity_mismatch')
    assert.equal(api.calls.length, 1)
    assert.equal(api.calls[0].method, 'GET')
  }
})

test('successful checks return safe public results and a separate atomic ingestion payload with source finish time', async () => {
  const api = fakeApi([{ body: run('succeeded') }])
  const { outcome } = await nightAllAContract.check(context(api, { job: WAITING }))
  assert.equal(outcome.status, 'succeeded')
  assert.equal(outcome.charge, true)
  assert.equal(outcome.itemCount, 1)
  assert.equal(outcome.dataStatus, 'success')
  assert.equal(outcome.result.items[0].body, '帖子摘要')
  assert.equal(outcome.result.items[0].raw, undefined)
  assert.equal(JSON.stringify(outcome.result).includes('original payload'), false)
  assert.equal(outcome.ingestion.items[0].raw.privateEvidence, 'original payload')
  assert.equal(outcome.ingestion.taskId, 21)
  assert.equal(outcome.ingestion.runId, 42)
  assert.equal(outcome.ingestion.capturedAt, '2026-11-18T01:00:00.000Z')
  assert.equal(api.calls[0].url.pathname, '/api/runs/42')
  assert.equal(api.calls[0].url.searchParams.get('include_result'), 'true')
})

test('partial bounded results stay partial; verified empty results need no fabricated persistence receipt', async () => {
  for (const [native, records, expected] of [[result({ complete: false }), run().metrics.records, 'partial'],
    [result({ empty: true }), undefined, 'no_data']]) {
    const api = fakeApi([{ body: run('succeeded', { result: native, metrics: { records } }) }])
    const { outcome } = await nightAllAContract.check(context(api, { job: WAITING }))
    assert.equal(outcome.status, 'succeeded')
    assert.equal(outcome.dataStatus, expected)
  }
})

test('successful run without confirmed source persistence cannot deliver, ingest or charge', async () => {
  for (const records of [undefined, { saved: 1, created: 1, updated: 0 }, { auto_persisted: true, saved: 0, created: 0, updated: 0 },
    { auto_persisted: true, saved: 1, created: 0, updated: 0, skipped: 1 },
    { auto_persisted: true, saved: 1, created: 1, updated: 0, tag_conflicts: 1 }]) {
    const api = fakeApi([{ body: run('succeeded', { metrics: { records } }) }])
    const { outcome } = await nightAllAContract.check(context(api, { job: WAITING }))
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.charge, false)
    assert.equal(outcome.ingestion, undefined)
    assert.equal(outcome.result, undefined)
  }
})

test('malformed, foreign-entity or unbound results and missing source times fail closed after terminal success', async () => {
  const foreign = result(); foreign.items[0].record_type = 'tieba.user'
  const unbound = result(); unbound.items[0].attributes.query = 'other'
  for (const changed of [{ result: foreign }, { result: unbound }, { finished_at: null }, { finished_at: '2026-11-18T09:00:00' },
    { result: { items: [], metrics: {} } }]) {
    const api = fakeApi([{ body: run('succeeded', changed) }])
    const { outcome } = await nightAllAContract.check(context(api, { job: WAITING }))
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.error.code, 'collector_result_unusable')
    assert.equal(outcome.charge, false)
    assert.equal(outcome.ingestion, undefined)
  }
})

test('poll transport failures wait without resubmitting; unreadable and orphaned runs remain unknown', async () => {
  for (const answer of [new TypeError('lost poll'), { status: 503, body: {} }, { body: run('running') }]) {
    const api = fakeApi([answer])
    const result = await nightAllAContract.check(context(api, { job: WAITING }))
    assert.ok(result.nextCheckMs > 0)
    assert.equal(api.calls.length, 1)
  }
  for (const answer of [{ status: 404, body: {} }, { status: 401, body: {} }, { body: run('orphaned') }]) {
    const api = fakeApi([answer])
    const { outcome } = await nightAllAContract.check(context(api, { job: WAITING }))
    assert.equal(outcome.status, 'unknown')
    assert.equal(outcome.quarantine, 'slot')
  }
  const api = fakeApi([{ body: run('failed', { error_message: 'secret diagnostic' }) }])
  const { outcome } = await nightAllAContract.check(context(api, { job: WAITING }))
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.charge, false)
  assert.equal(JSON.stringify(outcome).includes('secret diagnostic'), false)
})

test('abort validates ownership before cancellation and requires a matching terminal run afterwards', async () => {
  const api = fakeApi([{ body: run('running') }, { body: task({ status: 'running' }) }, { body: run('cancelled') }])
  assert.deepEqual(await nightAllAContract.abort(context(api, { job: WAITING })), { stopped: true, status: 'cancelled' })
  assert.deepEqual(api.calls.map(call => `${call.method} ${call.url.pathname}`), ['GET /api/runs/42', 'POST /api/tasks/21/cancel', 'GET /api/runs/42'])
  const pending = fakeApi([{ body: run('running') }, { body: task({ status: 'cancelled' }) }, { body: run('running') }])
  assert.equal((await nightAllAContract.abort(context(pending, { job: WAITING }))).stopped, false, 'task cancellation alone is not a confirmed process stop')
  const foreign = fakeApi([{ body: run('running', { task_id: 99 }) }])
  assert.equal((await nightAllAContract.abort(context(foreign, { job: WAITING }))).stopped, false)
  assert.equal(foreign.calls.length, 1, 'never cancel a mismatched task')
})

test('probe reads only the connector manifest and never starts collection or exposes its payload', async () => {
  const api = fakeApi([{ body: { items: [{ id: 'tieba', manifest_valid: true, capabilities: [{ id: 'content.search' }], last_test: { private: true } }] } }])
  const probe = await nightAllAContract.probe(context(api))
  assert.equal(probe.healthy, true)
  assert.equal(api.calls[0].url.pathname, '/api/connectors')
  assert.equal(api.calls[0].url.search, '?q=tieba')
  assert.equal(api.calls[0].method, 'GET')
  assert.equal(JSON.stringify(probe).includes('private'), false)
})
