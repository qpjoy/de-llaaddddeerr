import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHarborApp } from '../apps/server/app.mjs';

async function fixture(t,fetcher) {
  const server=createServer(createHarborApp({config:{sso:{origin:'https://dataport.example.test'},upstream:'http://hub.test',gatewayToken:'server-only-gateway'},
    sso:{sessionFor(){throw Error('SSO must not be used for a local cookie')},handle(){throw Error('No SSO fallback')}},fetch:fetcher}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections()}));
  return `http://127.0.0.1:${server.address().port}`;
}
test('local login rejects missing origin and malformed upstream credentials without exposing a token',async t=>{
  let calls=0;
  const base=await fixture(t,async()=>{calls++;return Response.json({data:{token:'invalid-private-value',csrf:'csrf'}})});
  const login=origin=>fetch(base+'/auth/local/login',{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify({account:'employee',password:'fixture-only'})});
  assert.equal((await login()).status,403);assert.equal(calls,0);
  const result=await login('https://dataport.example.test');assert.equal(result.status,503);assert.equal(result.headers.get('set-cookie'),null);
  assert.ok(!JSON.stringify(await result.json()).includes('invalid-private-value'));
});
test('expired local session becomes anonymous without MX fallback, while outages retain authentication uncertainty',async t=>{
  let status=401;
  const base=await fixture(t,async()=>Response.json({error:{code:status===401?'login_required':'private_code',message:'private upstream details'}},{status}));
  const headers={cookie:'__Host-mx_dataport_local='+'x'.repeat(43)};
  let result=await fetch(base+'/auth/sso/session',{headers});
  assert.equal(result.status,200);assert.deepEqual(await result.json(),{active:false});assert.match(result.headers.get('set-cookie'),/Max-Age=0/);
  status=503;result=await fetch(base+'/auth/sso/session',{headers});assert.equal(result.status,503);assert.equal(result.headers.get('set-cookie'),null);
  assert.ok(!JSON.stringify(await result.json()).includes('private upstream details'));
});
test('customer local-session headers are derived from the cookie; browser-provided gateway and bearer values are never forwarded',async t=>{
  const calls=[];
  const base=await fixture(t,async(url,options)=>{calls.push({url,headers:options.headers});return Response.json({data:url.endsWith('/local/session')?{csrf:'local-csrf',account:'employee'}:{memberships:[]}})});
  const token='a'.repeat(43),headers={cookie:'__Host-mx_dataport_local='+token,authorization:'Bearer browser-token','x-mx-harbor-gateway':'forged','x-mx-dataport-local-session':'forged'};
  assert.equal((await fetch(base+'/bff/v1/session',{headers})).status,200);
  assert.ok(calls.every(c=>c.headers['x-mx-harbor-gateway']==='server-only-gateway'&&c.headers['x-mx-dataport-local-session']===token&&!c.headers.authorization));
});
