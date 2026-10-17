import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { FACEBOOK_EMPTY_RECOVERY_CASE as incident, prepareFacebookEmptyRecovery } from '../../server/ops/prepare-facebook-empty-recovery.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const secret = 'private-query-token-raw-body'
const stepUuid = '57107be2-7e3c-4f11-a06c-91e7184b76c7'
const idem = `delta-page-${stepUuid}-r0-p1-0123456789abcdef`
async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  // Real column names/types from 001, 051, 054, 056, 057, 058 and 094.
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control; CREATE SCHEMA billing;
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,api_key_id uuid,
      fingerprint char(64),idempotency_key text,platform text,status text,response_status integer,
      response_body jsonb,reserved_at timestamptz,completed_at timestamptz,acquisition_request jsonb);
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,usage_request_id uuid,tenant_id uuid,
      consumer_id uuid,api_key_id uuid,request_fingerprint char(64),provider_key text,operation text,
      endpoint_key text,marketplace text,outcome text,http_status integer,business_code integer,billed boolean,
      cost_minor bigint,cost_kind text,currency char(3),started_at timestamptz,completed_at timestamptz);
    CREATE TABLE external_platform.response_archives(provider_call_id uuid PRIMARY KEY,contract_state text,
      http_status integer,business_code integer,raw_payload jsonb);
    CREATE TABLE control.external_platform_restricted_raw_responses(provider_call_id uuid PRIMARY KEY,
      body_sha256 char(64),body_size integer,json_parsed boolean,captured_at timestamptz,body_bytes bytea);
    CREATE TABLE usage_idempotency_bindings(tenant_id uuid,consumer_id uuid,api_key_id uuid,fingerprint char(64),
      idempotency_key text,current_request_id uuid,updated_at timestamptz,PRIMARY KEY(consumer_id,idempotency_key));
    CREATE TABLE billing.credit_accounts(id uuid PRIMARY KEY,tenant_id uuid,currency char(3),status text,held_minor bigint);
    CREATE TABLE billing.customer_charges(id uuid PRIMARY KEY,usage_request_id uuid UNIQUE,tenant_id uuid,
      consumer_id uuid,api_key_id uuid,account_id uuid,enforcement_mode text,status text,currency char(3),
      quoted_minor bigint,charged_minor bigint,settled_at timestamptz);
    CREATE TABLE billing.credit_ledger_entries(id uuid PRIMARY KEY,usage_request_id uuid,charge_id uuid,
      tenant_id uuid,account_id uuid,kind text,amount_minor bigint,available_delta_minor bigint,
      held_delta_minor bigint,currency char(3),created_at timestamptz,idempotency_key text,actor text,reason text);
    CREATE TABLE external_platform.provider_cost_reservations(id uuid PRIMARY KEY,usage_request_id uuid,
      provider_key text,status text,currency char(3),base_cost_minor bigint,reserved_cost_minor bigint,
      reserved_subsidy_minor bigint,created_at timestamptz,released_at timestamptz);`)
  const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID(), account = randomUUID(), charge = randomUUID()
  const at = '2026-10-17T05:26:40.028Z'
  await db.query(`INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,$6,'facebook','unknown',NULL,NULL,$7,$7,$8)`,
    [incident.requestId,tenant,consumer,key,'a'.repeat(64),idem,at,JSON.stringify({path:'/api/v1/data/search',body:{query:secret}})])
  await db.query(`INSERT INTO external_platform.provider_calls VALUES($1,$2,$3,$4,$5,$6,'justone',
    'native.j.facebook_post_search_v1','native.j.facebook_post_search_v1','facebook','unknown',NULL,NULL,true,3,'estimated','CNY',$7,$7)`,
    [incident.callId,incident.requestId,tenant,consumer,key,'a'.repeat(64),at])
  await db.query(`INSERT INTO external_platform.response_archives VALUES($1,'accepted',200,0,$2)`,
    [incident.callId,JSON.stringify({token:secret})])
  await db.query(`INSERT INTO control.external_platform_restricted_raw_responses VALUES($1,$2,153,true,$3,$4)`,
    [incident.callId,incident.sha256,at,Buffer.from(secret)])
  await db.query(`INSERT INTO usage_idempotency_bindings VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [tenant,consumer,key,'a'.repeat(64),idem,incident.requestId,at])
  await db.query(`INSERT INTO billing.credit_accounts VALUES($1,$2,'CNY','active',7)`, [account,tenant])
  await db.query(`INSERT INTO billing.customer_charges VALUES($1,$2,$3,$4,$5,$6,'enforced','unknown','CNY',7,0,NULL)`,
    [charge,incident.requestId,tenant,consumer,key,account])
  const addLedger = async (kind, { amount = '7', available = kind === 'hold' ? '-7' : kind === 'release' || kind === 'refund' ? '7' : '0',
    held = kind === 'hold' ? '7' : kind === 'refund' ? '0' : '-7', money = 'CNY' } = {}) => {
    await db.query(`INSERT INTO billing.credit_ledger_entries VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12)`,
      [randomUUID(),incident.requestId,charge,tenant,account,kind,amount,available,held,money,at,secret])
  }
  await addLedger('hold')
  await db.query(`INSERT INTO external_platform.provider_cost_reservations VALUES($1,$2,'justone','released','CNY',3,3,0,$3,$3)`,
    [randomUUID(),incident.requestId,at])
  const queries = []; let probe = true, releases = 0
  const pool = { async connect() { return { async query(sql, params) {
    queries.push(sql)
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b|body_bytes|raw_payload|parsed_payload/u)
    if (probe && sql.includes('facebook-empty-recovery:target')) {
      probe = false
      const { rows: [settings] } = await db.query(`SELECT current_setting('transaction_read_only') AS ro,
        current_setting('transaction_isolation') AS isolation,current_setting('statement_timeout') AS statement,
        current_setting('lock_timeout') AS lock`)
      assert.deepEqual(settings, {ro:'on',isolation:'repeatable read',statement:'5s',lock:'1s'})
      await db.query('SAVEPOINT readonly_probe')
      await assert.rejects(db.query('UPDATE usage_requests SET status=status WHERE false'), error => error.code === '25006')
      await db.query('ROLLBACK TO SAVEPOINT readonly_probe')
    }
    return db.query(sql, params)
  }, release() { releases++ } } } }
  const snapshot = async () => JSON.stringify(await Promise.all(['usage_requests','external_platform.provider_calls',
    'external_platform.response_archives','control.external_platform_restricted_raw_responses','usage_idempotency_bindings',
    'billing.credit_accounts','billing.customer_charges','billing.credit_ledger_entries','external_platform.provider_cost_reservations']
    .map(table => db.query(`SELECT * FROM ${table} ORDER BY 1`))))
  return {db,pool,queries,addLedger,snapshot,get releases() { return releases }}
}

test('exact Facebook dry run predicts the original capture, proves readonly and exposes only the Delta step binding', { skip: !modulePath }, async t => {
  const f = await fixture(t), before = await f.snapshot()
  const result = await prepareFacebookEmptyRecovery(f.pool, Object.fromEntries(Object.entries(incident).map(([key,value]) => [key,value.toUpperCase()])))
  assert.equal(result.mode, 'dry-run')
  assert.equal(result.currentStateOnly, true)
  assert.equal(result.supplierCallsMade, 0)
  assert.equal(result.databaseWritesMade, 0)
  assert.deepEqual(result.blockers, [])
  assert.equal(result.financialPrediction.state, 'would_capture_original_quote')
  assert.equal(result.financialPrediction.additionalCaptureMinor, '7')
  assert.equal(result.financialPrediction.currency, 'CNY')
  assert.equal(result.customerCharge.quotedMinor, '7')
  assert.equal(result.ledger[0].kind, 'hold')
  assert.equal(result.ledger[0].availableDeltaMinor, '-7')
  assert.equal(result.procurementReservations[0].status, 'released')
  assert.equal(result.call.costKind, 'estimated')
  assert.equal(result.call.costMinor, '3')
  assert.equal(result.idempotencyBinding.stillPointsToOriginal, true)
  assert.deepEqual(result.deltaPage, {matched:true,stepUuid,cursorRestarts:0,pageNumber:1})
  assert.match(result.archive.evidence, /not reverified/u)
  assert.match(result.interpretation, /not permission or a completed recovery/u)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${secret}|${idem}|0123456789abcdef`))
  assert.equal(await f.snapshot(), before)
  assert.equal(f.queries.at(-1), 'ROLLBACK')
  assert.equal(f.releases, 1)
  await f.db.query(`UPDATE billing.customer_charges SET status='reserved'`)
  assert.equal((await prepareFacebookEmptyRecovery(f.pool)).financialPrediction.additionalCaptureMinor, '7')
  await f.db.query(`UPDATE billing.customer_charges SET quoted_minor=9007199254740991`)
  await f.db.query(`UPDATE billing.credit_accounts SET held_minor=9007199254740991`)
  await f.db.query(`UPDATE billing.credit_ledger_entries SET amount_minor=9007199254740991,
    available_delta_minor=-9007199254740991,held_delta_minor=9007199254740991`)
  assert.equal((await prepareFacebookEmptyRecovery(f.pool)).financialPrediction.additionalCaptureMinor, '9007199254740991')
})

test('settled, refunded, missing and zero-charge records keep distinct financial predictions; bounded anomalies require review', { skip: !modulePath }, async t => {
  const f = await fixture(t)
  await f.db.query(`UPDATE billing.customer_charges SET status='captured',charged_minor=7,settled_at=now()`)
  await f.addLedger('capture')
  let result = await prepareFacebookEmptyRecovery(f.pool)
  assert.equal(result.financialPrediction.state, 'already_captured_no_new_wallet_movement')
  assert.equal(result.financialPrediction.additionalCaptureMinor, '0')
  await f.addLedger('refund', {amount:'1',available:'1'})
  assert.ok((await prepareFacebookEmptyRecovery(f.pool)).blockers.includes('existing_refund_requires_review'))
  await f.db.query(`DELETE FROM billing.credit_ledger_entries WHERE kind IN ('capture','refund')`)
  await f.addLedger('release')
  await f.db.query(`UPDATE billing.customer_charges SET status='released',charged_minor=0`)
  result = await prepareFacebookEmptyRecovery(f.pool)
  assert.equal(result.financialPrediction.state, 'blocked')
  assert.equal(result.financialPrediction.additionalCaptureMinor, null)
  assert.ok(result.blockers.includes('customer_charge_already_released'))
  await f.db.exec(`DELETE FROM billing.credit_ledger_entries; UPDATE billing.customer_charges
    SET status='unknown',enforcement_mode='shadow',settled_at=NULL`)
  result = await prepareFacebookEmptyRecovery(f.pool)
  assert.equal(result.financialPrediction.state, 'would_record_zero_charge')
  assert.equal(result.financialPrediction.additionalCaptureMinor, '0')
  await f.db.query(`UPDATE billing.customer_charges SET enforcement_mode='enforced',quoted_minor=0`)
  assert.equal((await prepareFacebookEmptyRecovery(f.pool)).financialPrediction.additionalCaptureMinor, '0')
  await f.addLedger('adjustment', {amount:'1',available:'1',held:'0'})
  assert.ok((await prepareFacebookEmptyRecovery(f.pool)).blockers.includes('unexpected_ledger_kind_requires_review'))
  await f.db.exec(`DELETE FROM billing.credit_ledger_entries; DELETE FROM billing.customer_charges`)
  result = await prepareFacebookEmptyRecovery(f.pool)
  assert.equal(result.customerCharge, null)
  assert.equal(result.financialPrediction.state, 'no_customer_charge_needs_review')
  assert.equal(result.financialPrediction.additionalCaptureMinor, '0')
  assert.deepEqual(result.financialPrediction.blockers, [])
  assert.match(result.financialPrediction.basis, /not verified/u)
  await f.addLedger('hold')
  result = await prepareFacebookEmptyRecovery(f.pool)
  assert.equal(result.financialPrediction.state, 'no_customer_charge_needs_review')
  assert.deepEqual(result.financialPrediction.blockers, ['ledger_without_customer_charge_requires_review'])
  assert.ok(result.blockers.includes('ledger_without_customer_charge_requires_review'))
  for (let i=0;i<20;i++) await f.addLedger('hold')
  result = await prepareFacebookEmptyRecovery(f.pool)
  assert.equal(result.ledgerTotal, 21)
  assert.equal(result.ledger.length, 20)
  assert.equal(result.ledgerTruncated, true)
  assert.deepEqual(result.financialPrediction.blockers, ['ledger_without_customer_charge_requires_review', 'ledger_truncated'])
  assert.ok(result.blockers.includes('ledger_truncated'))
})

test('exact identity, archive SHA and current binding are checked; CLI is stdin-only dry run with safe failures', { skip: !modulePath }, async t => {
  const f = await fixture(t)
  const other = randomUUID()
  await f.db.query(`UPDATE usage_idempotency_bindings SET current_request_id=$1`, [other])
  let result = await prepareFacebookEmptyRecovery(f.pool)
  assert.equal(result.idempotencyBinding.currentRequestId, other)
  assert.equal(result.idempotencyBinding.stillPointsToOriginal, false)
  assert.ok(result.blockers.includes('original_idempotency_binding_changed'))
  for (const invalid of [`prefix-${idem}`,`${idem}-suffix`,`delta-page-${stepUuid}-r0-p1-0123456789abcde`,
    `delta-page-${stepUuid}-r0-p0-0123456789abcdef`,secret]) {
    await f.db.query('UPDATE usage_requests SET idempotency_key=$1', [invalid])
    result = await prepareFacebookEmptyRecovery(f.pool)
    assert.deepEqual(result.deltaPage, {matched:false})
    assert.doesNotMatch(JSON.stringify(result), /private-query/u)
  }
  for (const [table,column,value] of [['usage_requests','platform','twitter'],['external_platform.provider_calls','provider_key','rapidapi'],
    ['external_platform.provider_calls','endpoint_key','other'],['external_platform.provider_calls','api_key_id',randomUUID()],
    ['control.external_platform_restricted_raw_responses','body_sha256','f'.repeat(64)]]) {
    const {rows:[old]}=await f.db.query(`SELECT ${column} AS value FROM ${table}`)
    await f.db.query(`UPDATE ${table} SET ${column}=$1`, [value])
    await assert.rejects(prepareFacebookEmptyRecovery(f.pool), {message:'bound_incident_not_found'})
    await f.db.query(`UPDATE ${table} SET ${column}=$1`, [old.value])
  }
  await assert.rejects(prepareFacebookEmptyRecovery({connect(){assert.fail('must not connect')}}, {...incident,callId:other}), {message:'invalid_arguments'})
  const source=readFileSync(new URL('../../server/ops/prepare-facebook-empty-recovery.mjs',import.meta.url),'utf8')
  assert.doesNotMatch(source,/from ['"]\.\.?\/|\bfetch\s*\(/u)
  const env={...process.env}; delete env.DATABASE_URL
  for (const [args,error] of [[[],'database_url_required'],[['--apply'],'invalid_arguments'],[[incident.requestId,incident.callId,incident.sha256],'database_url_required'],
    [[other,incident.callId,incident.sha256],'invalid_arguments']]) {
    const run=spawnSync(process.execPath,['--input-type=module','-',...args],{input:source,env,encoding:'utf8'})
    assert.equal(run.status,1); assert.equal(run.stdout,''); assert.deepEqual(JSON.parse(run.stderr),{error})
  }
  for(const failRollback of [false,true]) {
    const queries=[]; let released=false, releaseError
    const pool={async connect(){return {async query(sql){queries.push(sql)
      if(sql.includes('facebook-empty-recovery:target') || failRollback && sql==='ROLLBACK')throw new Error(secret)
      return {rows:[]}},release(error){released=true;releaseError=error}}}}
    await assert.rejects(prepareFacebookEmptyRecovery(pool),{message:'recovery_precheck_failed'})
    assert.equal(queries.at(-1),'ROLLBACK'); assert.equal(released,true); assert.equal(Boolean(releaseError),failRollback)
  }
})
