import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTikHubProxyFetch, DEFAULT_PROXY_PROBE_POLICY, ExternalPlatformProxyStore, resolveProbePolicy } from '../../server/external-platforms/proxy.mjs'
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
  // A gateway status is retried once on the same route before failing over, so
  // a single dropped handshake never costs the whole sequence.
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.slice(0, 3).map(call => call.init.dispatcher.name),
    ['http://proxy-a:7788', 'http://proxy-a:7788', 'http://proxy-b:7788'])
  assert.equal(calls[3].init.headers.authorization, options.headers.authorization)
  assert.equal(calls[3].init.dispatcher.name, 'http://proxy-b:7788')
  assert.equal(closed.length, 2)
})

test('any status from the target origin proves the route, only gateway failures reject it', async () => {
  for (const status of [200, 401, 403, 404, 422, 429, 500]) {
    let paid = 0
    const { run } = setup(async target => {
      if (target === url) { paid += 1; return new Response('{}') }
      return new Response('', { status })
    }, { proxyUrls: ['http://proxy-a:7788'], directFallback: false })
    assert.equal((await run(url, options)).status, 200, `status ${status} must select the route`)
    assert.equal(paid, 1)
  }
  for (const status of [407, 502, 503, 504]) {
    const { run } = setup(async target => {
      assert.notEqual(target, url)
      return new Response('', { status })
    }, { proxyUrls: ['http://proxy-a:7788'], directFallback: false })
    await assert.rejects(() => run(url, options), error => error.code === 'proxy_routes_unreachable')
  }
})

test('an exhausted route reports every probe verdict instead of an opaque failure', async () => {
  const recorded = []
  const route = { proxyUrls: ['http://user:secret@proxy-a:7788'], directFallback: false, fingerprint: 'f1' }
  const run = createTikHubProxyFetch({
    route: async () => route,
    recordProbeFailure: async entry => { recorded.push(entry); return undefined },
  }, {
    fetchImpl: async () => { throw Object.assign(new Error('connect'), { name: 'TypeError', code: 'ECONNREFUSED' }) },
    makeAgent: () => ({ close: async () => {} }),
    now: () => 1000,
  })
  const error = await run(url, options).then(() => null, caught => caught)
  assert.equal(error.code, 'proxy_routes_unreachable')
  assert.match(error.message, /http:\/\/proxy-a:7788#1 TypeError ECONNREFUSED/)
  assert.equal(error.details.attempts.length, 2)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].routeFingerprint, 'f1')
  assert.deepEqual(recorded[0].attempts[0],
    { endpoint: 'http://proxy-a:7788', attempt: 1, status: null, error: 'TypeError ECONNREFUSED', durationMs: 0 })
  // Diagnostics identify the endpoint without ever copying its credentials.
  assert.equal(JSON.stringify(recorded).includes('secret'), false)
  assert.equal(error.message.includes('secret'), false)
})

test('probe policy resolves provider override over sequence over application default', async () => {
  assert.deepEqual(resolveProbePolicy(null), DEFAULT_PROXY_PROBE_POLICY)
  assert.deepEqual(resolveProbePolicy({ timeoutMs: 8000, attempts: null, cacheTtlMs: 0 }),
    { timeoutMs: 8000, attempts: DEFAULT_PROXY_PROBE_POLICY.attempts, cacheTtlMs: 0 })
  // Out-of-range values never silently weaken the probe.
  assert.deepEqual(resolveProbePolicy({ timeoutMs: 1, attempts: 99, cacheTtlMs: -1 }), DEFAULT_PROXY_PROBE_POLICY)
  const client = { release() {}, async query(sql) {
    if (sql.includes('external_platform_proxy_bindings')) return { rows: [{ egress_mode: 'proxy-sequence', sequence_key: 'shared', revision: 3, probe_timeout_ms: 9000, probe_attempts: null, probe_cache_ttl_ms: null }] }
    if (sql.includes('agent_proxy_settings')) return { rows: [{}] }
    if (sql.includes('agent_proxy_sequences')) return { rows: [{ sequence_key: 'shared', display_name: 'Shared', enabled: true, proxy_keys: ['p'], direct_fallback: false, probe_timeout_ms: 20000, probe_attempts: 3, probe_cache_ttl_ms: 0 }] }
    if (sql.includes('agent_proxy_endpoints')) return { rows: [{ proxy_key: 'p', proxy_url: 'http://proxy:7788', enabled: true }] }
    return { rows: [] }
  } }
  const store = new ExternalPlatformProxyStore({ connect: async () => client, query: async () => ({ rows: [] }) })
  // A stored 0 is a decision (caching off), not an absent value, so it inherits as 0.
  assert.deepEqual((await store.route()).probePolicy, { timeoutMs: 9000, attempts: 3, cacheTtlMs: 0 })
  const described = await store.describe()
  assert.deepEqual(described.probePolicy.effective, { timeoutMs: 9000, attempts: 3, cacheTtlMs: DEFAULT_PROXY_PROBE_POLICY.cacheTtlMs })
  assert.deepEqual(described.probePolicy.override, { timeoutMs: 9000, attempts: null, cacheTtlMs: null })
})

test('a cached selection is only reused while the operator opted into caching', async () => {
  const route = { proxyUrls: ['http://proxy-a:7788'], directFallback: false, fingerprint: 'f1', probePolicy: { cacheTtlMs: 30000 } }
  let probes = 0
  let clock = 0
  const run = createTikHubProxyFetch({ route: async () => route }, {
    fetchImpl: async target => {
      if (target !== url) probes += 1
      return new Response('{}', { status: 200 })
    },
    makeAgent: () => ({ close: async () => {} }),
    now: () => clock,
  })
  await run(url, options)
  await run(url, options)
  assert.equal(probes, 1)
  clock = 30001
  await run(url, options)
  assert.equal(probes, 2)
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

test('the probe policy migration is additive and every column stays nullable', async () => {
  const sql = await readFile(new URL('../../migrations/095_proxy_probe_policy.sql', import.meta.url), 'utf8')
  // Existing routes must keep their behaviour: nothing is backfilled, dropped
  // or defaulted into a value an operator did not choose. The new diagnostics
  // table may of course declare its own NOT NULL columns.
  const statements = sql.replace(/^\s*--.*$/gmu, '')
  assert.doesNotMatch(statements, /UPDATE |DELETE FROM|DROP /i)
  const alterations = statements.match(/ALTER TABLE[\s\S]*?;/gu) || []
  assert.equal(alterations.length, 2)
  for (const statement of alterations) {
    assert.doesNotMatch(statement, /NOT NULL|DEFAULT/i)
  }
  for (const column of ['probe_timeout_ms', 'probe_attempts', 'probe_cache_ttl_ms']) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} integer`, 'g'))
    assert.match(sql, new RegExp(`${column} IS NULL OR ${column} BETWEEN`))
  }
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control\.external_platform_proxy_probe_failures/)
})

test('a binary running ahead of the probe migration keeps TikHub egress working', async () => {
  const attempted = []
  const client = { release() {}, async query(sql) {
    attempted.push(sql)
    if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] }
    if (sql.includes('probe_timeout_ms')) {
      throw Object.assign(new Error('column "probe_timeout_ms" does not exist'), { code: '42703', column: 'probe_timeout_ms' })
    }
    if (sql.includes('external_platform_proxy_bindings')) return { rows: [{ egress_mode: 'proxy-sequence', sequence_key: 'shared', revision: 1 }] }
    if (sql.includes('agent_proxy_settings')) return { rows: [{}] }
    if (sql.includes('agent_proxy_sequences')) return { rows: [{ sequence_key: 'shared', display_name: 'Shared', enabled: true, proxy_keys: ['p'], direct_fallback: false }] }
    if (sql.includes('agent_proxy_endpoints')) return { rows: [{ proxy_key: 'p', proxy_url: 'http://proxy:7788', enabled: true }] }
    return { rows: [] }
  } }
  const store = new ExternalPlatformProxyStore({ connect: async () => client })
  const route = await store.route()
  assert.deepEqual(route.proxyUrls, ['http://proxy:7788'])
  assert.deepEqual(resolveProbePolicy(route.probePolicy), DEFAULT_PROXY_PROBE_POLICY)
  assert.equal(attempted.some((sql) => sql.includes('rollback') || sql.includes('ROLLBACK')), true)
})

test('a caller deadline records its probe verdicts and never tries another proxy', async () => {
  const controller = new AbortController()
  const recorded = []
  let probes = 0
  const run = createTikHubProxyFetch({
    route: async () => ({ proxyUrls: ['http://proxy-a:7788', 'http://proxy-b:7788'], directFallback: false, fingerprint: 'f1' }),
    recordProbeFailure: async entry => { recorded.push(entry) },
  }, {
    fetchImpl: async () => { probes += 1; controller.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    makeAgent: () => ({ close: async () => {} }),
    now: () => 0,
  })
  const error = await run(url, { ...options, signal: controller.signal }).then(() => null, caught => caught)
  assert.equal(error.code, 'proxy_routes_unreachable')
  assert.equal(probes, 1)
  assert.equal(recorded.length, 1)
  assert.deepEqual(recorded[0].attempts.map(entry => entry.endpoint), ['http://proxy-a:7788'])
  assert.match(error.message, /AbortError/)
})
