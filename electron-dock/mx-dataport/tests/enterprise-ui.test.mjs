import test from 'node:test'
import assert from 'node:assert/strict'
import { utils,write } from 'xlsx'
import { randomUUID } from 'node:crypto'
import { canOpenPage,hasPermission } from '../apps/web/permissions.ts'
import { parseIpWorkbook } from '../apps/web/batch-ips.ts'
import { runBatchRows } from '../apps/web/batch-runner.ts'
import { riskAdvice, riskLevelLabel } from '../apps/web/risk-advice.ts'

const tenant=randomUUID(),session=permissions=>({memberships:[{tenantId:tenant,role:'viewer',dataport:{permissions}}]})
test('page gates require current enterprise permissions, including direct/return destinations and pending owners',()=>{
  const viewer=session(['history.read','usage.read','docs.read']);
  for(const page of ['intelligence','overview','docs-ip'])assert.equal(canOpenPage(viewer,tenant,page),true)
  for(const page of ['keys','orders','market','services','team','audit','unknown'])assert.equal(canOpenPage(viewer,tenant,page),false)
  assert.equal(canOpenPage(viewer,randomUUID(),'intelligence'),false);assert.equal(hasPermission(viewer,tenant,'history.export'),false)
  const pending=session(['query.execute','billing.read']);pending.memberships[0].role='owner';pending.memberships[0].dataport.ownerChallengeRequired=true
  for(const page of ['intelligence','orders','messages','account'])assert.equal(canOpenPage(pending,tenant,page),false)
  assert.equal(canOpenPage(null,tenant,'intelligence'),false)
})
function workbook(rows,type='xlsx') {const book=utils.book_new();utils.book_append_sheet(book,utils.aoa_to_sheet(rows),'IPs');return write(book,{type:'array',bookType:type})}
test('Excel parses xls and xlsx, locates IP column, deduplicates and rejects more than 500 rows',()=>{
  for(const type of ['xls','xlsx'])assert.deepEqual(parseIpWorkbook(workbook([['name','IP'],['one','8.8.8.8'],['two',' 8.8.8.8 '],['three','invalid'],['four','1.1.1.1']],type)),['8.8.8.8','invalid','1.1.1.1'])
  assert.throws(()=>parseIpWorkbook(workbook([['address'],['8.8.8.8'] ])),/IP/)
  assert.throws(()=>parseIpWorkbook(workbook([['IP'],...Array.from({length:501},(_,i)=>[`192.0.2.${i}`])])),/500/)
  assert.equal(parseIpWorkbook(workbook([['IP'],...Array.from({length:500},(_,i)=>[String(i)])])).length,500)
})
const rows=()=>['8.8.8.8','1.1.1.1','9.9.9.9'].map(ip=>({ip,intent:randomUUID(),status:'待查询'}))
const success={status:200,response:{data:{status:'success'}}}
test('stopping batch lets the in-flight result settle and never dispatches the next IP',async()=>{
  let stop=false,calls=0,release;const gate=new Promise(r=>release=r),source=rows();
  const pending=runBatchRows(source,async row=>{assert.equal(row.intent,source[0].intent);calls++;await gate;return success;},()=>stop,()=>{})
  stop=true;release();const result=await pending;assert.equal(calls,1);assert.equal(result[0].status,'成功');assert.equal(result[1].status,'待查询')
})
test('ambiguous batch outcomes stop dispatch and explicit continuation never retries a settled or unknown row',async()=>{
  let calls=0;const source=rows();
  const result=await runBatchRows(source,async()=>{calls++;throw Error('connection interrupted')},()=>false,()=>{})
  assert.equal(calls,1);assert.equal(result[0].status,'待确认');assert.equal(result[1].status,'待查询')
  const continued=await runBatchRows(result,async()=>{calls++;return success},()=>false,()=>{});assert.equal(calls,3);assert.equal(continued[0].status,'待确认');assert.equal(continued[2].status,'成功')
  calls=0;await runBatchRows(rows(),async()=>{calls++;return {status:429,error:{code:'quota_exhausted'}}},()=>false,()=>{});assert.equal(calls,1)
})
test('reference advice preserves unrated and low-risk uncertainty',()=>{assert.match(riskAdvice(null),/未提供/);assert.match(riskAdvice('low'),/不代表绝对安全/);assert.match(riskAdvice('高风险'),/核验/);})
test('missing and unrecognized risk levels cannot appear to mean no risk',()=>{
  for(const level of [null,undefined,'','无','none','safe',0])assert.equal(riskLevelLabel(level),'未知')
  assert.equal(riskLevelLabel(' HIGH '),'高风险')
  assert.equal(riskLevelLabel('中风险'),'中风险')
  assert.equal(riskLevelLabel('low'),'低风险')
})
