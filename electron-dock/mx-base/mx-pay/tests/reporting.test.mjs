import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { runMigrations } from '@qpjoy/mx-common/postgres'
import { PaymentCenter } from '../server/service.mjs'
import { createApp } from '../server/app.mjs'
import { createReportingPool } from '../server/database.mjs'
import { migrate } from '../server/migrate.mjs'
import { readCredentials } from '../server/config.mjs'
import { PaymentClient } from '../src/client.mjs'

test('read-only reporting credential enrollment is idempotent and never rotates business keys',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mx-report-key-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const file=join(dir,'credentials.json'), original={id:'business',appId:'hub',environment:'live',secret:randomUUID(),scopes:['orders.write']}
  await writeFile(file,JSON.stringify([original]))
  const run=id=>spawnSync(process.execPath,['scripts/add-reporting-credential.mjs','hub','live',id,file],{cwd:new URL('..',import.meta.url),encoding:'utf8'})
  let r=run('hub-bi');assert.equal(r.status,0,r.stderr)
  const first=await readFile(file,'utf8');r=run('hub-bi');assert.equal(r.status,0,r.stderr);assert.equal(await readFile(file,'utf8'),first)
  const entries=JSON.parse(first);assert.deepEqual(entries[0],original);assert.deepEqual(entries[1].scopes,['reports.read'])
  assert.ok(!r.stdout.includes(entries[1].secret))
  assert.notEqual(run('business').status,0);assert.equal(await readFile(file,'utf8'),first)
})

test('reporting bootstrap, commit-ordered replay, isolation, rollback and independent consumers on real PG', {skip:!process.env.MX_PAY_TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.MX_PAY_TEST_DATABASE_URL,max:1})
  const name=`pay_reports_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE ${name}`)
  const url=new URL(process.env.MX_PAY_TEST_DATABASE_URL);url.pathname=`/${name}`
  const pool=new pg.Pool({connectionString:url.href,max:8}), readPool=createReportingPool({databaseUrl:url.href})
  t.after(async()=>{await readPool.end();await pool.end();await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end()})
  const dir=await mkdtemp(join(tmpdir(),'mx-report-migrate-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  await writeFile(join(dir,'pay_001_transactions.sql'),await readFile(new URL('../migrations/pay_001_transactions.sql',import.meta.url)))
  await runMigrations({connectionString:url.href,migrationsDir:dir,logger:{log(){}}})
  const entries=[
    {id:'app',appId:'hub',environment:'test',secret:randomUUID(),scopes:['orders.read','orders.write','receipts.confirm','events.read','events.ack']},
    {id:'bi',appId:'hub',environment:'test',secret:randomUUID(),scopes:['reports.read']},
    {id:'finance',appId:'hub',environment:'test',secret:randomUUID(),scopes:['reports.read']},
    {id:'other',appId:'another-app',environment:'test',secret:randomUUID(),scopes:['reports.read']},
    {id:'live',appId:'hub',environment:'live',secret:randomUUID(),scopes:['reports.read']},
  ]
  const credentialsFile=join(dir,'credentials.json');await writeFile(credentialsFile,JSON.stringify(entries))
  const credentials=readCredentials(credentialsFile),service=new PaymentCenter(pool,{reportingPool:readPool})
  const input=()=>({businessOrderId:randomUUID(),customerRef:'tenant-ref',amountMinor:1200})
  const legacy=[]
  for(let i=0;i<2;i++)legacy.push(await service.create(credentials[0],input(),randomUUID()))
  // A committed legacy row can be ahead of today's clock after clock correction
  // or an import. It must not disappear between baseline and change replay.
  const future={...legacy[0],id:randomUUID(),businessOrderId:randomUUID()}
  await pool.query("INSERT INTO pay.orders(id,app_id,environment,business_order_id,request_key,fingerprint,document,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '1 year')",
    [future.id,future.appId,future.environment,future.businessOrderId,randomUUID(),'legacy-fixture',future])
  legacy.push(future)
  legacy.sort((a,b)=>a.id.localeCompare(b.id))
  await migrate(url.href,{log(){}})
  assert.equal((await pool.query('SELECT count(*) FROM pay.reporting_changes')).rows[0].count,'0','no blocking historical backfill during migration')
  const server=createServer(createApp({service,credentials,logger:{error(){}}}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const clients=entries.map(e=>new PaymentClient({baseUrl:`http://127.0.0.1:${server.address().port}`,token:e.secret}))
  const [business,bi,finance,other,live]=clients
  await assert.rejects(business.reportingSnapshot(),{status:403})
  await assert.rejects(bi.order(legacy[0].id),{status:403})
  await assert.rejects(bi.create(input(),randomUUID()),{status:403})
  await assert.rejects(bi.reportingChanges(),{code:'reporting_snapshot_required'})
  const first=await bi.reportingSnapshot(undefined,1)
  assert.equal(first.items[0].id,legacy[0].id);assert.equal(first.hasMore,true)
  let paid=await business.act(legacy[2].id,'submit',{expectedRevision:0,payerName:'PRIVATE NAME',tradeNo:'PRIVATE-TRADE-123'},randomUUID())
  paid=await business.act(paid.id,'confirm',{expectedRevision:1,tradeNo:'PRIVATE-SETTLEMENT-123',receivedAmountMinor:1200,feeMinor:null,paidAt:new Date().toISOString(),note:'PRIVATE NOTE'},randomUUID())
  const created=await business.create(input(),randomUUID()) // may appear in baseline; always included by replay
  let cursor=first.nextCursor,baseline=[...first.items]
  while(cursor){const page=await bi.reportingSnapshot(cursor,1);assert.equal(page.changesCursor,first.changesCursor);baseline.push(...page.items);cursor=page.nextCursor}
  for(const order of legacy)assert.ok(baseline.some(row=>row.id===order.id),'every previously committed order is in baseline regardless of its creation timestamp')
  assert.equal(new Set(baseline.map(row=>row.id)).size,baseline.length)
  assert.equal(baseline.find(o=>o.id===paid.id).revision,2,'later baseline pages may see newer revisions')
  const store=new Map(baseline.map(o=>[o.id,o]))
  let changesCursor=first.changesCursor,hasMore=true
  while(hasMore){const page=await bi.reportingChanges(changesCursor,1);for(const row of page.items)if(!store.has(row.id)||store.get(row.id).revision<row.revision)store.set(row.id,row);changesCursor=page.nextCursor;hasMore=page.hasMore}
  assert.equal(store.size,4);assert.equal(store.get(paid.id).status,'paid');assert.equal(store.get(paid.id).feeMinor,null)
  const replay=await finance.reportingChanges(first.changesCursor)
  assert.equal(replay.items.length,3)
  assert.doesNotMatch(JSON.stringify(replay),/PRIVATE|checkout|qrImage|tradeNo|payerName|confirmedBy/)
  const event=(await business.events()).items[0];await business.acknowledge(event.id,'business-ledger-test')
  assert.deepEqual((await finance.reportingChanges(first.changesCursor)).items,replay.items,'business ACK never removes reporting evidence')
  await assert.rejects(other.reportingChanges(first.changesCursor),{code:'invalid_reporting_cursor'})
  await assert.rejects(live.reportingChanges(first.changesCursor),{code:'invalid_reporting_cursor'})
  assert.equal((await other.reportingSnapshot()).items.length,0)
  const changed=JSON.parse(Buffer.from(changesCursor,'base64url').toString())
  await assert.rejects(bi.reportingChanges(Buffer.from(JSON.stringify({...changed,source:randomUUID()})).toString('base64url')),{code:'reporting_source_changed'})
  await assert.rejects(bi.reportingChanges(Buffer.from(JSON.stringify({...changed,position:'999999'})).toString('base64url')),{code:'reporting_source_rewound'})
  await assert.rejects(bi.request('/v1/reporting/snapshot?limit=201'),{code:'invalid_reporting_query'})
  await assert.rejects(bi.request('/v1/reporting/snapshot?limit='),{code:'invalid_reporting_query'})
  await assert.rejects(bi.request('/v1/reporting/snapshot?after='),{code:'invalid_reporting_cursor'})
  await assert.rejects(bi.reportingChanges(Buffer.from(JSON.stringify({...changed,source:[changed.source]})).toString('base64url')),{code:'invalid_reporting_cursor'})
  await assert.rejects(readPool.query('CREATE TABLE should_fail(id int)'),{code:'25006'})
  // Transaction A holds the stream row after writing an earlier position. B
  // must wait, while a reader can still read the old committed watermark.
  const a=await pool.connect(),b=await pool.connect()
  try {
    await a.query('BEGIN');await b.query('BEGIN')
    await a.query("UPDATE pay.orders SET document=jsonb_set(document,'{revision}','1') WHERE id=$1",[legacy[0].id])
    let completed=false
    const pending=b.query("UPDATE pay.orders SET document=jsonb_set(document,'{revision}','1') WHERE id=$1",[created.id]).then(()=>{completed=true})
    const page=await bi.reportingChanges(changesCursor)
    assert.equal(completed,false);assert.equal(page.items.length,0)
    await a.query('ROLLBACK');await pending;await b.query('COMMIT')
    const committed=await bi.reportingChanges(changesCursor)
    assert.deepEqual(committed.items.map(o=>o.id),[created.id],'rolled back facts are absent; later commit is not skipped')
    assert.equal(BigInt(JSON.parse(Buffer.from(committed.nextCursor,'base64url')).position),BigInt(changed.position)+1n)
  } finally {await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release()}
  await assert.rejects(pool.query('DELETE FROM pay.reporting_changes'),/append-only/)
  // Reporting saturation cannot borrow transaction connections or stop orders.
  const original=service.reporting.snapshot.bind(service.reporting), releases=[]
  service.reporting.snapshot=()=>new Promise(resolve=>releases.push(()=>resolve({items:[]})))
  const reads=[bi.reportingSnapshot(),bi.reportingSnapshot()]
  try {
    for(let attempts=0;attempts<200 && releases.length<2;attempts++)await new Promise(resolve=>setTimeout(resolve,5))
    assert.equal(releases.length,2,'both reporting requests reached the reader')
    await assert.rejects(finance.reportingSnapshot(),{code:'reporting_busy',status:429})
    assert.equal((await business.create(input(),randomUUID())).status,'pending')
  } finally {releases.forEach(release=>release());await Promise.all(reads);service.reporting.snapshot=original}
})
