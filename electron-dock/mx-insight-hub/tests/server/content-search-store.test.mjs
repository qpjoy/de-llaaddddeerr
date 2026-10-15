import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { ContentSearchStateStore } from '../../server/external-platforms/content-search-store.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemoryExternalPlatformStore, PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { normalizeTikHubContentSearchRequest, projectTikHubContentSearch, contentSearchDataItem, TIKHUB_CONTENT_SEARCH_VERSION } from '../../server/contracts/tikhub-content-search.mjs'
import { isPostgresSafeJsonValue } from '../../server/core/postgres-json.mjs'
import { NATIVE_FORWARDING_VERSION } from '../../server/contracts/native-forwarding.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const ago = milliseconds => new Date(Date.now() - milliseconds).toISOString()
const digest = value => createHash('sha256').update(value).digest('hex')
const clone = value => structuredClone(value)
const scopeHash = 'a'.repeat(64), fingerprint = 'b'.repeat(64)

function unsafeKuaishouArchive(capturedAt, metadataLiteral) {
  const data = { mixFeeds: Array.from({ length: 3 }, (_, index) => ({
    photoId: `fixture-photo-${index}`, caption: `Fixture post ${index}`, like_count: index,
  })), has_more: false }
  // Keep the original lexical values: JSON.stringify would rewrite -0/Infinity.
  const bodyBytes = Buffer.from(`{"code":200,"data":${JSON.stringify(data).slice(0, -1)},"optionalMetadata":${metadataLiteral}}}`)
  const payload = JSON.parse(bodyBytes.toString('utf8'))
  const projected = projectTikHubContentSearch({ publicBody: { data: payload.data, meta: { capturedAt } } },
    normalizeTikHubContentSearchRequest({ platform: 'kuaishou', query: 'fixture', pageSize: 2 }))
  assert.equal(isPostgresSafeJsonValue(payload), false)
  assert.equal(isPostgresSafeJsonValue(projected.acquiredItems), true)
  assert.equal(isPostgresSafeJsonValue(projected.acquiredItems.map(contentSearchDataItem)), true)
  assert.equal(isPostgresSafeJsonValue(projected.providerPage), true)
  return { payload, projected, bodyBytes, bodySize: bodyBytes.length, bodySha256: digest(bodyBytes), capturedAt }
}

async function fixture(t, postgres, platform = 'bilibili') {
  const identity = { tenantId: randomUUID(), consumerId: randomUUID(), apiKeyId: randomUUID(), path: '/api/v1/data/search', scopeHash }
  const sourceId = randomUUID(), targetId = randomUUID(), callId = randomUUID(), ownCallId = randomUUID(), accountId = randomUUID()
  const capturedAt = ago(1000), recipe = normalizeTikHubContentSearchRequest({ platform, query: 'fixture' })
  const manifest = { version: TIKHUB_CONTENT_SEARCH_VERSION, scopeHash, previousDeliveryId: null, capturedAt,
    state: { jobs: [{ query: 'fixture', providerPage: 1, providerCursor: null, done: true,
      started: true, upstreamPages: 1, buffer: null }] }, deliveredIds: [['already-delivered']] }
  const source = { id: sourceId, ...identity, platform, status: 'committed', responseStatus: 200, fingerprint: 'c'.repeat(64),
    acquisitionRequest: { path: identity.path, body: { platform, query: 'fixture', pageSize: 20 }, contentSearch: manifest },
    responseBody: { data: { items: [{ id: 'already-delivered' }] } }, reservedAt: capturedAt }
  delete source.path; delete source.scopeHash
  const target = { ...clone(source), id: targetId, status: 'reserved', responseStatus: null, responseBody: null, fingerprint,
    acquisitionRequest: { path: identity.path, body: { platform, query: 'fixture', pageSize: 20 } } }
  const call = { id: callId, usageRequestId: sourceId, tenantId: identity.tenantId, consumerId: identity.consumerId, apiKeyId: identity.apiKeyId,
    providerKey: 'tikhub', operation: recipe.operation, endpointKey: recipe.endpointKey, endpointVersion: recipe.endpointVersion,
    contractVersion: NATIVE_FORWARDING_VERSION, outcome: 'succeeded', httpStatus: 200, businessCode: 200, completedAt: capturedAt }
  const payload = { code: 200, data: { code: 0, data: { result: [{ id: '9007199254740993', title: 'fixture' }], page: 1, numPages: 1 } } }
  const bodyBytes = Buffer.from(JSON.stringify(payload)), archive = { bodyBytes, bodySize: bodyBytes.length, bodySha256: digest(bodyBytes), capturedAt }
  const delivery = { usageRequestId: targetId, tenantId: identity.tenantId, consumerId: identity.consumerId, apiKeyId: identity.apiKeyId, fingerprint, operation: recipe.operation }
  const sources = [callId, ownCallId].map((id, index) => ({ callId: id, rowsHash: 'd'.repeat(64), bodySha256: archive.bodySha256,
    bodySize: archive.bodySize, capturedAt, own: index === 1 }))
  const saved = { ...identity, delivery, capturedAt, sourceMode: 'live', usageUnitsActual: 2, sources,
    responseBody: { data: { items: [{ id: 'first' }, { id: 'second' }] } },
    manifest: { ...manifest, previousDeliveryId: sourceId, deliveredIds: [['first', 'second']] } }
  let db, pool, usageStore, providerStore
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
    providerStore = new PostgresExternalPlatformStore({ pool, providerKey: 'tikhub', authorizationPlatform: platform })
  } else {
    usageStore = new MemoryStore()
    usageStore.requests.set(sourceId, clone(source)); usageStore.requests.set(targetId, clone(target))
    usageStore.creditAccounts.set(identity.tenantId, { id: accountId, availableMinor: 91, heldMinor: 9, revision: 1, currency: 'CNY' })
    usageStore.customerCharges.set(targetId, { id: randomUUID(), usageRequestId: targetId, accountId, tenantId: identity.tenantId,
      enforcementMode: 'enforced', status: 'reserved', quotedMinor: 9, currency: 'CNY' })
    providerStore = new MemoryExternalPlatformStore({ usageStore, providerKey: 'tikhub', authorizationPlatform: platform })
    providerStore.calls.set(callId, clone(call)); providerStore.calls.set(ownCallId, { ...clone(call), id: ownCallId, usageRequestId: targetId })
    for (const id of [callId, ownCallId]) providerStore.restrictedResponseArchives.set(id, clone(archive))
  }
  const store = new ContentSearchStateStore(providerStore, { platform, operation: recipe.operation,
    endpointKey: recipe.endpointKey, endpointVersion: recipe.endpointVersion })
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
  return { ...identity, identity, store, providerStore, db, pool, source, target, call, callId, ownCallId, archive, payload, saved, manifest,
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
  test(`${name} content archive reader checks fixed native contract, every identity and original bytes without acquisition`, options, async t => {
    const f = await fixture(t, postgres), read = () => f.store.pageFor({ ...f.identity, callId: f.callId })
    assert.deepEqual((await read()).payload, f.payload)
    for (const field of ['tenantId', 'consumerId', 'apiKeyId', 'callId']) assert.equal(await f.store.pageFor({ ...f.identity, callId: f.callId, [field]: randomUUID() }), null, field)
    assert.equal(await f.store.pageFor({ ...f.identity, callId: f.callId, path: '/api/v1/night-all/search/raw' }), null)
    assert.equal(await f.store.pageFor({ ...f.identity, callId: f.callId, scopeHash: 'e'.repeat(64) }), null)
    for (const change of [{ endpointVersion: 'changed' }, { endpointKey: 'native.t.other' }, { operation: 'native.t.other' },
      { providerKey: 'justone' }, { contractVersion: 'changed' }, { outcome: 'unknown' }, { outcome: 'succeeded_unusable' },
      { httpStatus: 201 }, { businessCode: 0 }, { completedAt: ago(25 * 3600000) }, { completedAt: ago(-3600000) }]) {
      await f.setCall(change); assert.equal(await read(), null, JSON.stringify(change)); await f.setCall(f.call)
    }
    for (const change of [{ bodySha256: null }, { bodySha256: '0'.repeat(64) }, { bodySize: f.archive.bodySize + 1 },
      { capturedAt: ago(25 * 3600000) }, { capturedAt: ago(-3600000) }]) {
      await f.setArchive(change); assert.equal(await read(), null, JSON.stringify(change)); await f.setArchive(f.archive)
    }
    for (const bytes of [Buffer.from([255]), Buffer.from('null'), Buffer.from('{"code":200,"data":"\\u0000"}'), Buffer.from(JSON.stringify({ code: 200, data: 'a'.repeat(8388608) }))]) {
      await f.setArchive({ bodyBytes: bytes, bodySize: bytes.length, bodySha256: digest(bytes) }); assert.equal(await read(), null)
    }
    assert.deepEqual(await f.counts(), { gateways: 0, calls: 2, captures: 0, representative: undefined, charge: 'reserved' })
  })

  test(`${name} standard Kuaishou reads exact unsafe-metadata receipts without relaxing source or archive integrity`, options, async t => {
    const f = await fixture(t, postgres, 'kuaishou'), original = await f.getUsage(f.source.id)
    let archive
    for (const literal of ['"\\u0000"', '"\\ud800"', '-0', '1e400']) {
      archive = unsafeKuaishouArchive(f.archive.capturedAt, literal)
      for (const callId of [f.callId, f.ownCallId]) await f.setArchiveFor(callId, {
        bodyBytes: archive.bodyBytes, bodySize: archive.bodySize, bodySha256: archive.bodySha256, capturedAt: archive.capturedAt,
      })
      for (const [callId, ownUsageRequestId] of [[f.callId, undefined], [f.ownCallId, f.target.id]]) {
        const page = await f.store.pageFor({ ...f.identity, callId, ...(ownUsageRequestId ? { ownUsageRequestId } : {}) })
        assert.deepEqual(page.payload, archive.payload)
        assert.equal(page.bodySha256, digest(archive.bodyBytes))
        assert.equal(page.bodySize, archive.bodyBytes.length)
      }
    }
    assert.equal(await f.store.pageFor({ ...f.identity, callId: f.ownCallId }), null, 'another reserved delivery is not a readable source')
    for (const field of ['tenantId', 'consumerId', 'apiKeyId', 'callId']) {
      assert.equal(await f.store.pageFor({ ...f.identity, callId: f.callId, [field]: randomUUID() }), null)
    }
    assert.equal(await f.store.pageFor({ ...f.identity, callId: f.callId, scopeHash: 'e'.repeat(64) }), null)
    assert.equal(await f.store.pageFor({ ...f.identity, callId: f.callId,
      path: '/api/v1/data/native/t.kuaishou_app_search_comprehensive' }), null)
    const read = () => f.store.pageFor({ ...f.identity, callId: f.callId })
    for (const change of [{ endpointVersion: 'changed' }, { endpointKey: 'native.t.other' }, { operation: 'native.t.other' },
      { providerKey: 'justone' }, { contractVersion: 'changed' }, { outcome: 'unknown' }, { outcome: 'succeeded_unusable' },
      { httpStatus: 201 }, { businessCode: 0 }, { completedAt: ago(25 * 3600000) }]) {
      await f.setCall(change); assert.equal(await read(), null, JSON.stringify(change)); await f.setCall(f.call)
    }
    await f.setCall({ outcome: 'succeeded_unusable' })
    await f.setUsage(f.source.id, { responseStatus: 502 })
    const failed = await f.getUsage(f.source.id)
    assert.equal(await read(), null, 'an old paid failure is not repaired by the new projection mode')
    assert.deepEqual(await f.getUsage(f.source.id), failed)
    await f.setCall(f.call); await f.setUsage(f.source.id, { responseStatus: 200 })
    for (const change of [{ bodySha256: null }, { bodySha256: '0'.repeat(64) }, { bodySize: archive.bodySize + 1 },
      { capturedAt: ago(25 * 3600000) }, { capturedAt: ago(-3600000) }]) {
      await f.setArchive(change); assert.equal(await read(), null, JSON.stringify(change))
      await f.setArchive({ bodyBytes: archive.bodyBytes, bodySize: archive.bodySize, bodySha256: archive.bodySha256, capturedAt: archive.capturedAt })
    }
    for (const bodyBytes of [Buffer.from([255]), Buffer.from('{"code":200}'), Buffer.from('{"code":201,"data":{}}'),
      Buffer.from('{"code":200,"data":"literal\0nul"}'), Buffer.from(JSON.stringify({ code: 200, data: 'a'.repeat(8388608) }))]) {
      await f.setArchive({ bodyBytes, bodySize: bodyBytes.length, bodySha256: digest(bodyBytes) })
      assert.equal(await read(), null)
    }
    assert.deepEqual(await f.getUsage(f.source.id), original)
    assert.deepEqual(await f.counts(), { gateways: 0, calls: 2, captures: 0, representative: undefined, charge: 'reserved' })
  })

  for (const platform of ['bilibili', 'douyin', 'zhihu', 'kuaishou']) {
    test(`${name} unsafe-root opt-in stays unavailable for ${platform === 'kuaishou' ? 'legacy raw Kuaishou' : platform}`, options, async t => {
      const f = await fixture(t, postgres, platform)
      const archive = unsafeKuaishouArchive(f.archive.capturedAt, '"\\u0000"')
      await f.setArchive({ bodyBytes: archive.bodyBytes, bodySize: archive.bodySize, bodySha256: archive.bodySha256 })
      const identity = { ...f.identity }
      if (platform === 'kuaishou') {
        identity.path = '/api/v1/night-all/search/raw'
        await f.setUsage(f.source.id, { acquisitionRequest: { ...f.source.acquisitionRequest, path: identity.path } })
      }
      assert.equal(await f.store.pageFor({ ...identity, callId: f.callId }), null)
      assert.equal((await f.counts()).captures, 0)
    })
  }

  test(`${name} standard Kuaishou unsafe optional metadata still finalizes once and retains a verifiable overflow receipt`, options, async t => {
    const f = await fixture(t, postgres, 'kuaishou'), original = await f.getUsage(f.source.id)
    const archive = unsafeKuaishouArchive(f.archive.capturedAt, '"\\ud800"')
    const rows = archive.projected.acquiredItems, rowsHash = digest(JSON.stringify(rows))
    for (const callId of [f.callId, f.ownCallId]) await f.setArchiveFor(callId, {
      bodyBytes: archive.bodyBytes, bodySize: archive.bodySize, bodySha256: archive.bodySha256, capturedAt: archive.capturedAt,
    })
    const sources = f.saved.sources.map(source => ({ ...source, bodySize: archive.bodySize,
      bodySha256: archive.bodySha256, rowsHash }))
    const saved = { ...f.saved, sources, responseBody: { data: { items: rows.slice(0, 2).map(contentSearchDataItem) } },
      manifest: { ...f.saved.manifest, deliveredIds: [rows.slice(0, 2).map(row => row.content_id)],
        state: { jobs: [{ ...f.manifest.state.jobs[0], done: false, buffer: {
          callId: f.ownCallId, offset: 2, hash: rowsHash, providerCursor: null, providerPage: 1,
        } }] } } }
    await f.store.commitDelivery(saved)
    assert.deepEqual(await f.getUsage(f.source.id), original)
    assert.deepEqual(await f.counts(), { gateways: 1, calls: 2, captures: 1, representative: f.ownCallId, charge: 'captured' })
    const usage = await f.getUsage(f.target.id), buffer = usage.acquisitionRequest.contentSearch.state.jobs[0].buffer
    assert.deepEqual(usage.acquisitionRequest.contentSearch.sources, sources)
    const carry = await f.store.pageFor({ ...f.identity, callId: buffer.callId })
    assert.equal(carry.bodySha256, archive.bodySha256)
    assert.equal(carry.bodySize, archive.bodyBytes.length)
    assert.deepEqual(carry.payload, archive.payload)
    const reprojected = projectTikHubContentSearch({ publicBody: { data: carry.payload.data, meta: { capturedAt: carry.capturedAt } } },
      normalizeTikHubContentSearchRequest({ platform: 'kuaishou', query: 'fixture', pageSize: 2 }))
    assert.equal(digest(JSON.stringify(reprojected.acquiredItems)), buffer.hash)
    assert.deepEqual(reprojected.acquiredItems.slice(buffer.offset).map(row => row.content_id), ['fixture-photo-2'])
    const history = await f.store.historyFor({ ...f.identity, previousDeliveryId: f.target.id, jobCount: 1, totalLimit: 20 })
    assert.deepEqual([...history.seenIds[0]], ['fixture-photo-0', 'fixture-photo-1', 'already-delivered'])
    await assert.rejects(f.store.commitDelivery(saved), { code: 'search_page_unavailable' })
    assert.equal((await f.counts()).captures, 1)
  })

  test(`${name} content finalization atomically settles once and binds carried plus newly purchased sources`, options, async t => {
    const f = await fixture(t, postgres), original = await f.getUsage(f.source.id)
    for (const field of ['tenantId', 'consumerId', 'apiKeyId']) {
      await assert.rejects(f.store.commitDelivery({ ...f.saved, delivery: { ...f.saved.delivery, [field]: randomUUID() } }), { code: 'search_page_unavailable' })
      assert.equal((await f.getUsage(f.target.id)).status, 'reserved')
    }
    await assert.rejects(f.store.commitDelivery({ ...f.saved, sources: [f.saved.sources[0], f.saved.sources[0]] }), { code: 'search_page_unavailable' })
    await assert.rejects(f.store.commitDelivery({ ...f.saved, sources: f.saved.sources.map((source, index) => index ? { ...source, bodySha256: '0'.repeat(64) } : source) }), { code: 'search_page_unavailable' })
    const largeBytes = Buffer.from(JSON.stringify({ code: 200, data: { padding: 'a'.repeat(7 * 1024 * 1024) } }))
    const largeArchive = { ...f.archive, bodyBytes: largeBytes, bodySize: largeBytes.length, bodySha256: digest(largeBytes) }
    for (const source of f.saved.sources) await f.setArchiveFor(source.callId, largeArchive)
    await assert.rejects(f.store.commitDelivery({ ...f.saved, sources: f.saved.sources.map(source => ({ ...source,
      bodySize: largeArchive.bodySize, bodySha256: largeArchive.bodySha256 })) }), { code: 'search_page_unavailable' })
    for (const source of f.saved.sources) await f.setArchiveFor(source.callId, f.archive)
    assert.equal((await f.counts()).gateways, 0)
    await f.store.commitDelivery(f.saved)
    assert.deepEqual(await f.getUsage(f.source.id), original)
    assert.equal((await f.getUsage(f.target.id)).status, 'committed')
    const manifest = (await f.getUsage(f.target.id)).acquisitionRequest.contentSearch
    assert.deepEqual(manifest.sources, f.saved.sources)
    assert.deepEqual(manifest.deliveredIds, [['first', 'second']])
    assert.deepEqual(await f.counts(), { gateways: 1, calls: 2, captures: 1, representative: f.ownCallId, charge: 'captured' })
    await assert.rejects(f.store.commitDelivery(f.saved), { code: 'search_page_unavailable' })
    assert.equal((await f.counts()).captures, 1)
    const history = await f.store.historyFor({ ...f.identity, previousDeliveryId: f.target.id, jobCount: 1, totalLimit: 20 })
    assert.deepEqual([...history.seenIds[0]], ['first', 'second', 'already-delivered'])
  })

  test(`${name} content history rejects scope drift, malformed IDs, expired or cyclic predecessors`, options, async t => {
    const f = await fixture(t, postgres), input = { ...f.identity, previousDeliveryId: f.source.id, jobCount: 1, totalLimit: 20 }
    assert.deepEqual([...(await f.store.historyFor(input)).seenIds[0]], ['already-delivered'])
    for (const changes of [{ scopeHash: 'f'.repeat(64) }, { apiKeyId: randomUUID() }, { path: '/api/v1/night-all/search/raw' }, { jobCount: 2 }]) await assert.rejects(f.store.historyFor({ ...input, ...changes }), { code: 'search_page_unavailable' })
    for (const changes of [{ previousDeliveryId: f.source.id }, { capturedAt: ago(25 * 3600000) }, { deliveredIds: [[123]] },
      { deliveredIds: [[null]] }, ...(!postgres ? [{ deliveredIds: [['bad\0id']] }] : []), { state: { jobs: [] } },
      { state: { jobs: [null] } }, { state: { jobs: [{ ...f.manifest.state.jobs[0], upstreamPages: '1' }] } }]) {
      await f.setUsage(f.source.id, { acquisitionRequest: { ...f.source.acquisitionRequest, contentSearch: { ...f.manifest, ...changes } } })
      await assert.rejects(f.store.historyFor(input), { code: 'search_page_unavailable' })
    }
  })

  test(`${name} content parent lease serializes buffer-only delivery and unknown state is found without own supplier calls`, options, async t => {
    const f = await fixture(t, postgres), lease = { consumerId: f.consumerId, fingerprint, ownerRequestId: f.target.id, expiresAt: ago(-60000) }
    assert.equal(await f.store.acquireDeliveryLease(lease), true)
    assert.equal(await f.store.acquireDeliveryLease({ ...lease, ownerRequestId: randomUUID() }), false)
    await f.store.releaseDeliveryLease({ ...lease, ownerRequestId: randomUUID() })
    assert.equal(await f.store.acquireDeliveryLease({ ...lease, ownerRequestId: randomUUID() }), false)
    await f.store.releaseDeliveryLease(lease)
    assert.equal(await f.store.acquireDeliveryLease(lease), true)
    if (postgres) {
      await f.db.query('DELETE FROM control.external_platform_restricted_raw_responses WHERE provider_call_id=$1', [f.ownCallId])
      await f.db.query('DELETE FROM external_platform.provider_calls WHERE id=$1', [f.ownCallId])
    } else {
      f.providerStore.restrictedResponseArchives.delete(f.ownCallId)
      f.providerStore.calls.delete(f.ownCallId)
    }
    await f.setUsage(f.target.id, { status: 'unknown', fingerprint, responseStatus: null })
    assert.equal(await f.store.unknownFor(f.saved.delivery, f.path), true)
    assert.equal(await f.store.unknownFor({ ...f.saved.delivery, apiKeyId: randomUUID() }, f.path), false)
    assert.equal(await f.store.unknownFor(f.saved.delivery, '/api/v1/night-all/search/raw'), false)
  })
}

test('PGlite rollback leaves usage, settlement and source manifest untouched when gateway evidence insert fails', { skip: !modulePath }, async t => {
  const f = await fixture(t, true), original = await f.getUsage(f.target.id)
  await f.db.exec(`CREATE FUNCTION control.reject_gateway() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic gateway failure'; END; $$;
    CREATE TRIGGER reject_gateway BEFORE INSERT ON external_platform.gateway_requests FOR EACH ROW EXECUTE FUNCTION control.reject_gateway();`)
  await assert.rejects(f.store.commitDelivery(f.saved), /synthetic gateway failure/)
  assert.deepEqual(await f.getUsage(f.target.id), original)
  assert.deepEqual(await f.counts(), { gateways: 0, calls: 2, captures: 0, representative: undefined, charge: 'reserved' })
})

test('PGlite Zhihu 18+18 finalization commits 20 items and a lossless 16-item second-page buffer with one customer capture', { skip: !modulePath }, async t => {
  const f = await fixture(t, true, 'zhihu'), capturedAt = f.archive.capturedAt
  const providerCursor = { offset: '20', search_hash_id: 'fixture-session' }
  const acquisitions = [1, 2].map(page => {
    const payload = { code: 200, data: { data: Array.from({ length: 18 }, (_, index) => ({ type: 'search_result', object: {
      id: String(page * 100 + index), type: 'article', title: `fixture ${page}/${index}`, content: `<p>完整正文 ${page}/${index}</p>`,
    } })), paging: { is_end: false, next: `https://api.zhihu.com/search_v3?offset=${page * 20}&search_hash_id=fixture-session` } } }
    const bytes = Buffer.from(JSON.stringify(payload)), callId = page === 1 ? f.callId : f.ownCallId
    const request = normalizeTikHubContentSearchRequest({ platform: 'zhihu', query: 'fixture', pageSize: 20,
      page, providerCursor: page === 1 ? null : providerCursor })
    const projected = projectTikHubContentSearch({ publicBody: { data: payload.data, meta: { capturedAt } } }, request)
    assert.equal(projected.acquiredItems.length, 18)
    return { payload, projected, archive: { bodyBytes: bytes, bodySize: bytes.length, bodySha256: digest(bytes), capturedAt },
      source: { callId, bodySize: bytes.length, bodySha256: digest(bytes), capturedAt,
        rowsHash: digest(JSON.stringify(projected.acquiredItems)), own: true } }
  })
  // Both receipts belong to this reserved delivery; no older delivery is edited.
  await f.db.query('UPDATE external_platform.provider_calls SET usage_request_id=$2 WHERE id=$1', [f.callId, f.target.id])
  for (const acquisition of acquisitions) await f.setArchiveFor(acquisition.source.callId, acquisition.archive)
  const rows = [...acquisitions[0].projected.acquiredItems, ...acquisitions[1].projected.acquiredItems.slice(0, 2)]
  const job = { query: 'fixture', providerPage: 2, providerCursor, upstreamPages: 2, started: true, done: false,
    buffer: { callId: f.ownCallId, offset: 2, hash: acquisitions[1].source.rowsHash, providerCursor, providerPage: 2 } }
  const saved = { ...f.saved, sources: acquisitions.map(row => row.source), usageUnitsActual: 20,
    responseBody: { data: { items: rows.map(contentSearchDataItem) } },
    manifest: { ...f.manifest, previousDeliveryId: null, state: { jobs: [job] }, deliveredIds: [rows.map(row => row.content_id)] } }
  assert.equal(isPostgresSafeJsonValue(saved.manifest), false)
  await assert.rejects(f.store.commitDelivery(saved), { code: 'search_page_unavailable' })
  assert.equal((await f.getUsage(f.target.id)).status, 'reserved')
  assert.equal((await f.counts()).captures, 0)
  job.buffer.providerCursor = { ...job.providerCursor }
  assert.equal(isPostgresSafeJsonValue(saved.manifest), true)
  await f.store.commitDelivery(saved)
  const usage = await f.getUsage(f.target.id)
  assert.equal(usage.responseBody.data.items.length, 20)
  assert.equal(usage.acquisitionRequest.contentSearch.state.jobs[0].buffer.offset, 2)
  assert.deepEqual(await f.counts(), { gateways: 1, calls: 2, captures: 1, representative: f.ownCallId, charge: 'captured' })
  const carry = await f.store.pageFor({ ...f.identity, callId: f.ownCallId })
  assert.deepEqual(carry.payload, acquisitions[1].payload)
  assert.equal(acquisitions[1].projected.acquiredItems.slice(job.buffer.offset).length, 16)
  assert.equal(usage.acquisitionRequest.contentSearch.sources.length, 2)
  const history = await f.store.historyFor({ ...f.identity, previousDeliveryId: f.target.id, jobCount: 1, totalLimit: 20 })
  assert.equal(history.seenIds[0].size, 20)
})
