import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { SearchAdmissionDispositionService, getSearchAdmissionDispositionIds } from '../../server/operations/search-admission-disposition.mjs'
import { prepareDataSearchV2 } from '../../server/contracts/data-search-v2.mjs'
import { searchAdmissionDispositionFixture as fixture, pgOptions } from '../fixtures/search-admission-disposition.mjs'

const saved = async f => ({
  usage:(await f.db.query('SELECT * FROM usage_requests ORDER BY id')).rows,
  calls:(await f.db.query('SELECT * FROM external_platform.provider_calls ORDER BY id')).rows,
  protocol:(await f.db.query('SELECT * FROM control.data_search_protocol_bindings ORDER BY idempotency_key')).rows,
  charges:(await f.db.query('SELECT * FROM billing.customer_charges ORDER BY usage_request_id')).rows,
  ledger:(await f.db.query('SELECT * FROM billing.credit_ledger_entries ORDER BY id')).rows,
})

for (const v2 of [false,true]) test(`PG disposition v${v2?2:1} prepares read-only and records one immutable administrative decision`,pgOptions,async t=>{
  const f=await fixture(t,{v2}),before=await saved(f)
  const prepared=await f.service.prepare(f.id)
  assert.equal(prepared.eligibility.allowed,true)
  assert.deepEqual(prepared.scope,f.scope)
  assert.equal(prepared.disposition,null)
  assert.equal(prepared.upstreamDispatched,false)
  assert.ok(f.statements.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
  assert.equal(f.statements.some(sql=>/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/u.test(sql)),false)
  const body={revision:prepared.revision,reason:'Accept this historical risk',acceptUnknownRisk:true}
  const result=await f.service.resolve(f.id,body,{actor:'fixture-admin',requestId:randomUUID()})
  const repeated=await f.service.resolve(f.id,body,{actor:'fixture-admin',requestId:randomUUID()})
  assert.equal(result.upstreamDispatched,false)
  assert.equal(repeated.replay,true)
  assert.deepEqual(repeated.disposition,result.disposition)
  assert.deepEqual(await saved(f),before)
  assert.deepEqual(await getSearchAdmissionDispositionIds(f.pool,[f.id],f.scope),[f.id])
  await assert.rejects(f.service.resolve(f.id,{...body,reason:'Different decision'},{actor:'fixture-admin'}),{code:'search_admission_disposition_conflict'})
  await assert.rejects(f.db.query("UPDATE control.search_admission_dispositions SET reason='change' WHERE original_usage_request_id=$1",[f.id]),{code:'55000'})
  await assert.rejects(f.db.query('DELETE FROM control.search_admission_dispositions WHERE original_usage_request_id=$1',[f.id]),{code:'55000'})
  await assert.rejects(f.db.exec('TRUNCATE control.search_admission_dispositions'),{code:'55000'})
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM control.search_admission_dispositions')).rows[0].n,1)
})

test('PG disposition missing migration and invalid confirmations fail closed without mutating evidence',pgOptions,async t=>{
  const f=await fixture(t,{withMigration:false})
  assert.deepEqual(await getSearchAdmissionDispositionIds(f.pool,[f.id],f.scope),[])
  await assert.rejects(f.service.prepare(f.id),{code:'search_admission_disposition_unavailable'})
  for(const body of [null,{}, {revision:'a'.repeat(64),reason:'Accept risk',acceptUnknownRisk:false},
    {revision:'a'.repeat(64),reason:'Accept risk',acceptUnknownRisk:true,force:true}]) {
    await assert.rejects(f.service.resolve(f.id,body),{code:'invalid_search_admission_disposition'})
  }
})

test('PG disposition rejects live work, missing evidence, wrong identities and non-unknown requests',pgOptions,async t=>{
  const f=await fixture(t)
  const scenarios=[
    {sql:"UPDATE usage_requests SET status='reserved' WHERE id=$1",code:'search_admission_not_unknown'},
    {sql:"UPDATE usage_requests SET acquisition_request=NULL WHERE id=$1",code:'search_admission_evidence_unavailable'},
    {sql:"UPDATE usage_requests SET acquisition_request=jsonb_set(acquisition_request,'{body,query}','\"different query\"') WHERE id=$1",code:'search_admission_evidence_unavailable'},
    {sql:"UPDATE usage_requests SET completed_at=NULL WHERE id=$1",code:'search_admission_call_evidence_unavailable'},
    {sql:"UPDATE external_platform.provider_calls SET outcome='pending',completed_at=NULL WHERE usage_request_id=$1",code:'search_admission_call_evidence_unavailable'},
    {sql:"UPDATE control.data_search_protocol_bindings SET state='running' WHERE usage_request_id=$1",code:'search_admission_still_running'},
    {sql:"UPDATE control.data_search_protocol_bindings SET query_hash=repeat('b',64) WHERE usage_request_id=$1",code:'search_admission_evidence_unavailable'},
    {sql:"UPDATE control.data_search_protocol_bindings SET request_body=jsonb_set(request_body,'{query}','\"different query\"') WHERE usage_request_id=$1",code:'search_admission_evidence_unavailable'},
  ]
  for(const scenario of scenarios) {
    const root=await f.addUnknown()
    await f.db.query(scenario.sql,[root.id])
    const prepared=await f.service.prepare(root.id)
    assert.equal(prepared.eligibility.allowed,false,scenario.sql)
    assert.equal(prepared.eligibility.reasonCode,scenario.code,scenario.sql)
    await assert.rejects(f.service.resolve(root.id,{revision:prepared.revision,reason:'Accept risk',acceptUnknownRisk:true}),
      {code:'search_admission_disposition_not_allowed'})
  }
  const noCalls=await f.addUnknown({withCall:false})
  assert.equal((await f.service.prepare(noCalls.id)).eligibility.allowed,false)
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM control.search_admission_dispositions')).rows[0].n,0)
})

test('PG disposition requires no original protocol lease, including expired ones, and no active owned dispatch',pgOptions,async t=>{
  const f=await fixture(t)
  await f.db.query(`INSERT INTO control.data_search_protocol_leases
    (owner_id,tenant_id,consumer_id,api_key_id,platform,query_hash,idempotency_key,version,expires_at)
    SELECT owner_id,tenant_id,consumer_id,api_key_id,platform,query_hash,idempotency_key,2,now()-interval '1 hour'
    FROM control.data_search_protocol_bindings WHERE usage_request_id=$1`,[f.id])
  assert.equal((await f.service.prepare(f.id)).eligibility.reasonCode,'search_admission_still_running')
  await f.db.query('DELETE FROM control.data_search_protocol_leases WHERE owner_id=$1',[f.ownerId])
  await f.db.query(`INSERT INTO external_platform.dispatch_leases(consumer_id,operation,request_fingerprint,owner_request_id,expires_at)
    VALUES($1,'social.content.search',$2,$3,now()+interval '1 hour')`,[f.consumerId,f.fingerprint,f.id])
  assert.equal((await f.service.prepare(f.id)).eligibility.reasonCode,'search_admission_still_running')
})

test('PG disposition revision fences changed evidence; exact concurrent confirmations share one decision',pgOptions,async t=>{
  const f=await fixture(t),prepared=await f.service.prepare(f.id)
  await f.db.query("UPDATE external_platform.provider_calls SET error_code='changed_evidence' WHERE id=$1",[f.callId])
  await assert.rejects(f.service.resolve(f.id,{revision:prepared.revision,reason:'Accept risk',acceptUnknownRisk:true}),
    {code:'search_admission_disposition_changed'})
  const current=await f.service.prepare(f.id)
  const body={revision:current.revision,reason:'Accept unchanged evidence',acceptUnknownRisk:true}
  const result=await Promise.all([f.service.resolve(f.id,body),f.service.resolve(f.id,body)])
  assert.equal(result[0].disposition.id,result[1].disposition.id)
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM control.search_admission_dispositions')).rows[0].n,1)
})

test('PG lookup admits only the exact approved candidate, owner scope and unchanged proof',pgOptions,async t=>{
  const f=await fixture(t),second=await f.addUnknown()
  await f.resolve()
  assert.deepEqual(await getSearchAdmissionDispositionIds(f.pool,[{id:f.id},{usage_request_id:second.id}],f.scope),[f.id])
  for(const patch of [{tenantId:randomUUID()},{consumerId:randomUUID()},{apiKeyId:randomUUID()},{platform:'facebook'},{query:'different query'}]) {
    assert.deepEqual(await getSearchAdmissionDispositionIds(f.pool,[f.id],{...f.scope,...patch}),[])
  }
  assert.deepEqual(await getSearchAdmissionDispositionIds(f.pool,[f.id],{...f.scope,query:'offline AND disposition AND fixture'}),[f.id])
  // A fresh request's own lease cannot invalidate the historical decision.
  await f.db.query(`INSERT INTO external_platform.dispatch_leases(consumer_id,operation,request_fingerprint,owner_request_id,expires_at)
    VALUES($1,'social.content.search',$2,$3,now()+interval '1 hour')`,[f.consumerId,f.fingerprint,second.id])
  assert.deepEqual(await getSearchAdmissionDispositionIds(f.pool,[f.id],f.scope),[f.id])
  await f.db.query("UPDATE external_platform.provider_calls SET error_code='new_evidence' WHERE id=$1",[f.callId])
  assert.deepEqual(await getSearchAdmissionDispositionIds(f.pool,[f.id],f.scope),[])
  const stale=await f.service.prepare(f.id)
  assert.equal(stale.disposition.effective,false)
  assert.equal(stale.eligibility.reasonCode,'search_admission_disposition_stale')
})

test('PG lookup never admits approved history after state, request evidence, binding or calls drift',pgOptions,async t=>{
  const f=await fixture(t)
  for(const sql of ["UPDATE usage_requests SET status='committed' WHERE id=$1",
    "UPDATE usage_requests SET acquisition_request=jsonb_set(acquisition_request,'{body,query}','\"different query\"') WHERE id=$1",
    "UPDATE external_platform.provider_calls SET outcome='pending',completed_at=NULL WHERE usage_request_id=$1",
    "UPDATE external_platform.provider_calls SET dispatch_fingerprint=repeat('c',64) WHERE usage_request_id=$1",
    "UPDATE external_platform.provider_calls SET call_ordinal=call_ordinal+1 WHERE usage_request_id=$1",
    "UPDATE control.data_search_protocol_bindings SET state='running' WHERE usage_request_id=$1"]) {
    const root=await f.addUnknown()
    await f.resolve(root.id)
    await f.db.query(sql,[root.id])
    assert.deepEqual(await getSearchAdmissionDispositionIds(f.pool,[root.id],f.scope),[],sql)
    assert.equal((await f.service.prepare(root.id)).disposition.effective,false,sql)
  }
})

test('PG disposition accepts provider-neutral completed Twitter evidence without a paid retry',pgOptions,async t=>{
  const f=await fixture(t),root=await f.addUnknown({provider:'tikhub'})
  assert.equal((await f.service.prepare(root.id)).eligibility.allowed,true)
  await f.resolve(root.id)
  assert.deepEqual(await getSearchAdmissionDispositionIds(f.pool,[root.id],f.scope),[root.id])
})

test('PG disposition verifies saved v2 cursors without requiring expired pages to be acquired again',pgOptions,async t=>{
  const f=await fixture(t)
  const {state}=prepareDataSearchV2(f.body,f.codec)
  const body={...f.body,cursor:f.codec.encode({...state,page:2,expiresAt:Date.now()-3600000,cursor:'mxds1.saved-evidence'})}
  const root=await f.addUnknown({body})
  assert.equal((await f.service.prepare(root.id)).eligibility.allowed,true)
  const missingPepper=new SearchAdmissionDispositionService({pool:f.pool})
  assert.equal((await missingPepper.prepare(root.id)).eligibility.allowed,false)
  await f.resolve(root.id)
  assert.deepEqual(await getSearchAdmissionDispositionIds(f.pool,[root.id],f.scope),[root.id])
})

test('unavailable database does not offer memory-only administrative disposal',async()=>{
  await assert.rejects(new SearchAdmissionDispositionService({pool:null}).prepare(randomUUID()),{status:503})
})
