import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbe, INCIDENT, SLOTS, inspectArchive } from '../../server/ops/probe-instagram-account-54156c46.mjs'
import { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch } from '../../server/contracts/hub-social-compat.mjs'
import { normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'
import { projectPage } from '../../server/external-platforms/social-account-workflow.mjs'

const keyId = '10000000-0000-4000-8000-000000000001'
const consumerId = '10000000-0000-4000-8000-000000000002'
const tenantId = '10000000-0000-4000-8000-000000000003'
const privateAccount = 'private_fixture_account'
const privateText = 'PRIVATE-RAW-AND-ERROR-MUST-NOT-LEAK'
const demoSecret = 'mih_demo_PRIVATE-CREDENTIAL-MUST-NOT-LEAK'
const adminSecret = 'PRIVATE-ADMIN-CREDENTIAL-MUST-NOT-LEAK'
const now = '2026-11-20T08:00:00.000Z'
const contracts = { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch, normalizeNativeForwardingRequest, projectPage }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const badProfile = () => ({ code: 200, message: privateText, data: { status: false, error: privateText, error_code: 27 } })
const goodProfile = username => ({ code: 200, data: { user: { id: '42', username, biography: privateText } } })
const archive = payload => {
  const body_bytes = Buffer.from(JSON.stringify(payload))
  return { body_bytes, body_size: body_bytes.length, body_sha256: sha(body_bytes), captured_at: now }
}
const safeReport = report => assert.doesNotMatch(JSON.stringify(report), /private_fixture_account|PRIVATE-|mih_demo_|Bearer /)

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'ig-account-probe-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const sourceArchive = archive(badProfile())
  const incident = { ...INCIDENT, bodySize: sourceArchive.body_size, bodySha256: sourceArchive.body_sha256 }
  const snapshot = { method: 'POST', path: '/api/v1/data/social/crawl',
    body: { platform: 'instagram', username: options.originalUsername || privateAccount, count: 50 } }
  const original = { id: incident.requestId, tenant_id: tenantId, consumer_id: consumerId, api_key_id: keyId,
    platform: 'instagram', status: 'committed', response_status: 502, error_code: 'invalid_social_contract', acquisition_request: snapshot }
  const step = buildHubSocialCompatDispatch(normalizeHubSocialCompatRequest('crawl', snapshot.body).jobs[0], { page: 1, pageSize: 50 })
  const targetUsername = step.upstreamQuery.username
  const sourceCall = { id: incident.callId, usage_request_id: incident.requestId, tenant_id: tenantId,
    consumer_id: consumerId, api_key_id: keyId, call_ordinal: 0, provider_key: 'tikhub', marketplace: 'instagram',
    operation: step.endpointKey, endpoint_key: step.endpointKey, endpoint_version: step.endpointVersion,
    contract_version: step.endpointContractVersion, outcome: 'succeeded_unusable', http_status: 200, business_code: 200,
    error_code: 'invalid_social_contract', upstream_request_id: incident.upstreamRequestId, billed: true, ...sourceArchive }
  const usages = new Map(), calls = new Map(), archives = new Map(), requests = [], statements = []
  let inFlight = 0, maxInFlight = 0, paid = 0, released = 0
  const client = { release() { released++ }, async query(sql, values = []) {
    statements.push({ sql, values })
    assert.match(sql.trim(), /^(BEGIN|SET|SELECT|ROLLBACK)\b/i, 'diagnostic SQL must be read-only')
    if (options.databaseError) throw new Error(privateText + demoSecret)
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true, acquired: true, ok: true }] }
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] }
    if (sql.includes('ig-account-probe:original')) return { rows: options.missingOriginal ? [] : [original] }
    if (sql.includes('ig-account-probe:source-call')) return { rows: options.missingSource ? [] : [sourceCall] }
    if (sql.includes('ig-account-probe:priors')) return { rows: [...usages.values()] }
    if (sql.includes('ig-account-probe:calls')) {
      const usage = [...usages.values()].find(row => values.includes(row.id))
      const call = usage && calls.get(usage.id)
      return { rows: call ? options.duplicateCall ? [call, { ...call, id: '30000000-0000-4000-8000-000000000099' }] : [call] : [] }
    }
    if (sql.includes('ig-account-probe:archive')) {
      const call = [...calls.values()].find(row => values.includes(row.id) || values.includes(row.usage_request_id))
      return { rows: call && archives.has(call.id) ? [archives.get(call.id)] : [] }
    }
    if (/^(BEGIN|SET|ROLLBACK)\b/i.test(sql.trim())) return { rows: [] }
    assert.fail(`Unexpected read-only query: ${sql.slice(0, 100)}`)
  } }
  // Windows cannot open a directory for fsync. Keep actual exclusive files and
  // file fsyncs; only the Linux directory durability operation is substituted.
  const fsImpl = process.platform === 'win32' ? { ...fs, async open(path, flags, mode) {
    if (path === directory && flags === 'r') return { async sync() {}, async close() {} }
    return fs.open(path, flags, mode)
  } } : fs
  const input = { pool: { connect: async () => client }, fsImpl, incident,
    env: { MX_INSIGHT_ADMIN_TOKEN: adminSecret, MX_INSIGHT_PUBLIC_URL: 'https://hub.example.test/', MX_IG_PROBE_RUN_DIR: directory },
    loadContracts: async () => contracts, clock: () => new Date(now).getTime(),
    async fetchImpl(url, request = {}) {
      requests.push({ url: String(url), ...request })
      assert.equal(request.redirect, 'error')
      if (String(url).endsWith('/demo-credentials')) {
        assert.equal(request.method, 'POST')
        assert.deepEqual(JSON.parse(request.body), { keyId })
        assert.equal(request.headers['x-mx-insight-admin-token'], adminSecret)
        return Response.json({ data: { keyId: options.wrongKey ? tenantId : keyId, consumerId, secret: demoSecret } })
      }
      if (String(url).endsWith('/api/v1/data/capabilities')) {
        assert.equal(request.headers.authorization, `Bearer ${demoSecret}`)
        return Response.json({ data: { platforms: [{ platform: 'social', ready: true }],
          capabilities: options.noGrant ? [] : SLOTS.map(slot => ({ capability: `native.${slot.key}`, ready: !options.notReady })) } })
      }
      const slot = SLOTS.find(entry => entry.idempotencyKey === request.headers['idempotency-key'])
      assert.ok(slot, 'only the three fixed purchase identities may be dispatched')
      assert.equal(String(url), `https://hub.example.test/api/v1/data/native/${slot.key}`)
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.authorization, `Bearer ${demoSecret}`)
      assert.deepEqual(JSON.parse(request.body), { deliveryMode: 'live_only', params: { username: slot.target ? targetUsername : 'instagram' } })
      const marker = JSON.parse(await fs.readFile(join(directory, `${slot.name}.json`), 'utf8'))
      assert.equal(marker.state, 'dispatch_started')
      assert.equal(marker.idempotencyKey, slot.idempotencyKey)
      safeReport(marker)
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); paid++
      assert.ok(paid <= 3)
      await new Promise(resolve => setImmediate(resolve))
      const usageId = `20000000-0000-4000-8000-${String(paid).padStart(12, '0')}`
      const callId = `30000000-0000-4000-8000-${String(paid).padStart(12, '0')}`
      const normalized = normalizeNativeForwardingRequest(slot.key, JSON.parse(request.body))
      const payload = options.firstUsable || slot.name === 'target-v3' || slot.name === 'control-v2'
        ? goodProfile(slot.target ? targetUsername : 'instagram') : badProfile()
      if (!options.noReceipt) {
        usages.set(slot.idempotencyKey, { id: usageId, tenant_id: tenantId, consumer_id: consumerId, api_key_id: keyId,
          idempotency_key: slot.idempotencyKey, platform: 'social', status: options.unknown ? options.receiptStatus || 'unknown' : 'committed',
          response_status: options.unknown ? null : 200, acquisition_request: { method: 'POST',
            path: `/api/v1/data/native/${slot.key}`, body: JSON.parse(request.body) } })
        calls.set(usageId, { id: callId, usage_request_id: usageId, tenant_id: options.wrongCallOwner ? keyId : tenantId, consumer_id: consumerId,
          api_key_id: keyId, call_ordinal: options.invalidOrdinal ? 1 : 0, provider_key: 'tikhub', marketplace: 'instagram',
          operation: normalized.operation, endpoint_key: normalized.endpointKey, endpoint_version: normalized.endpointVersion,
          contract_version: normalized.endpointContractVersion, outcome: options.unknown ? 'unknown' : 'succeeded',
          http_status: options.unknown ? null : 200, business_code: options.unknown ? null : 200,
          billed: options.unknown ? null : true, item_count: 0, ...archive(payload) })
        archives.set(callId, archive(payload))
      }
      inFlight--
      if (options.unknown || options.noReceipt) throw new Error(privateText + demoSecret + privateAccount)
      return Response.json({ requestId: usageId, data: { data: payload.data } }, { headers: { 'x-mx-insight-request-id': usageId } })
    } }
  return { input, original, sourceCall, sourceArchive, step, directory, usages, calls, requests, statements,
    get paid() { return paid }, get maxInFlight() { return maxInFlight }, get released() { return released } }
}

test('inspection is the default and performs no HTTP or creates purchase markers', async t => {
  const f = await fixture(t)
  const report = await runProbe(f.input)
  assert.equal(f.requests.length, 0)
  assert.equal(f.paid, 0)
  assert.deepEqual(await fs.readdir(f.directory), [])
  assert.ok(f.released > 0)
  assert.ok(f.statements.some(({ sql }) => /READ ONLY/i.test(sql)))
  safeReport(report)
})

test('inspection after purchases reports each fixed receipt and archive without HTTP or filesystem writes', async t => {
  const f = await fixture(t)
  await runProbe({ ...f.input, execute: true })
  assert.equal(f.paid, 3)
  const requestCount = f.requests.length
  const report = await runProbe({ ...f.input, fsImpl: { ...f.input.fsImpl, async mkdir() { assert.fail('inspection must not create a directory') } } })
  assert.equal(f.requests.length, requestCount)
  assert.equal(f.paid, 3)
  for (const slot of SLOTS) {
    const row = report.slots.find(entry => entry.slot === slot.name)
    assert.ok(row, JSON.stringify(report))
    assert.equal(row.requestId, f.usages.get(slot.idempotencyKey).id)
    assert.equal(row.savedStatus, 'committed')
    assert.equal(row.archive.state, 'verified')
    assert.equal(row.call.callId, f.calls.get(row.requestId).id)
  }
  safeReport(report)
})

test('inspection exposes an uncertain saved receipt and call without credential minting or another purchase', async t => {
  for (const receiptStatus of ['unknown', 'reserved']) {
    const f = await fixture(t, { unknown: true, receiptStatus })
    await runProbe({ ...f.input, execute: true })
    assert.equal(f.paid, 1)
    const requestCount = f.requests.length
    const report = await runProbe(f.input)
    assert.equal(f.requests.length, requestCount)
    const row = report.slots.find(entry => entry.slot === SLOTS[0].name)
    assert.ok(row, JSON.stringify(report))
    assert.equal(row.requestId, f.usages.get(SLOTS[0].idempotencyKey).id)
    assert.equal(row.savedStatus, receiptStatus)
    assert.equal(row.calls[0].callId, f.calls.get(row.requestId).id)
    assert.equal(row.calls[0].outcome, 'unknown')
    safeReport(report)
  }
})

test('native verification uses the original key and at most three serial purchases, then never repeats them', async t => {
  const f = await fixture(t)
  const report = await runProbe({ ...f.input, execute: true })
  assert.equal(f.paid, 3, JSON.stringify(report))
  assert.equal(f.maxInFlight, 1)
  assert.deepEqual([...f.usages.keys()], SLOTS.map(slot => slot.idempotencyKey))
  safeReport(report)
  const again = await runProbe({ ...f.input, execute: true })
  assert.equal(f.paid, 3)
  safeReport(again)
})

test('a usable original target stops before control or alternate endpoint purchases', async t => {
  const f = await fixture(t, { firstUsable: true })
  const report = await runProbe({ ...f.input, execute: true })
  assert.equal(f.paid, 1, JSON.stringify(report))
  assert.deepEqual([...f.usages.keys()], [SLOTS[0].idempotencyKey])
  safeReport(report)
})

test('the Instagram control target is case-insensitively deduplicated and remains inspectable after two purchases', async t => {
  const f = await fixture(t, { originalUsername: 'InStAgRaM' })
  const report = await runProbe({ ...f.input, execute: true })
  assert.equal(f.paid, 2, JSON.stringify(report))
  assert.equal(f.maxInFlight, 1)
  assert.deepEqual([...f.usages.keys()], [SLOTS[0].idempotencyKey, SLOTS[2].idempotencyKey])
  const requestCount = f.requests.length
  const inspection = await runProbe(f.input)
  assert.equal(f.requests.length, requestCount)
  assert.notEqual(inspection.stoppedReason, 'prior_order_invalid')
  for (const slot of [SLOTS[0], SLOTS[2]]) {
    const row = inspection.slots.find(entry => entry.slot === slot.name)
    assert.ok(row, JSON.stringify(inspection))
    assert.equal(row.requestId, f.usages.get(slot.idempotencyKey).id)
    assert.equal(row.savedStatus, 'committed')
    assert.equal(row.archive.state, 'verified')
  }
  safeReport(report); safeReport(inspection)
})

test('unknown results stop the sequence and preserve the attempt without exposing errors', async t => {
  const f = await fixture(t, { unknown: true })
  const report = await runProbe({ ...f.input, execute: true })
  assert.equal(f.paid, 1, JSON.stringify(report))
  safeReport(report)
  await runProbe({ ...f.input, execute: true })
  assert.equal(f.paid, 1)
  safeReport(JSON.parse(await fs.readFile(join(f.directory, `${SLOTS[0].name}.json`), 'utf8')))
})

test('an attempt marker without any ledger receipt still prevents redispatch', async t => {
  const f = await fixture(t, { noReceipt: true })
  safeReport(await runProbe({ ...f.input, execute: true }))
  assert.equal(f.paid, 1)
  assert.equal(f.usages.size, 0)
  const requestCount = f.requests.length
  const inspection = await runProbe(f.input)
  const row = inspection.slots.find(entry => entry.slot === SLOTS[0].name)
  assert.equal(row.state, 'no_saved_receipt')
  assert.equal(row.markerState, 'present')
  assert.equal(row.dispatchState, 'not_proven_by_absent_receipt')
  assert.equal(f.requests.length, requestCount)
  safeReport(inspection)
  safeReport(await runProbe({ ...f.input, execute: true }))
  assert.equal(f.paid, 1)
})

test('an empty or malformed pre-existing marker is a spent attempt, never repaired or ignored', async t => {
  for (const contents of ['', '{']) {
    const f = await fixture(t)
    const marker = join(f.directory, `${SLOTS[0].name}.json`)
    await fs.writeFile(marker, contents)
    safeReport(await runProbe({ ...f.input, execute: true }))
    assert.equal(f.requests.length, 0)
    assert.equal(f.paid, 0)
    assert.equal(await fs.readFile(marker, 'utf8'), contents)
  }
})

test('old committed or released receipts block fresh purchases regardless of expiry', async t => {
  for (const status of ['committed', 'released', 'unknown']) {
    const f = await fixture(t)
    f.usages.set(SLOTS[0].idempotencyKey, { id: '20000000-0000-4000-8000-000000000099',
      tenant_id: tenantId, consumer_id: consumerId, api_key_id: keyId, idempotency_key: SLOTS[0].idempotencyKey,
      platform: 'social', status, response_status: status === 'committed' ? 200 : 502,
      completed_at: '2000-01-01T00:00:00Z', lease_expires_at: '2000-01-01T00:00:00Z',
      acquisition_request: { method: 'POST', path: `/api/v1/data/native/${SLOTS[0].key}`,
        body: { deliveryMode: 'live_only', params: { username: privateAccount } } } })
    safeReport(await runProbe({ ...f.input, execute: true }))
    assert.equal(f.paid, 0)
    for (const { sql } of f.statements.filter(entry => entry.sql.includes('ig-account-probe:priors'))) {
      assert.doesNotMatch(sql, /(?:completed_at|expires_at)\s*[<>]|status\s*=/i)
    }
  }
})

test('unusable credentials, missing grants and unavailable operations never purchase', async t => {
  for (const options of [{ wrongKey: true }, { noGrant: true }, { notReady: true }]) {
    const f = await fixture(t, options)
    safeReport(await runProbe({ ...f.input, execute: true }))
    assert.equal(f.paid, 0)
    assert.deepEqual(await fs.readdir(f.directory), [])
  }
})

test('ambiguous calls, wrong call owners and noninitial ordinals stop before further purchases', async t => {
  for (const options of [{ duplicateCall: true }, { wrongCallOwner: true }, { invalidOrdinal: true }]) {
    const f = await fixture(t, options)
    const report = await runProbe({ ...f.input, execute: true })
    assert.equal(f.paid, 1, JSON.stringify(report))
    assert.equal(report.stoppedReason, 'saved_call_unverified')
    safeReport(report)
  }
})

test('invalid source identity, snapshot, archive size or hash prevents all HTTP', async t => {
  const patches = [
    f => { f.original.acquisition_request.method = 'GET' },
    f => { f.original.acquisition_request.bodyOmitted = 'oversize' },
    f => { f.original.acquisition_request.body.params = { cursor: 'private-cursor' } },
    f => { f.original.acquisition_request.body.usernames = ['second_private_account'] },
    f => { f.sourceCall.call_ordinal = 1 },
    f => { f.sourceCall.marketplace = 'threads' },
    f => { f.sourceCall.tenant_id = keyId },
    f => { f.sourceCall.api_key_id = consumerId },
    f => { f.sourceCall.endpoint_version = 'unverified-version' },
    f => { f.sourceCall.body_size++ },
    f => { f.sourceCall.body_sha256 = '0'.repeat(64) },
    f => { f.sourceCall.body_bytes = Buffer.from('{}') },
  ]
  for (const patch of patches) {
    const f = await fixture(t); patch(f)
    safeReport(await runProbe({ ...f.input, execute: true }))
    assert.equal(f.requests.length, 0)
    assert.equal(f.paid, 0)
  }
})

test('archive analysis validates bytes before projection and distinguishes unusable from valid profiles', async t => {
  const f = await fixture(t)
  const inspect = row => inspectArchive(row, { step: f.step, projectPage })
  const unusable = inspect(archive(badProfile())), usable = inspect(archive(goodProfile(privateAccount)))
  assert.equal(unusable.usable, false)
  assert.equal(unusable.projection.reason, 'profile_identity_missing')
  assert.equal(usable.usable, true)
  assert.equal(usable.projection.profileCount, 1)
  assert.equal(usable.projection.itemCount, 0, 'a valid profile is not a content page')
  safeReport(unusable); safeReport(usable)
  let projections = 0
  inspectArchive({ ...archive(goodProfile(privateAccount)), body_sha256: '0'.repeat(64) },
    { step: f.step, projectPage() { projections++; throw new Error(privateText) } })
  assert.equal(projections, 0)
})

test('a valid profile with contradictory missing-account text is not declared an absent account', async t => {
  const f = await fixture(t)
  const result = inspectArchive(archive({ ...goodProfile(privateAccount), message: 'user not found' }), { step: f.step, projectPage })
  assert.equal(result.projection.state, 'accepts')
  assert.equal(result.accountNotFoundText, true)
  assert.equal(result.accountNotFoundSignal, false)
  assert.notEqual(result.accountNotFound, true)
  assert.equal(result.usable, false, 'contradictory evidence is not a usable profile or proof of an absent account')
  safeReport(result)
})

test('read failures and invalid CLI invocation cannot leak accounts, credentials or raw text', async t => {
  const f = await fixture(t, { databaseError: true })
  safeReport(await runProbe({ ...f.input, execute: true }))
  assert.equal(f.requests.length, 0)
  const env = { ...process.env, MX_INSIGHT_ADMIN_TOKEN: adminSecret, MX_INSIGHT_PUBLIC_URL: `https://example.invalid/?token=${privateText}` }
  delete env.DATABASE_URL
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../server/ops/probe-instagram-account-54156c46.mjs', import.meta.url)), '--invalid'],
    { env, encoding: 'utf8', timeout: 10_000 })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout + result.stderr, /private_fixture_account|PRIVATE-|mih_demo_|Bearer /)
})
