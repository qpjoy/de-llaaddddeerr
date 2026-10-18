import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'

function fixture({ providerKey='rapidapi', acquired=true, queryFailure=false, rollbackFailure=false, commitFailure=false }={}) {
  const queries=[], releases=[]
  const error=Object.assign(new Error('synthetic row lock timeout'),{code:'55P03'})
  const rollbackError=new Error('synthetic rollback connection loss'), commitError=new Error('synthetic lost COMMIT acknowledgement')
  const store=new PostgresExternalPlatformStore({providerKey,authorizationPlatform:'twitter',pool:{connect:async()=>({
    query:async(sql,params)=>{
      queries.push({sql,params})
      if(sql.includes('pg_try_advisory_xact_lock')) return {rows:[{acquired}]}
      if(sql.includes('UPDATE external_platform.provider_cost_reservations')) {
        if(queryFailure) throw error
        return {rows:[{id:params[0]}]}
      }
      if(sql==='ROLLBACK' && rollbackFailure) throw rollbackError
      if(sql==='COMMIT' && commitFailure) throw commitError
      return {rows:[]}
    },release:error=>releases.push(error),
  })}})
  const input={reservationId:randomUUID(),usageRequestId:randomUUID(),bestEffortRelease:true}
  return {store,input,queries,releases,error,rollbackError,commitError}
}

test('Twitter opt-in cleanup uses transaction-local short limits and nonwaiting advisory admission',async()=>{
  const f=fixture()
  assert.equal(await f.store.releaseProviderCostWorkflow(f.input),true)
  assert.deepEqual(f.queries.slice(0,4).map(row=>row.sql),['BEGIN',"SET LOCAL lock_timeout = '500ms'",
    "SET LOCAL statement_timeout = '5s'",'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired'])
  assert.deepEqual(f.queries[3].params,['external-platform-cost:rapidapi'])
  assert.equal(f.queries.at(-1).sql,'COMMIT');assert.deepEqual(f.releases,[null])
})

test('busy cost lock returns false with no reservation write and no blocking advisory fallback',async()=>{
  const f=fixture({acquired:false})
  assert.equal(await f.store.releaseProviderCostWorkflow(f.input),false)
  assert.equal(f.queries.at(-1).sql,'COMMIT')
  assert.ok(f.queries.every(row=>!row.sql.includes('UPDATE')&&!row.sql.includes('pg_advisory_xact_lock(')))
})

test('ordinary cleanup and other providers retain strict blocking cost release',async()=>{
  for(const [providerKey,bestEffortRelease] of [['rapidapi',false],['tikhub',true]]) {
    const f=fixture({providerKey})
    assert.equal(await f.store.releaseProviderCostWorkflow({...f.input,bestEffortRelease}),true)
    assert.equal(f.queries[1].sql,'SELECT pg_advisory_xact_lock(hashtext($1))')
    assert.ok(f.queries.every(row=>!row.sql.includes('SET LOCAL')&&!row.sql.includes('pg_try_advisory')))
  }
})

test('row lock failure rolls back and reports failure; lost rollback discards the broken connection',async()=>{
  for(const rollbackFailure of [false,true]) {
    const f=fixture({queryFailure:true,rollbackFailure})
    await assert.rejects(f.store.releaseProviderCostWorkflow(f.input),error=>error===f.error)
    assert.equal(f.queries.at(-1).sql,'ROLLBACK')
    assert.deepEqual(f.releases,[rollbackFailure?f.rollbackError:null])
    assert.ok(f.queries.every(row=>row.sql!=='COMMIT'))
  }
})

test('lost cleanup COMMIT acknowledgement never returns success or retries the write',async()=>{
  const f=fixture({commitFailure:true})
  await assert.rejects(f.store.releaseProviderCostWorkflow(f.input),error=>error===f.commitError)
  assert.deepEqual(f.releases,[f.commitError])
  assert.equal(f.queries.filter(row=>row.sql.includes('UPDATE external_platform.provider_cost_reservations')).length,1)
  assert.equal(f.queries.at(-1).sql,'COMMIT')
})
