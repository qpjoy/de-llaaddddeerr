import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
const root = 'local-ecommerce-admin-token'
const pepper = 'local-ecommerce-admin-pepper-long-enough'
const originalId = '00000000-0000-4000-8000-000000000001'
function seed(store, consumerId) {
 store.requests.set(originalId, { id: originalId, consumerId, platform:'ecommerce', status:'committed', responseStatus:200, createdAt:'2026-01-01T00:00:00.000Z', responseBody:{ contractVersion:'mx-insight-hub.ecommerce-products.v1', data:{items:Array.from({length:105}, (_,i)=>({id:String(i),marketplace:'taobao',title:`原始商品 ${i}`,pricing:{current:'10'},images:[]}))} } })
}
test('Admin automatic inventory uses admin authentication; public key remains scoped, CRUD preserves evidence', async () => {
 const store = new MemoryStore()
 const service = new HubService({store,adapter:{},apiKeyPepper:pepper})
 const tenant = await service.createTenant({name:'inventory'})
 const consumer = await service.createConsumer({tenantId:tenant.id,name:'reader'})
 await service.putPlatformConfiguration('ecommerce',{tenantId:tenant.id,consumerId:consumer.id,enabled:true})
 const key = await service.createApiKey({consumerId:consumer.id,name:'reader',platforms:['ecommerce']})
 seed(store,consumer.id)
 const server = createServer(createApp({service,store,adapter:{},adminToken:root,logger:{error(){}}}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base = `http://127.0.0.1:${server.address().port}`
 const path = '/internal/v1/admin/data-products/ecommerce/items'
 const send = async (method='GET',body=null, token=root, suffix='') => {
  const response=await fetch(base+path+suffix,{method,headers:{'x-mx-insight-admin-token':token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,payload:await response.json()}
 }
 try {
  assert.equal((await send('GET',null,'')).status,401)
  assert.equal((await send('GET',null,key.secret)).status,403)
  const first=await send();assert.equal(first.status,200);assert.equal(first.payload.data.items.length,100)
  const second=await send('GET',null,root,'?cursor='+encodeURIComponent(first.payload.data.pageInfo.nextCursor));assert.equal(second.payload.data.items.length,5)
  const edit={requestId:originalId,ordinal:1,revision:0,title:'修改标题',price:'25.50'}
  assert.equal((await send('PUT',edit)).status,200)
  assert.equal((await send('PUT',edit)).status,409)
  assert.equal(store.requests.get(originalId).responseBody.data.items[0].title,'原始商品 0')
  const pub=await fetch(base+'/api/v1/data/ecommerce/products/items?marketplace=all',{headers:{authorization:`Bearer ${key.secret}`}})
  assert.equal(pub.status,200);assert.equal((await pub.json()).data.items[0].product.title,'原始商品 0')
  const deleted=await send('DELETE',{requestId:originalId,ordinal:1,revision:1});assert.equal(deleted.status,200)
  assert.equal((await send('GET',null,root,'?query=修改标题')).payload.data.items.length,0)
  assert.equal((await send('POST',{marketplace:'xianyu',title:'手动商品',price:'40'})).status,201)
  assert.equal((await send('GET',null,root,'?marketplace=xianyu')).payload.data.items[0].manual,true)
  assert.equal((await send('POST',{marketplace:'all',title:'不合法',price:'40'})).status,400)
 } finally { await new Promise(resolve=>server.close(resolve)) }
})

test('PostgreSQL admin edits, manual rows, optimistic conflicts and hidden rows', {skip:!process.env.MX_ECOMMERCE_TEST_DATABASE_URL}, async()=>{
 const {default:pg}=await import('pg');const {PostgresStore}=await import('../../server/stores/postgres-store.mjs');const {readFile}=await import('node:fs/promises')
 const pool=new pg.Pool({connectionString:process.env.MX_ECOMMERCE_TEST_DATABASE_URL,max:1})
 try {
  await pool.query('CREATE TEMP TABLE usage_requests (id uuid, consumer_id uuid, platform text, status text, response_status int, response_body jsonb, created_at timestamptz)')
  const migration=await readFile(new URL('../../migrations/073_ecommerce_product_edits.sql',import.meta.url),'utf8')
  await pool.query(migration.replace('CREATE TABLE IF NOT EXISTS ecommerce_product_edits','CREATE TEMP TABLE ecommerce_product_edits'))
  await pool.query("INSERT INTO usage_requests VALUES ($1,$2,'ecommerce','committed',200,$3,'2026-01-01T00:00:00.123456Z')",[originalId,'00000000-0000-4000-8000-000000000002',{contractVersion:'mx-insight-hub.ecommerce-products.v1',data:{items:[{id:'1',title:'原始商品',marketplace:'taobao',pricing:{current:'10'},images:[]}]}}])
  const store=new PostgresStore(pool);const service=new HubService({store,adapter:{},apiKeyPepper:pepper})
  assert.equal((await service.adminEcommerceItems({})).items.length,1)
  await service.adminSaveEcommerceItem({requestId:originalId,ordinal:1,revision:0,title:'修改标题',price:'20'})
  assert.equal((await service.adminEcommerceItems({})).items[0].product.title,'修改标题')
  await assert.rejects(service.adminSaveEcommerceItem({requestId:originalId,ordinal:1,revision:0,title:'覆盖',price:'30'}),e=>e.code==='product_revision_conflict')
  await service.adminSaveEcommerceItem({requestId:originalId,ordinal:1,revision:1},true)
  assert.equal((await service.adminEcommerceItems({})).items.length,0)
  const manual=await service.adminSaveEcommerceItem({marketplace:'jd',title:'手动京东',price:'40'})
  assert.equal((await service.adminEcommerceItems({marketplace:'jd'})).items[0].manual,true)
  await service.adminSaveEcommerceItem({...manual,title:'手动更新',price:'50'})
  assert.equal((await service.adminEcommerceItems({})).items[0].revision,2)
 } finally {await pool.end()}
})
