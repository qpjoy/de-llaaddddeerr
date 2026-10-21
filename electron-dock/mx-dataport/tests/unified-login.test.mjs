import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHarborApp } from '../apps/server/app.mjs';

async function fixture(t, {local = false, mx = false, localStatus = 200, resolveStatus = 200, mxError, preview = false} = {}) {
  const calls = [], origin = 'https://dataport.example.test';
  const server = createServer(createHarborApp({
    config: {preview, sso:{origin}, upstream:'http://hub.test', gatewayToken:'private-gateway'},
    sso: {
      prepareLogin: async (req,res,login) => {calls.push({kind:'mx-prepare',login});res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({redirect:'https://auth.example.test/connect'}));return true;},
      resolveLogin: async (req, login) => { calls.push({kind:'mx-resolve',login}); if (mxError) throw mxError; return mx; },
      login: async (req, res, body) => { calls.push({kind:'mx-login',body,csrf:req.headers['x-mx-csrf']}); res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({redirect:'https://auth.example.test/continue'})); return true; },
    },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body), kind = url.endsWith('/resolve') ? 'local-resolve' : 'local-login';
      calls.push({kind,body,headers:options.headers});
      const status = kind === 'local-resolve' ? resolveStatus : localStatus;
      return Response.json(status === 200 ? {data:kind === 'local-resolve' ? {exists:local} : {token:'t'.repeat(43),csrf:'local-csrf'}}
        : {error:{code:'local_login_failed',message:'账号或密码不正确，或账号不可用。'}}, {status});
    },
  }));
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  t.after(() => new Promise(r => {server.close(r);server.closeAllConnections();}));
  const base = `http://127.0.0.1:${server.address().port}`;
  const submit = (body = {}, headers = {}, path = '/auth/login') => fetch(base+path, {method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify({login:'FixtureAccount',password:'FixturePassword',...body})});
  const prepare = login => fetch(base+'/auth/login/prepare',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({login})});
  return {calls,submit,prepare,base};
}

test('account preparation connects only MX and never authenticates or accepts a password', async t => {
  for (const mx of [false,true]) {
    const f = await fixture(t,{mx,local:!mx});
    const response = await f.prepare('FixtureAccount');
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),mx ? {redirect:'https://auth.example.test/connect'} : {ready:true});
    assert.ok(!f.calls.some(c=>c.kind.endsWith('login')));
    assert.equal((await f.submit({}, {}, '/auth/login/prepare')).status,400);
  }
});

test('unified employee login only sends credentials to Hub and sets host-only cookies', async t => {
  const f = await fixture(t,{local:true});
  const response = await f.submit({inviteCode:'must-not-reach-hub',formId:'old-mx-form'},{'x-mx-harbor-gateway':'browser-forgery'});
  assert.equal(response.status,200); assert.deepEqual(await response.json(),{redirect:'/#/intelligence'});
  const login = f.calls.find(c => c.kind === 'local-login');
  assert.deepEqual(login.body,{account:'FixtureAccount',password:'FixturePassword'});
  assert.equal(login.headers['x-mx-harbor-gateway'],'private-gateway');
  assert.ok(f.calls.filter(c => c.kind.endsWith('resolve')).every(c => !JSON.stringify(c).includes('FixturePassword')));
  assert.ok(!f.calls.some(c => c.kind === 'mx-login'));
  assert.match(response.headers.getSetCookie()[0],/HttpOnly; Secure; SameSite=Lax/);
  assert.ok(response.headers.getSetCookie().some(c => c.startsWith('__Host-mx-harbor_sso=;')));
});

test('MX login forwards the same browser form proof and optional admission invite only to SSO', async t => {
  const f = await fixture(t,{mx:true});
  const response = await f.submit({inviteCode:' first-admission ',formId:'browser-form'},{'x-mx-csrf':'browser-csrf'});
  assert.equal(response.status,200);
  assert.deepEqual(f.calls.find(c => c.kind === 'mx-login'),{kind:'mx-login',csrf:'browser-csrf',body:{login:'FixtureAccount',password:'FixturePassword',inviteCode:'first-admission',formId:'browser-form'}});
  assert.ok(!f.calls.some(c => c.kind === 'local-login'));
});

for (const [name, options, expected] of [
  ['unknown identity',{local:false,mx:false},401],
  ['ambiguous identity',{local:true,mx:true},409],
  ['local password failure',{local:true,localStatus:401},401],
  ['local throttling',{local:true,localStatus:429},429],
  ['Hub routing unavailable',{local:true,resolveStatus:503},503],
  ['MX routing unavailable',{local:true,mxError:Object.assign(Error('账号服务不可用'),{status:503})},503],
]) test(`${name} cannot fall back to another identity or set a session`, async t => {
  const f = await fixture(t,options), response = await f.submit();
  assert.equal(response.status,expected); assert.equal(response.headers.get('set-cookie'),null);
  assert.ok(!f.calls.some(c => c.kind === 'mx-login'));
  if (options.localStatus === undefined) assert.ok(!f.calls.some(c => c.kind === 'local-login'));
});

test('unified login validates origin, method, query, content type and fields before routing', async t => {
  const f = await fixture(t,{local:true});
  for (const [body,headers,path,status] of [
    [{},{origin:'https://evil.test'},'/auth/login',403],
    [{},{'sec-fetch-site':'cross-site'},'/auth/login',403],
    [{},{'content-type':'text/plain'},'/auth/login',415],
    [{},{},'/auth/login?tenant=forged',400],
    [{action:'register'},{},'/auth/login',400],
    [{login:''},{},'/auth/login',400],
    [{password:''},{},'/auth/login',400],
    [{inviteCode:7},{},'/auth/login',400],
  ]) assert.equal((await f.submit(body,headers,path)).status,status);
  assert.equal((await fetch(f.base+'/auth/login')).status,405);
  assert.equal(f.calls.length,0);
  const preview = await fixture(t,{preview:true});
  assert.equal((await preview.submit()).status,503); assert.equal(preview.calls.length,0);
});
