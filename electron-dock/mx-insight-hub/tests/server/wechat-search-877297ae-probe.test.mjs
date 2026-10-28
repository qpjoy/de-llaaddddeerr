import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { SOURCE, CONTROL_KEYWORD, ENDPOINT_PATH, boundedAdapter, isPinnedSource, runWechatProbe, savedKeyword }
  from '../../server/ops/verify-wechat-search-877297ae.mjs'

const secret = '私密关键词测试八字'.slice(0, 8)
const upstreamId = '20000000-0000-4000-8000-000000000001'
const noChargeClaim = "Request failed. Please retry. Check the docs below to verify your parameters, test with the default demo parameters, and send the response JSON to support. You won't be charged for this request."
const echo = keyword => ({ keyword, business_type: 'all', sort: 'default', publish_time: 'all', offset: 0, cursor: null, raw: true })
const rejected = keyword => ({ status: 400, body: { detail: { code: 400, request_id: upstreamId, router: ENDPOINT_PATH,
  message: noChargeClaim, params: echo(keyword) } } })
const accepted = keyword => ({ status: 200, body: { code: 200, request_id: upstreamId, router: ENDPOINT_PATH, params: echo(keyword),
  data: { keyword, business_type: 0, total: 9, continue_flag: 1, cursor: 'next-cursor', no_more: null, categories: [{ type: 1 }],
    results: { data: [{ items: [{ title: secret }, { title: secret }], subBoxes: [{ items: [{ desc: secret }] }] }] } } } })

function adapterFor(responses) {
  const sent = []
  const adapter = new TikHubAdapter({ apiKey: 'synthetic-probe-credential', fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body)
    sent.push({ path: new URL(url).pathname, body })
    const next = responses.shift()(body.keyword)
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  } })
  return { adapter, sent }
}
const clock = () => { let now = 0; return () => (now += 5) }

test('a rejected demo keyword stops before the saved keyword is sent', async () => {
  const { adapter, sent } = adapterFor([rejected])
  const report = await runWechatProbe({ keyword: secret, adapter, execute: true, clock: clock() })
  assert.equal(report.supplierCalls, 1)
  assert.deepEqual(sent.map(row => row.body.keyword), [CONTROL_KEYWORD])
  assert.equal(sent[0].path, ENDPOINT_PATH)
  assert.deepEqual(sent[0].body, { keyword: CONTROL_KEYWORD, business_type: 'all', sort: 'default', publish_time: 'all', offset: 0, raw: true })
  assert.equal(report.control.httpStatus, 400)
  assert.equal(report.control.outcome, 'rejected')
  assert.equal(report.control.envelope.location, 'detail')
  assert.equal(report.control.envelope.requestId, upstreamId)
  assert.equal(report.control.envelope.message.classification, 'request_failed_no_charge_claim')
  assert.deepEqual(report.original, { skipped: 'control_not_accepted' })
  assert.equal(report.conclusion, 'demo_also_rejected_supplier_side')
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret))
})

test('an accepted demo sends the saved keyword once and reports a keyword-specific rejection', async () => {
  const { adapter, sent } = adapterFor([accepted, rejected])
  const report = await runWechatProbe({ keyword: secret, adapter, execute: true, clock: clock() })
  assert.equal(report.supplierCalls, 2)
  assert.deepEqual(sent.map(row => row.body.keyword), [CONTROL_KEYWORD, secret])
  assert.deepEqual(report.control.data, { keywordMatches: true, total: 9, boxes: 1, items: 3, continueFlag: true,
    cursorPresent: true, noMore: 'null', categories: 1 })
  assert.deepEqual(report.original.echoed, { keywordMatches: true, business_type: 'all', sort: 'default',
    publish_time: 'all', offset: 0, cursor: 'null', raw: true })
  assert.equal(report.original.keyword.length, 8)
  assert.equal(report.conclusion, 'saved_keyword_rejected_demo_accepted')
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${secret}|next-cursor`))
})

test('both keywords accepted means the original rejection did not recur', async () => {
  const { adapter } = adapterFor([accepted, accepted])
  const report = await runWechatProbe({ keyword: secret, adapter, execute: true, clock: clock() })
  assert.equal(report.original.outcome, 'accepted')
  assert.equal(report.original.data.items, 3)
  assert.equal(report.conclusion, 'saved_keyword_now_accepted')
})

test('dry run never constructs a supplier call and the bounded adapter refuses extra or altered calls', async () => {
  const report = await runWechatProbe({ keyword: secret, adapter: null, execute: false })
  assert.equal(report.supplierCalls, 0)
  assert.equal(report.mode, 'dry_run')
  const { adapter } = adapterFor([accepted, accepted, accepted])
  const bounded = boundedAdapter(adapter)
  await assert.rejects(bounded.forwardNative('wechat.search.search', { params: { keyword: secret, raw: false } }), /probe_request_mismatch/)
  await bounded.forwardNative('wechat.search.search', { params: { keyword: CONTROL_KEYWORD } })
  await bounded.forwardNative('wechat.search.search', { params: { keyword: secret } })
  await assert.rejects(bounded.forwardNative('wechat.search.search', { params: { keyword: secret } }), /probe_call_limit/)
  assert.equal(bounded.calls, 2)
})

test('the saved keyword is used only when the verified archive echoes it unchanged', () => {
  const bytes = Buffer.from(JSON.stringify(rejected(secret).body))
  const pin = { ...SOURCE, bodySize: bytes.length, bodySha256: createHash('sha256').update(bytes).digest('hex') }
  const row = { body_bytes: bytes, acquisition_request: { body: { params: { keyword: secret } } } }
  assert.equal(savedKeyword(row, pin), secret)
  assert.throws(() => savedKeyword(row), /archive_integrity_failed/)
  assert.throws(() => savedKeyword({ ...row, acquisition_request: { body: { params: { keyword: secret, raw: false } } } }, pin), /saved_keyword_unverified/)
  const other = Buffer.from(JSON.stringify(rejected('另一个关键词八字').body))
  assert.throws(() => savedKeyword({ ...row, body_bytes: other },
    { ...pin, bodySize: other.length, bodySha256: createHash('sha256').update(other).digest('hex') }), /saved_keyword_unverified/)
  const source = { request_id: SOURCE.requestId, call_id: SOURCE.callId, usage_request_id: SOURCE.requestId, status: 'committed',
    response_status: 502, provider_key: 'tikhub', operation: SOURCE.operation, outcome: 'rejected', http_status: 400,
    upstream_request_id: SOURCE.upstreamRequestId, body_size: SOURCE.bodySize, body_sha256: SOURCE.bodySha256 }
  assert.equal(isPinnedSource(source), true)
  assert.equal(isPinnedSource({ ...source, outcome: 'succeeded' }), false)
})

test('the command refuses unknown arguments before reading the database', () => {
  const script = fileURLToPath(new URL('../../server/ops/verify-wechat-search-877297ae.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [script, '--retry'], { encoding: 'utf8', env: { PATH: process.env.PATH } })
  assert.equal(run.status, 1)
  assert.deepEqual(JSON.parse(run.stdout), { diagnosticRevision: 'wechat-search-877297ae-probe.v1', errorCode: 'invalid_arguments' })
})
