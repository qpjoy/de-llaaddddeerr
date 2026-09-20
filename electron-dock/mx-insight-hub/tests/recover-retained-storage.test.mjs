import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, linkSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { VOLUMES, validateReport, replacementVolumes, databaseCredential, postgresGuard, HUB_DEPLOYMENTS, withPatchFile, command, commandDescription, validateResumeState, validateResumeResources, validateOnlineRecoveryState, validateOnlineRecoveryResources, podProgress, restoreSearchAndApis } from '../scripts/recover-retained-storage.mjs'

const retained = '/data/k8s/mx-runtime/mx-common/k8s'
const report = { source: retained, control: ['Database system identifier: 7671038612254789664'],
  pepper: { verdict: 'MATCHED_SAMPLES', matched: 4 }, originalControlFileUnchanged: true,
  database: { hasStoredRecords: true, hasRequestHistory: true } }

function resources() {
  return {
    pvs: VOLUMES.map(([name, claim, suffix]) => ({ metadata: { name }, spec: {
      hostPath: { path: `/var/lib/mx-common/k8s/${suffix}`, type: 'DirectoryOrCreate' },
      claimRef: { namespace: 'mx-common', name: claim, uid: 'old-claim-uid' },
      persistentVolumeReclaimPolicy: 'Retain', capacity: { storage: '50Gi' }, accessModes: ['ReadWriteOnce'],
    } })),
    claims: VOLUMES.map(([name, claim]) => ({ metadata: { name: claim, uid: 'old-claim-uid' }, spec: {
      volumeName: name, storageClassName: '', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '50Gi' } },
    } })),
  }
}

test('recovery requires positive stored-data and matching-pepper evidence for this original directory', () => {
  assert.equal(validateReport(report), '7671038612254789664')
  for (const change of [{ source: '/data/mx-launcher' }, { control: ['Database system identifier: $(bad)'] },
    { pepper: { verdict: 'UNVERIFIED_NO_VAULT_SAMPLES' } }, { originalControlFileUnchanged: false }, { database: {} }]) {
    assert.throws(() => validateReport({ ...report, ...change }))
  }
})

test('replacement volumes retain exact claims, preserve data, pin the original node, and never create absent directories', () => {
  const { pvs, claims } = resources()
  const replacements = replacementVolumes(pvs, claims, retained, 'original-node')
  replacements.forEach(([pv, pvc], i) => {
    assert.equal(pv.spec.hostPath.path, `${retained}/${VOLUMES[i][2]}`)
    assert.equal(pv.spec.hostPath.type, 'Directory')
    assert.equal(pv.spec.persistentVolumeReclaimPolicy, 'Retain')
    assert.equal(pv.spec.claimRef.uid, undefined)
    assert.equal(pv.spec.claimRef.name, pvc.metadata.name)
    assert.equal(pvc.spec.volumeName, pv.metadata.name)
    assert.deepEqual(pv.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values, ['original-node'])
  })
})

test('dynamic, foreign, already-rebound or misbound storage is refused before deleting any binding', () => {
  for (const mutate of [r => { r.pvs[0].spec.persistentVolumeReclaimPolicy = 'Delete' },
    r => { r.pvs[0].spec.claimRef.namespace = 'mx-internal-shadow' },
    r => { r.pvs[0].spec.hostPath.path = `${retained}/postgres/data` },
    r => { r.claims[0].spec.volumeName = 'other-pv' },
    r => { r.claims[0].spec.storageClassName = 'dynamic' }]) {
    const r = resources(); mutate(r)
    assert.throws(() => replacementVolumes(r.pvs, r.claims, retained, 'node'))
  }
})

test('only the dedicated Hub database password can be aligned and invalid credentials are never exposed', () => {
  const password = 'SyntheticPassword1234567890'
  const url = `postgres://mx_insight_hub:${password}@mx-common-postgres.mx-common.svc.cluster.local:5432/mx_insight_hub`
  const encode = value => Buffer.from(value).toString('base64')
  const secret = value => ({ data: { DATABASE_URL: encode(value) } })
  const product = { data: { password: encode(password) } }
  assert.equal(databaseCredential(secret(url), product), password)
  for (const value of [url.replace('mx_insight_hub:', 'mx_launcher:'), url.replace('/mx_insight_hub', '/mx_launcher'),
    url.replace(password, "quoted'Password123456789"), url.replace('.cluster.local', '.elsewhere.local')]) {
    assert.throws(() => databaseCredential(secret(value), product), error => !error.message.includes(password) && !error.message.includes(value))
  }
})

test('PostgreSQL identity guard refuses missing/wrong data and preserves runtime postgres arguments on success', t => {
  const root = mkdtempSync(join(tmpdir(), 'mx-recovery-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'base'))
  writeFileSync(join(root, 'PG_VERSION'), '16\n')
  writeFileSync(join(root, 'pg_controldata'), '#!/bin/sh\nprintf "Database system identifier: 7671038612254789664\\n"\n', { mode: 0o755 })
  writeFileSync(join(root, 'docker-entrypoint.sh'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$GUARD_OUTPUT"\n', { mode: 0o755 })
  const guard = postgresGuard('7671038612254789664')
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, PGDATA: root, GUARD_OUTPUT: join(root, 'output') }
  assert.equal(spawnSync(guard[0], [...guard.slice(1), '-c', 'max_connections=200'], { env }).status, 0)
  assert.equal(readFileSync(join(root, 'output'), 'utf8'), 'postgres\n-c\nmax_connections=200\n')
  rmSync(join(root, 'output'))
  writeFileSync(join(root, 'PG_VERSION'), '17\n')
  assert.notEqual(spawnSync(guard[0], guard.slice(1), { env }).status, 0)
  writeFileSync(join(root, 'PG_VERSION'), '16\n')
  const wrong = postgresGuard('1111111111111111111')
  assert.notEqual(spawnSync(wrong[0], wrong.slice(1), { env }).status, 0)
  assert.throws(() => readFileSync(join(root, 'output')))
})

test('Hub down stops all six workloads and waits for workers without mutating shared or Launcher services', () => {
  const script = resolve('scripts/manage.sh')
  const shell = `source "$1"
kubectl() {
  printf '%s\\n' "$*" >&2
  case "$*" in
    *'get deployments -o name') printf '%s\\n' ${HUB_DEPLOYMENTS.map(n => `deployment.apps/${n}`).join(' ')} ;;
    *'get pods '*) printf 'pod/mx-insight-hub-ingest-test\\n' ;;
  esac
}
stop_hub_workloads`
  const result = spawnSync('bash', ['-c', shell, '_', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  for (const name of HUB_DEPLOYMENTS) assert.ok(result.stderr.includes(`scale deployment.apps/${name} --replicas=0`))
  assert.match(result.stderr, /wait --for=delete pods/)
  assert.doesNotMatch(result.stderr, /-n mx-common|-n mx-internal-shadow| delete (pvc|pv)/)
  const failure = spawnSync('bash', ['-c', shell.replace("case \"$*\" in", "case \"$*\" in\n *'wait --for=delete'*) return 1 ;;"), '_', script], { encoding: 'utf8' })
  assert.notEqual(failure.status, 0)
  assert.doesNotMatch(failure.stdout, /background workers stopped/)
})

test('storage lookup fails closed on API failure and uses the existing PV after successful recovery', () => {
  const script = resolve('../mx-common/scripts/manage.sh')
  const failed = spawnSync('bash', ['-c', 'source "$1"; kubectl() { return 1; }; resolve_host_data_root', '_', script], { encoding: 'utf8' })
  assert.equal(failed.status, 78)
  assert.match(failed.stderr, /refusing a default-path fallback/)
  const restored = spawnSync('bash', ['-c', `source "$1"; kubectl() { printf '%s' '${retained}/postgres/data'; }; resolve_host_data_root; printf '%s' "$HOST_DATA_ROOT"`, '_', script], { encoding: 'utf8' })
  assert.equal(restored.status, 0, restored.stderr)
  assert.equal(restored.stdout, retained)
})

test('Hub deployment must not treat a storage guard rejection as optional search degradation', t => {
  const root = mkdtempSync(join(tmpdir(), 'mx-storage-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts/manage.sh'), '#!/bin/bash\nexit 78\n')
  const result = spawnSync('bash', ['-c', `source "$1"
MX_COMMON_DIR="$2"
ensure_hub_database() { printf 'UNSAFE_DATABASE_PROVISION'; }
discover_launcher_url() { :; }
ensure_shared_data_plane`, '_', resolve('scripts/manage.sh'), root], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /UNSAFE_DATABASE_PROVISION/)
  assert.match(result.stderr, /refusing database provisioning/)
})

test('retained-directory detection distinguishes a separate old database from the same mounted files', t => {
  const root = mkdtempSync(join(tmpdir(), 'mx-old-pg-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = join(root, 'old'), current = join(root, 'current')
  for (const path of [old, current]) mkdirSync(join(path, 'postgres/data/pgdata/global'), { recursive: true })
  const file = join(old, 'postgres/data/pgdata/global/pg_control')
  const target = join(current, 'postgres/data/pgdata/global/pg_control')
  writeFileSync(join(old, 'postgres/data/pgdata/PG_VERSION'), '16')
  writeFileSync(file, 'retained-control')
  writeFileSync(target, 'new-control')
  const check = () => spawnSync('bash', ['-c', 'source "$1"; retained_postgres_conflicts "$2" "$3"', '_', resolve('../mx-common/scripts/manage.sh'), old, current], { encoding: 'utf8' })
  assert.equal(check().status, 0, 'separate retained data must stop default initialization')
  rmSync(target); linkSync(file, target)
  assert.equal(check().status, 1, 'same files through an alias must not be mistaken for a second database')
})


test('kubectl input is a private real file readable by a subprocess and removed on success or failure', () => {
  let file
  const value = { spec: { replicas: 0 } }
  const output = withPatchFile(value, path => {
    file = path
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700)
    const child = spawnSync(process.execPath, ['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", path], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    assert.equal(child.status, 0, child.stderr)
    return JSON.parse(child.stdout)
  })
  assert.deepEqual(output, value)
  assert.equal(existsSync(file), false)
  assert.throws(() => withPatchFile(value, path => { file = path; throw new Error('synthetic kubectl failure') }), /synthetic kubectl failure/)
  assert.equal(existsSync(file), false)
})

test('real kubectl local strategic merge preserves PostgreSQL image and arguments while adding the guard', t => {
  if (spawnSync('kubectl', ['version', '--client'], { encoding: 'utf8' }).error?.code === 'ENOENT') return t.skip('kubectl not installed')
  const root = mkdtempSync(join(tmpdir(), 'mx-kubectl-local-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'statefulset.json')
  const container = { name: 'postgres', image: 'synthetic/pg:16', args: ['-c', 'max_connections=200'] }
  writeFileSync(file, JSON.stringify({ apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'mx-common-postgres' },
    spec: { replicas: 0, template: { spec: { containers: [container] } } } }))
  const guard = postgresGuard('7671038612254789664')
  const result = withPatchFile({ spec: { template: { spec: { containers: [{ name: 'postgres', command: guard }] } } } },
    path => spawnSync('kubectl', ['patch', '--local', '-f', file, '--type=strategic', '--patch-file', path, '-o', 'json'], { encoding: 'utf8' }))
  assert.equal(result.status, 0, result.stderr)
  const patched = JSON.parse(result.stdout)
  assert.equal(patched.spec.replicas, 0)
  assert.deepEqual(patched.spec.template.spec.containers, [{ ...container, command: guard }])
})

test('failed-command summary names the Kubernetes action but excludes payloads and private child output', () => {
  assert.equal(commandDescription('kubectl', ['--request-timeout=20s', '-n', 'mx-common', 'patch', 'statefulset', 'mx-common-postgres', '--patch', 'SyntheticSecret']),
    'kubectl patch statefulset mx-common-postgres')
  assert.equal(commandDescription('kubectl', ['--request-timeout=20s', '-n', 'mx-common', 'exec', '-i', 'statefulset/mx-common-postgres', '--', 'psql']),
    'kubectl database operation')
  assert.throws(() => command(process.execPath, ['-e', "console.error('SyntheticSecret'); process.exit(7)"], 'SyntheticInput'), error => {
    assert.match(error.message, /exit 7/)
    assert.doesNotMatch(error.message, /SyntheticSecret|SyntheticInput|console.error/)
    return true
  })
})

function resumeResources() {
  const { pvs, claims } = resources()
  for (const pv of pvs) { pv.metadata.uid = `uid-${pv.metadata.name}`; pv.status = { phase: 'Bound' } }
  for (const pvc of claims) { pvc.kind = 'PersistentVolumeClaim'; pvc.metadata.uid = `uid-${pvc.metadata.name}`; pvc.status = { phase: 'Bound' } }
  const hub = HUB_DEPLOYMENTS.map(name => ({ kind: 'Deployment', metadata: { name, uid: `uid-${name}` }, spec: { replicas: 1, template: { spec: { containers: [{ image: 'hub:original' }] } } } }))
  const storage = ['mx-common-postgres', 'mx-common-elasticsearch'].map(name => ({ kind: 'StatefulSet', metadata: { name, uid: `uid-${name}` }, spec: { replicas: 1 } }))
  const secret = { kind: 'Secret', metadata: { name: 'mx-insight-hub-secrets', uid: 'hub-secret' }, data: { key: 'synthetic-only' } }
  const productSecret = { kind: 'Secret', metadata: { name: 'mx-common-db-mx-insight-hub', uid: 'product-secret' }, data: { password: 'synthetic-only' } }
  const saved = structuredClone({ pvs, hub: { items: [...hub, secret] }, common: { items: [...storage, ...claims, productSecret] } })
  for (const value of [...hub, ...storage]) value.spec.replicas = 0
  return { saved, current: { hub, storage, pvs, claims, secret, productSecret } }
}

test('resume accepts only completed pre-rebinding checkpoints for the original database', () => {
  const state = { phase: 'both-storage-copies-preserved', originalRoot: retained, previousRoot: '/var/lib/mx-common/k8s', originalSystemIdentifier: '7671038612254789664' }
  for (const phase of ['both-storage-copies-preserved', 'storage-bindings-verified', 'postgres-startup-guard-installed', 'storage-startup-guards-installed']) {
    assert.doesNotThrow(() => validateResumeState({ ...state, phase }, state.originalSystemIdentifier))
  }
  for (const change of [{ phase: 'preflight' }, { phase: 'hub-stopped-current-db-empty' }, { phase: 'retained-volumes-bound' },
    { phase: 'replacing-binding-mx-common-postgres-data' }, { originalRoot: '/other' }, { previousRoot: '/other' }, { originalSystemIdentifier: 'wrong' }]) {
    assert.throws(() => validateResumeState({ ...state, ...change }, state.originalSystemIdentifier))
  }
})

test('resume validates stopped workloads, exact bindings and credential continuity without modifying the snapshots', () => {
  const { saved, current } = resumeResources()
  const before = structuredClone({ saved, current })
  assert.doesNotThrow(() => validateResumeResources(saved, current))
  assert.deepEqual({ saved, current }, before)
})

test('resume refuses a partial volume deletion/rebind, restarted/recreated workload, rollout or changed Secret', () => {
  for (const mutate of [
    r => { r.current.pvs.pop() },
    r => { r.current.pvs[0].metadata.deletionTimestamp = '2026-09-21' },
    r => { r.current.pvs[0].metadata.uid = 'recreated' },
    r => { r.current.pvs[0].spec.hostPath.path = `${retained}/postgres/data` },
    r => { r.current.pvs[0].status.phase = 'Released' },
    r => { r.current.claims.pop() },
    r => { r.current.claims[0].metadata.deletionTimestamp = '2026-09-21' },
    r => { r.current.claims[0].metadata.uid = 'recreated' },
    r => { r.current.hub[2].spec.replicas = 1 },
    r => { r.current.hub[0].metadata.uid = 'recreated' },
    r => { r.current.hub[0].spec.template.spec.containers[0].image = 'hub:new' },
    r => { r.current.storage[0].spec.replicas = 1 },
    r => { r.current.storage[1].metadata.uid = 'recreated' },
    r => { r.current.secret.data.key = 'different-secret' },
    r => { r.current.productSecret.data.password = 'different-secret' },
    r => { r.current.secret.metadata.uid = 'recreated' },
  ]) {
    const r = resumeResources(); mutate(r)
    assert.throws(() => validateResumeResources(r.saved, r.current), error => !error.message.includes('different-secret'))
  }
})


test('resume CLI refuses multiple recovery directories before reading files or contacting a cluster', () => {
  const result = spawnSync(process.execPath, ['scripts/recover-retained-storage.mjs', '--resume-before-rebind',
    '/nonexistent/recovery-a', '/nonexistent/recovery-b'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stdout, /Usage:/)
  assert.equal(result.stderr, '')
})


const originalIdentifier = '7671038612254789664'
function onlineResources() {
  const r = resumeResources()
  const expected = replacementVolumes(r.saved.pvs, r.saved.common.items.filter(v => v.kind === 'PersistentVolumeClaim'), retained, 'original-node')
  r.current.pvs = expected.map(([pv]) => ({ ...pv, metadata: { ...pv.metadata, uid: `new-${pv.metadata.name}` }, status: { phase: 'Bound' } }))
  r.current.claims = expected.map(([, pvc]) => ({ ...pvc, metadata: { ...pvc.metadata, uid: `new-${pvc.metadata.name}` }, status: { phase: 'Bound' } }))
  r.current.pvs.forEach((pv, i) => { pv.spec.claimRef.uid = r.current.claims[i].metadata.uid })
  for (const value of r.current.storage) {
    const postgres = value.metadata.name.endsWith('-postgres')
    const container = { name: postgres ? 'postgres' : 'elasticsearch', image: postgres ? 'pgvector/pgvector:pg16' : 'docker.elastic.co/elasticsearch/elasticsearch:9.4.2' }
    const before = r.saved.common.items.find(v => v.metadata.name === value.metadata.name)
    before.spec.template = { spec: { containers: [structuredClone(container)] } }
    if (postgres) container.command = postgresGuard(originalIdentifier)
    value.spec.replicas = 1
    value.spec.template = { spec: { containers: [container] } }
    value.metadata.generation = 3
    value.status = { readyReplicas: postgres ? 1 : 0, observedGeneration: 3 }
    if (!postgres) value.spec.template.spec.initContainers = [{ name: 'verify-retained-data',
      command: ['sh', '-ec', 'test -d /retained/_state || test -d /retained/nodes/0/_state'],
      volumeMounts: [{ name: 'data', mountPath: '/retained', readOnly: true }] }]
  }
  return r
}

test('online continuation accepts only database-verified or search-verified checkpoints', () => {
  const state = { originalRoot: retained, previousRoot: '/var/lib/mx-common/k8s', originalSystemIdentifier: originalIdentifier }
  for (const phase of ['original-database-verified-hub-password-aligned', 'original-search-verified']) {
    assert.doesNotThrow(() => validateOnlineRecoveryState({ ...state, phase }, originalIdentifier))
  }
  for (const phase of ['both-storage-copies-preserved', 'retained-volumes-bound', 'data-and-api-restored-workers-paused']) {
    assert.throws(() => validateOnlineRecoveryState({ ...state, phase }, originalIdentifier))
  }
  assert.throws(() => validateOnlineRecoveryState({ ...state, phase: 'original-search-verified' }, '9999999999999'))
})

test('online continuation accepts the exact rebound storage and guarded live PG without requiring ES readiness', () => {
  const r = onlineResources(), before = structuredClone(r)
  assert.doesNotThrow(() => validateOnlineRecoveryResources(r.saved, r.current, originalIdentifier, 'original-node'))
  assert.deepEqual(r, before)
  assert.throws(() => validateResumeResources(r.saved, r.current), 'pre-rebind route must still reject this state')
})

test('online continuation rejects wrong paths, claims, node, guards, live writers, credentials or replaced workloads', () => {
  for (const mutate of [
    r => { r.current.pvs[0].spec.hostPath.path = '/var/lib/mx-common/k8s/postgres/data' },
    r => { r.current.pvs[0].spec.hostPath.type = 'DirectoryOrCreate' },
    r => { r.current.pvs[0].spec.persistentVolumeReclaimPolicy = 'Delete' },
    r => { r.current.pvs[0].spec.claimRef.uid = 'other-claim' },
    r => { r.current.pvs[0].metadata.deletionTimestamp = 'now' },
    r => { r.current.pvs[0].status.phase = 'Released' },
    r => { r.current.pvs[0].spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values = ['other-node'] },
    r => { r.current.claims[0].spec.volumeName = 'other-volume' },
    r => { r.current.claims[0].metadata.namespace = 'mx-launcher' },
    r => { r.current.claims[0].spec.storageClassName = 'dynamic' },
    r => { r.current.claims.pop() },
    r => { r.current.storage[0].status.readyReplicas = 0 },
    r => { delete r.current.storage[0].status.observedGeneration },
    r => { r.current.storage[0].spec.template.spec.containers[0].command = ['postgres'] },
    r => { r.current.storage[0].metadata.uid = 'recreated' },
    r => { r.current.storage[1].spec.template.spec.initContainers = [] },
    r => { r.current.storage[1].spec.template.spec.containers[0].image = 'elasticsearch:other' },
    r => { r.current.hub[0].spec.replicas = 1 },
    r => { r.current.hub[2].spec.replicas = 1 },
    r => { r.current.secret.data.key = 'SyntheticSecret' },
  ]) {
    const r = onlineResources(); mutate(r)
    assert.throws(() => validateOnlineRecoveryResources(r.saved, r.current, originalIdentifier, 'original-node'), error => !error.message.includes('SyntheticSecret'))
  }
})

test('progress reports container state without exposing spec, raw error messages or credentials', () => {
  const pod = { metadata: { name: 'mx-common-elasticsearch-0' }, spec: { secret: 'SyntheticSecret' }, status: {
    phase: 'Pending', initContainerStatuses: [{ name: 'verify-retained-data', state: { terminated: { reason: 'Completed', exitCode: 0, message: 'SyntheticSecret' } } }],
    containerStatuses: [{ name: 'elasticsearch', restartCount: 0, state: { waiting: { reason: 'PodInitializing', message: 'SyntheticSecret' } } }],
  } }
  const progress = podProgress(pod)
  assert.equal(progress.init[0].exitCode, 0)
  assert.equal(progress.containers[0].state, 'PodInitializing')
  assert.doesNotMatch(JSON.stringify(progress), /SyntheticSecret/)
})

test('final recovery phase gates API start on schema/auth checks and never mutates storage or database credentials', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mx-final-recovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const trace = join(root, 'trace.jsonl')
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MX_RECOVERY_TEST_TRACE, JSON.stringify(args)+'\\n');
const out = value => process.stdout.write(JSON.stringify(value));
if(args.includes('get') && args.includes('statefulset')) out({metadata:{generation:1},status:{observedGeneration:1,readyReplicas:1}});
else if(args.includes('get') && args.includes('deployment')) out({metadata:{generation:1},status:{observedGeneration:1,availableReplicas:1}});
else if(args.includes('get') && args.includes('pod')) out({status:{phase:'Succeeded'}});
else if(args.includes('exec') && args.at(-1).includes('/_cluster/health')) out({status:'green'});
else if(args.includes('exec') && args.at(-1).includes('/_cat/indices')) out([{index:'mx-insight-hub-content-v6-current','docs.count':'2548317','store.size':'55gb'}]);
else if(args.includes('logs')) out({schemaCompatible:process.env.MX_RECOVERY_TEST_SCHEMA==='pass',productDatabaseAuthentication:true});
else if(args.includes('create')) {const pod=JSON.parse(fs.readFileSync(0,'utf8'));if(pod.kind!=='Pod'||!pod.metadata.name.startsWith('mx-insight-hub-recovery-')) process.exit(44);}
else if(args.includes('delete') && args.includes('pod')) {}
else if(args.includes('scale') && args.some(a=>a==='deployment/mx-insight-hub-public'||a==='deployment/mx-insight-hub-admin')) {}
else {console.error('Unexpected operation');process.exit(45);}
`
  writeFileSync(join(root, 'kubectl'), stub, { mode: 0o755 })
  const checked = spawnSync(process.execPath, ['--check', join(root, 'kubectl')], { encoding: 'utf8' })
  assert.equal(checked.status, 0, checked.stderr)
  const savedEnv = { ...process.env }, savedFetch = globalThis.fetch
  t.mock.method(console, 'log', () => {})
  try {
    process.env.PATH = `${root}:${process.env.PATH}`
    process.env.MX_RECOVERY_TEST_TRACE = trace
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { tenants: 9, consumers: 10, activeApiKeys: 10 } }) })
    const input = { hub: [{ metadata: { name: 'mx-insight-hub-public' }, spec: { template: { spec: { containers: [{ image: 'synthetic/hub:test' }] } } } }],
      node: { metadata: { name: 'original-node' } }, secret: { data: { MX_INSIGHT_ADMIN_TOKEN: Buffer.from('synthetic-token').toString('base64') } },
      summary: { tenants: 9, consumers: 10 }, checkpoint: () => {} }
    for (const schema of ['fail', 'pass']) {
      process.env.MX_RECOVERY_TEST_SCHEMA = schema
      writeFileSync(trace, '')
      if (schema === 'fail') await assert.rejects(restoreSearchAndApis(input), /cannot safely serve this schema/)
      else await restoreSearchAndApis(input)
      const commands = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const scales = commands.filter(args => args.includes('scale'))
      assert.equal(scales.length, schema === 'pass' ? 2 : 0)
      for (const args of commands) {
        assert.ok(!args.includes('patch') && !args.includes('psql'))
        if (args.includes('delete')) assert.ok(args.includes('pod'))
        if (args.includes('scale')) assert.ok(args.some(a => ['deployment/mx-insight-hub-public', 'deployment/mx-insight-hub-admin'].includes(a)))
      }
      assert.equal(commands.filter(args => args.includes('delete') && args.includes('pod')).length, 1)
    }
  } finally {
    process.env.PATH = savedEnv.PATH
    for (const name of ['MX_RECOVERY_TEST_TRACE', 'MX_RECOVERY_TEST_SCHEMA']) {
      if (savedEnv[name] === undefined) delete process.env[name]
      else process.env[name] = savedEnv[name]
    }
    globalThis.fetch = savedFetch
  }
})
