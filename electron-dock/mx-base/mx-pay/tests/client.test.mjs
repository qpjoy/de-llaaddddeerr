import test from 'node:test'
import assert from 'node:assert/strict'
import { PaymentClient } from '../src/client.mjs'

test('lost create response remains unknown; SDK never invents another key or retries payment',async()=>{
  const calls=[], client=new PaymentClient({baseUrl:'http://localhost:18230',token:'x'.repeat(32),fetchImplementation:async(url,options)=>{calls.push({url,options});throw Error('timeout')}})
  await assert.rejects(client.create({businessOrderId:'order-1',customerRef:'tenant-a',amountMinor:500},'stable-key-123'),{code:'payment_outcome_unknown'})
  assert.equal(calls.length,1);assert.equal(calls[0].options.headers['idempotency-key'],'stable-key-123')
})
test('failed business commit is not acknowledged; later events can still be processed',async()=>{
  const events=[{id:'one'},{id:'two'}],acked=[]
  const client=new PaymentClient({baseUrl:'http://localhost:18230',token:'x'.repeat(32)})
  client.events=async after=>{assert.equal(after,'previous-page');return {items:events,nextAfter:'two'}};client.acknowledge=async(id,receipt)=>acked.push([id,receipt])
  const result=await client.consumeBatch(async e=>{if(e.id==='one')throw Error('wallet transaction rolled back');return 'ledger-two'},{after:'previous-page'})
  assert.deepEqual(acked,[['two','ledger-two']]);assert.deepEqual(result.failed,[{id:'one',code:'business_delivery_failed'}])
  assert.equal(result.nextAfter,'two')
})
