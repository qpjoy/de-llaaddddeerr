import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTikHubProxyFetch, ExternalPlatformProxyStore } from '../../server/external-platforms/proxy.mjs'
import { readFile } from 'node:fs/promises'
const url = 'https://api.tikhub.io/api/v1/xiaohongshu/app_v2/search_notes?keyword=test'
const options = { headers: { authorization: 'Bearer secret-sentinel' } }
function setup(fetchImpl, route = { proxyUrls: ['http://proxy-a:7788','http://proxy-b:7788'], directFallback: false }) {
  const closed = []
  return { closed, run: createTikHubProxyFetch({ route: async () => route }, {
    fetchImpl, makeAgent: name => ({ name, close: async () => { closed.push(name) } }),
  }) }
}
test('probe failover is credential-free and paid request dispatches once', async () => {
  const calls = []
  const { run, closed } = setup(async (target, init) => {
    calls.push({ target, init })
    if (target === url) return new Response('{}')
    assert.equal(init.headers, undefined)
    return new Response('', { status: init.dispatcher.name.includes('proxy-a') ? 502 : 401 })
  })
  assert.equal((await run(url, options)).status, 200)
  assert.equal(calls.length, 3)
  assert.equal(calls[2].init.headers.authorization, options.headers.authorization)
  assert.equal(calls[2].init.dispatcher.name, 'http://proxy-b:7788')
  assert.equal(closed.length, 2)
})
test('paid timeout never retries another proxy or direct fallback', async () => {
  let paid = 0, probes = 0
  const { run } = setup(async target => {
    if (target === url) { paid++; throw new Error('paid timeout') }
    probes++; return new Response('', { status: 401 })
  }, { proxyUrls: ['http://proxy-a:7788','http://proxy-b:7788'], directFallback: true })
  await assert.rejects(() => run(url, options), /paid timeout/)
  assert.equal(paid, 1); assert.equal(probes, 1)
})
test('paid HTTP 502 returns without retry', async () => {
  let calls = 0
  const { run } = setup(async target => { calls++; return new Response('', { status: target === url ? 502 : 401 }) })
  assert.equal((await run(url, options)).status, 502); assert.equal(calls, 2)
})
test('disabled and exhausted routes never send a paid request', async () => {
  const { run } = setup(async target => { assert.notEqual(target, url); throw new Error('connect failed') })
  await assert.rejects(() => run(url, options), e => e.code === 'proxy_routes_unreachable')
  const empty = setup(() => { throw new Error('must not fetch') }, { proxyUrls: [], directFallback: false })
  await assert.rejects(() => empty.run(url, options), e => e.code === 'proxy_route_unavailable')
})
test('direct selection sends once', async () => {
  let count = 0
  const { run } = setup(async (target, init) => { count++; assert.equal(target,url); assert.equal(init.dispatcher,undefined); return new Response('{}') }, { proxyUrls: [], directFallback: true })
  await run(url,options); assert.equal(count,1)
})
test('binding rejects inconsistent modes before querying', async () => {
  const store = new ExternalPlatformProxyStore({ connect: () => { throw new Error('must not connect') } })
  for (const body of [{}, {mode:'system-egress',sequenceKey:'some',expectedRevision:1,reason:'test'}, {mode:'proxy-sequence',expectedRevision:1,reason:'test'}]) {
    await assert.rejects(() => store.update(body), e => e.code === 'invalid_proxy_binding')
  }
})
test('migration preserves existing choices and global LLM policy', async () => {
  const sql = await readFile(new URL('../../migrations/076_external_platform_proxy.sql',import.meta.url),'utf8')
  assert.match(sql,/http:\/\/127\.0\.0\.1:7788/)
  assert.match(sql,/ON CONFLICT DO NOTHING RETURNING/)
  assert.doesNotMatch(sql,/UPDATE control\.agent_proxy_settings|DELETE FROM|DO UPDATE/i)
})

test('probe deadline is a known pre-business failure', async () => {
  const controller = new AbortController()
  const { run } = setup(async () => { controller.abort(); throw new Error('aborted') })
  await assert.rejects(() => run(url, {...options,signal:controller.signal}), error => error.code === 'proxy_routes_unreachable')
})

test('store uses shared proxy policy and exposes no proxy secrets in management DTO', async () => {
  const queries = []
  const client = { release() {}, async query(sql) {
    queries.push(sql)
    if (sql.includes('external_platform_proxy_bindings')) return {rows:[{egress_mode:'inherit',revision:2}]}
    if (sql.includes('agent_proxy_settings')) return {rows:[{global_sequence_key:'shared',egress_mode:'proxy-sequence'}]}
    if (sql.includes('agent_proxy_sequences')) return {rows:[{sequence_key:'shared',display_name:'Shared',enabled:true,proxy_keys:['p'],direct_fallback:false}]}
    if (sql.includes('agent_proxy_endpoints')) return {rows:[{proxy_key:'p',proxy_url:'http://user:secret@proxy:7788',enabled:true}]}
    return {rows:[]}
  }}
  const store = new ExternalPlatformProxyStore({connect:async()=>client})
  assert.deepEqual((await store.route()).proxyUrls,['http://user:secret@proxy:7788'])
  assert.equal(JSON.stringify(await store.describe()).includes('secret'),false)
  assert.equal(queries.some(sql=>sql.includes('provider_settings')),false)
})

test('binding update uses optimistic revision and writes audit in the same transaction', async () => {
  const calls=[]
  const client={release(){},async query(sql,args){
    calls.push({sql,args})
    if(sql.startsWith('SELECT enabled'))return {rows:[{enabled:true}]}
    if(sql.startsWith('UPDATE'))return {rowCount:1,rows:[{revision:4}]}
    return {rows:[]}
  }}
  const store=new ExternalPlatformProxyStore({connect:async()=>client})
  store.describe=async()=>({revision:4})
  assert.deepEqual(await store.update({mode:'proxy-sequence',sequenceKey:'shared',expectedRevision:3,reason:' reviewed '}),{revision:4})
  assert.deepEqual(calls.find(c=>c.sql.startsWith('UPDATE')).args,['proxy-sequence','shared','reviewed',3])
  assert.deepEqual(calls.find(c=>c.sql.startsWith('INSERT')).args,[4,'proxy-sequence','shared','reviewed'])
  assert.equal(calls.at(-1).sql,'COMMIT')
  client.query=async(sql)=> {calls.push({sql});return {rowCount:0,rows:[]}}
  await assert.rejects(()=>store.update({mode:'system-egress',expectedRevision:3,reason:'stale'}),e=>e.code==='proxy_revision_conflict')
  assert.equal(calls.at(-1).sql,'ROLLBACK')
})

test('proxy binding HTTP mutation requires admin token and forwards the exact binding', async () => {
  const {createServer}=await import('node:http')
  const {createApp}=await import('../../server/app.mjs')
  const {MemoryStore}=await import('../../server/stores/memory-store.mjs')
  const {HubService}=await import('../../server/hub-service.mjs')
  const store=new MemoryStore()
  const service=new HubService({store,adapter:{},apiKeyPepper:'local-test-pepper-at-least-thirty-two-bytes'})
  const updates=[]
  const server=createServer(createApp({store,service,adminToken:'proxy-test-admin',externalPlatformAdmin:{updateProxy:async(...args)=>{updates.push(args);return {revision:2}}},logger:{warn(){},error(){}}}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    const target=`http://127.0.0.1:${server.address().port}/internal/v1/admin/external-platforms/tikhub/proxy`
    const body={mode:'inherit',sequenceKey:null,expectedRevision:1,reason:'use shared policy'}
    assert.equal((await fetch(target,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,401)
    assert.equal(updates.length,0)
    const response=await fetch(target,{method:'PUT',headers:{'content-type':'application/json','x-mx-insight-admin-token':'proxy-test-admin'},body:JSON.stringify(body)})
    assert.equal(response.status,200)
    assert.deepEqual(updates,[['tikhub',body]])
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
