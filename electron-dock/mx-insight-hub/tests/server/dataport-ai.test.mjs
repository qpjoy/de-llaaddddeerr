import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {DataportAi, aiConfig, assessmentInput, assessmentView} from '../../server/portal/dataport-ai.mjs';
import {dataportRoute,dataportRouteAllowed} from '../../server/portal/dataport-routes.mjs';

const connectionString=process.env.MX_DATAPORT_TEST_DATABASE_URL;
const config={environment:'prod',token:'synthetic-fixture-only',fingerprint:'fixture-fingerprint'};
const profile=()=>({status:200,ip:'8.8.8.8',response:{contractVersion:'mx-insight-hub.ip-risk.subscription.v1',data:{ip:'8.8.8.8',status:'success',data:{risk_level:'高',risk_score:null,risk_tags:[{name:'测试标签',code:null}],data_available:true,future_field:false}},meta:{capturedAt:'2026-10-23T00:00:00Z'},requestId:'original-receipt'}});
test('complete delivered JSON keeps null, false, arrays and future fields; unavailable deliveries cannot become AI input',()=>{
  const payload=profile(),before=structuredClone(payload);
  assert.deepEqual(assessmentInput(payload),payload.response);assert.deepEqual(payload,before);
  assert.equal(assessmentInput({...payload,status:503}),null);
  assert.equal(assessmentInput({...payload,response:{data:{status:'failed',data:{}}}}),null);
  assert.equal(assessmentInput({...payload,response:{data:{status:'success',data:[]}}}),null);
  assert.equal(aiConfig({},()=>{throw Error('missing')}),null);
  assert.equal(aiConfig({MX_DATAPORT_AI_ENV:'other'},()=>config.token),null);
  assert.equal(aiConfig({},()=>config.token).environment,'prod');
  assert.equal(aiConfig({MX_DATAPORT_AI_ENV:'dev'},()=>config.token).environment,'dev');
  assert.equal(assessmentView({status:'failed',result_text:'not a conclusion'}).text,null);
});
async function fixture(t, fetcher) {
  const url=new URL(connectionString);assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname.includes('test'));
  const admin=new pg.Pool({connectionString}),name=`ai_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE DATABASE ${name}`);url.pathname=`/${name}`;
  const pool=new pg.Pool({connectionString:url.href});
  t.after(async()=>{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end()});
  for(const file of ['001_initial.sql','007_launcher_identity.sql','149_dataport_enterprise.sql','165_dataport_ai_assessments.sql']) {
    // Find the actual baseline filename without changing existing migration checksums.
    let path=new URL('../../migrations/'+file,import.meta.url);
    if(file==='001_initial.sql') {
      const {readdir}=await import('node:fs/promises');const first=(await readdir(new URL('../../migrations/',import.meta.url))).find(n=>n.startsWith('001_'));
      path=new URL('../../migrations/'+first,import.meta.url);
    }
    await pool.query(await readFile(path,'utf8'));
  }
  const tenant=randomUUID(),other=randomUUID(),member=randomUUID(),query=randomUUID();
  await pool.query("INSERT INTO tenants(id,name) VALUES($1,'AI fixture'),($2,'Other fixture')",[tenant,other]);
  await pool.query("INSERT INTO iam.members(id,display_name) VALUES($1,'Fixture member')",[member]);
  await pool.query("INSERT INTO dataport.queries(id,tenant_id,actor,intent_key,fingerprint,ip,status,payload) VALUES($1,$2,$3,$4,repeat('f',64),'8.8.8.8',200,$5)",[query,tenant,member,randomUUID(),profile()]);
  const calls=[],api=fetcher || (async (_url,options)=> options.method==='POST'
    ? Response.json({status:'queued',run_key:runKey,poll_url:'http://untrusted.test/token-theft'},{status:202})
    : Response.json({status:'succeeded',result:{result:'测试 AI 结论'},usage:{private:true}}));
  const runKey=randomUUID();
  const fetch=async(url,options)=>{calls.push({url,options});return api(url,options)};
  const make=()=>new DataportAi(pool,{config:()=>config,fetch}),ai=make();
  const principal={memberId:member,memberships:[{tenantId:tenant,status:'active',role:'viewer',dataport:{permissions:['history.read','query.execute']}}]};
  return {pool,tenant,other,member,query,runKey,ai,make,calls,principal,
    drain:async()=>{await Promise.all([...ai.inflight])},
    readyPoll:()=>pool.query("UPDATE dataport.ai_assessments SET poll_after=now()-interval '1 second'")};
}
const db={skip:!connectionString};
test('concurrent and replayed queries submit once; restarts poll only fixed origin; completed text is durable and original delivery is unchanged',db,async t=>{
  const f=await fixture(t),before=(await f.pool.query('SELECT payload FROM dataport.queries')).rows;
  const second=f.make();
  await Promise.all(Array.from({length:8},(_,i)=>(i%2?second:f.ai).ensure(f.tenant,f.query)));
  await Promise.all([...f.ai.inflight,...second.inflight]);
  assert.equal(f.calls.length,1);
  const input=JSON.parse(f.calls[0].options.body);
  assert.deepEqual(JSON.parse(input.input),profile().response);
  assert.deepEqual(Object.keys(input).sort(),['async','input','stream','uid']);assert.equal(input.async,true);assert.equal(input.stream,false);
  assert.equal(input.uid,`dataport:${f.tenant}:${f.member}`);
  const read=await f.make().read(f.principal,f.tenant,f.query);
  assert.equal(read.status,'succeeded');assert.equal(read.text,'测试 AI 结论');
  assert.equal(f.calls[1].url,`http://delta.mxinfo-inc.cn/api/agent-runs/by-key/${f.runKey}/`);
  assert.equal(f.calls[1].options.redirect,'error');assert.equal(f.calls[1].options.method,'GET');
  assert.equal((await f.ai.read(f.principal,f.tenant,f.query)).text,'测试 AI 结论');assert.equal(f.calls.length,2);
  assert.deepEqual((await f.pool.query('SELECT payload FROM dataport.queries')).rows,before);
  assert.ok(!JSON.stringify(read).includes('usage'));assert.ok(!JSON.stringify(read).includes(config.token));assert.ok(!JSON.stringify(read).includes(f.runKey));
});
test('read authority remains tenant scoped; query-only members see their own current result and cannot trigger Agent POST from reads',db,async t=>{
  const f=await fixture(t);
  const own={...f.principal,memberships:[{tenantId:f.tenant,dataport:{permissions:['query.execute']}}]};
  assert.equal((await f.ai.read(own,f.tenant,f.query)).status,'not_requested');assert.equal(f.calls.length,0);
  await assert.rejects(f.ai.read({...own,memberId:randomUUID()},f.tenant,f.query),{status:403});
  await assert.rejects(f.ai.read({memberId:f.member,memberships:[]},f.tenant,f.query),{status:403});
  const other={...f.principal,memberships:[{tenantId:f.other,dataport:{permissions:['history.read']}}]};
  await assert.rejects(f.ai.read(other,f.other,f.query),{status:404});
  await assert.rejects(f.ai.read({...own,memberships:[{tenantId:f.tenant,dataport:{permissions:[]}}]},f.tenant,f.query),{status:403});
  assert.equal(f.calls.length,0);
});
test('ambiguous submission never rePOSTs across replays/restarts and does not expose upstream errors as conclusions',db,async t=>{
  const f=await fixture(t,async()=>{throw Error('private-token-in-upstream-message')});
  await f.ai.ensure(f.tenant,f.query);await f.drain();
  await f.make().ensure(f.tenant,f.query);
  const read=await f.make().read(f.principal,f.tenant,f.query);
  assert.equal(read.status,'submission_unknown');assert.equal(read.text,null);assert.equal(f.calls.length,1);
  assert.ok(!JSON.stringify(read).includes('private-token'));
});
test('terminal failures, paused runs, fallback text and malformed successes remain distinct from conclusions',db,async t=>{
  let response={status:'failed',error_message:'private model details',result:{result:'must not show'}};
  const key=randomUUID(),f=await fixture(t,async(_url,o)=>o.method==='POST'?Response.json({status:'queued',run_key:key},{status:202}):Response.json(response));
  await f.ai.ensure(f.tenant,f.query);await f.drain();
  let read=await f.ai.read(f.principal,f.tenant,f.query);assert.equal(read.status,'failed');assert.equal(read.text,null);assert.ok(!JSON.stringify(read).includes('private'));
  for(const status of ['canceled','stale','paused']) {
    await f.pool.query("UPDATE dataport.ai_assessments SET status='queued',poll_after=now()-interval '1 second'");response={status,result:null};
    read=await f.ai.read(f.principal,f.tenant,f.query);assert.equal(read.status,status);assert.equal(read.text,null);
  }
  response={status:'succeeded',result:{result:{invalid:true}}};await f.readyPoll();
  read=await f.ai.read(f.principal,f.tenant,f.query);assert.equal(read.status,'paused');assert.equal(read.error,'poll_unavailable');assert.equal(read.text,null);
  response={status:'succeeded',run:{output:{result:'备用输出结论'}}};await f.readyPoll();
  read=await f.ai.read(f.principal,f.tenant,f.query);assert.equal(read.text,'备用输出结论');
});
test('poll leases coalesce concurrent readers and credential/environment changes never poll a run under a different identity',db,async t=>{
  const f=await fixture(t);await f.ai.ensure(f.tenant,f.query);await f.drain();
  const changed=new DataportAi(f.pool,{config:()=>({...config,environment:'dev'}),fetch:async()=>assert.fail('must not cross environments')});
  assert.equal((await changed.read(f.principal,f.tenant,f.query)).error,'configuration_unavailable');
  await Promise.all(Array.from({length:8},()=>f.make().read(f.principal,f.tenant,f.query)));
  assert.equal(f.calls.filter(c=>c.options.method==='GET').length,1);
});
test('known handles survive an abnormal 202, remain pollable, and cannot turn into another POST',db,async t=>{
  const key=randomUUID(),f=await fixture(t,async(_url,o)=>o.method==='POST'
    ? Response.json({status:'unrecognized',run_key:key,poll_path:'/untrusted',msg:'private diagnostic'},{status:202})
    : Response.json({status:'succeeded',result:{result:'已核对的分析'}}));
  await f.ai.ensure(f.tenant,f.query);await f.drain();
  const stored=await f.ai.row(f.tenant,f.query);assert.equal(stored.run_key,key);assert.equal(stored.status,'submission_unknown');
  const read=await f.make().read(f.principal,f.tenant,f.query);assert.equal(read.status,'succeeded');assert.equal(read.text,'已核对的分析');
  await f.ai.ensure(f.tenant,f.query);assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
});
test('submission rejects do not produce conclusions, and bad/large poll bodies retain a bounded resumable receipt',db,async t=>{
  const key=randomUUID();let reject=true;
  const f=await fixture(t,async(_url,o)=>o.method==='POST'
    ? reject?Response.json({error:'private rejection'},{status:401}):Response.json({status:'queued',run_key:key},{status:202})
    : new Response('x'.repeat(600000)));
  await f.ai.ensure(f.tenant,f.query);await f.drain();
  assert.equal((await f.ai.read(f.principal,f.tenant,f.query)).status,'failed');
  assert.equal((await f.ai.read(f.principal,f.tenant,f.query)).text,null);
  // Reset only this disposable fixture to exercise a separate acceptance scenario.
  await f.pool.query('DELETE FROM dataport.ai_assessments');reject=false;
  await f.ai.ensure(f.tenant,f.query);await f.drain();
  const read=await f.ai.read(f.principal,f.tenant,f.query);
  assert.equal(read.status,'queued');assert.equal(read.error,'poll_unavailable');assert.equal(read.text,null);
});
test('query route failure in the derived AI service never replaces the successful IP result; analysis route is GET-only',async()=>{
  const tenant=randomUUID(),member=randomUUID(),query=randomUUID(),payload={...profile(),id:query};let result;
  const principal={memberId:member,memberships:[{tenantId:tenant,role:'owner'}]};
  await dataportRoute({request:{method:'POST',headers:{}},response:{},path:`/enterprises/${tenant}/query`,searchParams:new URLSearchParams(),principal,
    dataport:{available(){},query:async()=>payload},assessments:{ensure:async()=>{throw Error('private')}},readJson:async()=>({ip:'8.8.8.8'}),sendJson(_r,_s,value){result=value.data}});
  assert.equal(result.status,200);assert.equal(result.id,query);assert.equal(result.aiAnalysis.status,'unavailable');
  assert.equal(dataportRouteAllowed('GET',`/enterprises/${tenant}/assessments/${query}`),true);
  assert.equal(dataportRouteAllowed('POST',`/enterprises/${tenant}/assessments/${query}`),false);
});
