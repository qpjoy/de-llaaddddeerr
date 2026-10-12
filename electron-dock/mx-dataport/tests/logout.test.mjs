import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../apps/web/api.ts';

test('204 logout is successful while malformed 200 and rejected logout retain errors',async t=>{
 const mocked=t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:204}));
 assert.equal(await request('/auth/sso/logout',{method:'POST'}),undefined);
 mocked.mock.mockImplementation(async()=>new Response('',{status:200}));
 await assert.rejects(request('/auth/sso/session'),{code:'invalid_response'});
 mocked.mock.mockImplementation(async()=>Response.json({code:'sso_csrf',message:'请刷新'},{status:403}));
 await assert.rejects(request('/auth/sso/logout',{method:'POST'}),{status:403,code:'sso_csrf'});
});
