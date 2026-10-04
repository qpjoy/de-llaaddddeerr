// Deployment-host discovery. No npm dependencies, cluster switching or secret output.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { databaseEnv } from './render.mjs'
import { readCredentials } from '../server/config.mjs'
import { readConsoleConfig } from '../server/console-config.mjs'
import { readApplicationSsoProfile } from '../../../mx-common/src/identity/profile.mjs'

export const assert = (ok, message) => { if (!ok) throw new Error(message) }
export function run(command, args, options = {}) {
  try { return (execFileSync(command, args, { encoding: 'utf8', timeout: 30000, stdio: ['pipe','pipe','pipe'], ...options })?.toString() || '').trim() }
  catch { throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed; check reachability/permissions (command output withheld)` ) }
}
export const kube = (...args) => run('kubectl', ['--context',process.env.MX_PAY_KUBE_CONTEXT,'--request-timeout=20s','-n',process.env.MX_PAY_NAMESPACE,...args])
export function get(kind, name) {
  const value = kube('get',kind,name,'--ignore-not-found','-o','json')
  return value ? JSON.parse(value) : null
}
export function writePrivate(filename, value, exclusive = false) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  if (exclusive && fs.existsSync(filename)) return
  const temp = `${filename}.${process.pid}.tmp`
  const fd = fs.openSync(temp, 'wx', 0o600)
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value,null,2)+'\n'); fs.fsyncSync(fd) }
  finally { fs.closeSync(fd) }
  try {
    if (exclusive) fs.linkSync(temp, filename)
    else fs.renameSync(temp, filename)
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}
export function apply(document) {
  run('kubectl',['--context',process.env.MX_PAY_KUBE_CONTEXT,'--request-timeout=30s','-n',process.env.MX_PAY_NAMESPACE,'apply','-f','-'],{ input: JSON.stringify(document) })
}
export function create(document) {
  run('kubectl',['--context',process.env.MX_PAY_KUBE_CONTEXT,'--request-timeout=30s','-n',process.env.MX_PAY_NAMESPACE,'create','-f','-'],{ input: JSON.stringify(document) })
}
export const data = secret => Object.fromEntries(Object.entries(secret?.data || {}).map(([k,v]) => [k,Buffer.from(v,'base64').toString()]))
export function resource(kind, name, extra = {}) {
  return { apiVersion:'v1',kind,metadata:{name,namespace:process.env.MX_PAY_NAMESPACE,labels:{'app.kubernetes.io/part-of':'mx-pay'}},...extra }
}
export function selectContext(config, requested, previous) {
  const names = (config.contexts || []).map(c=>c.name)
  const selected = requested || previous?.context || config['current-context'] || (names.length===1 ? names[0] : '')
  assert(selected && names.includes(selected),'No unambiguous Kubernetes context; set MX_PAY_KUBE_CONTEXT to one of kubectl config get-contexts')
  assert(!previous || previous.context===selected,'Recorded Kubernetes target differs; ordinary deploy cannot move an installation')
  return selected
}
export function target(root) {
  const filename = path.join(root,'.deploy/target.json')
  const previous = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename)) : null
  const config = JSON.parse(run('kubectl',['config','view','-o','json']))
  const context = selectContext(config,process.env.MX_PAY_KUBE_CONTEXT,previous)
  const clusterUID = run('kubectl',['--context',context,'--request-timeout=15s','get','namespace','kube-system','-o','jsonpath={.metadata.uid}'])
  assert(clusterUID,'Cannot determine Kubernetes cluster identity')
  const namespace = process.env.MX_PAY_NAMESPACE
  assert(!previous || (previous.clusterUID===clusterUID && previous.namespace===namespace),'Cluster UID/namespace changed; refusing to reuse another installation')
  // Persist before the first mutation; read-only discovery/status does not enroll a target.
  if (['deploy','migrate'].includes(process.env.MX_PAY_ACTION)) writePrivate(filename,{context,clusterUID,namespace},true)
  return context
}
export function workers(nodes) {
  return nodes.filter(n=>!n.spec?.unschedulable && !Object.hasOwn(n.metadata.labels || {},'node-role.kubernetes.io/control-plane')
    && !Object.hasOwn(n.metadata.labels || {},'node-role.kubernetes.io/master') && n.status?.conditions?.some(c=>c.type==='Ready' && c.status==='True'))
}
export function localNode(nodes, addresses=Object.values(os.networkInterfaces()).flat().map(a=>a.address)) {
  const matches=nodes.filter(n=>n.status?.addresses?.some(a=>a.type==='InternalIP' && addresses.includes(a.address)))
  assert(matches.length===1,'Cannot identify this Linux host among Kubernetes node InternalIPs; run deploy on a node or configure a StorageClass/registry')
  return matches[0]
}
export function prepareConsole(root, { env=process.env, configured=false, log=console.log } = {}) {
  const profileFile=env.MX_PAY_SSO_SOURCE, accessFile=env.MX_PAY_CONSOLE_ACCESS_SOURCE
  assert(profileFile && accessFile,'Payment console configuration paths are required')
  const marker=path.join(root,'.deploy/console-enrolled.json')
  const enrolled=configured || fs.existsSync(marker)
  const auto=env.MX_PAY_SSO_AUTO_DISCOVER ?? '1'
  assert(['0','1'].includes(auto),'MX_PAY_SSO_AUTO_DISCOVER must be 0 or 1')
  if (!fs.existsSync(profileFile)) {
    assert(!enrolled,'Previously configured payment console profile is missing; restore its original profile, refusing a new identity')
    if (auto === '1' && env.MX_PAY_SSO_SOURCE_EXPLICIT !== '1') {
      const identityDir=path.resolve(root,env.MX_PAY_LAUNCHER_IDENTITY_DIR || '/var/lib/mx-launcher/identity')
      const candidates=['public','private'].map(entry=>path.join(identityDir,'applications',entry,'mx-pay.json')).filter(file=>{
        try {
          const stat=fs.lstatSync(file)
          assert(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid(),
            'Launcher mx-pay profile must be a private regular file owned by the deploy user')
          return true
        } catch (error) { if (error.code === 'ENOENT') return false; throw error }
      })
      assert(candidates.length < 2,'Multiple Launcher mx-pay profiles found; select the intended entry with MX_PAY_SSO_SOURCE')
      if (candidates.length) {
        const settings=readApplicationSsoProfile(candidates[0])
        assert(settings.appId === 'mx-pay' && settings.scope === 'openid mx:identity','Launcher profile must belong to mx-pay with openid mx:identity scope')
        if (fs.existsSync(accessFile)) readConsoleConfig(candidates[0],accessFile)
        writePrivate(profileFile,settings,true)
        log('Payment console: imported registered Launcher mx-pay profile; existing client and session keys retained')
      }
    }
  }
  if (!fs.existsSync(profileFile)) {
    assert(!fs.existsSync(accessFile),'Payment console access exists without its SSO profile; restore the original profile')
    log('Payment console: SSO profile not available yet; deploying payment API only')
    return
  }
  // Validate before creating an empty grant list, and never reset an enrolled console.
  const settings=readApplicationSsoProfile(profileFile)
  assert(settings.appId === 'mx-pay' && settings.scope === 'openid mx:identity','Payment console requires its own mx-pay SSO profile')
  if (!fs.existsSync(accessFile)) {
    assert(!enrolled,'Previously configured payment console access is missing; restore original grants, refusing an empty replacement')
    writePrivate(accessFile,[],true)
    log('Payment console: initialized empty viewer access; login grants no order visibility')
  }
  readConsoleConfig(profileFile,accessFile)
  writePrivate(marker,{version:1},true)
}
export function prepare(root) {
  const env=process.env, installation=get('configmap','mx-pay-installation'), deployment=get('deployment','mx-pay')
  const previous=installation?.data || {}
  // Never treat an inaccessible API as an empty installation. get() throws on errors.
  const runtimeName=deployment?.spec.template.spec.volumes?.find(v=>v.name==='credentials')?.secret?.secretName || previous.runtimeSecret
  const runtime=runtimeName ? data(get('secret',runtimeName)) : null
  const consoleDeployment=get('deployment','mx-pay-console')
  const consoleName=consoleDeployment?.spec.template.spec.volumes?.find(v=>v.name==='console')?.secret?.secretName || previous.consoleSecret
  assert(!consoleDeployment || consoleName,'Existing payment console has no retained Secret reference; explicit recovery required')
  if (consoleName) {
    const retained=data(get('secret',consoleName))
    for (const [file,key] of [[env.MX_PAY_SSO_SOURCE,'profile.json'],[env.MX_PAY_CONSOLE_ACCESS_SOURCE,'access.json']]) {
      if (!fs.existsSync(file || '')) {
        assert(file && retained?.[key],'Retained payment console identity/access missing; explicit recovery required')
        writePrivate(file,retained[key],true)
      }
    }
  }
  prepareConsole(root,{configured:Boolean(consoleName)})
  if (env.MX_PAY_CHANNELS_SOURCE && !fs.existsSync(env.MX_PAY_CHANNELS_SOURCE)) {
    const required=deployment?.spec.template.spec.containers?.some(c=>c.env?.some(e=>e.name==='MX_PAY_CHANNELS_FILE'))
    assert(!required || runtime?.['channels.json'],'Deployed channel Secret is missing; explicit configuration recovery required, refusing empty channel configuration')
    writePrivate(env.MX_PAY_CHANNELS_SOURCE,runtime?.['channels.json'] || '[]\n',true)
  }
  const clientBootstrap=get('secret','mx-pay-client-bootstrap')
  if (!fs.existsSync(env.MX_PAY_CREDENTIALS_SOURCE)) {
    if (runtime) {
      assert(runtime['credentials.json'],'Retained credential Secret is missing its credentials; explicit recovery required')
      writePrivate(env.MX_PAY_CREDENTIALS_SOURCE,runtime['credentials.json'],true)
    } else if (clientBootstrap) {
      const retained=data(clientBootstrap)['credentials.json']
      assert(retained,'Client bootstrap credential data is missing')
      writePrivate(env.MX_PAY_CREDENTIALS_SOURCE,retained,true)
    } else {
      assert(!installation && !deployment,'Existing installation has no recoverable credentials; refusing rotation')
      run(process.execPath,[path.join(root,'scripts/init-credentials.mjs'),'mx-insight-hub',env.MX_PAY_CREDENTIALS_SOURCE])
    }
  }
  readCredentials(env.MX_PAY_CREDENTIALS_SOURCE)
  if (!installation && !deployment && !clientBootstrap) create(resource('Secret','mx-pay-client-bootstrap',{immutable:true,type:'Opaque',data:{'credentials.json':Buffer.from(fs.readFileSync(env.MX_PAY_CREDENTIALS_SOURCE)).toString('base64')}}))
  if (!fs.existsSync(env.MX_PAY_RUNTIME_ENV_FILE) && runtime) {
    assert(runtime.MX_PAY_DATABASE_URL,'Retained runtime database connection missing')
    writePrivate(env.MX_PAY_RUNTIME_ENV_FILE,Object.entries(runtime).filter(([k])=>!['credentials.json','channels.json'].includes(k)).map(([k,v])=>`${k}=${v}\n`).join(''),true)
  }
  if (!fs.existsSync(env.MX_PAY_MIGRATION_ENV_FILE) && previous.migrationSecret) {
    const migration=data(get('secret',previous.migrationSecret))
    assert(migration.MX_PAY_DATABASE_URL,'Retained migration Secret missing; refusing a new database')
    writePrivate(env.MX_PAY_MIGRATION_ENV_FILE,Object.entries(migration).map(([k,v])=>`${k}=${v}\n`).join(''),true)
  }
  if (installation || deployment) assert(fs.existsSync(env.MX_PAY_RUNTIME_ENV_FILE),'Existing installation has no recoverable database target; explicit recovery required')
  if (installation && fs.existsSync(env.MX_PAY_RUNTIME_ENV_FILE)) assert(previous.databaseIdentity===databaseEnv(env.MX_PAY_RUNTIME_ENV_FILE).identity,'Database identity differs from retained installation; ordinary deploy cannot move databases')
  // Namespace-local contract for a later global manage.sh. Absence is normal;
  // arbitrary Hub/Launcher URLs, Secrets or running databases are never adopted.
  const capabilities=get('configmap','mx-platform-runtime')?.data || {}
  const existingImage=env.MX_PAY_IMAGE || previous.lastAttemptImage || ''
  const retainedRepository=/^[-a-zA-Z0-9.:/_]+@sha256:[a-f0-9]{64}$/.test(existingImage) ? existingImage.split('@')[0] : ''
  const repository=env.MX_PAY_IMAGE_REPOSITORY || previous.imageRepository || capabilities.imageRepository || retainedRepository
  if (repository) assert(/^[a-zA-Z0-9][a-zA-Z0-9.:/_-]+$/.test(repository) && !repository.includes('@'),'Invalid discovered image repository')
  const settings={MX_PAY_IMAGE_REPOSITORY:repository,MX_PAY_IMAGE_DELIVERY:repository ? 'registry' : (env.MX_PAY_IMAGE_DELIVERY || previous.imageDelivery || 'nodes')}
  assert(['registry','nodes'].includes(settings.MX_PAY_IMAGE_DELIVERY),'Unsupported image delivery mode')
  const lines=Object.entries(settings).map(([k,v])=>`export ${k}='${v.replaceAll("'", "'\\''")}'`).join('\n')
  writePrivate(path.join(root,'.deploy/discovered.env'),lines+'\n')
}

// Only existing trusted SSH access is used. No new host keys, daemon config,
// privileged Kubernetes importer Pods, or restarts of another product.
export function nodeCommand(node, local, script, options={}) {
  if (node.metadata.name===local?.metadata.name) return run('sh',['-ec',script],options)
  const host=node.metadata.annotations?.['mx-pay.io/ssh-target'] || node.status.addresses?.find(a=>a.type==='InternalIP')?.address
  assert(/^(?:[a-zA-Z0-9_-]+@)?[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host || ''),'Invalid or missing node SSH target')
  try { return run('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',host,script],options) }
  catch { throw new Error(`Node ${node.metadata.name}: trusted SSH/containerd access unavailable. Configure existing SSH access or MX_PAY_IMAGE_REPOSITORY; no host keys or runtimes were changed`) }
}
export const ctrCommand='if command -v ctr >/dev/null 2>&1; then if [ "$(id -u)" = 0 ]; then ctr -n k8s.io; else sudo -n ctr -n k8s.io; fi; elif command -v k3s >/dev/null 2>&1; then if [ "$(id -u)" = 0 ]; then k3s ctr -n k8s.io; else sudo -n k3s ctr -n k8s.io; fi; else exit 1; fi'
// Insert arguments into the fixed command, never interpolate an arbitrary shell value.
export function ctrScript(args) { return ctrCommand.replaceAll('ctr -n k8s.io;',`ctr -n k8s.io ${args};`) }
export function imagePlan(root) {
  const nodes=workers(JSON.parse(kube('get','nodes','-o','json')).items)
  assert(nodes.length>=2,'At least two ready workers are required; discovery cannot create machines')
  const architectures=new Set(nodes.map(n=>n.status.nodeInfo?.architecture))
  assert(architectures.size===1 && ['amd64','arm64'].includes([...architectures][0]),'Workers must share amd64 or arm64 architecture for this build')
  let local=null
  try { local=localNode(nodes) } catch { /* A remote deployment host can use existing SSH access. */ }
  for (const node of nodes) {
    assert(node.status.nodeInfo?.containerRuntimeVersion?.startsWith('containerd:'),'Automatic node image delivery requires containerd; use a registry for other runtimes')
    nodeCommand(node,local,ctrScript('version'))
  }
  const plan={nodes,local,platform:`linux/${[...architectures][0]}`}
  writePrivate(path.join(root,'.deploy/nodes.json'),plan)
  return plan.platform
}
export function imagePlatforms() {
  const nodes=workers(JSON.parse(kube('get','nodes','-o','json')).items)
  const architectures=[...new Set(nodes.map(n=>n.status.nodeInfo?.architecture))].sort()
  assert(architectures.length>0 && architectures.every(a=>['amd64','arm64'].includes(a)),'Cannot determine supported worker image architectures')
  return architectures.map(a=>`linux/${a}`).join(',')
}
export function importImage(root, archive, image) {
  assert(/^local\.mx\/mx-pay:[a-f0-9]{64}$/.test(image),'Node-loaded image must use its SHA-256 content ID as tag')
  const plan=JSON.parse(fs.readFileSync(path.join(root,'.deploy/nodes.json')))
  for (const node of plan.nodes) {
    const fd=fs.openSync(archive,'r')
    try { nodeCommand(node,plan.local,ctrScript('images import --no-unpack -'),{encoding:undefined,stdio:[fd,'pipe','pipe'],timeout:300000}) }
    finally { fs.closeSync(fd) }
    // Import retained the canonical name. Verify it exists before any workload can use it.
    const names=nodeCommand(node,plan.local,ctrScript('images ls -q')).split('\n')
    assert(names.includes(image),`Image not present on node ${node.metadata.name}`)
  }
  writePrivate(path.join(root,'.deploy/image-nodes.json'),plan.nodes.map(n=>n.metadata.name))
}
export function discover() {
  const installation=get('configmap','mx-pay-installation')?.data || {}
  const database=get('configmap','mx-pay-database')
  const identity=database ? JSON.parse(database.data.identity) : null
  const deployment=get('deployment','mx-pay')
  const capabilities=get('configmap','mx-platform-runtime')?.data || {}
  const nodeList=JSON.parse(kube('get','nodes','-o','json')).items
  return {version:1,product:'mx-pay',driver:'k8s',context:process.env.MX_PAY_KUBE_CONTEXT,namespace:process.env.MX_PAY_NAMESPACE,
    actions:['deploy','migrate','status','doctor','discover','backup','logs','start','stop','restart'],
    readyWorkers:workers(nodeList).map(n=>n.metadata.name),readyReplicas:deployment?.status?.readyReplicas || 0,
    serviceURL:installation.serviceURL || null,
    database:identity ? {mode:'managed',phase:identity.phase,systemIdentifier:identity.systemIdentifier,pv:identity.pvName,node:identity.node || null,path:identity.localPath || null} : {mode:installation.databaseIdentity ? 'external' : 'unconfigured'},
    imageRepository:process.env.MX_PAY_IMAGE_REPOSITORY || installation.imageRepository || capabilities.imageRepository || null,
    requiredDependencies:['Kubernetes','dedicated PostgreSQL'],optionalRuntimeContract:'ConfigMap/mx-platform-runtime (same namespace)',
    authenticationDependency:null,hubDependency:null,launcherDependency:null,
  }
}
if (process.argv[1] && fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [mode,root,...args]=process.argv.slice(2)
    if (mode==='target') console.log(target(root))
    else if (mode==='prepare') prepare(root)
    else if (mode==='prepare-console') prepareConsole(root)
    else if (mode==='image-plan') console.log(imagePlan(root))
    else if (mode==='image-platforms') console.log(imagePlatforms())
    else if (mode==='import-image') importImage(root,...args)
    else if (mode==='discover') console.log(JSON.stringify(discover(),null,2))
    else throw new Error('Unknown runtime operation')
  } catch(error) { console.error(`mx-pay discovery: ${error instanceof SyntaxError || error instanceof TypeError ? 'invalid retained/discovered metadata (values hidden)' : error.message}`); process.exitCode=1 }
}
