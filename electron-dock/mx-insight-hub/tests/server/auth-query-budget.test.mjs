import test from 'node:test'
import assert from 'node:assert/strict'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

test('machine and demo key lookup each use one fresh database round trip', async () => {
  const calls = []
  const row = { id: 'key-id', status: 'active', platforms: ['source_catalog'], capabilities: [], consumer_record: { id: 'consumer-id', status: 'active' }, tenant_record: { id: 'tenant-id', status: 'active' } }
  let rows = [row]
  const store = new PostgresStore({ query: async (sql, values) => { calls.push({sql, values}); return { rows } } })
  assert.equal((await store.findApiKeyByDigest('digest')).apiKey.id, 'key-id')
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /WHERE k.key_digest = \$1/)
  assert.match(calls[0].sql, /k.status = 'active'/)
  assert.match(calls[0].sql, /k.expires_at > now\(\)/)
  assert.match(calls[0].sql, /c.status = 'active'/)
  assert.match(calls[0].sql, /t.status = 'active'/)
  assert.match(calls[0].sql, /target.last_used_at < now\(\) - interval '1 minute'/)
  await store.findApiKeyById('key-id')
  assert.equal(calls.length, 2)
  assert.match(calls[1].sql, /WHERE k.id = \$1/)
  rows = [] // A subsequent database refusal cannot reuse the first positive result.
  assert.equal(await store.findApiKeyByDigest('digest'), null)
  assert.equal(calls.length, 3)
})

test('menu grants are fetched in one tenant-scoped query and empty memberships do no work', async () => {
  const calls = []
  const store = new PostgresStore({ query: async (sql, values) => { calls.push({sql, values}); return {rows: []} } })
  assert.deepEqual(await store.listProductScopes([]), [])
  assert.equal(calls.length, 0)
  await store.listProductScopes(['tenant-a', 'tenant-b'])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].values, [['tenant-a', 'tenant-b']])
  assert.match(calls[0].sql, /c.tenant_id = ANY\(\$1::uuid\[\]\)/)
})

test('batched product scopes preserve consumer boundaries and reflect revocation immediately', async () => {
  const store = new MemoryStore()
  store.consumers.set('a', {id:'a', tenantId:'tenant-a', status:'active'})
  store.consumers.set('b', {id:'b', tenantId:'tenant-b', status:'active'})
  store.grants.set('a', ['source_catalog'])
  store.grants.set('b', ['xiaohongshu'])
  assert.deepEqual(await store.listProductScopes(['tenant-a']), [{platforms:['source_catalog'],capabilities:[]}])
  store.grants.set('a', [])
  assert.deepEqual(await store.listProductScopes(['tenant-a']), [{platforms:[],capabilities:[]}])
})

test('existing console identity uses one statement and returns current suspended status', async () => {
  const calls = []
  const store = new PostgresStore({ query: async (sql, values) => {
    calls.push({sql,values})
    return { rows: [{member_id:'member-a', display_name:'A', status:'suspended'}] }
  } })
  const member = await store.upsertExternalIdentity({issuer:'issuer',subject:'subject',audience:'hub',displayName:'New name'})
  assert.equal(calls.length, 1)
  assert.equal(member.status, 'suspended')
  assert.equal(member.displayName, 'New name')
  assert.match(calls[0].sql, /JOIN iam.members/)
  assert.match(calls[0].sql, /interval '1 minute'/)
})
