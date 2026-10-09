import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'

test('limits and recovery require Admin Token, remain private on Public, and reads never mutate', async t => {
  const events = [], path = '/internal/v1/admin/admission-limits'
  async function listen({ listenerMode = 'combined', available = true } = {}) {
    const server = createServer(createApp({
      service: {}, store: {}, adapter: {}, adminToken: 'local-admission-admin', listenerMode,
      identity: { enabled: true, async resolve(token) { return { kind: 'launcher-user', memberId: token,
        platformAdmin: token === 'platform-admin', capabilities: [], memberships: [], tenantIds: [] } } },
      admissionRecovery: available ? {
        async snapshot(filter) { events.push(['read',filter]); return { items: [] } },
        async recover(body, actor) { events.push(['recover',body,actor]); return { upstreamDispatched: false } },
      } : null, logger: { error() {} },
    }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    return `http://127.0.0.1:${server.address().port}${path}`
  }
  const url = await listen(), publicUrl = await listen({ listenerMode: 'public' }), unavailable = await listen({ available: false })
  const admin = { 'x-mx-insight-admin-token': 'local-admission-admin', 'content-type': 'application/json' }
  for (const method of ['GET','POST']) {
    assert.equal((await fetch(url,{method})).status,401)
    for (const token of ['tenant-admin','platform-admin','mih_live_example']) {
      assert.equal((await fetch(url,{method,headers:{authorization:`Bearer ${token}`}})).status,403)
    }
    assert.equal((await fetch(publicUrl,{method,headers:admin})).status,404)
    assert.equal((await fetch(unavailable,{method,headers:admin})).status,503)
  }
  assert.equal(events.length,0)
  const read = await fetch(url,{headers:admin})
  assert.equal(read.status,200); assert.match(read.headers.get('cache-control'),/no-store/)
  assert.deepEqual(events,[['read',{}]])
  assert.equal((await fetch(url+'?unexpected=1',{method:'POST',headers:admin,body:'{}'})).status,400)
  assert.equal(events.length,1)
  const recover = await fetch(url,{method:'POST',headers:admin,body:JSON.stringify({reason:'Reviewed recovery'})})
  assert.equal(recover.status,200); assert.match(recover.headers.get('cache-control'),/no-store/)
  assert.equal((await recover.json()).data.upstreamDispatched,false)
  assert.equal(events[1][2].actor,'admin-token'); assert.ok(events[1][2].requestId)
})
