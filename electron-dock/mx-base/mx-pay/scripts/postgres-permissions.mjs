// One existing PostgreSQL startup-command repair; never restart a Pod or touch PGDATA.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { assert, get, kube, run, localNode } from './runtime.mjs'
import { assertDiskIdentity, checkDatabase, databaseResources } from './postgres.mjs'

const name='mx-pay-postgres', claim='mx-pay-postgres-data'
const chmod=' chmod -- 00700 "$PGDATA";'
const readJSON=filename=>JSON.parse(fs.readFileSync(filename,'utf8'))
const defaults={get,kube,run,localNode,checkDatabase,readJSON,platform:process.platform,env:process.env}
const readState=io=>{
  const raw=io.kube('get','statefulset',name,'-o','json')
  return {raw,object:JSON.parse(raw)}
}

function diskIdentity(root,identity,pod,io) {
  if (!identity.localPath) return
  assert(io.platform==='linux','Local payment storage must be checked on its original Linux node')
  const node=io.localNode(JSON.parse(io.kube('get','nodes','-o','json')).items)
  assert(node.metadata.name===identity.node && pod.spec.nodeName===identity.node,'Payment storage is on another node; use its original deployment host')
  assert(fs.realpathSync(identity.localPath)===identity.localPath && fs.statSync(identity.localPath).isDirectory(),'Payment storage path is missing or contains a symlink')
  const mount=JSON.parse(io.run('findmnt',['--json','--target',identity.localPath,'--output','TARGET,UUID,FSROOT'])).filesystems?.[0]
  assert(mount?.uuid && mount.target && mount.fsroot,'Cannot identify the original payment filesystem')
  const volumeMountRoot=path.posix.join(mount.fsroot,path.relative(mount.target,identity.localPath)).replaceAll('\\','\\134').replaceAll(' ','\\040').replaceAll('\t','\\011').replaceAll('\n','\\012')
  const current={...io.readJSON(path.join(root,'.deploy/target.json')),node:node.metadata.name,localPath:identity.localPath,mountTarget:mount.target,filesystemUUID:mount.uuid,volumeMountRoot}
  assertDiskIdentity(identity,current)
  assertDiskIdentity(io.readJSON(`/var/lib/mx-pay/${io.env.MX_PAY_NAMESPACE}/storage-identity.json`),current)
}

function commandKind(spec,identity,known) {
  const containers=spec.containers || [], index=containers.findIndex(c=>c.name==='postgres'), container=containers[index]
  assert(container && containers.length===1 && !spec.initContainers?.length,'Expected only the original PostgreSQL container, without init containers')
  assert(container.image===identity.image && (!container.args || container.args.length===0),'PostgreSQL image or arguments differ from the retained installation')
  assert((container.securityContext?.runAsUser ?? spec.securityContext?.runAsUser)===999 && (container.securityContext?.runAsGroup ?? spec.securityContext?.runAsGroup)===999,'PostgreSQL must retain its original non-root owner')
  const pgdata=container.env?.filter(e=>e.name==='PGDATA') || []
  assert(pgdata.length===1 && pgdata[0].value==='/var/lib/postgresql/data/pgdata' && !pgdata[0].valueFrom,'Unexpected PostgreSQL data directory')
  const volume=spec.volumes?.find(v=>v.name==='data'), mount=container.volumeMounts?.find(v=>v.name==='data')
  assert(volume?.persistentVolumeClaim?.claimName===claim && !volume.persistentVolumeClaim.readOnly,'PostgreSQL volume changed')
  assert(mount?.mountPath==='/var/lib/postgresql/data' && !mount.subPath && !mount.subPathExpr && !mount.readOnly,'PostgreSQL volume mount changed')
  assert(spec.volumes?.find(v=>v.name==='bootstrap')?.secret?.secretName==='mx-pay-postgres-bootstrap','PostgreSQL bootstrap identity mount changed')
  assert(container.volumeMounts?.find(v=>v.name==='bootstrap')?.mountPath==='/bootstrap','PostgreSQL bootstrap mount changed')
  if (identity.localPath) assert(container.env?.find(e=>e.name==='MX_PAY_EXPECTED_MOUNT_ROOT')?.value===identity.volumeMountRoot,'PostgreSQL mount guard differs from retained storage')
  const kind=isDeepStrictEqual(container.command,known.current) ? 'known-current' : isDeepStrictEqual(container.command,known.legacy) ? 'known-legacy' : null
  assert(kind,'Unknown PostgreSQL startup command; a missing string does not prove an equivalent guard is absent; manual review required')
  return {kind,index,container}
}

function compatiblePodSpecs(template,pod) {
  for (const key of ['volumes','securityContext','affinity','nodeSelector','dnsConfig','runtimeClassName','imagePullSecrets','readinessGates']) {
    assert(isDeepStrictEqual(template[key] ?? null,pod[key] ?? null),`Other PostgreSQL Pod changes are pending: ${key}`)
  }
  for (const key of ['hostNetwork','hostPID','hostIPC']) assert(Boolean(template[key])===Boolean(pod[key]),`Other PostgreSQL Pod changes are pending: ${key}`)
  assert(template.automountServiceAccountToken===false && pod.automountServiceAccountToken===false,'Unexpected PostgreSQL service account token mounting')
  assert((template.serviceAccountName || 'default')===(pod.serviceAccountName || 'default'),'Other PostgreSQL service account changes are pending')
  // The default admission controller adds these two tolerations to Pods only.
  const explicitTolerations=spec=>(spec.tolerations || []).filter(t=>!(
    ['node.kubernetes.io/not-ready','node.kubernetes.io/unreachable'].includes(t.key) && t.operator==='Exists' && t.effect==='NoExecute' && t.tolerationSeconds===300))
  assert(isDeepStrictEqual(explicitTolerations(template),explicitTolerations(pod)),'Other PostgreSQL toleration changes are pending')
}

function inspect(root,io) {
  const target=io.readJSON(path.join(root,'.deploy/target.json'))
  assert(target.context===io.env.MX_PAY_KUBE_CONTEXT && target.namespace===io.env.MX_PAY_NAMESPACE,'Payment target differs from its retained local anchor')
  const clusterUID=io.kube('get','namespace','kube-system','-o','jsonpath={.metadata.uid}')
  assert(target.clusterUID===clusterUID,'Payment cluster identity changed')
  const config=io.checkDatabase(root)
  assert(config,'Only an existing ready managed payment database is supported')
  const identity=JSON.parse(config.data.identity)
  assert(identity.phase==='ready' && identity.clusterUID===clusterUID && identity.namespace===target.namespace && identity.context===target.context,'Managed payment database identity differs from its target')
  assert(typeof identity.image==='string' && identity.image,'Retained PostgreSQL image is missing')
  const bootstrap=io.get('secret','mx-pay-postgres-bootstrap')
  const installationID=Buffer.from(bootstrap?.data?.installationID || '','base64').toString()
  assert(installationID===identity.installationID,'Original PostgreSQL bootstrap installation identity is missing or changed')
  const credentials={installationID}
  const current=databaseResources(identity,credentials).items.find(i=>i.kind==='StatefulSet').spec.template.spec.containers[0].command
  assert(current[2].split(chmod).length===2,'Expected one known permission guard in the source template')
  const known={current,legacy:[...current.slice(0,2),current[2].replace(chmod,'')]}
  const state=readState(io), sts=state.object
  assert(sts.kind==='StatefulSet' && sts.metadata?.name===name && sts.metadata.namespace===target.namespace && sts.metadata.uid && sts.metadata.resourceVersion && !sts.metadata.deletionTimestamp,'Original StatefulSet is missing or terminating')
  assert(sts.spec?.updateStrategy?.type==='OnDelete' && sts.spec.replicas===1,'Repair requires the existing single-replica OnDelete StatefulSet')
  assert(sts.status?.readyReplicas===1,'PostgreSQL StatefulSet is not ready; diagnose before changing its template')
  const template=commandKind(sts.spec.template.spec,identity,known)
  const pod=io.get('pod',`${name}-0`)
  assert(pod?.metadata?.uid && !pod.metadata.deletionTimestamp && pod.metadata.ownerReferences?.some(o=>o.kind==='StatefulSet' && o.name===name && o.uid===sts.metadata.uid && o.controller===true),'Running PostgreSQL Pod does not belong to the original StatefulSet')
  assert(pod.status?.phase==='Running' && pod.status.conditions?.some(c=>c.type==='Ready' && c.status==='True') && pod.status.containerStatuses?.find(c=>c.name==='postgres')?.ready,'Current PostgreSQL Pod is not ready')
  const running=commandKind(pod.spec,identity,known)
  // Reject unrelated pending changes to the database container and its storage/scheduling.
  assert(isDeepStrictEqual({...template.container,command:known.current},{...running.container,command:known.current}),'Other PostgreSQL container changes are pending; review them separately')
  compatiblePodSpecs(sts.spec.template.spec,pod.spec)
  diskIdentity(root,identity,pod,io)
  const owner=io.kube('exec',`${name}-0`,'-c','postgres','--','sh','-ec','test -d "$PGDATA" && test ! -L "$PGDATA" && stat -c \'%u:%g\' "$PGDATA"')
  assert(owner==='999:999','PGDATA is not the original non-root-owned directory')
  return {state,sts,template,pod,running,known}
}

const summary=state=>({statefulSet:name,strategy:'OnDelete',templateGuard:state.template.kind,podGuard:state.running.kind,podUID:state.pod.metadata.uid,templateChangeNeeded:state.template.kind==='known-legacy',podRecreationNeededForGuard:state.running.kind==='known-legacy',restartsPod:false,changesDatabaseData:false})
export function plan(root,options={}) { return summary(inspect(root,{...defaults,...options})) }

function checkLock(io) {
  const lock=io.get('configmap','mx-pay-deploy-lock')
  assert(io.env.MX_PAY_PERMISSIONS_LOCK_UID && lock?.metadata?.uid===io.env.MX_PAY_PERMISSIONS_LOCK_UID && lock.data?.action==='postgres-permissions-apply','Run apply through manage.sh while holding its original Pay deployment lock')
}
function backup(root,state,patch) {
  const parent=path.join(root,'.deploy')
  assert(fs.lstatSync(parent).isDirectory() && !fs.lstatSync(parent).isSymbolicLink(),'Deployment metadata must be a real directory')
  const directory=fs.mkdtempSync(path.join(parent,'postgres-permissions-'))
  fs.chmodSync(directory,0o700)
  for (const [filename,contents] of [['statefulset.json',state.state.raw],['patch.json',JSON.stringify(patch)]]) {
    const fd=fs.openSync(path.join(directory,filename),'wx',0o600)
    try { fs.writeFileSync(fd,contents); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  return directory
}
export function apply(root,options={}) {
  const io={...defaults,...options}
  checkLock(io)
  const state=inspect(root,io)
  if (state.template.kind==='known-current') return {...summary(state),result:'already-current',backup:null}
  const commandPath=`/spec/template/spec/containers/${state.template.index}/command`
  const patch=[
    {op:'test',path:'/metadata/uid',value:state.sts.metadata.uid},
    {op:'test',path:'/metadata/resourceVersion',value:state.sts.metadata.resourceVersion},
    {op:'test',path:'/spec/updateStrategy/type',value:'OnDelete'},
    {op:'test',path:`/spec/template/spec/containers/${state.template.index}/name`,value:'postgres'},
    {op:'test',path:commandPath,value:state.template.container.command},
    {op:'replace',path:commandPath,value:state.known.current},
  ]
  const directory=backup(root,state,patch)
  checkLock(io)
  let confirmed=true
  try { io.kube('patch','statefulset',name,'--type=json','--patch-file',path.join(directory,'patch.json'),'-o','json') }
  catch { confirmed=false }
  let actual
  try { actual=readState(io).object }
  catch { throw new Error(`Template update outcome unknown; read-only recheck failed. Metadata backup: ${directory}. No Pod restart or automatic rollback was attempted`) }
  const expected=structuredClone(state.sts.spec)
  expected.template.spec.containers[state.template.index].command=state.known.current
  assert(actual.metadata?.uid===state.sts.metadata.uid && isDeepStrictEqual(actual.spec,expected),`Template update not confirmed or concurrent configuration changed; inspect before retrying. Metadata backup: ${directory}. No Pod restart or automatic rollback was attempted`)
  let pod
  try { pod=io.get('pod',`${name}-0`) }
  catch { throw new Error(`Template update verified, but current Pod recheck failed. Metadata backup: ${directory}. No Pod restart or automatic rollback was attempted`) }
  assert(pod?.metadata?.uid===state.pod.metadata.uid && !pod.metadata.deletionTimestamp,`Template update verified, but the original Pod changed independently; inspect it before proceeding. Metadata backup: ${directory}`)
  return {...summary({...state,template:{...state.template,kind:'known-current'}}),templateChangeNeeded:false,result:'template-updated',patchResponseConfirmed:confirmed,originalPodStillPresent:true,backup:directory,backupType:'StatefulSet metadata only; not a database backup'}
}

if (process.argv[1] && fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [action,root,...extra]=process.argv.slice(2)
    assert(root && extra.length===0 && ['plan','apply'].includes(action),'Usage: postgres-permissions.mjs plan|apply ROOT')
    console.log(JSON.stringify(action==='plan' ? plan(root) : apply(root),null,2))
  } catch(error) {
    console.error(`mx-pay PostgreSQL permissions: ${error instanceof SyntaxError || error instanceof TypeError ? 'invalid retained metadata (values hidden)' : error.message}`)
    process.exitCode=1
  }
}
