import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemoryExternalPlatformStore, PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const PATH = '/api/v1/data/search'
const fingerprint = 'a'.repeat(64)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const ago = milliseconds => new Date(Date.now() - milliseconds).toISOString()

async function fixture(t, postgres, provider = 'rapidapi') {
  const input = { callId: randomUUID(), tenantId: randomUUID(), consumerId: randomUUID(), apiKeyId: randomUUID(), path: PATH,
    sourceProvider:provider,query:'fixture',pageSize:20,type:'stable',startDate:'2026-10-14',endDate:'2026-10-15',
    scopeHash:digest(JSON.stringify({query:'fixture',pageSize:20,dates:{},format:'stable'})) }
  const sourceId = randomUUID(), targetId = randomUUID(), accountId = randomUUID()
  const capturedAt = ago(1000)
  // Keep the complete root and its timeline wrapper, not only root.data.
  const data = {results:[{post_id:'pfbid-long-string-identity',message:'complete body'}],cursor:'next'}
  const payload = provider==='justone'?{code:0,data}:data
  const bodyBytes = Buffer.from('\uFEFF' + JSON.stringify(payload))
  const archive = { bodyBytes, bodySize: bodyBytes.length, bodySha256: digest(bodyBytes), capturedAt }
  const source = { id: sourceId, tenantId: input.tenantId, consumerId: input.consumerId, apiKeyId: input.apiKeyId,
    platform: 'facebook', status: 'committed', responseStatus: 200, fingerprint: 'b'.repeat(64),
    acquisitionRequest: { path: PATH, body: {platform:'facebook',query:'fixture',pageSize:20,type:'stable'} }, responseBody: { immutable: 'original delivery' }, unitsActual: 20 }
  const target = { ...source, id: targetId, status: 'reserved', responseStatus: null, responseBody: null, fingerprint, unitsActual: null }
  const call = { id: input.callId, usageRequestId: sourceId, tenantId: input.tenantId, consumerId: input.consumerId, apiKeyId: input.apiKeyId,
    providerKey: provider, operation: provider==='rapidapi'?'social.facebook.search':'native.j.facebook_post_search_v1',
    endpointKey:provider==='rapidapi'?'facebook-scraper3.search':'native.j.facebook_post_search_v1',
    endpointVersion:provider==='rapidapi'?'v1':'night-all-source-snapshot.2026-09-26',
    contractVersion:provider==='rapidapi'?'mx-insight-hub.facebook-search.v1':'mx-insight-hub.native-forwarding.v1',businessCode:provider==='justone'?0:null, outcome: 'succeeded', httpStatus: 200, completedAt: capturedAt,startedAt:capturedAt,
    dispatchFingerprint:fingerprint,errorCode:null }
  const delivery = { usageRequestId: targetId, tenantId: input.tenantId, consumerId: input.consumerId, apiKeyId: input.apiKeyId,
    operation: 'social.facebook.search', fingerprint }
  const saved = { ...input,delivery,sourceMode:'fresh_cache',capturedAt,
    sources:[{callId:input.callId,providerKey:provider,bodySize:archive.bodySize,bodySha256:archive.bodySha256,rowsHash:digest('rows'),capturedAt}],
    lineage:{version:'facebook-fill.v1',scopeHash:input.scopeHash,previousDeliveryId:null,upstreamPages:1,startDate:input.startDate,endDate:input.endDate},
    responseBody:{data:{platform:'facebook',query:'fixture',pageInfo:{pageSize:20},items:[{id:'pfbid-long-string-identity'}]}},usageUnitsActual:1 }
  if (!postgres) {
    const usageStore = new MemoryStore()
    usageStore.requests.set(sourceId, structuredClone(source))
    usageStore.requests.set(targetId, structuredClone(target))
    usageStore.creditAccounts.set(input.tenantId, { id: accountId, availableMinor: 91, heldMinor: 9, revision: 1, currency: 'CNY' })
    usageStore.customerCharges.set(targetId, { id: randomUUID(), usageRequestId: targetId, accountId,
      tenantId: input.tenantId, enforcementMode: 'enforced', status: 'reserved', quotedMinor: 9, currency: 'CNY' })
    const store = new MemoryExternalPlatformStore({ usageStore, providerKey: 'rapidapi' })
    const sourceStore = provider==='rapidapi'?store:new MemoryExternalPlatformStore({usageStore,providerKey:provider})
    input.stores={rapidapi:store,justone:sourceStore};saved.stores=input.stores
    sourceStore.calls.set(input.callId, structuredClone(call))
    sourceStore.restrictedResponseArchives.set(input.callId, structuredClone(archive))
    return { input, payload, archive, source, target, call, saved, store,
      setCall: async changes => Object.assign(sourceStore.calls.get(input.callId), changes),
      setUsage: async (id, changes) => Object.assign(usageStore.requests.get(id), changes),
      setArchive: async changes => Object.assign(sourceStore.restrictedResponseArchives.get(input.callId), changes),
      insertCall: async value=>sourceStore.calls.set(value.id,structuredClone(value)),
      insertArchive: async (id,value)=>sourceStore.restrictedResponseArchives.set(id,structuredClone(value)),
      insertUsage: async value=>usageStore.requests.set(value.id,structuredClone(value)),
      getUsage: async id => structuredClone(usageStore.requests.get(id)),
      counts: async () => ({ calls: sourceStore.calls.size, gateways: sourceStore.requests.length, captures: usageStore.creditLedgerEntries.length,
        sourceCallId: sourceStore.requests[0]?.providerCallId,provider:sourceStore.requests[0]?.providerKey, charge: usageStore.customerCharges.get(targetId).status }),
    }
  }
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control; CREATE SCHEMA billing;
    CREATE TABLE usage_requests (id uuid PRIMARY KEY, tenant_id uuid, consumer_id uuid, api_key_id uuid,
      platform text, status text, response_status int, fingerprint char(64), acquisition_request jsonb, response_body jsonb,
      units_actual int, upstream_latency_ms int, delivery_source_mode text, response_captured_at timestamptz, completed_at timestamptz,
      reserved_at timestamptz DEFAULT now());
    CREATE TABLE external_platform.provider_calls (id uuid PRIMARY KEY, usage_request_id uuid REFERENCES usage_requests,
      tenant_id uuid, consumer_id uuid, api_key_id uuid, provider_key text, operation text, endpoint_key text,
      endpoint_version text, contract_version text, outcome text, http_status int, completed_at timestamptz,started_at timestamptz,
      dispatch_fingerprint char(64),error_code text,request_fingerprint char(64),business_code int);
    CREATE TABLE control.admission_recoveries(kind text,target text);
    CREATE TABLE external_platform.dispatch_leases (consumer_id uuid,operation text,request_fingerprint char(64),owner_request_id uuid,
      expires_at timestamptz,created_at timestamptz DEFAULT now(),UNIQUE(consumer_id,operation,request_fingerprint));
    CREATE TABLE control.external_platform_restricted_raw_responses (provider_call_id uuid REFERENCES external_platform.provider_calls,
      body_bytes bytea, body_sha256 text, body_size int, captured_at timestamptz);
    CREATE TABLE external_platform.gateway_requests (id uuid, provider_key text, tenant_id uuid, consumer_id uuid,
      usage_request_id uuid REFERENCES usage_requests, request_fingerprint text, source_mode text, succeeded boolean,
      response_status int, provider_call_id uuid REFERENCES external_platform.provider_calls, snapshot_id uuid, error_code text);
    CREATE TABLE billing.customer_charges (id uuid, usage_request_id uuid, tenant_id uuid, account_id uuid, status text,
      enforcement_mode text, quoted_minor int, currency text, charged_minor int, settled_at timestamptz);
    CREATE TABLE billing.credit_ledger_entries (account_id uuid, tenant_id uuid, charge_id uuid, usage_request_id uuid,
      kind text, amount_minor int, available_delta_minor int, held_delta_minor int, currency text, idempotency_key text UNIQUE,
      actor text, reason text);`)
  // Exercise the existing production settlement function, not a test imitation.
  const migration = await readFile(new URL('../../migrations/056_commercial_billing_ledger.sql', import.meta.url), 'utf8')
  const settlement = migration.match(/CREATE OR REPLACE FUNCTION billing\.settle_customer_charge\(\)[\s\S]*?EXECUTE FUNCTION billing\.settle_customer_charge\(\);/u)?.[0]
  assert.ok(settlement)
  await db.exec(settlement)
  const columns = { usageRequestId: 'usage_request_id', tenantId: 'tenant_id', consumerId: 'consumer_id', apiKeyId: 'api_key_id',
    providerKey: 'provider_key', endpointKey: 'endpoint_key', endpointVersion: 'endpoint_version', contractVersion: 'contract_version',
    reservedAt:'reserved_at',httpStatus: 'http_status', completedAt: 'completed_at', responseStatus: 'response_status', responseBody: 'response_body',
    acquisitionRequest: 'acquisition_request', unitsActual: 'units_actual', bodyBytes: 'body_bytes', bodySize: 'body_size',
    businessCode:'business_code',bodySha256: 'body_sha256', capturedAt: 'captured_at',dispatchFingerprint:'dispatch_fingerprint',startedAt:'started_at',errorCode:'error_code' }
  const sqlValue = value => value && typeof value === 'object' && !(value instanceof Uint8Array) ? JSON.stringify(value) : value
  const insert = async (table, data) => {
    const entries = Object.entries(data)
    await db.query(`INSERT INTO ${table} (${entries.map(([key]) => columns[key] || key).join(',')}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(',')})`, entries.map(([, value]) => sqlValue(value)))
  }
  const update = async (table, idColumn, id, changes) => {
    const entries = Object.entries(changes)
    await db.query(`UPDATE ${table} SET ${entries.map(([key], i) => `${columns[key] || key}=$${i + 2}`).join(',')} WHERE ${idColumn}=$1`, [id, ...entries.map(([, value]) => sqlValue(value))])
  }
  await insert('usage_requests', source)
  await insert('usage_requests', target)
  await insert('external_platform.provider_calls', call)
  await insert('control.external_platform_restricted_raw_responses', { provider_call_id: input.callId, ...archive })
  await insert('billing.customer_charges', { id: randomUUID(), usage_request_id: targetId, tenant_id: input.tenantId, account_id: accountId,
    status: 'reserved', enforcement_mode: 'enforced', quoted_minor: 9, currency: 'CNY' })
  const pool = { query: (sql, args) => db.query(sql, args), connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }) }
  const store = new PostgresExternalPlatformStore({ pool, providerKey: 'rapidapi' })
  return { input, payload, archive, source, target, call, saved, store, db,
    setCall: changes => update('external_platform.provider_calls', 'id', input.callId, changes),
    setUsage: async (id, changes) => {
      // Seed adversarial states without settling their fixture holds. The
      // delivery under test always runs with the production trigger enabled.
      await db.exec('ALTER TABLE usage_requests DISABLE TRIGGER usage_requests_settle_customer_charge')
      try { await update('usage_requests', 'id', id, changes) }
      finally { await db.exec('ALTER TABLE usage_requests ENABLE TRIGGER usage_requests_settle_customer_charge') }
    },
    setArchive: changes => update('control.external_platform_restricted_raw_responses', 'provider_call_id', input.callId, changes),
    insertCall: value=>insert('external_platform.provider_calls',value),
    insertArchive: (id,value)=>insert('control.external_platform_restricted_raw_responses',{provider_call_id:id,...value}),
    insertUsage: value=>insert('usage_requests',value),
    getUsage: async id => {
      const row = (await db.query('SELECT * FROM usage_requests WHERE id=$1', [id])).rows[0]
      return Object.fromEntries(Object.entries(row).map(([key, value]) => [Object.entries(columns).find(([, column]) => column === key)?.[0] || key,
        value instanceof Date ? value.toISOString() : value]))
    },
    counts: async () => ({ calls: (await db.query('SELECT count(*)::int n FROM external_platform.provider_calls')).rows[0].n,
      gateways: (await db.query('SELECT count(*)::int n FROM external_platform.gateway_requests')).rows[0].n,
      captures: (await db.query('SELECT count(*)::int n FROM billing.credit_ledger_entries')).rows[0].n,
      sourceCallId: (await db.query('SELECT provider_call_id FROM external_platform.gateway_requests')).rows[0]?.provider_call_id,
      provider:(await db.query('SELECT provider_key FROM external_platform.gateway_requests')).rows[0]?.provider_key,
      charge: (await db.query('SELECT status FROM billing.customer_charges')).rows[0].status }),
  }
}

for (const postgres of [false,true]) for (const provider of ['rapidapi','justone']) {
  const name=`${postgres?'PostgreSQL':'memory'} ${provider}`
  const options={skip:postgres&&!modulePath?'Set MX_INSIGHT_TEST_PGLITE_MODULE':false}
  test(`${name} Facebook archive binds exact source, identity and bytes`,options,async t=>{
    const f=await fixture(t,postgres,provider),read=()=>f.store.facebookPageFor(f.input)
    assert.deepEqual((await read()).payload,f.payload)
    for(const key of ['callId','tenantId','consumerId','apiKeyId'])
      assert.equal(await f.store.facebookPageFor({...f.input,[key]:randomUUID()}),null,key)
    for(const change of [{operation:'other'},{endpointVersion:'unreviewed'},{contractVersion:'other'},
      {providerKey:'other'},{httpStatus:201},{outcome:'unknown'},{completedAt:ago(25*3600000)},
      ...(provider==='justone'?[{businessCode:200}]:[])]) {
      await f.setCall(change);assert.equal(await read(),null,JSON.stringify(change));await f.setCall(f.call)
    }
    for(const change of [{platform:'twitter'},{status:'reserved'},{responseStatus:502},{apiKeyId:randomUUID()}]) {
      await f.setUsage(f.source.id,change);assert.equal(await read(),null,JSON.stringify(change));await f.setUsage(f.source.id,f.source)
    }
    for(const bytes of [Buffer.from([0xff]),Buffer.from('[]'),Buffer.from('null'),Buffer.from('{"bad":"\\u0000"}')]) {
      await f.setArchive({bodyBytes:bytes,bodySize:bytes.length,bodySha256:digest(bytes)})
      assert.equal(await read(),null);await f.setArchive(f.archive)
    }
    await f.setArchive({bodySha256:'0'.repeat(64)});assert.equal(await read(),null)
  })
  test(`${name} Facebook commits carry plus five private sources in one settlement`,options,async t=>{
    const f=await fixture(t,postgres,provider),owned=Array.from({length:5},()=>randomUUID()),own=owned.at(-1)
    for(const id of owned) {
      await f.insertCall({...f.call,id,usageRequestId:f.target.id})
      await f.insertArchive(id,f.archive)
    }
    assert.equal(await f.store.facebookPageFor({...f.input,callId:own}),null)
    const commit={...f.saved,lineage:{...f.saved.lineage,upstreamPages:6},
      sources:[...f.saved.sources,...owned.map(callId=>({...f.saved.sources[0],callId}))]}
    await assert.rejects(f.store.commitFacebookFillDelivery({...commit,
      sources:Array.from({length:17},()=>({...f.saved.sources[0],callId:randomUUID()}))}),{code:'search_page_unavailable'})
    if(postgres) {
      await f.db.exec('ALTER TABLE external_platform.gateway_requests ADD CONSTRAINT force_rollback CHECK (false)')
      await assert.rejects(f.store.commitFacebookFillDelivery(commit))
      assert.equal((await f.getUsage(f.target.id)).status,'reserved')
      assert.equal((await f.counts()).captures,0)
      await f.db.exec('ALTER TABLE external_platform.gateway_requests DROP CONSTRAINT force_rollback')
    }
    await f.store.commitFacebookFillDelivery(commit)
    const target=await f.getUsage(f.target.id),counts=await f.counts()
    assert.equal(target.status,'committed');assert.equal(target.unitsActual,1)
    assert.deepEqual(target.responseBody,commit.responseBody)
    assert.deepEqual(target.acquisitionRequest.facebookFill.sources,commit.sources)
    assert.deepEqual((await f.getUsage(f.source.id)).responseBody,f.source.responseBody)
    assert.equal(counts.calls,6);assert.equal(counts.gateways,1);assert.equal(counts.captures,1);assert.equal(counts.charge,'captured')
    assert.equal(counts.provider,provider);assert.equal(counts.sourceCallId,own)
    assert.ok(await f.store.facebookPageFor({...f.input,callId:own}))
    await assert.rejects(f.store.commitFacebookFillDelivery(commit),{code:'search_page_unavailable'})
  })
  test(`${name} Facebook lineage rejects scope drift, cycles and bad identities`,options,async t=>{
    const f=await fixture(t,postgres,provider)
    await f.store.commitFacebookFillDelivery(f.saved)
    const request={...f.input,previousDeliveryId:f.target.id}
    assert.deepEqual((await f.store.facebookDeliveredIdsFor(request)).ids,['pfbid-long-string-identity'])
    for(const changes of [{query:'other'},{scopeHash:'0'.repeat(64)},{type:'fresh'},{pageSize:19},{startDate:'2026-10-13'},{apiKeyId:randomUUID()}])
      await assert.rejects(f.store.facebookDeliveredIdsFor({...request,...changes}),{code:'search_page_unavailable'})
    const target=await f.getUsage(f.target.id)
    await f.setUsage(f.target.id,{acquisitionRequest:{...target.acquisitionRequest,facebookFill:{...target.acquisitionRequest.facebookFill,previousDeliveryId:f.target.id}}})
    await assert.rejects(f.store.facebookDeliveredIdsFor(request),{code:'search_page_unavailable'})
    await f.setUsage(f.target.id,{acquisitionRequest:target.acquisitionRequest,responseBody:{...target.responseBody,data:{...target.responseBody.data,items:[{id:123}]}}})
    await assert.rejects(f.store.facebookDeliveredIdsFor(request),{code:'search_page_unavailable'})
  })
}
for(const postgres of [false,true]) {
  test(`${postgres?'PostgreSQL':'memory'} Facebook parent lease protects exact ownership and unknown carry`,{skip:postgres&&!modulePath},async t=>{
    const f=await fixture(t,postgres)
    const lease={consumerId:f.input.consumerId,operation:'social.facebook.search',fingerprint,ownerRequestId:f.target.id,expiresAt:ago(-60000)}
    assert.equal((await f.store.acquireFacebookFillDeliveryLease(lease)).kind,'acquired')
    assert.equal((await f.store.acquireFacebookFillDeliveryLease(lease)).kind,'busy')
    assert.equal((await f.store.acquireDispatchLease({...lease,ownedDeliveryLease:true})).kind,'acquired')
    assert.equal((await f.store.acquireDispatchLease({...lease,ownedDeliveryLease:true,ownerRequestId:randomUUID()})).kind,'busy')
    assert.equal((await f.store.acquireDispatchLease({...lease,ownedDeliveryLease:true,expiresAt:ago(-90000)})).kind,'busy')
    await f.setUsage(f.target.id,{status:'unknown',reservedAt:ago(1000)})
    assert.equal(await f.store.facebookFillUnknownFor(f.saved.delivery),true)
    assert.equal(await f.store.facebookFillUnknownFor({...f.saved.delivery,apiKeyId:randomUUID()}),false)
  })
}
for (const postgres of [false,true]) {
  test(`${postgres?'PostgreSQL':'memory'} Facebook history is bounded and rejects altered acquisition scope`,{skip:postgres&&!modulePath},async t=>{
    const f=await fixture(t,postgres)
    await f.store.commitFacebookFillDelivery(f.saved)
    const committed=await f.getUsage(f.target.id),request={...f.input,previousDeliveryId:f.target.id}
    for(const body of [
      {platform:'facebook',query:'fixture',pageSize:20,type:'stable',params:{startDate:'2026-10-14'}},
      {platform:'facebook',query:'fixture',pageSize:20,type:'stable',params:{provider:'justone'}},
      {platform:'facebook',query:'fixture',pageSize:20,type:'fresh'},
    ]) {
      await f.setUsage(f.target.id,{acquisitionRequest:{...committed.acquisitionRequest,body}})
      await assert.rejects(f.store.facebookDeliveredIdsFor(request),{code:'search_page_unavailable'})
    }
    await f.setUsage(f.target.id,{acquisitionRequest:committed.acquisitionRequest})
    let previous=f.target.id
    for(let n=1;n<=15;n++) {
      const next=randomUUID()
      await f.insertUsage({...committed,id:next,acquisitionRequest:{...committed.acquisitionRequest,
        facebookFill:{...committed.acquisitionRequest.facebookFill,previousDeliveryId:previous}}})
      previous=next
      if(n===14) assert.equal((await f.store.facebookDeliveredIdsFor({...request,previousDeliveryId:previous})).deliveries,15)
    }
    await assert.rejects(f.store.facebookDeliveredIdsFor({...request,previousDeliveryId:previous}),{code:'search_page_unavailable'})
  })
}
test('Facebook PostgreSQL lost COMMIT acknowledgment discards connection and retains durable settlement',{skip:!modulePath},async t=>{
  const f=await fixture(t,true),original=f.store.pool.connect
  let releasedWith=null
  f.store.pool.connect=async()=>{
    const connection=await original()
    return {query:async(sql,args)=>{
      const result=await connection.query(sql,args)
      if(sql==='COMMIT') throw new Error('lost commit acknowledgment')
      return result
    },release:error=>{releasedWith=error}}
  }
  await assert.rejects(f.store.commitFacebookFillDelivery(f.saved),/lost commit acknowledgment/)
  assert.match(releasedWith?.message,/lost commit acknowledgment/)
  assert.equal((await f.getUsage(f.target.id)).status,'committed')
  assert.equal((await f.counts()).captures,1)
  assert.equal((await f.counts()).gateways,1)
})
