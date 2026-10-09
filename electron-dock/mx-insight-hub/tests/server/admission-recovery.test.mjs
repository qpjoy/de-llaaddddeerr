import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { AdmissionRecoveryService } from '../../server/operations/admission-recovery.mjs'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { assertPostgresKeyAccessLimits } from '../../server/stores/key-access-limits.mjs'
import { quotaRecoverySql } from '../../server/core/admission-recovery.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA control; CREATE SCHEMA external_platform;
    CREATE TABLE consumers(id uuid PRIMARY KEY,name text);
    CREATE TABLE api_keys(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,name text,status text,created_at timestamptz DEFAULT now(),scope_mode text DEFAULT 'snapshot',expires_at timestamptz DEFAULT now()+interval '1 day');
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,api_key_id uuid,consumer_id uuid,tenant_id uuid,platform text,capability text,status text,
      reserved_at timestamptz DEFAULT now(),lease_expires_at timestamptz DEFAULT now()+interval '2 minutes');
    CREATE TABLE usage_request_authorization_scopes(usage_request_id uuid,scope_type text,scope_key text);
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,provider_key text,consumer_id uuid,operation text,endpoint_key text,
      contract_version text,request_fingerprint text,dispatch_fingerprint text,outcome text,error_code text,started_at timestamptz,
      completed_at timestamptz,usage_request_id uuid,billed boolean);
    CREATE TABLE external_platform.dispatch_leases(consumer_id uuid,operation text,request_fingerprint text,owner_request_id uuid,
      expires_at timestamptz,created_at timestamptz DEFAULT now(),PRIMARY KEY(consumer_id,operation,request_fingerprint));
    CREATE TABLE external_platform.provider_state(provider_key text PRIMARY KEY,consecutive_failures int,circuit_open_until timestamptz,
      last_failure_at timestamptz,last_error_code text,updated_at timestamptz DEFAULT now());
    CREATE TABLE external_platform.provider_contract_circuits(provider_key text,scope text,consecutive_failures int,circuit_open_until timestamptz,
      last_failure_at timestamptz,last_error_code text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(provider_key,scope));
    CREATE TABLE external_platform.provider_rate_buckets(provider_key text PRIMARY KEY,capacity int,window_ms int,tokens float,
      last_admitted boolean,refilled_at timestamptz,updated_at timestamptz DEFAULT now());
    CREATE TABLE api_key_platform_entitlements(api_key_id uuid,platform text,max_requests int,window_seconds int,max_page_size int,created_at timestamptz DEFAULT now());
    CREATE TABLE api_key_capability_entitlements(api_key_id uuid,capability text,max_requests int,window_seconds int,created_at timestamptz DEFAULT now());
    CREATE TABLE consumer_platform_policies(consumer_id uuid,platform text,max_requests int,window_seconds int,max_page_size int DEFAULT 100);
    CREATE TABLE consumer_capability_policies(consumer_id uuid,capability text,max_requests int,window_seconds int,created_at timestamptz DEFAULT now());
    CREATE TABLE platform_grants(consumer_id uuid,platform text);
    CREATE TABLE capability_grants(consumer_id uuid,capability text);
    CREATE TABLE control.api_key_access_limits(api_key_id uuid,scope_type text,scope_key text,total_limit bigint,rate_limit int,window_seconds int,revision int);
    CREATE TABLE consumer_plan_assignments(consumer_id uuid,plan_version_id uuid,assigned_at timestamptz);
    CREATE TABLE plan_versions(id uuid,plan_id uuid,limits jsonb,status text DEFAULT 'published');
    CREATE TABLE plans(id uuid,plan_key text,status text DEFAULT 'active');`)
  await db.exec(await readFile(new URL('../../migrations/138_admission_recovery.sql', import.meta.url), 'utf8'))
  const query = async (...args) => { const result = await db.query(...args); return { ...result, rowCount: result.rows.length || result.affectedRows } }
  const pool = { query, async connect() { return { query, release() {} } } }
  const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID(), request = randomUUID()
  await db.query("INSERT INTO consumers VALUES($1,'Fixture consumer')", [consumer])
  await db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,status) VALUES($1,$2,$3,'Fixture key','active')", [key,tenant,consumer])
  await db.query("INSERT INTO usage_requests(id,api_key_id,consumer_id,tenant_id,platform,status,reserved_at) VALUES($1,$2,$3,$4,'instagram','committed',now()-interval '10 seconds')", [request,key,consumer,tenant])
  const store = new PostgresStore(pool)
  const service = new AdmissionRecoveryService({ pool, usageStore: store, providers: { tikhub: { cooldownMs:900000,burst:1 } } })
  const platform = new PostgresExternalPlatformStore({ pool,providerKey:'tikhub',uncertainCooldownMs:900000,rateLimitBurst:1 })
  const recover = row => service.recover(Object.fromEntries(Object.entries({ kind:row.kind,target:row.target,scopeType:row.scopeType,
    scopeKey:row.scopeKey,revision:row.revision,apiKeyId:key,reason:'Operator reviewed the parser fix' }).filter(([,v]) => v !== undefined)), { requestId:randomUUID() })
  const addCall = async (outcome='succeeded_unusable') => {
    const id=randomUUID()
    await db.query(`INSERT INTO external_platform.provider_calls VALUES($1,'tikhub',$2,'native.instagram','native.instagram','v1','fingerprint','fingerprint',
      $3,'invalid_instagram_search_shape',now()-interval '11 seconds',now()-interval '10 seconds',$4,true)`, [id,consumer,outcome,request])
    return id
  }
  const lease = {consumerId:consumer,operation:'native.instagram',fingerprint:'fingerprint',endpointKey:'native.instagram',contractVersion:'v1',
    ownerRequestId:request,expiresAt:new Date(Date.now()+60000)}
  return {db,pool,store,service,platform,tenant,consumer,key,request,recover,addCall,lease}
}

test('quarantine recovery changes dispatch admission but preserves the paid receipt and does not waive newer or unknown calls', {skip:!modulePath}, async t => {
  const f=await fixture(t), callId=await f.addCall()
  assert.equal((await f.platform.acquireDispatchLease(f.lease)).kind,'blocked')
  const before=(await f.db.query('SELECT * FROM external_platform.provider_calls')).rows
  const row=(await f.service.snapshot({requestId:f.request})).items.find(row=>row.target===callId)
  assert.equal(row.active,true); assert.equal(row.recoverable,true)
  const result=await f.recover(row)
  assert.equal(result.upstreamDispatched,false)
  assert.equal((await f.recover(row)).replay,true)
  assert.equal((await f.platform.acquireDispatchLease(f.lease)).kind,'acquired')
  await f.platform.releaseDispatchLease(f.lease)
  assert.deepEqual((await f.db.query('SELECT * FROM external_platform.provider_calls')).rows,before)
  await f.addCall('unknown')
  const unknown=(await f.service.snapshot()).items.find(row=>row.kind==='unknown')
  assert.equal(unknown.recoverable,false)
  await assert.rejects(f.recover(unknown), {status:400})
  assert.equal((await f.platform.acquireDispatchLease(f.lease)).reason,'unknown')
  await f.addCall()
  assert.ok((await f.service.snapshot()).items.some(row=>row.kind==='response_quarantine'))
  assert.equal((await f.db.query('SELECT count(*)::int n FROM control.admission_recoveries')).rows[0].n,1)
})

test('ordinary admission counts new reservations after a reset and still rejects the next over-limit request', {skip:!modulePath}, async t => {
  const f=await fixture(t)
  await f.db.exec(`ALTER TABLE usage_requests ADD idempotency_key text, ADD fingerprint text, ADD billing_meter_key text,
    ADD authorization_scopes jsonb, ADD units_reserved int, ADD acquisition_request jsonb;
    CREATE TABLE usage_idempotency_bindings(tenant_id uuid,consumer_id uuid,idempotency_key text,api_key_id uuid,fingerprint text,current_request_id uuid,updated_at timestamptz);`)
  await f.db.query("INSERT INTO platform_grants VALUES($1,'instagram')",[f.consumer])
  await f.db.query("INSERT INTO api_key_platform_entitlements(api_key_id,platform,max_requests,window_seconds,max_page_size) VALUES($1,'instagram',1,3600,20)",[f.key])
  await f.db.query("INSERT INTO consumer_platform_policies(consumer_id,platform,max_requests,window_seconds) VALUES($1,'instagram',100,3600)",[f.consumer])
  const plan=randomUUID(),version=randomUUID()
  await f.db.query("INSERT INTO plans(id,plan_key) VALUES($1,'test-plan')",[plan])
  await f.db.query('INSERT INTO plan_versions(id,plan_id,limits) VALUES($1,$2,$3)',[version,plan,JSON.stringify({maxRequests:100,windowSeconds:3600,monthlyRequests:100,burstRps:100})])
  await f.db.query("INSERT INTO consumer_plan_assignments VALUES($1,$2,now()-interval '1 day')",[f.consumer,version])
  const reserve=()=>f.store.reserve({requestId:randomUUID(),tenantId:f.tenant,consumerId:f.consumer,apiKeyId:f.key,
    idempotencyKey:randomUUID(),fingerprint:'fixture',platform:'instagram',unitsReserved:1,leaseExpiresAt:new Date(Date.now()+60000),
    requiredAuthorizationScopes:[{type:'platform',key:'instagram'}]})
  await assert.rejects(reserve,{code:'api_key_quota_exceeded'})
  const row=(await f.service.snapshot({apiKeyId:f.key})).items.find(row=>row.kind==='key_window')
  const reset=await f.recover(row)
  const admitted=await reserve()
  assert.equal(admitted.kind,'reserved')
  assert.ok(Date.parse(admitted.request.reservedAt)>=Date.parse(reset.recoveredAt))
  await assert.rejects(reserve,{code:'api_key_quota_exceeded'})
  assert.equal((await f.db.query('SELECT count(*)::int n FROM usage_requests')).rows[0].n,2)
})

test('legacy Key scopes and internal TikHub exemptions remain visible without clearing shared state', {skip:!modulePath}, async t => {
  const f=await fixture(t)
  await f.db.query("UPDATE api_keys SET scope_mode='legacy_dynamic' WHERE id=$1",[f.key])
  await f.db.query("INSERT INTO platform_grants VALUES($1,'instagram')",[f.consumer])
  await f.db.exec(`INSERT INTO external_platform.provider_state VALUES('tikhub',3,now()+interval '1 minute',now()-interval '11 seconds','upstream_rate_limited',now());
    INSERT INTO external_platform.provider_rate_buckets VALUES('tikhub',1,3600000,0,false,now(),now());`)
  f.store.internalTrafficPolicy={matches:()=>true}
  const rows=(await f.service.snapshot({apiKeyId:f.key})).items
  assert.equal(rows.find(r=>r.kind==='key_window').scopeKey,'instagram')
  assert.match(rows.find(r=>r.kind==='provider_rate').selectedKeyEffect,/豁免/)
  assert.match(rows.find(r=>r.kind==='provider_circuit').selectedKeyEffect,/已到期/)
  assert.equal(rows.find(r=>r.kind==='provider_circuit').active,true)
  assert.equal((await f.db.query('SELECT count(*)::int n FROM control.admission_recoveries')).rows[0].n,0)
})

test('circuit recovery compares the current revision, preserves failure evidence and records an audit; rate recovery refills one burst', {skip:!modulePath}, async t => {
  const f=await fixture(t)
  await f.db.exec(`INSERT INTO external_platform.provider_state VALUES('tikhub',3,now()+interval '1 minute',now(),'upstream_rate_limited',now());
    INSERT INTO external_platform.provider_rate_buckets VALUES('tikhub',1,3600000,0,false,now(),now());
    INSERT INTO external_platform.provider_contract_circuits VALUES('tikhub','instagram',3,now()+interval '1 minute',now(),'invalid_shape',now());`)
  const first=(await f.service.snapshot()).items.find(row=>row.kind==='provider_circuit')
  await f.db.exec('UPDATE external_platform.provider_state SET consecutive_failures=4')
  await assert.rejects(f.recover(first),{status:409})
  const rows=(await f.service.snapshot()).items
  for(const kind of ['provider_circuit','contract_circuit','provider_rate']) await f.recover(rows.find(row=>row.kind===kind))
  assert.equal((await f.service.snapshot()).items.length,0)
  const state=(await f.db.query('SELECT * FROM external_platform.provider_state')).rows[0]
  assert.equal(state.last_error_code,'upstream_rate_limited');assert.equal(state.consecutive_failures,0)
  assert.equal((await f.db.query('SELECT tokens FROM external_platform.provider_rate_buckets')).rows[0].tokens,1)
})

test('Key and consumer windows reset independently of monthly/total accounting and share the actual admission predicates', {skip:!modulePath}, async t => {
  const f=await fixture(t)
  await f.db.query("INSERT INTO api_key_platform_entitlements(api_key_id,platform,max_requests,window_seconds,max_page_size) VALUES($1,'instagram',1,3600,20)",[f.key])
  await f.db.query("INSERT INTO consumer_platform_policies(consumer_id,platform,max_requests,window_seconds) VALUES($1,'instagram',1,3600)",[f.consumer])
  await f.db.query("INSERT INTO control.api_key_access_limits VALUES($1,'platform','instagram',10,1,3600,1)",[f.key])
  const plan=randomUUID(), version=randomUUID()
  await f.db.query("INSERT INTO plans(id,plan_key) VALUES($1,'test-plan')",[plan])
  await f.db.query('INSERT INTO plan_versions(id,plan_id,limits) VALUES($1,$2,$3)',[version,plan,JSON.stringify({maxRequests:1,windowSeconds:3600,burstRps:5,monthlyRequests:1})])
  await f.db.query("INSERT INTO consumer_plan_assignments VALUES($1,$2,now()-interval '1 day')",[f.consumer,version])
  let rows=(await f.service.snapshot({apiKeyId:f.key})).items
  for(const kind of ['key_window','consumer_window','key_rate','plan_window','plan_month']) assert.equal(rows.find(r=>r.kind===kind).active,true,kind)
  assert.equal(rows.find(r=>r.kind==='plan_month').recoverable,false)
  await assert.rejects(assertPostgresKeyAccessLimits(f.pool,f.key,[{type:'platform',key:'instagram'}]),{code:'api_key_rate_limit_exceeded'})
  await f.recover(rows.find(r=>r.kind==='key_window'))
  let quota=await f.store.quotaSnapshot({tenantId:f.tenant,consumerId:f.consumer,apiKeyId:f.key})
  assert.equal(quota[0].layers.find(r=>r.limitScope==='api_key').used,0)
  assert.equal(quota[0].layers.find(r=>r.limitScope==='consumer').used,1)
  for(const kind of ['consumer_window','key_rate','plan_window']) {
    rows=(await f.service.snapshot({apiKeyId:f.key})).items
    await f.recover(rows.find(r=>r.kind===kind))
  }
  await assertPostgresKeyAccessLimits(f.pool,f.key,[{type:'platform',key:'instagram'}])
  const counted=await f.db.query(`SELECT count(*)::int n FROM usage_requests request WHERE consumer_id=$1 ${quotaRecoverySql('plan_window','$1')}`,[f.consumer])
  assert.equal(counted.rows[0].n,0)
  rows=(await f.service.snapshot({apiKeyId:f.key})).items
  assert.equal(rows.find(r=>r.kind==='plan_month').used,1)
  assert.equal(rows.find(r=>r.kind==='key_total').used,1)
  assert.equal((await f.db.query('SELECT count(*)::int n FROM usage_requests')).rows[0].n,1)
  await f.db.query("INSERT INTO usage_requests(id,api_key_id,consumer_id,tenant_id,platform,status,reserved_at) VALUES($1,$2,$3,$4,'instagram','committed',clock_timestamp())",[randomUUID(),f.key,f.consumer,f.tenant])
  await assert.rejects(assertPostgresKeyAccessLimits(f.pool,f.key,[{type:'platform',key:'instagram'}]),{code:'api_key_rate_limit_exceeded'})
  quota=await f.store.quotaSnapshot({tenantId:f.tenant,consumerId:f.consumer,apiKeyId:f.key})
  assert.equal(quota[0].layers.find(r=>r.limitScope==='api_key').used,1)
  f.store.internalTrafficPolicy={matches:()=>true}
  rows=(await f.service.snapshot({apiKeyId:f.key})).items
  assert.ok(rows.filter(r=>r.kind.startsWith('key_')||r.kind.startsWith('plan_')).every(r=>r.exempt&&!r.active&&!r.recoverable))
})
