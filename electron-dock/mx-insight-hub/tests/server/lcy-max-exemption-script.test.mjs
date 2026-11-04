import test from 'node:test'
import assert from 'node:assert/strict'
import { enableLcyMaxExemption, LCY_KEY_ID } from '../../scripts/enable-lcy-max-exemption.mjs'
const before={apiKeyId:LCY_KEY_ID,policyVersion:2,revision:4,hubRateLimitExempt:null,effectiveExempt:false}

test('LCY max activation previews, writes once with CAS and verifies without business calls',async()=>{
  const calls=[];let state={...before}
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});if(options.method==='PUT') {const body=JSON.parse(options.body);assert.equal(body.revision,4);assert.equal(body.hubRateLimitExempt,true);state={...before,revision:5,hubRateLimitExempt:true,effectiveExempt:true}}
    return Response.json({data:state})
  }
  await enableLcyMaxExemption({token:'fixture',fetchImpl});assert.equal(calls.length,1)
  const result=await enableLcyMaxExemption({token:'fixture',fetchImpl,apply:true})
  assert.equal(result.applied,true);assert.deepEqual(calls.map(row=>row.options.method),['GET','GET','PUT','GET'])
  assert(calls.every(row=>row.url===`http://127.0.0.1:18151/internal/v1/admin/api-keys/${LCY_KEY_ID}/hub-limits`))
  assert.equal((await enableLcyMaxExemption({token:'fixture',fetchImpl,apply:true})).alreadyEnabled,true)
  assert.equal(calls.filter(row=>row.options.method==='PUT').length,1)
})

test('LCY max activation refuses older binaries and never retries an ambiguous save',async()=>{
  await assert.rejects(enableLcyMaxExemption({token:'fixture',apply:true,fetchImpl:async()=>Response.json({data:{...before,policyVersion:1}})}),/deploy/)
  let calls=0
  await assert.rejects(enableLcyMaxExemption({token:'fixture',apply:true,fetchImpl:async()=>{if(++calls===2)throw Error('private transport');return Response.json({data:before})}}),/outcome unknown/)
  assert.equal(calls,2)
})
