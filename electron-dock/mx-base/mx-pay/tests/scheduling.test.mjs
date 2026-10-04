import test from 'node:test'
import assert from 'node:assert/strict'
import { selectTopology, eligibleNodes, podPlacement } from '../scripts/scheduling.mjs'
const node=(name,control=false)=>({metadata:{name,labels:control ? {'node-role.kubernetes.io/control-plane':''} : {}},
  spec:{taints:control ? [{key:'node-role.kubernetes.io/control-plane',effect:'NoSchedule'}] : []},status:{conditions:[{type:'Ready',status:'True'}]}})
test('new single-node kubeadm selects the original control plane without changing labels or taints',()=>{
  const nodes=[node('internal',true)],original=structuredClone(nodes)
  assert.deepEqual(selectTopology(nodes),{mode:'single-node',node:'internal'})
  const env={MX_PAY_TOPOLOGY:'single-node',MX_PAY_NODE:'internal'}
  assert.equal(eligibleNodes(nodes,env).length,1)
  const placement=podPlacement(env,['internal'])
  assert.deepEqual(placement.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchFields[0].values,['internal'])
  assert.equal(placement.tolerations.length,2)
  assert.deepEqual(nodes,original)
})
test('multi-node requirements remain for existing installations, explicit minimum and partially failed clusters',()=>{
  const only=[node('internal',true)]
  for(const options of [{previous:{mode:'multi-node',node:''}},{requested:'multi-node'},{minimum:'2'}])assert.throws(()=>selectTopology(only,options),/requires 2/)
  assert.throws(()=>selectTopology([node('control',true),node('worker')]),/requires 2/)
  assert.equal(selectTopology([node('control',true),node('worker-a'),node('worker-b')]).mode,'multi-node')
  assert.throws(()=>selectTopology(only,{previous:{mode:'multi-node',node:''},requested:'single-node'}),/migration/)
})
test('saved single-node identity survives cluster expansion but never follows a replacement node',()=>{
  const previous={mode:'single-node',node:'original'}
  assert.deepEqual(selectTopology([node('original',true),node('added')],{previous}),previous)
  assert.throws(()=>selectTopology([node('replacement',true)],{previous}),/discovered 0/)
})
test('single-node placement cannot bypass cordon, NotReady, pressure or arbitrary taints',()=>{
  for(const change of [n=>{n.spec.unschedulable=true},n=>{n.status.conditions[0].status='False'},
    n=>{n.spec.taints.push({key:'node.kubernetes.io/disk-pressure',effect:'NoSchedule'})},n=>{n.spec.taints.push({key:'dedicated',effect:'NoExecute'})}]) {
    const n=node('internal',true);change(n)
    assert.throws(()=>selectTopology([n]),/discovered 0/)
  }
})
test('image placement requires verification on the selected node and preserves multi-node exclusion',()=>{
  const env={MX_PAY_TOPOLOGY:'single-node',MX_PAY_NODE:'original'}
  assert.throws(()=>podPlacement(env,['another']),/Verified image nodes/)
  assert.throws(()=>podPlacement({},['only-one']),/Verified image nodes/)
  const p=podPlacement({},['worker-a','worker-b'])
  assert.equal(p.tolerations,undefined)
  assert.ok(p.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions.every(r=>r.operator==='DoesNotExist'))
})
