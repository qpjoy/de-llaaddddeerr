import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { LCY_IDENTITY } from '../fixtures/lcy-hub-limit-store.mjs'

// Never run against a deployed tenant; the fixed IDs must be unused in a disposable DB.
test('paced LCY overdraft, repayment, ordinary Key isolation and IP subscription exhaustion', {
  skip: !process.env.MX_INSIGHT_TEST_DATABASE_URL,
}, async () => {
  const db = new pg.Client({ connectionString: process.env.MX_INSIGHT_TEST_DATABASE_URL })
  await db.connect()
  const { tenant, consumer, key } = LCY_IDENTITY
  const sibling = randomUUID()
  const query = (sql, args) => db.query(sql, args)
  async function reserve(apiKey = key, meter = 'social.content.crawl') {
    const id = randomUUID()
    await query(`INSERT INTO usage_requests(id,tenant_id,consumer_id,api_key_id,platform,billing_meter_key,
      idempotency_key,fingerprint,status,units_reserved,lease_expires_at)
      VALUES($1,$2,$3,$4,'twitter',$5,$6,repeat('a',64),'reserved',1,now()+interval '1 minute')`,
    [id, tenant, consumer, apiKey, meter, randomUUID()])
    return id
  }
  const settle = (id, status) => query(`UPDATE usage_requests SET status=$2,
    units_actual=CASE WHEN $2='committed' THEN 1 ELSE 0 END,completed_at=now() WHERE id=$1`, [id, status])
  const ordinaryReject = async (fn, message) => {
    await query('SAVEPOINT expected_refusal')
    await assert.rejects(fn(), { message })
    await query('ROLLBACK TO expected_refusal')
  }
  const credit = amount => query(`INSERT INTO billing.credit_ledger_entries(account_id,tenant_id,kind,amount_minor,
    available_delta_minor,currency,idempotency_key,actor,reason) SELECT id,tenant_id,'topup',$2,$2,'CNY',$3,'test','synthetic credit'
    FROM billing.credit_accounts WHERE tenant_id=$1`, [tenant, amount, randomUUID()])
  const wallet = async () => (await query('SELECT available_minor::int AS a,held_minor::int AS h FROM billing.credit_accounts WHERE tenant_id=$1',[tenant])).rows[0]
  const charge = async id => (await query('SELECT status,charged_minor::int AS amount FROM billing.customer_charges WHERE usage_request_id=$1',[id])).rows[0]
  const mode = enabled => query('UPDATE api_keys SET hub_rate_limit_exempt=$2 WHERE id=$1',[key,enabled])
  try {
    await query('BEGIN')
    await query("INSERT INTO tenants(id,name) VALUES($1,'Synthetic debt tenant')", [tenant])
    await query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Synthetic','debt-fixture')",[consumer,tenant])
    for (const id of [key, sibling]) await query(`INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four,
      expires_at,environment,hub_rate_limit_exempt,hub_supplier_admission)
      VALUES($1,$2,$3,'Same name',$4,'mih_live_fixture','0000',now()+interval '1 day','live',$5,$6)`,
    [id,tenant,consumer,id.replaceAll('-','').repeat(2),id === key ? true : null,id === key ? 'priority' : 'bypass'])
    await query(`INSERT INTO billing.tenant_billing_profiles(tenant_id,mode,default_unit_price_minor,revision,updated_by)
      VALUES($1,'enforced',25,1,'test')`,[tenant])
    await query("INSERT INTO billing.credit_accounts(tenant_id,currency) VALUES($1,'CNY')",[tenant])
    const paid = await reserve()
    assert.deepEqual(await wallet(), { a: -25, h: 25 })
    await ordinaryReject(() => reserve(sibling), 'insufficient_credit')
    await mode(false)
    await ordinaryReject(() => reserve(), 'insufficient_credit')
    await settle(paid, 'committed')
    assert.deepEqual(await charge(paid), {status:'captured',amount:25})
    assert.deepEqual(await wallet(), { a:-25, h:0 })
    await ordinaryReject(() => query(`INSERT INTO billing.credit_ledger_entries(account_id,tenant_id,kind,amount_minor,
      available_delta_minor,currency,idempotency_key,actor,reason) SELECT id,tenant_id,'adjustment',5,-5,'CNY',$2,'test','debit'
      FROM billing.credit_accounts WHERE tenant_id=$1`,[tenant,randomUUID()]), 'insufficient_credit')
    await credit(5)
    assert.deepEqual(await wallet(), { a:-20, h:0 })
    await mode(true)
    const released = await reserve()
    await settle(released, 'unknown')
    assert.deepEqual(await wallet(), { a:-45, h:25 }, 'unknown request retains its hold')
    await settle(released, 'released')
    assert.deepEqual(await charge(released), {status:'released',amount:0})
    assert.deepEqual(await wallet(), { a:-20, h:0 })
    const ip = 'ip.risk.subscription.product'
    await ordinaryReject(() => reserve(key,ip), 'commerce_subscription_required')
    const sub = randomUUID(), order = randomUUID()
    await query(`INSERT INTO hub_commerce.orders(id,tenant_id,environment,request_key,fingerprint,source_id,app_id,intent)
      VALUES($1,$2,'live','fixture','fixture',$1,'fixture','{}')`,[order,tenant])
    await query(`INSERT INTO hub_commerce.subscriptions(id,order_id,tenant_id,channel,starts_at,ends_at,quota,daily_limit)
      VALUES($1,$2,$3,'product',now()-interval '1 day',now()+interval '1 day',2,1)`,[sub,order,tenant])
    const included = await reserve(key,ip)
    await settle(included,'committed')
    assert.equal(await charge(included), undefined, 'included usage cannot generate a second customer charge')
    await ordinaryReject(() => reserve(sibling,ip), 'commerce_daily_limit_exhausted')
    const overDay = await reserve(key,ip)
    await settle(overDay,'released')
    assert.deepEqual(await wallet(), { a:-20, h:0 })
    await query('UPDATE hub_commerce.subscriptions SET quota=1 WHERE id=$1',[sub])
    await ordinaryReject(() => reserve(sibling,ip), 'commerce_quota_exhausted')
    const overTerm = await reserve(key,ip)
    await settle(overTerm,'committed')
    assert.deepEqual(await charge(overTerm), {status:'captured',amount:25})
    assert.equal((await query('SELECT used FROM hub_commerce.subscriptions WHERE id=$1',[sub])).rows[0].used,1)
    assert.equal((await query('SELECT count(*)::int AS n FROM hub_commerce.subscription_overage WHERE subscription_id=$1',[sub])).rows[0].n,2)
    await credit(50)
    assert.deepEqual(await wallet(), { a:5, h:0 })
    // Exercise actual reservation code in this fixture transaction. Each store
    // transaction maps to a savepoint; all synthetic immutable IDs roll back.
    const tx = { release() {}, query: (sql, args) => query(({
      BEGIN: 'SAVEPOINT store_call', COMMIT: 'RELEASE SAVEPOINT store_call', ROLLBACK: 'ROLLBACK TO SAVEPOINT store_call',
    })[sql] || sql, args) }
    const store = new PostgresStore({ connect: async () => tx, query })
    await query("INSERT INTO platform_grants(consumer_id,platform) VALUES($1,'twitter') ON CONFLICT DO NOTHING",[consumer])
    await query("INSERT INTO api_key_platform_entitlements(api_key_id,platform,max_requests,window_seconds,max_page_size) VALUES($1,'twitter',1,3600,100)",[key])
    await query(`INSERT INTO control.api_key_access_limits(api_key_id,scope_type,scope_key,total_limit,rate_limit,window_seconds)
      VALUES($1,'platform','twitter',1,1,3600)`,[key])
    const attempt = () => store.reserve({ requestId: randomUUID(), idempotencyKey: randomUUID(), fingerprint: 'a'.repeat(64),
      tenantId:tenant, consumerId:consumer, apiKeyId:key, platform:'twitter', meterKey:'social.content.crawl',
      maxRequests:1, unitsReserved:1, windowStart:new Date(Date.now()-3600000), leaseExpiresAt:new Date(Date.now()+60000) })
    await assert.rejects(attempt(), {code:'api_key_rate_limit_exceeded'})
    await query("UPDATE control.api_key_access_limits SET rate_limit=NULL WHERE api_key_id=$1",[key])
    const fresh = await attempt()
    assert.equal(fresh.kind,'reserved','the total limit and the nominal scope quota cannot block this Key')
    assert.deepEqual(await wallet(), {a:-20,h:25})
    await settle(fresh.request.id,'released')
    await query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await db.query('ROLLBACK')
    await db.end()
  }
})
