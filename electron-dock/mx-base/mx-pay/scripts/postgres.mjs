// Dedicated payment PostgreSQL bootstrap. Existing data is never restored,
// adopted from another product, rebound, deleted, or initialized by a restart.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { assert, run, kube, get, data, resource, apply, create, writePrivate, localNode } from './runtime.mjs'
import { databaseEnv } from './render.mjs'

const name='mx-pay-postgres', claim='mx-pay-postgres-data'
const readJSON=file=>fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null
const secretDocument=values=>resource('Secret','mx-pay-postgres-bootstrap',{immutable:true,type:'Opaque',data:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,Buffer.from(v).toString('base64')]))})
export function selectStorageClass(classes, requested) {
  if (requested) { assert(classes.some(c=>c.metadata.name===requested),'Requested PostgreSQL StorageClass does not exist'); return requested }
  const defaults=classes.filter(c=>c.metadata.annotations?.['storageclass.kubernetes.io/is-default-class']==='true' || c.metadata.annotations?.['storageclass.beta.kubernetes.io/is-default-class']==='true')
  assert(defaults.length<=1,'Multiple default StorageClasses; choose MX_PAY_STORAGE_CLASS')
  return defaults[0]?.metadata.name || ''
}
export function assertStorageIdentity(expected, pvc, pv) {
  assert(pvc && pv && !pvc.metadata.deletionTimestamp && !pv.metadata.deletionTimestamp,'Payment PV/PVC missing or terminating; explicit recovery required')
  assert(pvc.metadata.uid===expected.pvcUID && pvc.spec.volumeName===expected.pvName && pv.metadata.uid===expected.pvUID,'Payment volume identity changed; refusing replacement/backup data')
  assert(pvc.status?.phase==='Bound' && pv.status?.phase==='Bound' && pv.spec.claimRef?.uid===pvc.metadata.uid,'Payment volume binding is not intact')
  assert(pv.spec.persistentVolumeReclaimPolicy==='Retain','Payment PV must retain data')
  if (expected.localPath) assert(pv.spec.local?.path===expected.localPath,'Payment local volume path changed')
}
export function assertDiskIdentity(previous, current) {
  for (const key of ['clusterUID','namespace','node','localPath','mountTarget','filesystemUUID','volumeMountRoot']) assert(previous[key]===current[key],`Payment disk identity changed: ${key}; mount original disk, do not select a backup`)
}
function localStorage(root, previous) {
  assert(process.platform==='linux','No default StorageClass; local PostgreSQL provisioning must run on the Linux Kubernetes host')
  const node=localNode(JSON.parse(kube('get','nodes','-o','json')).items)
  const ns=process.env.MX_PAY_NAMESPACE
  const receipt=`/var/lib/mx-pay/${ns}/storage-identity.json`
  const recorded=readJSON(receipt)
  assert(!recorded || previous,'Retained host payment identity exists but cluster metadata is missing; explicit recovery required')
  // Prefer a mounted /data disk. A present but unmounted /data is not permission
  // to fill the OS disk; deployments never search backup directories.
  const selected=previous?.localPath || process.env.MX_PAY_PG_DATA_PATH || (fs.existsSync('/data') ? `/data/mx-pay/${ns}/postgres` : `/var/lib/mx-pay/${ns}/postgres`)
  assert(path.isAbsolute(selected) && path.normalize(selected)===selected && selected!=='/','Invalid payment data path')
  assert(!process.env.MX_PAY_PG_DATA_PATH || process.env.MX_PAY_PG_DATA_PATH===selected,'Explicit data path differs from retained payment volume')
  let ancestor=selected
  while (!fs.existsSync(ancestor)) ancestor=path.dirname(ancestor)
  assert(fs.realpathSync(ancestor)===ancestor,'Payment storage path contains a symlink')
  const mount=JSON.parse(run('findmnt',['--json','--target',ancestor,'--output','TARGET,UUID,FSROOT'])).filesystems?.[0]
  assert(mount?.uuid && mount.target && mount.fsroot,'Cannot identify payment data filesystem UUID/root')
  assert(!selected.startsWith('/data/') || mount.target!=='/','/data is not mounted; refusing OS-disk fallback')
  // mountinfo exposes the bind mount's filesystem-relative root inside the
  // unprivileged container. This changes if /data disappears and kubelet binds
  // the old path on the OS disk, even when that path contains an older copy.
  const volumeMountRoot=path.posix.join(mount.fsroot,path.relative(mount.target,selected)).replaceAll('\\','\\134').replaceAll(' ','\\040').replaceAll('\t','\\011').replaceAll('\n','\\012')
  const current={...readJSON(path.join(root,'.deploy/target.json')),node:node.metadata.name,localPath:selected,mountTarget:mount.target,filesystemUUID:mount.uuid,volumeMountRoot}
  if (previous) assertDiskIdentity(previous,current)
  if (recorded) assertDiskIdentity(recorded,current)
  if (!previous) assert(!fs.existsSync(selected) || fs.readdirSync(selected).length===0,'Payment directory is not empty; automatic adoption/restore is forbidden')
  // Record outside the data disk before creating storage. If cluster metadata
  // disappears later, this receipt prevents a fresh database on the same host.
  writePrivate(receipt,current,true)
  fs.mkdirSync(selected,{recursive:true,mode:0o700})
  assert(fs.realpathSync(selected)===selected,'Payment data path is not canonical')
  fs.chownSync(selected,999,999); fs.chmodSync(selected,0o700)
  return current
}
export function databaseResources(settings, credentials, { initialize=false }={}) {
  assert(/^[a-f0-9]{32}$/.test(credentials.installationID || ''),'Invalid payment installation identity')
  const labels={'app.kubernetes.io/part-of':'mx-pay','app.kubernetes.io/name':name,'mx-pay-role':initialize ? 'database-init' : 'database'}
  const image=settings.image || 'postgres:16-bookworm'
  const affinity=settings.node ? {nodeAffinity:{requiredDuringSchedulingIgnoredDuringExecution:{nodeSelectorTerms:[{matchFields:[{key:'metadata.name',operator:'In',values:[settings.node]}]}]}}} : undefined
  const securityContext={runAsNonRoot:true,runAsUser:999,runAsGroup:999,fsGroup:999,fsGroupChangePolicy:'OnRootMismatch',seccompProfile:{type:'RuntimeDefault'}}
  const mount={name:'data',mountPath:'/var/lib/postgresql/data'}
  const base={automountServiceAccountToken:false,securityContext,affinity,terminationGracePeriodSeconds:120,
    tolerations:[{key:'node-role.kubernetes.io/control-plane',operator:'Exists',effect:'NoSchedule'},{key:'node-role.kubernetes.io/master',operator:'Exists',effect:'NoSchedule'}],
    volumes:[{name:'data',persistentVolumeClaim:{claimName:claim}},{name:'bootstrap',secret:{secretName:'mx-pay-postgres-bootstrap',defaultMode:288}}]}
  const container={name:'postgres',image,imagePullPolicy:'IfNotPresent',securityContext:{allowPrivilegeEscalation:false,capabilities:{drop:['ALL']}},
    env:[{name:'PGDATA',value:'/var/lib/postgresql/data/pgdata'}],volumeMounts:[mount,{name:'bootstrap',mountPath:'/bootstrap',readOnly:true}],
    resources:{requests:{cpu:'250m',memory:'512Mi'},limits:{cpu:'2',memory:'2Gi'}}}
  const mountGuard=settings.localPath ? `test "$(awk '$5 == "/var/lib/postgresql/data" {print $4}' /proc/self/mountinfo)" = "$MX_PAY_EXPECTED_MOUNT_ROOT" || { echo 'Payment data mount changed; startup refused' >&2; exit 1; };\n` : ''
  if (settings.localPath) {
    assert(settings.volumeMountRoot,'Missing retained payment mount root')
    container.env.push({name:'MX_PAY_EXPECTED_MOUNT_ROOT',value:settings.volumeMountRoot})
  }
  if (initialize) {
    const script=`set -eu
${mountGuard}
test "$(cat /bootstrap/installationID)" = '${credentials.installationID}'
if [ -e /var/lib/postgresql/data/.installation-id ]; then
  test "$(cat /var/lib/postgresql/data/.installation-id)" = '${credentials.installationID}'
else
  test ! -e "$PGDATA"
  printf '%s' '${credentials.installationID}' > /var/lib/postgresql/data/.installation-id
fi
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  test ! -d "$PGDATA" || test -z "$(ls -A "$PGDATA")"
  initdb --encoding=UTF8 --locale=C --username=mx_pay_owner --pwfile=/bootstrap/ownerPassword --auth-local=trust --auth-host=scram-sha-256 >/dev/null
  printf '\\nhost mx_pay mx_pay_owner,mx_pay_runtime 0.0.0.0/0 scram-sha-256\\nhost mx_pay mx_pay_owner,mx_pay_runtime ::/0 scram-sha-256\\n' >> "$PGDATA/pg_hba.conf"
fi
test "$(cat "$PGDATA/PG_VERSION")" = 16
pg_ctl -D "$PGDATA" -o "-c listen_addresses=''" -w start >/dev/null
trap 'pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null' EXIT
psql -X -v ON_ERROR_STOP=1 -U mx_pay_owner -d postgres <<'SQL' >/dev/null
SELECT 'CREATE DATABASE mx_pay OWNER mx_pay_owner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='mx_pay')\\gexec
REVOKE ALL ON DATABASE mx_pay FROM PUBLIC;
SQL
# Password is read inside psql, never present in argv, manifests or logs.
psql -X -v ON_ERROR_STOP=1 -U mx_pay_owner -d mx_pay <<'SQL' >/dev/null
\\set runtime_password \`cat /bootstrap/runtimePassword\`
SELECT format('CREATE ROLE mx_pay_runtime LOGIN PASSWORD %L', :'runtime_password') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='mx_pay_runtime')\\gexec
GRANT CONNECT ON DATABASE mx_pay TO mx_pay_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
psql -XAt -U mx_pay_owner -d postgres -c 'SELECT system_identifier FROM pg_control_system()'
`
    return resource('Job','mx-pay-postgres-init',{apiVersion:'batch/v1',spec:{backoffLimit:0,activeDeadlineSeconds:240,template:{metadata:{labels},spec:{...base,restartPolicy:'Never',containers:[{...container,command:['sh','-ec',script]}]}}}})
  }
  assert(/^\d+$/.test(settings.systemIdentifier || ''),'Initialized PostgreSQL identity is required before running the database')
  const guard=mountGuard+`test "$(cat /var/lib/postgresql/data/.installation-id)" = '${credentials.installationID}' && test "$(cat "$PGDATA/PG_VERSION")" = 16 && test -d "$PGDATA/base" && test "$(LC_ALL=C pg_controldata "$PGDATA" | awk -F ': *' '$1 == "Database system identifier" {print $2}')" = '${settings.systemIdentifier}' || { echo 'Payment data identity missing/changed; startup refused' >&2; exit 1; }; exec postgres -c listen_addresses='*' -c max_connections=100 -c shared_buffers=256MB`
  const probe={exec:{command:['pg_isready','-h','127.0.0.1','-U','mx_pay_owner','-d','mx_pay']},timeoutSeconds:3,periodSeconds:5}
  return {apiVersion:'v1',kind:'List',items:[
    resource('Service',name,{spec:{selector:labels,ports:[{name:'postgres',port:5432,targetPort:5432}]}}),
    resource('StatefulSet',name,{apiVersion:'apps/v1',spec:{serviceName:name,replicas:1,selector:{matchLabels:labels},updateStrategy:{type:'OnDelete'},template:{metadata:{labels},spec:{...base,containers:[{...container,command:['sh','-ec',guard],ports:[{name:'postgres',containerPort:5432}],startupProbe:{...probe,failureThreshold:180},readinessProbe:probe,livenessProbe:{...probe,failureThreshold:6}}]}}}}),
    resource('PodDisruptionBudget',name,{apiVersion:'policy/v1',spec:{minAvailable:1,selector:{matchLabels:labels}}}),
  ]}
}
export function provision(root) {
  const env=process.env, config=get('configmap','mx-pay-database'), previous=config ? JSON.parse(config.data.identity) : null
  const checkpoint=readJSON(path.join(root,'.deploy/database.json'))
  assert(!checkpoint || previous,'Retained payment checkpoint exists but cluster database metadata is missing; refusing a fresh database')
  if (checkpoint && previous) for (const key of ['installationID','systemIdentifier','pvcUID','pvUID','pvName']) assert(checkpoint[key]===previous[key],`Retained payment checkpoint differs: ${key}; refusing replacement data`)
  const bootstrap=get('secret','mx-pay-postgres-bootstrap'), pvc=get('pvc',claim), existing=get('statefulset',name)
  if (!previous && fs.existsSync(env.MX_PAY_RUNTIME_ENV_FILE)) {
    assert(!bootstrap && !pvc && !existing,'Payment database resources exist without their identity anchor; refusing to reinterpret managed storage as an external database')
    assert(fs.existsSync(env.MX_PAY_MIGRATION_ENV_FILE),'External database requires its migration env file (or the same runtime file)')
    return // Explicit external database: never provision or change it.
  }
  if (!previous) assert(!bootstrap && !pvc && !existing && !get('configmap','mx-pay-installation'),'Orphaned payment resources exist; explicit recovery required, no initialization')
  const settings=previous || {...readJSON(path.join(root,'.deploy/target.json')),phase:'provisioning',image:env.MX_PAY_POSTGRES_IMAGE || 'postgres:16-bookworm',storageClass:selectStorageClass(JSON.parse(kube('get','storageclass','-o','json')).items,env.MX_PAY_STORAGE_CLASS)}
  if (!settings.storageClass) Object.assign(settings,localStorage(root,previous))
  let credentials=data(bootstrap)
  if (previous) {
    assert(credentials.installationID===settings.installationID,'Payment bootstrap Secret missing/changed; refusing credential regeneration')
    if (settings.phase==='ready') assertStorageIdentity(settings,pvc,pvc ? get('pv',pvc.spec.volumeName) : null)
  } else {
    credentials={installationID:randomBytes(16).toString('hex'),ownerPassword:randomBytes(32).toString('hex'),runtimePassword:randomBytes(32).toString('hex')}
    settings.installationID=credentials.installationID
    // Ownership anchor is created before any volume or database initialization.
    create(resource('ConfigMap','mx-pay-database',{data:{identity:JSON.stringify(settings)}}))
    create(secretDocument(credentials))
    if (!settings.storageClass) {
      const pvName=`${env.MX_PAY_NAMESPACE}-postgres-data`
      assert(!get('pv',pvName),'Payment PV name already exists; refusing adoption')
      const pv=resource('PersistentVolume',pvName,{spec:{
        capacity:{storage:'20Gi'},accessModes:['ReadWriteOnce'],persistentVolumeReclaimPolicy:'Retain',storageClassName:'',
        local:{path:settings.localPath},claimRef:{namespace:env.MX_PAY_NAMESPACE,name:claim},
        nodeAffinity:{required:{nodeSelectorTerms:[{matchFields:[{key:'metadata.name',operator:'In',values:[settings.node]}]}]}},
      }})
      delete pv.metadata.namespace
      create(pv)
    }
    create(resource('PersistentVolumeClaim',claim,{spec:{accessModes:['ReadWriteOnce'],storageClassName:settings.storageClass,resources:{requests:{storage:'20Gi'}},...(!settings.storageClass ? {volumeName:`${env.MX_PAY_NAMESPACE}-postgres-data`} : {})}}))
  }
  if (settings.phase!=='ready') {
    // A failed/unfinished initialization Job is retained for inspection. A
    // completed Job can be resumed after a CLI crash without rerunning initdb.
    let job=get('job','mx-pay-postgres-init')
    assert(!job?.status?.failed,'PostgreSQL initialization failed; inspect retained Job before explicit recovery')
    if (!job) create(databaseResources(settings,credentials,{initialize:true}))
    run('kubectl',['--context',env.MX_PAY_KUBE_CONTEXT,'-n',env.MX_PAY_NAMESPACE,'--request-timeout=280s','wait','--for=condition=complete','job/mx-pay-postgres-init','--timeout=260s'],{timeout:285000})
    const log=kube('logs','job/mx-pay-postgres-init','--tail=10')
    const identifiers=log.split('\n').filter(line=>/^\d{10,25}$/.test(line))
    assert(identifiers.length===1,'Cannot determine initialized PostgreSQL identity; retained Job must be inspected')
    const bound=get('pvc',claim), volume=bound?.spec.volumeName ? get('pv',bound.spec.volumeName) : null
    assert(bound?.status?.phase==='Bound' && volume,'Payment PVC did not bind')
    // Dynamic classes commonly default to Delete. Retain ONLY this owned PV.
    kube('patch','pv',volume.metadata.name,'--type=merge','-p',JSON.stringify({spec:{persistentVolumeReclaimPolicy:'Retain'}}))
    Object.assign(settings,{phase:'ready',systemIdentifier:identifiers[0],pvcUID:bound.metadata.uid,pvName:volume.metadata.name,pvUID:volume.metadata.uid})
    apply(resource('ConfigMap','mx-pay-database',{data:{identity:JSON.stringify(settings)}}))
  }
  writePrivate(path.join(root,'.deploy/database.json'),settings)
  // Normal deploy validates an existing database but never upgrades/restarts it.
  if (!existing) apply(databaseResources(settings,credentials))
  else {
    const actual=existing.spec.template.spec.containers.find(c=>c.name==='postgres')
    assert(actual?.command?.join(' ').includes(settings.systemIdentifier),'Database startup identity guard changed; explicit recovery required')
  }
  // rollout status rejects OnDelete StatefulSets; wait on this existing object
  // instead of racing the controller's asynchronous creation of its first Pod.
  run('kubectl',['--context',env.MX_PAY_KUBE_CONTEXT,'-n',env.MX_PAY_NAMESPACE,'--request-timeout=200s','wait','--for=jsonpath={.status.readyReplicas}=1',`statefulset/${name}`,'--timeout=180s'],{timeout:205000})
  const identifier=kube('exec',`${name}-0`,'--','psql','-XAt','-U','mx_pay_owner','-d','postgres','-c','SELECT system_identifier FROM pg_control_system()')
  assert(identifier===settings.systemIdentifier,'Running PostgreSQL identity differs from retained payment database')
  const host=`${name}.${env.MX_PAY_NAMESPACE}.svc.cluster.local:5432/mx_pay`
  const runtime=`MX_PAY_DATABASE_URL=postgresql://mx_pay_runtime:${credentials.runtimePassword}@${host}\nMX_PAY_DB_POOL_SIZE=10\n`
  const migration=`MX_PAY_DATABASE_URL=postgresql://mx_pay_owner:${credentials.ownerPassword}@${host}\nMX_PAY_RUNTIME_ROLE=mx_pay_runtime\n`
  if (fs.existsSync(env.MX_PAY_RUNTIME_ENV_FILE)) {
    const actual=new URL(databaseEnv(env.MX_PAY_RUNTIME_ENV_FILE).values.MX_PAY_DATABASE_URL)
    assert(actual.host+actual.pathname===host && actual.username==='mx_pay_runtime' && actual.password===credentials.runtimePassword,'Runtime connection differs from managed payment database; refusing silent switch/rotation')
  }
  assert(env.MX_PAY_MIGRATION_ENV_FILE!==env.MX_PAY_RUNTIME_ENV_FILE,'Managed PostgreSQL requires separate runtime.env and migration.env')
  writePrivate(env.MX_PAY_RUNTIME_ENV_FILE,runtime,true)
  writePrivate(env.MX_PAY_MIGRATION_ENV_FILE,migration,true)
  console.log('[mx-pay] dedicated PostgreSQL ready; fixed PVC/database identity, existing credentials retained')
}
export function checkDatabase(root) {
  const config=get('configmap','mx-pay-database')
  if (!config) {
    assert(!readJSON(path.join(root,'.deploy/database.json')) && !get('statefulset',name) && !get('secret','mx-pay-postgres-bootstrap'),'Retained payment database anchor missing; explicit recovery required')
    return null
  }
  const identity=JSON.parse(config.data.identity), pvc=get('pvc',claim)
  const checkpoint=readJSON(path.join(root,'.deploy/database.json'))
  if (checkpoint) for (const key of ['installationID','systemIdentifier','pvcUID','pvUID','pvName']) assert(checkpoint[key]===identity[key],`Retained payment checkpoint differs: ${key}`)
  assert(identity.phase==='ready','Payment database initialization is unresolved')
  assertStorageIdentity(identity,pvc,pvc ? get('pv',pvc.spec.volumeName) : null)
  const actual=kube('exec',`${name}-0`,'--','psql','-XAt','-U','mx_pay_owner','-d','postgres','-c','SELECT system_identifier FROM pg_control_system()')
  assert(actual===identity.systemIdentifier,'Running PostgreSQL identity differs from retained payment database')
  return config
}
export function backup(root) {
  const config=checkDatabase(root)
  assert(config,'backup currently requires managed PostgreSQL; external PG must use its own pg_dump/PITR tooling')
  const identity=JSON.parse(config.data.identity)
  const directory=path.resolve(process.env.MX_PAY_BACKUP_DIR || (process.platform==='linux' ? `/var/backups/mx-pay/${process.env.MX_PAY_NAMESPACE}` : path.join(root,'backups')))
  const stamp=new Date().toISOString().replaceAll(':','-')+'-'+randomBytes(3).toString('hex')
  const temp=path.join(directory,`.${stamp}.partial`), final=path.join(directory,stamp)
  fs.mkdirSync(temp,{recursive:true,mode:0o700})
  const dump=path.join(temp,'mx_pay.dump'), fd=fs.openSync(dump,'wx',0o600)
  try {
    run('kubectl',['--context',process.env.MX_PAY_KUBE_CONTEXT,'-n',process.env.MX_PAY_NAMESPACE,'--request-timeout=0','exec',`${name}-0`,'--','pg_dump','-U','mx_pay_owner','-d','mx_pay','--format=custom','--no-owner','--no-acl'],{encoding:undefined,stdio:['ignore',fd,'pipe'],timeout:1800000})
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  assert(fs.statSync(dump).size>0,'Empty backup; partial directory retained for inspection')
  // Verify archive readability with the same PG major version, streaming stdin.
  const input=fs.openSync(dump,'r')
  try { run('kubectl',['--context',process.env.MX_PAY_KUBE_CONTEXT,'-n',process.env.MX_PAY_NAMESPACE,'exec','-i',`${name}-0`,'--','pg_restore','--list'],{encoding:undefined,stdio:[input,'pipe','pipe'],timeout:1800000}) }
  finally { fs.closeSync(input) }
  const clusterObjects={database:config,installation:get('configmap','mx-pay-installation'),bootstrap:get('secret','mx-pay-postgres-bootstrap')}
  const refs=clusterObjects.installation?.data
  assert(refs?.runtimeSecret && refs?.migrationSecret,'Current runtime/migration credential references missing; backup cannot be declared complete')
  clusterObjects.runtime=get('secret',refs.runtimeSecret); clusterObjects.migration=get('secret',refs.migrationSecret)
  assert(clusterObjects.runtime && clusterObjects.migration && clusterObjects.bootstrap,'Required recovery credentials missing')
  // A failed rollout may leave replicas on the previous credential generation.
  // Keep all referenced active ReplicaSet generations, not just lastAttempt.
  const sets=JSON.parse(kube('get','replicasets','-l','app.kubernetes.io/part-of=mx-pay','-o','json')).items
  clusterObjects.activeRuntimeSecrets={}
  for (const set of sets.filter(s=>s.status?.replicas>0)) {
    const ref=set.spec.template.spec.volumes?.find(v=>v.name==='credentials')?.secret?.secretName
    assert(ref,'Active payment ReplicaSet credential reference missing')
    const secret=get('secret',ref);assert(secret,'Active payment runtime credential missing')
    clusterObjects.activeRuntimeSecrets[ref]=secret
  }
  writePrivate(path.join(temp,'recovery-secrets.json'),clusterObjects)
  // Hash streaming to avoid loading a large payment ledger into memory.
  const hash=createHash('sha256'), buffer=Buffer.alloc(1024*1024), hashFD=fs.openSync(dump,'r')
  try { let length; while ((length=fs.readSync(hashFD,buffer,0,buffer.length,null))>0) hash.update(buffer.subarray(0,length)) }
  finally { fs.closeSync(hashFD) }
  const digest=hash.digest('hex')
  writePrivate(path.join(temp,'manifest.json'),{version:1,createdAt:new Date().toISOString(),identity,sha256:digest,archiveVerified:true,restoreDrillCompleted:false})
  fs.renameSync(temp,final)
  console.log(`[mx-pay] backup complete: ${final}; contains private credentials. Copy off-host securely; restore is always explicit.`)
}
if (process.argv[1] && fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { const [mode,root]=process.argv.slice(2); if(mode==='provision') provision(root); else if(mode==='backup') backup(root); else if(mode==='check') checkDatabase(root); else throw new Error('Unknown PostgreSQL operation') }
  catch(error) { console.error(`mx-pay database: ${error instanceof SyntaxError ? 'invalid retained storage metadata' : error.message}`); process.exitCode=1 }
}
