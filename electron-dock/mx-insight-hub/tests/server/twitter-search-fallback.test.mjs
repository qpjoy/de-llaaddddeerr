import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { pinTwitterSearchFallback, assertTwitterSearchFallback } from '../../server/external-platforms/twitter-search-fallback.mjs'
import { twitterDeliveryLeases } from '../../server/external-platforms/twitter-delivery-leases.mjs'
import { TIKHUB_CONTENT_SEARCH_VERSION } from '../../server/contracts/tikhub-content-search.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE

async function fixture(t, database) {
  const delivery = { usageRequestId: randomUUID(), tenantId: randomUUID(), consumerId: randomUUID(), apiKeyId: randomUUID(),
    operation: 'social.content.search', fingerprint: 'a'.repeat(64) }
  const body = { platform: 'twitter', query: '("外交" OR "diplomacy") AND "update" -ad', pageSize: 20, type: 'stable',
    params: { retainedTestCondition: 'unchanged' } }
  const acquisition = { method: 'POST', path: '/api/v1/data/search', body }
  const usage = { id: delivery.usageRequestId, ...delivery, status: 'reserved', platform: 'twitter', acquisitionRequest: acquisition }
  const call = { id: randomUUID(), ...delivery, providerKey: 'rapidapi', endpointKey: 'twitter-aio.search', marketplace: 'twitter',
    callOrdinal: 0, outcome: 'rejected', httpStatus: 400, completedAt: new Date().toISOString(), retryOfRequestId: null }
  const lease = { ownerRequestId: delivery.usageRequestId, expiresAt: new Date(Date.now() + 120000).toISOString() }
  let usageStore, rapidStore, tikStore, db, fault = null
  if (database) {
    const { PGlite } = await import(pathToFileURL(modulePath).href)
    db = new PGlite()
    t.after(() => db.close())
    await db.exec(`CREATE SCHEMA external_platform;
      CREATE TABLE usage_requests(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,api_key_id uuid,
        platform text,status text,fingerprint text,acquisition_request jsonb);
      CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,usage_request_id uuid,tenant_id uuid,
        consumer_id uuid,api_key_id uuid,provider_key text,operation text,endpoint_key text,marketplace text,
        request_fingerprint text,call_ordinal int,outcome text,http_status int,completed_at timestamptz,retry_of_usage_request_id uuid);
      CREATE TABLE external_platform.dispatch_leases(consumer_id uuid,operation text,request_fingerprint text,
        owner_request_id uuid,expires_at timestamptz,PRIMARY KEY(consumer_id,operation,request_fingerprint));`)
    usageStore = { pool: { async connect() { return { async query(sql, args) {
      const result = await db.query(sql, args)
      if (fault && (fault === 'update' && sql.startsWith('UPDATE') || fault === 'commit' && sql === 'COMMIT')) throw new Error('simulated persistence acknowledgement failure')
      return result
    }, release() {} } } } }
  } else {
    usageStore = { requests: new Map() }
    rapidStore = { usageStore, calls: new Map() }
    tikStore = { usageStore, calls: new Map() }
  }
  const write = async (extraCalls = []) => {
    if (!database) {
      usageStore.requests.set(usage.id, structuredClone(usage))
      rapidStore.calls.clear(); tikStore.calls.clear()
      for (const row of [call, ...extraCalls]) (row.providerKey === 'tikhub' ? tikStore : rapidStore).calls.set(row.id, structuredClone(row))
      twitterDeliveryLeases(usageStore).set([delivery.consumerId, 'social.content.search', delivery.fingerprint].join('\0'), structuredClone(lease))
      return
    }
    await db.exec('DELETE FROM external_platform.provider_calls; DELETE FROM external_platform.dispatch_leases; DELETE FROM usage_requests;')
    await db.query('INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [usage.id, usage.tenantId, usage.consumerId, usage.apiKeyId, usage.platform, usage.status, usage.fingerprint, JSON.stringify(usage.acquisitionRequest)])
    for (const row of [call, ...extraCalls]) await db.query('INSERT INTO external_platform.provider_calls VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [row.id, row.usageRequestId, row.tenantId, row.consumerId, row.apiKeyId, row.providerKey, row.operation, row.endpointKey,
        row.marketplace, row.fingerprint, row.callOrdinal, row.outcome, row.httpStatus, row.completedAt, row.retryOfRequestId])
    await db.query('INSERT INTO external_platform.dispatch_leases VALUES($1,$2,$3,$4,$5)',
      [delivery.consumerId, 'social.content.search', delivery.fingerprint, lease.ownerRequestId, lease.expiresAt])
  }
  const read = async () => database ? (await db.query('SELECT status,fingerprint,acquisition_request AS "acquisitionRequest" FROM usage_requests WHERE id=$1', [usage.id])).rows[0]
    : structuredClone(usageStore.requests.get(usage.id))
  await write()
  return { usage, call, lease, delivery, acquisition, usageStore, rapidStore, tikStore, db, write, read,
    setFault(value) { fault = value },
    pin: () => pinTwitterSearchFallback({ usageStore, rapidStore, providerStores: [tikStore].filter(Boolean), delivery, callId: call.id }),
    verify: () => assertTwitterSearchFallback({ usageStore, rapidStore, providerStores: [tikStore].filter(Boolean), delivery }) }
}

for (const database of [false, true]) {
  const options = database && !modulePath ? { skip: 'Set MX_INSIGHT_TEST_PGLITE_MODULE for PostgreSQL verification' } : {}
  const name = database ? 'PostgreSQL' : 'memory'
  test(`${name}: one definite first-page 400 pins TikHub under the same live reservation without changing conditions`, options, async t => {
    const h = await fixture(t, database), before = await h.read()
    await assert.rejects(h.verify(), { code: 'twitter_search_fallback_unavailable' })
    const expected = { version: 'rapidapi-400.v1', callId: h.call.id }
    assert.deepEqual(await h.pin(), expected)
    assert.deepEqual(await h.verify(), expected)
    assert.deepEqual(await h.pin(), expected, 'A repeated pre-dispatch pin has no new effect')
    const after = await h.read()
    assert.equal(after.status, 'reserved'); assert.equal(after.fingerprint, before.fingerprint)
    assert.deepEqual(after.acquisitionRequest.body, before.acquisitionRequest.body)
    assert.equal(after.acquisitionRequest.path, before.acquisitionRequest.path)
    assert.equal(after.acquisitionRequest.searchProvider, 'tikhub')
    assert.equal(after.acquisitionRequest.searchContractVersion, TIKHUB_CONTENT_SEARCH_VERSION)
    assert.deepEqual(after.acquisitionRequest.twitterFallback, expected)
    const calls = database ? (await h.db.query('SELECT count(*)::int AS n FROM external_platform.provider_calls')).rows[0].n : h.rapidStore.calls.size + h.tikStore.calls.size
    assert.equal(calls, 1, 'Pinning never dispatches or fabricates a supplier call')
  })

  test(`${name}: committed/unknown/history and continuation cannot be repurposed as fallback`, options, async t => {
    const h = await fixture(t, database)
    for (const mutation of [
      h => { h.usage.status = 'committed' }, h => { h.usage.status = 'unknown' }, h => { h.usage.status = 'released' },
      h => { h.usage.acquisitionRequest.body.cursor = 'signed-old-rapid-cursor' },
      h => { h.usage.acquisitionRequest.body.params.cursor = 'provider-cursor' },
      h => { h.usage.acquisitionRequest.body.page = 2 },
      h => { h.usage.acquisitionRequest.twitterFill = {} }, h => { h.usage.acquisitionRequest.contentSearch = {} },
      h => { h.usage.acquisitionRequest.path = '/api/v1/night-all/search/raw' },
      h => { h.usage.acquisitionRequest.searchProvider = 'tikhub' },
      h => { h.usage.apiKeyId = randomUUID() }, h => { h.usage.fingerprint = 'b'.repeat(64) },
    ]) {
      const saved = structuredClone(h.usage)
      mutation(h); await h.write()
      const before = await h.read()
      await assert.rejects(h.pin(), { code: 'twitter_search_fallback_unavailable' })
      assert.deepEqual(await h.read(), before)
      Object.assign(h.usage, saved)
    }
  })

  test(`${name}: unknown, timeout, 429, unusable and foreign receipts never authorize fallback`, options, async t => {
    const h = await fixture(t, database)
    for (const mutation of [
      h => { h.call.outcome = 'unknown' }, h => { h.call.httpStatus = null }, h => { h.call.httpStatus = 429 },
      h => { h.call.outcome = 'succeeded_unusable'; h.call.httpStatus = 200 },
      h => { h.call.outcome = 'pending'; h.call.completedAt = null },
      h => { h.call.providerKey = 'tikhub' }, h => { h.call.endpointKey = 'twitter-aio.profile' },
      h => { h.call.operation = 'social.profile.get' }, h => { h.call.marketplace = 'facebook' },
      h => { h.call.consumerId = randomUUID() }, h => { h.call.fingerprint = 'b'.repeat(64) },
      h => { h.call.callOrdinal = 1 }, h => { h.call.retryOfRequestId = randomUUID() },
    ]) {
      const saved = structuredClone(h.call)
      mutation(h); await h.write()
      await assert.rejects(h.pin(), { code: 'twitter_search_fallback_unavailable' })
      assert.equal((await h.read()).acquisitionRequest.twitterFallback, undefined)
      Object.assign(h.call, saved)
    }
    h.delivery.twitterManualRetry = { retryOfRequestId: randomUUID() }
    await h.write(); await assert.rejects(h.pin(), { code: 'twitter_search_fallback_unavailable' })
  })

  test(`${name}: extra supplier calls and a lost/expired parent lease forbid a second handoff`, options, async t => {
    const h = await fixture(t, database)
    for (const providerKey of ['rapidapi', 'tikhub']) {
      await h.write([{ ...h.call, id: randomUUID(), providerKey, callOrdinal: 1 }])
      await assert.rejects(h.pin(), { code: 'twitter_search_fallback_unavailable' })
    }
    await h.write(); await h.pin()
    for (const change of [{ ownerRequestId: randomUUID() }, { expiresAt: new Date(Date.now() - 1000).toISOString() }]) {
      const original = { ...h.lease }
      h.usage.acquisitionRequest = (await h.read()).acquisitionRequest
      Object.assign(h.lease, change); await h.write()
      await assert.rejects(h.verify(), { code: 'twitter_search_fallback_unavailable' })
      Object.assign(h.lease, original)
    }
    await h.write()
    h.usage.acquisitionRequest.twitterFallback.callId = randomUUID()
    await h.write(); await assert.rejects(h.verify(), { code: 'twitter_search_fallback_unavailable' })
  })
}

test('PostgreSQL: failed pin transaction rolls back; lost commit acknowledgement preserves its durable supplier pin',
  { skip: !modulePath ? 'Set MX_INSIGHT_TEST_PGLITE_MODULE for PostgreSQL verification' : false }, async t => {
    const h = await fixture(t, true), before = await h.read()
    h.setFault('update')
    await assert.rejects(h.pin(), /simulated persistence acknowledgement failure/u)
    h.setFault(null)
    assert.deepEqual(await h.read(), before, 'A failed write cannot leave a partial pin')
    h.setFault('commit')
    await assert.rejects(h.pin(), /simulated persistence acknowledgement failure/u)
    h.setFault(null)
    assert.equal((await h.read()).acquisitionRequest.searchProvider, 'tikhub')
    assert.deepEqual(await h.verify(), { version: 'rapidapi-400.v1', callId: h.call.id })
  })
