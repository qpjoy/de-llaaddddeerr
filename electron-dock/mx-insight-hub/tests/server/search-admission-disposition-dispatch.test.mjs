import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { normalizeDataSearchV2, prepareDataSearchV2, dataSearchQueryHash } from '../../server/contracts/data-search-v2.mjs'
import { createDataSearchV2CursorCodec } from '../../server/external-platforms/cursor.mjs'
import { PostgresExternalPlatformStore, MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { ContentSearchStateStore } from '../../server/external-platforms/content-search-store.mjs'
import { SearchAdmissionDispositionService } from '../../server/operations/search-admission-disposition.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const options = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL guards' }
const pepper = 'offline-disposition-dispatch-pepper-at-least-32-bytes'
const body = normalizeDataSearchV2({ platform: 'twitter', query: 'offline search admission fixture', pageSize: 20, type: 'fresh',
  timeWindow: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-28T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' } })

async function fixture(t, { migration = true, provider = 'rapidapi' } = {}) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA ingest; CREATE SCHEMA control; CREATE TABLE ingest.ingest_runs(id uuid PRIMARY KEY)')
  for (const name of ['001_initial.sql', '004_reservation_lease.sql', '051_external_platform_gateway.sql',
    '053_external_platform_uncertain_retry.sql', '055_external_platform_multi_call_rate_limit.sql',
    '094_acquisition_request_snapshot.sql', '138_admission_recovery.sql', '158_data_search_v2_protocol.sql',
    ...(migration ? ['166_search_admission_dispositions.sql'] : [])]) {
    await db.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  }
  const tenantId = randomUUID(), consumerId = randomUUID(), apiKeyId = randomUUID()
  const codec = createDataSearchV2CursorCodec(pepper, `${consumerId}:${apiKeyId}`)
  const snapshot = { method: 'POST', path: '/api/v1/data/search', body: prepareDataSearchV2(body, codec).upstream }
  const fingerprint = requestFingerprint(snapshot), identity = { tenantId, consumerId, apiKeyId, fingerprint }
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Offline fixture')", [tenantId])
  await db.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Offline fixture',$3)", [consumerId, tenantId, consumerId])
  const addKey = async () => {
    const id = randomUUID()
    await db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'Offline fixture',$4,'fixture','0000')",
      [id, tenantId, consumerId, requestFingerprint({ id })])
    return id
  }
  await db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'Offline fixture',$4,'fixture','0000')",
    [apiKeyId, tenantId, consumerId, 'a'.repeat(64)])
  const addRequest = async (status = 'unknown', overrides = {}) => {
    const row = { id: randomUUID(), ...identity, status, platform: 'twitter', idempotencyKey: randomUUID(), snapshot, ...overrides }
    await db.query(`INSERT INTO usage_requests
      (id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,acquisition_request,lease_expires_at,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '2 minutes',CASE WHEN $8='unknown' THEN now() ELSE NULL END)`,
    [row.id,row.tenantId,row.consumerId,row.apiKeyId,row.idempotencyKey,row.fingerprint,row.platform,row.status,JSON.stringify(row.snapshot)])
    return row
  }
  const operation = provider === 'rapidapi' ? 'social.content.search' : 'native.t.twitter_web_fetch_search_timeline'
  const endpoint = provider === 'rapidapi' ? 'twitter-aio.search' : operation
  const addCall = async (request, outcome = 'unknown') => {
    const id = randomUUID()
    await db.query(`INSERT INTO external_platform.provider_calls
      (id,provider_key,tenant_id,consumer_id,api_key_id,usage_request_id,operation,contract_version,endpoint_key,endpoint_version,
        marketplace,request_fingerprint,outcome,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'mx-insight-hub.social-data.v1',$8,'offline.fixture.v1','twitter',$9,$10,
        CASE WHEN $10='pending' THEN NULL ELSE now() END)`,
    [id,provider,request.tenantId,request.consumerId,request.apiKeyId,request.id,operation,endpoint,request.fingerprint,outcome])
    return id
  }
  const root = await addRequest(), rootCall = await addCall(root), next = await addRequest('reserved')
  await db.query(`INSERT INTO control.data_search_protocol_bindings
    (consumer_id,idempotency_key,tenant_id,api_key_id,platform,query_hash,fingerprint,request_body,state,owner_id,lease_expires_at,usage_request_id)
    VALUES($1,$2,$3,$4,'twitter',$5,$6,$7,'unknown',$8,now()-interval '1 minute',$9)`,
  [consumerId,root.idempotencyKey,tenantId,apiKeyId,dataSearchQueryHash(body.query),
    requestFingerprint({ method:'POST',path:'/api/v2/data/search',body }),JSON.stringify(body),randomUUID(),root.id])
  const statements = [], pool = { query: (sql, args) => { statements.push(sql); return db.query(sql,args) },
    connect: async () => ({ query: (...args) => db.query(...args), release() {} }) }
  const store = new PostgresExternalPlatformStore({ pool, providerKey: provider, authorizationPlatform:'twitter' })
  const service = new SearchAdmissionDispositionService({ pool, apiKeyPepper:pepper })
  const resolve = async () => {
    const prepared = await service.prepare(root.id)
    assert.equal(prepared.eligibility.allowed,true,prepared.eligibility.message)
    return service.resolve(root.id,{ revision:prepared.revision,reason:'Offline future collection recovery',acceptUnknownRisk:true })
  }
  const delivery = request => ({ ...identity, ...request, usageRequestId:request.id, operation })
  const lease = request => ({ consumerId,operation,fingerprint:request.fingerprint,endpointKey:endpoint,
    contractVersion:'mx-insight-hub.social-data.v1',ownerRequestId:request.id,expiresAt:new Date(Date.now()+60000) })
  const content = platform => new ContentSearchStateStore({ pool,providerKey:'tikhub' }, { platform,
    operation:'native.t.twitter_web_fetch_search_timeline',endpointKey:'native.t.twitter_web_fetch_search_timeline',endpointVersion:'offline.fixture.v1' })
  return { db,pool,store,service,root,rootCall,next,identity,snapshot,fingerprint,statements,
    resolve,addKey,addRequest,addCall,delivery,lease,content }
}

test('PG an ended Twitter unknown never holds a new equal delivery and a disposition still records without rewriting history', options, async t => {
  const f = await fixture(t), lease = f.lease(f.next)
  const before = (await f.db.query('SELECT * FROM usage_requests WHERE id=$1',[f.root.id])).rows[0]
  const callBefore = (await f.db.query('SELECT * FROM external_platform.provider_calls WHERE id=$1',[f.rootCall])).rows[0]
  assert.equal((await f.store.acquireDispatchLease(lease)).kind,'acquired')
  await f.store.releaseDispatchLease(lease)
  // Manual recovery remains available as an audited record; it is no longer required to proceed.
  const disposition = await f.resolve()
  assert.ok(disposition)
  assert.equal((await f.store.acquireDispatchLease(lease)).kind,'acquired')
  await f.store.releaseDispatchLease(lease)
  assert.deepEqual((await f.db.query('SELECT * FROM usage_requests WHERE id=$1',[f.root.id])).rows[0],before)
  assert.deepEqual((await f.db.query('SELECT * FROM external_platform.provider_calls WHERE id=$1',[f.rootCall])).rows[0],callBefore)
})

test('PG additional ended unknowns do not hold dispatch while pending calls still do', options, async t => {
  const f = await fixture(t)
  const other = await f.addRequest(), call = await f.addCall(other)
  assert.equal((await f.store.acquireDispatchLease(f.lease(f.next))).kind,'acquired')
  await f.store.releaseDispatchLease(f.lease(f.next))
  await f.db.query("UPDATE usage_requests SET status='reserved' WHERE id=$1",[other.id])
  await f.db.query("UPDATE external_platform.provider_calls SET outcome='pending',completed_at=NULL WHERE id=$1",[call])
  assert.equal((await f.store.acquireDispatchLease(f.lease(f.next))).reason,'pending')
})

test('PG a current delivery lease and endpoint quarantine remain effective after disposition', options, async t => {
  const f = await fixture(t)
  await f.resolve()
  const owner = await f.addRequest('reserved'), current = f.lease(owner)
  await f.db.query(`INSERT INTO external_platform.dispatch_leases
    (consumer_id,operation,request_fingerprint,owner_request_id,expires_at) VALUES($1,$2,$3,$4,$5)`,
  [current.consumerId,current.operation,current.fingerprint,current.ownerRequestId,current.expiresAt])
  assert.equal((await f.store.acquireDispatchLease(f.lease(f.next))).kind,'busy')
  await f.store.releaseDispatchLease(current)
  const rejected = await f.addRequest('released')
  await f.addCall(rejected,'succeeded_unusable')
  const quarantined = await f.store.acquireDispatchLease(f.lease(f.next))
  assert.equal(quarantined.reason,'succeeded_unusable')
  assert.ok(Date.parse(quarantined.blockedUntil) - Date.now() <= 300_000)
})

test('PG ended unknowns do not hold another API key, raw path or operation', options, async t => {
  const f = await fixture(t)
  for (const request of [await f.addRequest('reserved',{apiKeyId:await f.addKey()}),
    await f.addRequest('reserved',{snapshot:{...f.snapshot,path:'/api/v1/night-all/search/raw'}})]) {
    assert.equal((await f.store.acquireDispatchLease(f.lease(request))).kind,'acquired')
    await f.store.releaseDispatchLease(f.lease(request))
  }
  await f.db.query("UPDATE external_platform.provider_calls SET operation='social.account.search' WHERE id=$1",[f.rootCall])
  assert.equal((await f.store.acquireDispatchLease({...f.lease(f.next),operation:'social.account.search'})).kind,'acquired')
})

test('PG TikHub Twitter native child dispatch is held only by a pending call', options, async t => {
  const f = await fixture(t,{provider:'tikhub'})
  assert.equal((await f.store.acquireDispatchLease(f.lease(f.next))).kind,'acquired')
  await f.store.releaseDispatchLease(f.lease(f.next))
  const pending = await f.addRequest('reserved'); await f.addCall(pending,'pending')
  assert.equal((await f.store.acquireDispatchLease(f.lease(f.next))).reason,'pending')
})

test('PG without the additive disposition schema an ended unknown still does not hold dispatch', options, async t => {
  const f = await fixture(t,{migration:false})
  assert.equal((await f.store.acquireDispatchLease(f.lease(f.next))).kind,'acquired')
})

test('PG dispatch never consults administrative search dispositions or equal-request unknown checks', options, async t => {
  const f = await fixture(t)
  await f.resolve()
  const raw = await f.addRequest('reserved',{snapshot:{...f.snapshot,path:'/api/v1/night-all/search/raw'}})
  const other = await f.addRequest('reserved',{platform:'reddit'})
  f.statements.length=0
  for (const request of [raw, other]) {
    assert.equal((await f.store.acquireDispatchLease(f.lease(request))).kind,'acquired')
    await f.store.releaseDispatchLease(f.lease(request))
  }
  assert.equal(f.statements.some(sql=>sql.includes('search_admission_dispositions')),false)
  assert.equal(typeof f.store.twitterFillUnknownFor,'undefined')
  assert.equal(typeof f.content('twitter').unknownFor,'undefined')
})

test('Memory mode has no equal-request unknown checks either', async () => {
  const identity = {tenantId:randomUUID(),consumerId:randomUUID(),apiKeyId:randomUUID(),fingerprint:'a'.repeat(64)}
  const root = {id:randomUUID(),...identity,platform:'twitter',status:'unknown',reservedAt:new Date().toISOString(),
    acquisitionRequest:{path:'/api/v1/data/search'}}
  const usageStore = {requests:new Map([[root.id,root]])}
  const store = new MemoryExternalPlatformStore({usageStore,providerKey:'rapidapi'})
  assert.equal(typeof store.twitterFillUnknownFor,'undefined')
  const content = new ContentSearchStateStore({usageStore,providerKey:'tikhub'}, {platform:'twitter'})
  assert.equal(typeof content.unknownFor,'undefined')
})
