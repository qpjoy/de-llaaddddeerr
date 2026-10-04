// Payment-owned scheduling only; never change cluster labels or taints.
const check=(ok,message)=>{if(!ok)throw new Error(message)}
export const controlPlaneKeys=['node-role.kubernetes.io/control-plane','node-role.kubernetes.io/master']
const ready=node=>!node.spec?.unschedulable && node.status?.conditions?.some(c=>c.type==='Ready' && c.status==='True')
const control=node=>controlPlaneKeys.some(key=>Object.hasOwn(node.metadata.labels || {},key))
const blocked=(node,single)=>node.spec?.taints?.some(t=>['NoSchedule','NoExecute'].includes(t.effect) &&
  !(single && t.effect==='NoSchedule' && controlPlaneKeys.includes(t.key)))
export function eligibleNodes(nodes,env={}) {
  const single=env.MX_PAY_TOPOLOGY==='single-node'
  const minimum=Number(env.MX_PAY_MIN_READY_WORKERS || (single ? 1 : 2))
  check(Number.isInteger(minimum) && minimum >= (single ? 1 : 2) && (!single || minimum===1),'Invalid minimum node requirement for payment topology')
  const selected=nodes.filter(n=>ready(n) && !blocked(n,single) && (single ? n.metadata.name===env.MX_PAY_NODE : !control(n)))
  check(selected.length>=minimum,`Payment ${single ? 'single-node' : 'multi-node'} requires ${minimum} ready, schedulable node(s); discovered ${selected.length}. Existing topology is not downgraded`)
  return selected
}
export function selectTopology(nodes,{requested='auto',minimum,previous}={}) {
  check(['auto','single-node','multi-node'].includes(requested),'MX_PAY_TOPOLOGY must be auto, single-node or multi-node')
  if(previous) {
    check(['single-node','multi-node'].includes(previous.mode),'Invalid retained payment topology')
    check(requested==='auto' || requested===previous.mode,'Payment topology differs from retained installation; plan a separate topology migration')
  }
  const mode=previous?.mode || (requested!=='auto' ? requested : nodes.length===1 && (!minimum || Number(minimum)===1) ? 'single-node' : 'multi-node')
  if(mode==='single-node' && !previous)check(nodes.length===1,'First single-node deployment requires exactly one cluster node')
  const node=mode==='single-node' ? previous?.node || nodes[0]?.metadata?.name : ''
  check(mode!=='single-node' || /^[a-z0-9][a-z0-9.-]{0,252}$/.test(node || ''),'Invalid retained single payment node')
  const topology={mode,node}
  eligibleNodes(nodes,{MX_PAY_TOPOLOGY:mode,MX_PAY_NODE:node,MX_PAY_MIN_READY_WORKERS:minimum})
  return topology
}
export function podPlacement(env, imageNodes) {
  const single=env.MX_PAY_TOPOLOGY==='single-node'
  check(!env.MX_PAY_TOPOLOGY || ['single-node','multi-node'].includes(env.MX_PAY_TOPOLOGY),'Payment topology must be resolved before rendering')
  if(single)check(/^[a-z0-9][a-z0-9.-]{0,252}$/.test(env.MX_PAY_NODE || ''),'Single-node payment placement requires its retained node')
  if(imageNodes)check(Array.isArray(imageNodes) && new Set(imageNodes).size >= (single ? 1 : 2) &&
    imageNodes.every(n=>/^[a-z0-9][a-z0-9.-]{0,252}$/.test(n)) && (!single || imageNodes.length===1 && imageNodes[0]===env.MX_PAY_NODE),'Verified image nodes do not match payment topology')
  const term=single ? {matchFields:[{key:'metadata.name',operator:'In',values:[env.MX_PAY_NODE]}]} :
    {matchExpressions:controlPlaneKeys.map(key=>({key,operator:'DoesNotExist'})),...(imageNodes ? {matchFields:[{key:'metadata.name',operator:'In',values:imageNodes}]} : {})}
  return {affinity:{nodeAffinity:{requiredDuringSchedulingIgnoredDuringExecution:{nodeSelectorTerms:[term]}}},
    ...(single ? {tolerations:controlPlaneKeys.map(key=>({key,operator:'Exists',effect:'NoSchedule'}))} : {})}
}
