import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { SocialSearchStateStore, SOCIAL_SEARCH_STATE_VERSION } from '../../server/external-platforms/social-search-store.mjs'
import { YOUTUBE_COMMENTS_VERSION } from '../../server/contracts/youtube-comments.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemoryExternalPlatformStore, PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const ago = milliseconds => new Date(Date.now() - milliseconds).toISOString()
const digest = value => createHash('sha256').update(value).digest('hex')
const clone = value => structuredClone(value)
const scopeHash = 'a'.repeat(64), fingerprint = 'b'.repeat(64)

async function fixture(t, postgres, provider = 'tikhub', path = '/api/v1/data/social/crawl', workflowKind = 'social-account') {
  const platform = workflowKind === 'youtube-comments' ? 'youtube' : provider === 'rapidapi' ? 'twitter' : provider === 'justone' ? 'facebook' : 'weibo'
  const recipe = { operation: 'native.account.posts', endpointKey: 'native.account.posts', endpointVersion: 'v1' }
  const expected = { provider, ...recipe, contractVersion: 'fixture.native.v1' }
  const identity = { tenantId: randomUUID(), consumerId: randomUUID(), apiKeyId: randomUUID(), path, scopeHash }
  const sourceId = randomUUID(), targetId = randomUUID(), callId = randomUUID(), ownCallId = randomUUID(), accountId = randomUUID()
  const capturedAt = ago(1000)
  const manifest = { version: workflowKind === 'youtube-comments' ? YOUTUBE_COMMENTS_VERSION : SOCIAL_SEARCH_STATE_VERSION, scopeHash, previousDeliveryId: null, capturedAt,
    state: { jobs: [{ query: 'fixture', providerPage: 1, providerCursor: null, done: true,
      started: true, upstreamPages: 1, buffer: null, resolvedIdentity: { userId: '42' }, profiles: [{ userId: '42', name: 'Fixture' }] }] }, deliveredIds: [['already-delivered']] }
  const source = { id: sourceId, ...identity, platform, status: 'committed', responseStatus: 200, fingerprint: 'c'.repeat(64),
    acquisitionRequest: { path: identity.path, body: { platform, query: 'fixture', pageSize: 20 }, socialSearch: manifest },
    responseBody: { data: { items: [{ id: 'already-delivered' }] } }, reservedAt: capturedAt }
  delete source.path; delete source.scopeHash
  const target = { ...clone(source), id: targetId, status: 'reserved', responseStatus: null, responseBody: null, fingerprint,
    acquisitionRequest: { path: identity.path, body: { platform, query: 'fixture', pageSize: 20 } } }
  const call = { id: callId, usageRequestId: sourceId, tenantId: identity.tenantId, consumerId: identity.consumerId, apiKeyId: identity.apiKeyId,
    providerKey: provider, operation: recipe.operation, endpointKey: recipe.endpointKey, endpointVersion: recipe.endpointVersion,
    contractVersion: expected.contractVersion, outcome: 'succeeded', httpStatus: 200, businessCode: provider === 'tikhub' ? 200 : provider === 'justone' ? 0 : null, completedAt: capturedAt }
  const payload = provider === 'rapidapi' ? { data: { timeline: { entries: [] } } }
    : { code: provider === 'tikhub' ? 200 : 0, data: { items: [{ id: '9007199254740993', title: 'fixture' }] } }
  const bodyBytes = Buffer.from(JSON.stringify(payload)), archive = { bodyBytes, bodySize: bodyBytes.length, bodySha256: digest(bodyBytes), capturedAt }
  const delivery = { usageRequestId: targetId, tenantId: identity.tenantId, consumerId: identity.consumerId, apiKeyId: identity.apiKeyId, fingerprint, operation: recipe.operation }
  const sources = [callId, ownCallId].map((id, index) => ({ callId: id, rowsHash: 'd'.repeat(64), bodySha256: archive.bodySha256,
    bodySize: archive.bodySize, capturedAt, own: index === 1, expected: clone(expected) }))
  const saved = { ...identity, delivery, capturedAt, sourceMode: 'live', usageUnitsActual: 2, sources,
    responseBody: { data: { items: [{ id: 'first' }, { id: 'second' }] } },
    manifest: { ...manifest, previousDeliveryId: sourceId, deliveredIds: [['first', 'second']] } }
  let db, pool, usageStore, providerStore, providerStores
  const columns = { tenantId: 'tenant_id', consumerId: 'consumer_id', apiKeyId: 'api_key_id', responseStatus: 'response_status', responseBody: 'response_body',
    acquisitionRequest: 'acquisition_request', reservedAt: 'reserved_at', usageRequestId: 'usage_request_id', providerKey: 'provider_key', operation: 'operation',
    endpointKey: 'endpoint_key', endpointVersion: 'endpoint_version', contractVersion: 'contract_version', httpStatus: 'http_status', businessCode: 'business_code', completedAt: 'completed_at',
    bodyBytes: 'body_bytes', bodySize: 'body_size', bodySha256: 'body_sha256', capturedAt: 'captured_at' }
  const sqlValue = value => value && typeof value === 'object' && !(value instanceof Uint8Array) ? JSON.stringify(value) : value
  const insert = async (table, values) => {
    const entries = Object.entries(values)
    await db.query(`INSERT INTO ${table} (${entries.map(([key]) => columns[key] || key).join(',')}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(',')})`, entries.map(([, value]) => sqlValue(value)))
  }
  const update = async (table, idColumn, id, values) => {
    const entries = Object.entries(values)
    await db.query(`UPDATE ${table} SET ${entries.map(([key], index) => `${columns[key] || key}=$${index + 2}`).join(',')} WHERE ${idColumn}=$1`, [id, ...entries.map(([, value]) => sqlValue(value))])
  }
  if (postgres) {
    const { PGlite } = await import(pathToFileURL(modulePath).href)
    db = new PGlite()
    t.after(() => db.close())
    await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control; CREATE SCHEMA billing;
      CREATE TABLE usage_requests (id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,api_key_id uuid,platform text,status text,
        response_status int,fingerprint char(64),acquisition_request jsonb,response_body jsonb,reserved_at timestamptz,
        units_actual int,upstream_latency_ms int,delivery_source_mode text,response_captured_at timestamptz,completed_at timestamptz);
      CREATE TABLE external_platform.provider_calls (id uuid PRIMARY KEY,usage_request_id uuid REFERENCES usage_requests,
        tenant_id uuid,consumer_id uuid,api_key_id uuid,provider_key text,operation text,endpoint_key text,endpoint_version text,
        contract_version text,outcome text,http_status int,business_code int,completed_at timestamptz);
      CREATE TABLE control.external_platform_restricted_raw_responses (provider_call_id uuid REFERENCES external_platform.provider_calls,
        body_bytes bytea,body_size int,body_sha256 text,captured_at timestamptz);
      CREATE TABLE external_platform.gateway_requests (id uuid,provider_key text,tenant_id uuid,consumer_id uuid,usage_request_id uuid REFERENCES usage_requests,
        request_fingerprint char(64),source_mode text,succeeded boolean,response_status int,provider_call_id uuid REFERENCES external_platform.provider_calls);
      CREATE TABLE external_platform.dispatch_leases (consumer_id uuid,operation text,request_fingerprint char(64),owner_request_id uuid,
        expires_at timestamptz,created_at timestamptz DEFAULT now(),UNIQUE(consumer_id,operation,request_fingerprint));
      CREATE TABLE billing.customer_charges (id uuid,usage_request_id uuid,tenant_id uuid,account_id uuid,status text,
        enforcement_mode text,quoted_minor int,currency text,charged_minor int,settled_at timestamptz);
      CREATE TABLE billing.credit_ledger_entries (account_id uuid,tenant_id uuid,charge_id uuid,usage_request_id uuid,kind text,amount_minor int,
        available_delta_minor int,held_delta_minor int,currency text,idempotency_key text UNIQUE,actor text,reason text);`)
    const migration = await readFile(new URL('../../migrations/056_commercial_billing_ledger.sql', import.meta.url), 'utf8')
    const trigger = migration.match(/CREATE OR REPLACE FUNCTION billing\.settle_customer_charge\(\)[\s\S]*?EXECUTE FUNCTION billing\.settle_customer_charge\(\);/u)?.[0]
    assert(trigger)
    await db.exec(trigger)
    await insert('usage_requests', source); await insert('usage_requests', target)
    await insert('external_platform.provider_calls', call)
    await insert('external_platform.provider_calls', { ...call, id: ownCallId, usageRequestId: targetId })
    for (const id of [callId, ownCallId]) await insert('control.external_platform_restricted_raw_responses', { provider_call_id: id, ...archive })
    await insert('billing.customer_charges', { id: randomUUID(), usage_request_id: targetId, tenant_id: identity.tenantId,
      account_id: accountId, status: 'reserved', enforcement_mode: 'enforced', quoted_minor: 9, currency: 'CNY' })
    pool = { query: (sql, args) => db.query(sql, args), connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }) }
    providerStores = Object.fromEntries(['tikhub', 'rapidapi', 'justone'].map(providerKey => [providerKey,
      new PostgresExternalPlatformStore({ pool, providerKey, authorizationPlatform: platform })]))
    providerStore = providerStores[provider]
  } else {
    usageStore = new MemoryStore()
    usageStore.requests.set(sourceId, clone(source)); usageStore.requests.set(targetId, clone(target))
    usageStore.creditAccounts.set(identity.tenantId, { id: accountId, availableMinor: 91, heldMinor: 9, revision: 1, currency: 'CNY' })
    usageStore.customerCharges.set(targetId, { id: randomUUID(), usageRequestId: targetId, accountId, tenantId: identity.tenantId,
      enforcementMode: 'enforced', status: 'reserved', quotedMinor: 9, currency: 'CNY' })
    providerStores = Object.fromEntries(['tikhub', 'rapidapi', 'justone'].map(providerKey => [providerKey,
      new MemoryExternalPlatformStore({ usageStore, providerKey, authorizationPlatform: platform })]))
    providerStore = providerStores[provider]
    providerStore.calls.set(callId, clone(call)); providerStore.calls.set(ownCallId, { ...clone(call), id: ownCallId, usageRequestId: targetId })
    for (const id of [callId, ownCallId]) providerStore.restrictedResponseArchives.set(id, clone(archive))
  }
  const store = new SocialSearchStateStore(providerStores, { platform, workflowKind })
  const setUsage = async (id, changes) => {
    if (!postgres) return Object.assign(usageStore.requests.get(id), clone(changes))
    await db.exec('ALTER TABLE usage_requests DISABLE TRIGGER usage_requests_settle_customer_charge')
    try { await update('usage_requests', 'id', id, changes) }
    finally { await db.exec('ALTER TABLE usage_requests ENABLE TRIGGER usage_requests_settle_customer_charge') }
  }
  const getUsage = async id => {
    if (!postgres) return clone(usageStore.requests.get(id))
    const row = (await db.query('SELECT * FROM usage_requests WHERE id=$1', [id])).rows[0]
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [Object.entries(columns).find(([, name]) => name === key)?.[0] || key, value instanceof Date ? value.toISOString() : value]))
  }
  return { ...identity, identity, expected, store, providerStore, providerStores, usageStore, db, pool, source, target, call, callId, ownCallId, archive, payload, saved, manifest,
    setUsage, getUsage,
    setCall: changes => postgres ? update('external_platform.provider_calls', 'id', callId, changes) : Object.assign(providerStore.calls.get(callId), clone(changes)),
    setArchive: changes => postgres ? update('control.external_platform_restricted_raw_responses', 'provider_call_id', callId, changes) : Object.assign(providerStore.restrictedResponseArchives.get(callId), clone(changes)),
    setArchiveFor: (id, changes) => postgres ? update('control.external_platform_restricted_raw_responses', 'provider_call_id', id, changes) : Object.assign(providerStore.restrictedResponseArchives.get(id), clone(changes)),
    counts: async () => postgres ? { gateways: (await db.query('SELECT count(*)::int n FROM external_platform.gateway_requests')).rows[0].n,
      calls: (await db.query('SELECT count(*)::int n FROM external_platform.provider_calls')).rows[0].n,
      captures: (await db.query('SELECT count(*)::int n FROM billing.credit_ledger_entries')).rows[0].n,
      representative: (await db.query('SELECT provider_call_id FROM external_platform.gateway_requests')).rows[0]?.provider_call_id,
      charge: (await db.query('SELECT status FROM billing.customer_charges')).rows[0].status }
      : { gateways: providerStore.requests.length, calls: providerStore.calls.size, captures: usageStore.creditLedgerEntries.length,
        representative: providerStore.requests[0]?.providerCallId, charge: usageStore.customerCharges.get(targetId).status },
  }
}

for (const postgres of [false, true]) {
  const name = postgres ? 'PGlite' : 'Memory'
  const options = { skip: postgres && !modulePath ? 'Set MX_INSIGHT_TEST_PGLITE_MODULE to the local PGlite module' : false }
  test(`${name} YouTube comment manifests keep their own path/version and settle one parent without rewriting source receipts`, options, async t => {
    const f = await fixture(t, postgres, 'tikhub', '/api/v1/data/youtube/channel-comments', 'youtube-comments')
    const before = await f.getUsage(f.source.id)
    const saved = clone(f.saved)
    saved.usageUnitsActual = 1
    saved.manifest.state.jobs[0].resolvedIdentity = { channelId: 'UC' + 'a'.repeat(22), videos: [{ videoId: 'dQw4w9WgXcQ' }], discoveryDone: true }
    await f.store.commitDelivery(saved)
    const history = await f.store.historyFor({ ...f.identity, previousDeliveryId: f.target.id, jobCount: 1, totalLimit: 20 })
    assert.equal(history.state.jobs[0].resolvedIdentity.videos[0].videoId, 'dQw4w9WgXcQ')
    assert.deepEqual(await f.getUsage(f.source.id), before)
    assert.equal((await f.counts()).captures, 1)
    assert.equal((await f.counts()).charge, 'captured')
    assert.equal(await f.store.pageFor({ ...f.identity, path: '/api/v1/data/youtube/comments', callId: f.callId, expected: f.expected }), null)
    const accountStore = new SocialSearchStateStore(f.providerStores, { platform: 'youtube' })
    await assert.rejects(accountStore.historyFor({ ...f.identity, previousDeliveryId: f.target.id, jobCount: 1, totalLimit: 20 }), { code: 'search_page_unavailable' })
  })
  for (const provider of ['tikhub', 'rapidapi', 'justone']) {
    test(`${name} ${provider} social receipt checks scope, exact contract, outcome, original bytes and TTL without acquisition`, options, async t => {
      const f = await fixture(t, postgres, provider)
      const read = changes => f.store.pageFor({ ...f.identity, callId: f.callId, expected: f.expected, ...changes })
      assert.deepEqual((await read()).payload, f.payload)
      assert.equal(await read({ expected: undefined }), null)
      for (const field of ['tenantId', 'consumerId', 'apiKeyId', 'callId']) assert.equal(await read({ [field]: randomUUID() }), null, field)
      for (const field of ['provider', 'operation', 'endpointKey', 'endpointVersion', 'contractVersion']) {
        assert.equal(await read({ expected: { ...f.expected, [field]: 'changed' } }), null, field)
      }
      assert.equal(await read({ path: '/api/v1/data/social/user-info' }), null)
      assert.equal(await read({ scopeHash: 'e'.repeat(64) }), null)
      for (const change of [{ endpointVersion: 'changed' }, { endpointKey: 'other' }, { operation: 'other' },
        { providerKey: 'changed' }, { contractVersion: 'changed' }, { outcome: 'unknown' }, { outcome: 'succeeded_unusable' },
        { httpStatus: 201 }, { businessCode: provider === 'tikhub' ? 0 : 200 },
        { completedAt: ago(25 * 3600000) }, { completedAt: ago(-3600000) }]) {
        await f.setCall(change); assert.equal(await read(), null, JSON.stringify(change)); await f.setCall(f.call)
      }
      for (const change of [{ bodySha256: null }, { bodySha256: '0'.repeat(64) }, { bodySize: f.archive.bodySize + 1 },
        { capturedAt: ago(25 * 3600000) }, { capturedAt: ago(-3600000) }]) {
        await f.setArchive(change); assert.equal(await read(), null, JSON.stringify(change)); await f.setArchive(f.archive)
      }
      const invalidBodies = [Buffer.from([255]), Buffer.from('null'), Buffer.from('{"data":"\\u0000"}'),
        Buffer.from('{"code":200,"data":{},"errors":[{"message":"failed"}]}'),
        Buffer.from(JSON.stringify({ code: 200, data: 'a'.repeat(8388608) }))]
      // TikHub's own error envelope is rejected by its business code; RapidAPI
      // instead records a successful HTTP response with a separate errors list.
      invalidBodies[3] = Buffer.from(JSON.stringify(provider === 'rapidapi'
        ? { data: {}, errors: [{ message: 'failed' }] } : { code: provider === 'tikhub' ? 0 : 200, data: {} }))
      for (const bytes of invalidBodies) {
        await f.setArchive({ bodyBytes: bytes, bodySize: bytes.length, bodySha256: digest(bytes) })
        assert.equal(await read(), null)
      }
      assert.deepEqual(await f.counts(), { gateways: 0, calls: 2, captures: 0, representative: undefined, charge: 'reserved' })
    })

    test(`${name} ${provider} social finalization retains complete overflow/profile state and settles exactly once`, options, async t => {
      const f = await fixture(t, postgres, provider), original = await f.getUsage(f.source.id)
      const saved = clone(f.saved)
      saved.manifest.state.jobs[0] = { ...saved.manifest.state.jobs[0], done: false,
        providerCursor: { after: 'source-page' }, buffer: { callId: f.ownCallId, offset: 2,
          hash: saved.sources[1].rowsHash, projectionHash: 'e'.repeat(64), expected: clone(f.expected),
          providerPage: 1, providerCursor: { after: 'source-page' } } }
      for (const field of ['projectionHash', 'expected']) {
        const invalid = clone(saved)
        delete invalid.manifest.state.jobs[0].buffer[field]
        await assert.rejects(f.store.commitDelivery(invalid), { code: 'search_page_unavailable' })
      }
      for (const field of ['tenantId', 'consumerId', 'apiKeyId']) {
        await assert.rejects(f.store.commitDelivery({ ...saved, delivery: { ...saved.delivery, [field]: randomUUID() } }), { code: 'search_page_unavailable' })
      }
      for (const sources of [[saved.sources[0], saved.sources[0]], saved.sources.map((source, index) => index
        ? { ...source, bodySha256: '0'.repeat(64) } : source), saved.sources.map(source => ({ ...source, expected: { ...source.expected, operation: 'profile.other' } }))]) {
        await assert.rejects(f.store.commitDelivery({ ...saved, sources }), { code: 'search_page_unavailable' })
        assert.equal((await f.getUsage(f.target.id)).status, 'reserved')
        assert.equal((await f.counts()).captures, 0)
      }
      await f.store.commitDelivery(saved)
      const manifest = (await f.getUsage(f.target.id)).acquisitionRequest.socialSearch
      assert.deepEqual(manifest.sources, saved.sources)
      assert.deepEqual(manifest.state.jobs, saved.manifest.state.jobs)
      assert.deepEqual(await f.getUsage(f.source.id), original)
      assert.deepEqual(await f.counts(), { gateways: 1, calls: 2, captures: 1, representative: f.ownCallId, charge: 'captured' })
      await assert.rejects(f.store.commitDelivery(saved), { code: 'search_page_unavailable' })
      assert.equal((await f.counts()).captures, 1)
      const history = await f.store.historyFor({ ...f.identity, previousDeliveryId: f.target.id, jobCount: 1, totalLimit: 20 })
      assert.deepEqual([...history.seenIds[0]], ['first', 'second', 'already-delivered'])
      assert.deepEqual(history.state.jobs[0].profiles, [{ userId: '42', name: 'Fixture' }])
      const carry = await f.store.pageFor({ ...f.identity, callId: f.ownCallId, expected: f.expected })
      assert.deepEqual(carry.payload, f.payload)
      assert.equal(carry.bodySha256, digest(f.archive.bodyBytes))
    })
  }

  test(`${name} social history rejects scope drift, stale/cyclic parents and malformed job/profile state`, options, async t => {
    const f = await fixture(t, postgres), input = { ...f.identity, previousDeliveryId: f.source.id, jobCount: 1, totalLimit: 20 }
    assert.deepEqual([...(await f.store.historyFor(input)).seenIds[0]], ['already-delivered'])
    for (const changes of [{ scopeHash: 'f'.repeat(64) }, { apiKeyId: randomUUID() }, { path: '/api/v1/data/social/user-info' }, { jobCount: 2 }]) {
      await assert.rejects(f.store.historyFor({ ...input, ...changes }), { code: 'search_page_unavailable' })
    }
    for (const changes of [{ previousDeliveryId: f.source.id }, { capturedAt: ago(25 * 3600000) }, { version: 'unreviewed.v2' },
      { deliveredIds: [[123]] }, { state: { jobs: [] } }, { state: { jobs: [null] } },
      { state: { jobs: [{ ...f.manifest.state.jobs[0], upstreamPages: '1' }] } },
      { state: { jobs: [{ ...f.manifest.state.jobs[0], profiles: 'not profiles' }] } },
      { state: { jobs: [{ ...f.manifest.state.jobs[0], dispatchedTokens: ['supplier-token-must-not-be-stored-here'] }] } },
      { state: { jobs: [{ ...f.manifest.state.jobs[0], dispatchedTokens: Array(19).fill('a'.repeat(64)) }] } },
      { state: { jobs: [{ ...f.manifest.state.jobs[0], resolvedIdentity: 'unbound identity' }] } }]) {
      await f.setUsage(f.source.id, { acquisitionRequest: { ...f.source.acquisitionRequest, socialSearch: { ...f.manifest, ...changes } } })
      await assert.rejects(f.store.historyFor(input), { code: 'search_page_unavailable' })
    }
  })

  test(`${name} social parent lease serializes buffered delivery without supplier calls`, options, async t => {
    const f = await fixture(t, postgres), lease = { consumerId: f.consumerId, fingerprint, ownerRequestId: f.target.id, expiresAt: ago(-60000) }
    assert.equal(await f.store.acquireDeliveryLease(lease), true)
    assert.equal(await f.store.acquireDeliveryLease({ ...lease, ownerRequestId: randomUUID() }), false)
    await f.store.releaseDeliveryLease({ ...lease, ownerRequestId: randomUUID() })
    assert.equal(await f.store.acquireDeliveryLease({ ...lease, ownerRequestId: randomUUID() }), false)
    await f.store.releaseDeliveryLease(lease)
    assert.equal(await f.store.acquireDeliveryLease(lease), true)
    // An ended unknown parent no longer has an equal-request check; same-key replay owns it.
    assert.equal(typeof f.store.unknownFor, 'undefined')
  })

  test(`${name} user-info sources and profile resolver receipts cannot be reused under crawl or post descriptors`, options, async t => {
    const f = await fixture(t, postgres, 'tikhub', '/api/v1/data/social/user-info')
    const expected = { ...f.expected, operation: 'native.account.profile', endpointKey: 'native.account.profile' }
    await f.setCall({ operation: expected.operation, endpointKey: expected.endpointKey })
    assert.equal(await f.store.pageFor({ ...f.identity, callId: f.callId, expected: f.expected }), null)
    assert.deepEqual((await f.store.pageFor({ ...f.identity, callId: f.callId, expected })).payload, f.payload)
    assert.equal(await f.store.pageFor({ ...f.identity, path: '/api/v1/data/social/crawl', callId: f.callId, expected }), null)
  })
}

test('PGlite social finalization rolls back settlement, manifest and response if gateway evidence fails', { skip: !modulePath }, async t => {
  const f = await fixture(t, true), original = await f.getUsage(f.target.id)
  await f.db.exec(`CREATE FUNCTION control.reject_social_gateway() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic gateway failure'; END; $$;
    CREATE TRIGGER reject_social_gateway BEFORE INSERT ON external_platform.gateway_requests FOR EACH ROW EXECUTE FUNCTION control.reject_social_gateway();`)
  await assert.rejects(f.store.commitDelivery(f.saved), /synthetic gateway failure/)
  assert.deepEqual(await f.getUsage(f.target.id), original)
  assert.deepEqual(await f.counts(), { gateways: 0, calls: 2, captures: 0, representative: undefined, charge: 'reserved' })
})

test('social stores reject unrelated ledgers and retain provider ownership when a delivery carries mixed receipts', async t => {
  const f = await fixture(t, false)
  const other = new MemoryExternalPlatformStore({ usageStore: new MemoryStore(), providerKey: 'rapidapi' })
  assert.throws(() => new SocialSearchStateStore({ tikhub: f.providerStore, rapidapi: other }, { platform: 'weibo' }), /share usage/)
  const rapid = f.providerStores.rapidapi, expected = { ...f.expected, provider: 'rapidapi' }
  const payload = { data: { user: { result: { rest_id: '42' } } } }, bodyBytes = Buffer.from(JSON.stringify(payload))
  rapid.calls.set(f.ownCallId, { ...f.providerStore.calls.get(f.ownCallId), providerKey: 'rapidapi', businessCode: null })
  rapid.restrictedResponseArchives.set(f.ownCallId, { ...f.archive, bodyBytes, bodySize: bodyBytes.length, bodySha256: digest(bodyBytes) })
  f.providerStore.calls.delete(f.ownCallId); f.providerStore.restrictedResponseArchives.delete(f.ownCallId)
  const saved = clone(f.saved)
  saved.sources[1] = { ...saved.sources[1], expected, bodySize: bodyBytes.length, bodySha256: digest(bodyBytes) }
  await f.store.commitDelivery(saved)
  assert.equal(rapid.requests.length, 1)
  assert.equal(f.providerStore.requests.length, 0)
  assert.equal(rapid.requests[0].providerKey, 'rapidapi')
  assert.equal(f.usageStore.creditLedgerEntries.length, 1)
  assert.deepEqual((await f.getUsage(f.target.id)).acquisitionRequest.socialSearch.sources, saved.sources)
})
