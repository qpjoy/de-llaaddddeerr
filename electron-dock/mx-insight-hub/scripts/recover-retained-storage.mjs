#!/usr/bin/env node
// Explicit Internal incident recovery. Does not call deploy, migrations,
// provisioning, Launcher, source connectors, or any full-data rebuild.
import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { hostname, networkInterfaces, tmpdir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { containerIsolation, overlap, pepperEvidence, validateLayout } from './inspect-retained-database.mjs'

export const HUB_DEPLOYMENTS = ['admin', 'public', 'ingest', 'projector', 'classifier', 'retrieval'].map(s => `mx-insight-hub-${s}`)
export const VOLUMES = [
  ['mx-common-postgres-data', 'data-mx-common-postgres-0', 'postgres/data'],
  ['mx-common-elasticsearch-data', 'data-mx-common-elasticsearch-0', 'elasticsearch/data'],
  ['mx-common-elasticsearch-snapshots', 'mx-common-elasticsearch-snapshots', 'elasticsearch/snapshots'],
]
const DEFAULT_ROOT = '/var/lib/mx-common/k8s'
const RETAINED_ROOT = '/data/k8s/mx-runtime/mx-common/k8s'

export function validateReport(report) {
  const identifier = report.control?.find(line => line.startsWith('Database system identifier:'))?.split(':').slice(1).join(':').trim()
  if (report.source !== RETAINED_ROOT || !/^\d{10,30}$/.test(identifier || '')
      || report.pepper?.verdict !== 'MATCHED_SAMPLES' || !(report.pepper.matched > 0)
      || report.originalControlFileUnchanged !== true
      || !report.database?.hasStoredRecords || !report.database.hasRequestHistory) {
    throw new Error('A successful retained-data inspection report is required')
  }
  return identifier
}

export function replacementVolumes(pvs, claims, root, nodeLabel) {
  return VOLUMES.map(([pvName, claimName, suffix]) => {
    const pv = pvs.find(value => value.metadata.name === pvName)
    const pvc = claims.find(value => value.metadata.name === claimName)
    if (!pv || !pvc || pv.spec.persistentVolumeReclaimPolicy !== 'Retain'
        || pv.spec.hostPath?.path !== `${DEFAULT_ROOT}/${suffix}`
        || pv.spec.claimRef?.namespace !== 'mx-common' || pv.spec.claimRef?.name !== claimName
        || pvc.spec.volumeName !== pvName || (pvc.spec.storageClassName || '') !== '') {
      throw new Error(`Unexpected binding or reclaim policy for ${pvName}; no volume will be replaced`)
    }
    return [
      { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels: pv.metadata.labels },
        spec: { capacity: pv.spec.capacity, accessModes: pv.spec.accessModes,
          volumeMode: 'Filesystem', persistentVolumeReclaimPolicy: 'Retain', storageClassName: '',
          hostPath: { path: `${root}/${suffix}`, type: 'Directory' },
          claimRef: { namespace: 'mx-common', name: claimName },
          nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [
            { key: 'kubernetes.io/hostname', operator: 'In', values: [nodeLabel] },
          ] }] } },
        } },
      { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: claimName, namespace: 'mx-common', labels: pvc.metadata.labels },
        spec: { accessModes: pvc.spec.accessModes, resources: pvc.spec.resources,
          volumeMode: 'Filesystem', storageClassName: '', volumeName: pvName } },
    ]
  })
}

export function databaseCredential(secret, productSecret) {
  const value = Buffer.from(secret.data?.DATABASE_URL || '', 'base64').toString()
  let url
  try { url = new URL(value) } catch { throw new Error('Hub database connection is invalid; value withheld') }
  const password = decodeURIComponent(url.password)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || url.hostname !== 'mx-common-postgres.mx-common.svc.cluster.local'
      || (url.port && url.port !== '5432') || url.pathname !== '/mx_insight_hub'
      || url.username !== 'mx_insight_hub' || url.search
      || !/^[A-Za-z0-9]{16,}$/.test(password)
      || password !== Buffer.from(productSecret.data?.password || '', 'base64').toString()) {
    throw new Error('Hub DSN and retained product Secret do not agree; credential values withheld')
  }
  return password
}

export function postgresGuard(identifier) {
  if (!/^\d{10,30}$/.test(identifier)) throw new Error('Invalid original PostgreSQL system identifier')
  return ['sh', '-ec',
    `test "$(cat "$PGDATA/PG_VERSION")" = 16 && test -d "$PGDATA/base" && test "$(LC_ALL=C pg_controldata "$PGDATA" | awk -F ': *' '$1 == "Database system identifier" {print $2}')" = '${identifier}' || { echo 'Original PG16 identity missing; initialization refused' >&2; exit 1; }; exec docker-entrypoint.sh postgres "$@"`,
    '--']
}

let failureDirectory
let failureNumber = 0

export function commandDescription(binary, args) {
  if (binary !== 'kubectl') return `${binary} operation`
  const index = args.findIndex(arg => ['get', 'patch', 'create', 'delete', 'scale', 'exec', 'logs'].includes(arg))
  if (index < 0) return 'kubectl operation'
  const action = args[index]
  if (action === 'exec') return args.includes('psql') ? 'kubectl database operation' : 'kubectl container operation'
  // Only resource words, never payloads, URLs, arguments after -- or child output.
  const words = args.slice(index + 1, index + 3).filter(word => /^[a-zA-Z0-9][a-zA-Z0-9.,_/-]*$/.test(word))
  return ['kubectl', action, ...words].join(' ')
}

export function command(binary, args, input, timeout = 30_000) {
  try {
    return execFileSync(binary, args, { input, encoding: 'utf8', timeout,
      maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' } }).trim()
  } catch (error) {
    const operation = commandDescription(binary, args)
    const status = Number.isInteger(error.status) ? `exit ${error.status}` : 'no exit status'
    let detail = ''
    if (failureDirectory) {
      const file = join(failureDirectory, `command-error-${Date.now()}-${++failureNumber}.json`)
      try {
        persist(file, { operation, status: error.status, code: error.code, signal: error.signal,
          stdout: error.stdout?.toString(), stderr: error.stderr?.toString() })
        detail = `; private diagnostic: ${file} (do not paste its contents)`
      } catch { detail = '; private diagnostic could not be saved' }
    }
    throw new Error(`${operation} failed (${status}); private output withheld${detail}`)
  }
}
function kube(args, input, timeout) { return command('kubectl', ['--request-timeout=20s', ...args], input, timeout) }
function get(ns, kind) { return JSON.parse(kube([...(ns ? ['-n', ns] : []), 'get', ...kind.split(' '), '-o', 'json'])) }
function persist(file, value) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flush: true })
  renameSync(`${file}.tmp`, file)
}
// Node child stdio can be a socket on Linux: reopening /dev/stdin as a file
// fails with ENXIO. kubectl --patch-file needs a real private file instead.
export function withPatchFile(value, use) {
  const directory = mkdtempSync(join(tmpdir(), 'mx-hub-recovery-input-'))
  chmodSync(directory, 0o700)
  try {
    const file = join(directory, 'input.json')
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
    return use(file)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
function patch(ns, kind, name, value) {
  return withPatchFile(value, file => kube(['-n', ns, 'patch', kind, name, '--type=strategic', '--patch-file', file]))
}
function psql(sql, database = 'mx_insight_hub') {
  return kube(['-n', 'mx-common', 'exec', '-i', 'statefulset/mx-common-postgres', '--',
    'psql', '-X', '-w', '-qAt', '-U', 'mx_common', '-d', database, '-v', 'ON_ERROR_STOP=1'], sql, 60_000)
}
const hasDataSQL = `SELECT json_build_object('records', EXISTS(SELECT 1 FROM core.canonical_records), 'requests', EXISTS(SELECT 1 FROM public.usage_requests));`
const samplesSQL = `SELECT coalesce(json_agg(s), '[]'::json) FROM (
  SELECT v.api_key_id AS id, v.envelope, k.key_digest AS digest FROM api_key_vault v
  JOIN api_keys k ON k.id=v.api_key_id ORDER BY v.created_at DESC LIMIT 10) s;`

async function until(check, description, seconds = 180, progress) {
  const started = Date.now()
  const deadline = started + seconds * 1000
  let nextProgress = started
  while (Date.now() < deadline) {
    if (await check()) return
    if (Date.now() >= nextProgress) {
      console.log(JSON.stringify({ waiting: description, elapsedSeconds: Math.floor((Date.now() - started) / 1000),
        timeoutSeconds: seconds, ...(progress ? progress() : {}) }))
      nextProgress = Date.now() + 30_000
    }
    await sleep(2000)
  }
  throw new Error(`Timed out: ${description}`)
}
function nonterminal(pods) { return pods.filter(pod => !['Succeeded', 'Failed'].includes(pod.status.phase)) }
async function stopHub() {
  for (const name of HUB_DEPLOYMENTS) kube(['-n', 'mx-insight-hub', 'scale', `deployment/${name}`, '--replicas=0'])
  await until(() => nonterminal(get('mx-insight-hub', 'pods').items).length === 0, 'Hub writers did not stop')
}
function unusedRoot(root, allPvs, pods) {
  const claims = new Map(allPvs.filter(pv => pv.spec.hostPath && pv.spec.claimRef).map(pv => [
    `${pv.spec.claimRef.namespace}/${pv.spec.claimRef.name}`, pv.spec.hostPath.path,
  ]))
  for (const pod of nonterminal(pods)) for (const volume of pod.spec.volumes || []) {
    const path = volume.hostPath?.path || claims.get(`${pod.metadata.namespace}/${volume.persistentVolumeClaim?.claimName}`)
    if (path && existsSync(path) && overlap(realpathSync(path), root)) throw new Error('Retained data is referenced by a live Pod')
  }
  const ids = command('docker', ['ps', '-q']).split(/\s+/).filter(Boolean)
  if (ids.length) for (const container of JSON.parse(command('docker', ['inspect', ...ids]))) {
    for (const mount of container.Mounts || []) if (mount.RW && mount.Source && existsSync(mount.Source) && overlap(realpathSync(mount.Source), root)) {
      throw new Error('Retained data has a live Docker writer')
    }
  }
  // Detect host-native writers in addition to the orchestrated workloads.
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          const path = realpathSync(`/proc/${pid}/fd/${fd}`)
          if (path === root || path.startsWith(`${root}/`)) throw new Error('Retained data is open by a host process')
        }
        catch (error) { if (!['ENOENT', 'ESRCH', 'EINVAL'].includes(error.code)) throw error }
      }
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
  }
}

// The deployed image checks its own schema and authenticates using its real
// Secret before either API opens a port. No application module is imported.
export const PROBE_CODE = `
import fs from 'node:fs'; import crypto from 'node:crypto'; import pg from 'pg';
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL, connectionTimeoutMillis:10000});
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'");
    const applied = new Map((await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map(r=>[r.filename,r.checksum]));
    const invalid = ['/app/migrations','/mx-common/migrations'].flatMap(dir=>fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).filter(f=>applied.get(f)!==crypto.createHash('sha256').update(fs.readFileSync(dir+'/'+f)).digest('hex')));
    if(invalid.length) { console.log(JSON.stringify({schemaCompatible:false, pendingOrChangedMigrations:invalid})); process.exitCode=2; }
    else { console.log(JSON.stringify({schemaCompatible:true, productDatabaseAuthentication:true})); }
    await client.query('ROLLBACK');
  } finally { client.release(); }
} catch { console.log(JSON.stringify({databaseProbeFailed:true})); process.exitCode=2; }
finally { await pool.end(); }
`

const RESUMABLE_PHASES = ['both-storage-copies-preserved', 'storage-bindings-verified',
  'postgres-startup-guard-installed', 'storage-startup-guards-installed']

export function validateResumeState(state, identifier) {
  if (!RESUMABLE_PHASES.includes(state.phase) || state.originalRoot !== RETAINED_ROOT
      || state.previousRoot !== DEFAULT_ROOT || state.originalSystemIdentifier !== identifier) {
    throw new Error('Resume requires a completed backup before any volume replacement; inspect the recorded stage')
  }
}

function validateHubContinuity(saved, current) {
  if (current.hub.length !== HUB_DEPLOYMENTS.length) throw new Error('Unexpected Hub deployments; resume refused')
  for (const name of HUB_DEPLOYMENTS) {
    const before = saved.hub.items.find(r => r.kind === 'Deployment' && r.metadata.name === name)
    const now = current.hub.find(r => r.metadata.name === name)
    if (!before?.metadata.uid || now?.metadata.uid !== before.metadata.uid || now.spec.replicas !== 0) {
      throw new Error(`Resume refused: ${name} was recreated or is not stopped`)
    }
    const { replicas: oldReplicas, ...oldSpec } = before.spec
    const { replicas: newReplicas, ...newSpec } = now.spec
    if (!isDeepStrictEqual(oldSpec, newSpec)) throw new Error(`Resume refused: ${name} deployment configuration changed`)
  }
  for (const [snapshot, secret] of [[saved.hub, current.secret], [saved.common, current.productSecret]]) {
    const before = snapshot.items.find(r => r.kind === 'Secret' && r.metadata.name === secret.metadata.name)
    if (!before?.metadata.uid || before.metadata.uid !== secret.metadata.uid || !isDeepStrictEqual(before.data, secret.data)) {
      throw new Error('Resume refused: a Hub credential Secret changed; values withheld')
    }
  }
}

export function validateResumeResources(saved, current) {
  validateHubContinuity(saved, current)
  for (const name of ['mx-common-postgres', 'mx-common-elasticsearch']) {
    const before = saved.common.items.find(r => r.kind === 'StatefulSet' && r.metadata.name === name)
    const now = current.storage.find(r => r.metadata.name === name)
    if (!before?.metadata.uid || now?.metadata.uid !== before.metadata.uid || now.spec.replicas !== 0) {
      throw new Error(`Resume refused: ${name} was recreated or is not stopped`)
    }
  }
  for (const [pvName, pvcName] of VOLUMES) {
    const oldPv = saved.pvs.find(r => r.metadata.name === pvName)
    const pv = current.pvs.find(r => r.metadata.name === pvName)
    const oldPvc = saved.common.items.find(r => r.kind === 'PersistentVolumeClaim' && r.metadata.name === pvcName)
    const pvc = current.claims.find(r => r.metadata.name === pvcName)
    if (!oldPv?.metadata.uid || pv?.metadata.uid !== oldPv.metadata.uid || pv.metadata.deletionTimestamp
        || !oldPvc?.metadata.uid || pvc?.metadata.uid !== oldPvc.metadata.uid || pvc.metadata.deletionTimestamp
        || pv.status?.phase !== 'Bound' || pvc.status?.phase !== 'Bound'
        || !isDeepStrictEqual(oldPv.spec, pv.spec) || !isDeepStrictEqual(oldPvc.spec, pvc.spec)) {
      throw new Error(`Resume refused: ${pvName} binding changed or is being deleted; do not force finalizers`)
    }
  }
}

export function validateOnlineRecoveryState(state, identifier) {
  if (!['original-database-verified-hub-password-aligned', 'original-search-verified'].includes(state.phase)
      || state.originalRoot !== RETAINED_ROOT || state.previousRoot !== DEFAULT_ROOT
      || state.originalSystemIdentifier !== identifier) {
    throw new Error('Online continuation requires the original database verification checkpoint; no bindings will be changed')
  }
}

export function validateOnlineRecoveryResources(saved, current, identifier, nodeLabel) {
  validateHubContinuity(saved, current)
  const expected = replacementVolumes(saved.pvs, saved.common.items.filter(r => r.kind === 'PersistentVolumeClaim'), RETAINED_ROOT, nodeLabel)
  for (const [expectedPv, expectedPvc] of expected) {
    const pv = current.pvs.find(r => r.metadata.name === expectedPv.metadata.name)
    const pvc = current.claims.find(r => r.metadata.name === expectedPvc.metadata.name)
    const differences = []
    if (!pv) differences.push('pv.missing')
    if (!pvc) differences.push('pvc.missing')
    if (pv && pvc) {
      if (pv.metadata.deletionTimestamp) differences.push('pv.metadata.deletionTimestamp')
      if (pvc.metadata.deletionTimestamp) differences.push('pvc.metadata.deletionTimestamp')
      if (pv.status?.phase !== 'Bound') differences.push('pv.status.phase')
      if (pvc.status?.phase !== 'Bound') differences.push('pvc.status.phase')
      if (!pvc.metadata.uid) differences.push('pvc.metadata.uid')
      if (pvc.metadata.namespace !== 'mx-common') differences.push('pvc.metadata.namespace')
      if (pv.spec.claimRef?.uid !== pvc.metadata.uid) differences.push('pv.spec.claimRef.uid')
      if (pv.spec.claimRef?.namespace !== 'mx-common') differences.push('pv.spec.claimRef.namespace')
      if (pv.spec.claimRef?.name !== pvc.metadata.name) differences.push('pv.spec.claimRef.name')
      for (const key of Object.keys(expectedPv.spec).filter(key => key !== 'claimRef')) {
        // PV StorageClassName is a Go string with json omitempty: the API omits
        // an empty class. PVC uses a *string instead; keep its explicit empty
        // value strict so default-class assignment cannot pass this check.
        const actual = key === 'storageClassName' && pv.spec[key] === undefined ? '' : pv.spec[key]
        if (!isDeepStrictEqual(actual, expectedPv.spec[key])) differences.push(`pv.spec.${key}`)
      }
      for (const key of Object.keys(expectedPvc.spec)) {
        if (!isDeepStrictEqual(pvc.spec[key], expectedPvc.spec[key])) differences.push(`pvc.spec.${key}`)
      }
    }
    if (differences.length) {
      // Fixed field names only; never dump resource objects or their values.
      throw new Error(`Online continuation refused: ${expectedPv.metadata.name} retained binding validation failed; mismatched fields: ${differences.join(', ')}`)
    }
  }
  for (const name of ['mx-common-postgres', 'mx-common-elasticsearch']) {
    const before = saved.common.items.find(r => r.kind === 'StatefulSet' && r.metadata.name === name)
    const now = current.storage.find(r => r.metadata.name === name)
    if (!before?.metadata.uid || now?.metadata.uid !== before.metadata.uid || now.metadata.deletionTimestamp || now.spec.replicas !== 1) {
      throw new Error(`Online continuation refused: ${name} identity or replicas changed`)
    }
    const containerName = name === 'mx-common-postgres' ? 'postgres' : 'elasticsearch'
    const container = now.spec.template.spec.containers.find(c => c.name === containerName)
    const beforeContainer = before.spec.template.spec.containers.find(c => c.name === containerName)
    if (!container?.image || container.image !== beforeContainer?.image) throw new Error(`Online continuation refused: ${name} image changed`)
    if (containerName === 'postgres') {
      if (now.status?.readyReplicas !== 1 || (now.status?.observedGeneration ?? -1) < (now.metadata.generation ?? 0)
          || !isDeepStrictEqual(container.command, postgresGuard(identifier))) {
        throw new Error('Verified PostgreSQL is not ready or its startup identity guard changed')
      }
    } else {
      const guard = now.spec.template.spec.initContainers?.find(c => c.name === 'verify-retained-data')
      if (!container.image.endsWith(':9.4.2')
          || !isDeepStrictEqual(guard?.command, ['sh', '-ec', 'test -d /retained/_state || test -d /retained/nodes/0/_state'])
          || !guard?.volumeMounts?.some(m => m.name === 'data' && m.mountPath === '/retained' && m.readOnly === true)) {
        throw new Error('Elasticsearch retained-data startup guard or version changed')
      }
    }
  }
}

export async function continueAfterDatabase(directory) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Run on the Internal Linux host as root')
  process.umask(0o077)
  const backup = resolve(directory)
  if (!/^\/data\/\.mx-hub-recovery-[a-zA-Z0-9]+$/.test(backup) || realpathSync(backup) !== backup
      || statSync(backup).uid !== 0 || (statSync(backup).mode & 0o077) !== 0) {
    throw new Error('Use the original root-private recovery directory on /data')
  }
  const read = file => JSON.parse(readFileSync(join(backup, file), 'utf8'))
  const state = read('state.json'), report = read('inspection.json')
  const identifier = validateReport(report)
  validateOnlineRecoveryState(state, identifier)
  const saved = { pvs: read('volumes.json'), common: read('mx-common.json'), hub: read('mx-insight-hub.json') }
  const root = realpathSync(state.originalRoot)
  if (root !== RETAINED_ROOT || statSync(root).dev !== statSync('/data').dev || statSync(root).dev === statSync('/').dev) {
    throw new Error('Original /data filesystem is missing; online continuation refused')
  }
  for (const dataRoot of [root, join(backup, 'retained-before-recovery'), join(backup, 'default-before-recovery')]) {
    for (const [, , suffix] of VOLUMES) {
      const path = join(dataRoot, suffix)
      if (!statSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('Retained data or a preserved copy is missing or redirected')
    }
    // The live control file will change after PostgreSQL starts. Never compare
    // it with a cold backup or demand a clean shutdown in this entry point.
    if (dataRoot !== root) validateLayout(join(dataRoot, 'postgres/data/pgdata'))
  }
  const nodes = get('', 'nodes').items
  const localIps = Object.values(networkInterfaces()).flat().filter(Boolean).map(item => item.address)
  if (nodes.length !== 1 || !nodes[0].status.addresses.some(a => a.address === hostname() || localIps.includes(a.address))) {
    throw new Error('kubectl is not targeting this same single-node host')
  }
  const node = nodes[0], label = node.metadata.labels['kubernetes.io/hostname']
  if (!label) throw new Error('Original node hostname label is missing')
  const runtime = join(dirname(fileURLToPath(import.meta.url)), '../.runtime')
  mkdirSync(runtime, { recursive: true })
  const lock = join(runtime, 'internal-production-deploy.lock')
  try { mkdirSync(lock, { mode: 0o700 }) } catch { throw new Error('Deploy/recovery lock exists; inspect it before continuing') }
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
  const checkpoint = phase => { state.phase = phase; persist(join(backup, 'state.json'), state); console.log(`Recovery stage: ${phase}`) }
  let validated = false
  failureDirectory = backup
  try {
    if (get('mx-insight-hub', 'hpa').items.length || get('mx-insight-hub', 'cronjobs').items.length
        || get('mx-insight-hub', 'jobs').items.some(job => job.status.active > 0)
        || nonterminal(get('mx-insight-hub', 'pods').items).length) throw new Error('Hub writers/jobs must remain stopped before continuing')
    const current = { hub: get('mx-insight-hub', 'deployments').items, storage: get('mx-common', 'statefulsets').items,
      pvs: get('', 'pv').items, claims: get('mx-common', 'pvc').items,
      secret: get('mx-insight-hub', 'secret mx-insight-hub-secrets'),
      productSecret: get('mx-common', 'secret mx-common-db-mx-insight-hub') }
    validateOnlineRecoveryResources(saved, current, identifier, label)
    databaseCredential(current.secret, current.productSecret)
    const pepper = Buffer.from(current.secret.data.MX_INSIGHT_API_KEY_PEPPER || '', 'base64').toString()
    if (pepper.length < 32 || !current.secret.data.MX_INSIGHT_ADMIN_TOKEN) throw new Error('Current Hub credentials are missing; values withheld')
    const summary = await verifyOriginalDatabase(identifier, report, pepper)
    if (psql('BEGIN READ ONLY; SELECT EXISTS (SELECT 1 FROM control.search_settings WHERE startup_rebuild=true); COMMIT;') !== 'f') {
      throw new Error('Startup rebuild was re-enabled; stop and review before starting APIs')
    }
    validated = true
    console.log('Online database, retained bindings and current credentials verified. Continuing search/API checks; background workers remain paused.')
    await restoreSearchAndApis({ hub: current.hub, node, secret: current.secret, summary, checkpoint })
  } catch (error) {
    if (validated) {
      try { await stopHub() } catch { console.error('Could not confirm all Hub writers stopped; inspect Hub Pods.') }
    }
    console.error(`Recovery stopped at ${state.phase}. PostgreSQL and retained storage were not rolled back.`)
    throw error
  } finally {
    failureDirectory = undefined
    if (readFileSync(join(lock, 'pid'), 'utf8') === String(process.pid)) { unlinkSync(join(lock, 'pid')); rmdirSync(lock) }
    console.log(`Recovery record: ${backup}/state.json (private; do not paste Secret backups).`)
  }
}

export function podProgress(pod) {
  const summarize = values => (values || []).map(value => ({ name: value.name, ready: value.ready === true,
    restarts: value.restartCount || 0, state: value.state?.running ? 'Running'
      : value.state?.waiting?.reason || value.state?.terminated?.reason || 'Unknown',
    exitCode: value.state?.terminated?.exitCode }))
  // Deliberately omit environment, Pod spec, raw error messages and logs.
  return { pod: pod.metadata.name, phase: pod.status.phase,
    init: summarize(pod.status.initContainerStatuses), containers: summarize(pod.status.containerStatuses) }
}
function searchPodProgress() {
  try { return podProgress(get('mx-common', 'pod mx-common-elasticsearch-0')) }
  catch { return { podStatus: 'unavailable' } }
}

async function verifyOriginalDatabase(identifier, report, pepper) {
  if (psql('SELECT system_identifier::text FROM pg_control_system();') !== identifier) throw new Error('Running PostgreSQL has the wrong identity')
  const evidence = pepperEvidence(JSON.parse(psql(`BEGIN READ ONLY; ${samplesSQL} COMMIT;`)), pepper)
  if (evidence.verdict !== 'MATCHED_SAMPLES') throw new Error(`Current Pepper failed original database verification: ${evidence.verdict}`)
  const summary = JSON.parse(psql(`BEGIN READ ONLY; SET LOCAL statement_timeout='10s';
    SELECT json_build_object('tenants',(SELECT count(*) FROM tenants),'consumers',(SELECT count(*) FROM consumers),
      'allApiKeys',(SELECT count(*) FROM api_keys),'hasStoredRecords',EXISTS(SELECT 1 FROM core.canonical_records),
      'latestRequestAt',(SELECT created_at FROM usage_requests ORDER BY created_at DESC LIMIT 1)); COMMIT;`))
  if (['tenants', 'consumers', 'allApiKeys'].some(key => summary[key] !== report.database[key])
      || !summary.hasStoredRecords || Date.parse(summary.latestRequestAt) !== Date.parse(report.database.latestRequestAt)) throw new Error('Original business evidence differs from the inspected report')
  console.log(JSON.stringify({ originalDatabase: summary, pepper: evidence }, null, 2))
  return summary
}

export async function restoreSearchAndApis({ hub, node, secret, summary, checkpoint }) {
  let probe
  try {
    await until(() => {
      const value = get('mx-common', 'statefulset mx-common-elasticsearch')
      return value.status.observedGeneration >= value.metadata.generation && value.status.readyReplicas === 1
    }, 'original Elasticsearch readiness', 600, () => searchPodProgress())
    const es = path => JSON.parse(kube(['-n', 'mx-common', 'exec', 'statefulset/mx-common-elasticsearch', '-c', 'elasticsearch', '--', 'curl', '-fsS', '--max-time', '20', `http://127.0.0.1:9200${path}`]))
    let health
    await until(() => {
      try { health = es('/_cluster/health'); return ['yellow', 'green'].includes(health.status) } catch { return false }
    }, 'Elasticsearch shard recovery', 600, () => ({ clusterStatus: health?.status || 'unavailable', initializingShards: health?.initializing_shards, unassignedShards: health?.unassigned_shards }))
    const indices = es('/_cat/indices/mx-insight-hub-*?format=json&h=index,docs.count,store.size')
    if (!['yellow', 'green'].includes(health.status) || !indices.some(index => index.index.includes('content') && Number(index['docs.count']) > 0)) throw new Error('Original Elasticsearch has not recovered its populated indices')
    console.log(JSON.stringify({ elasticsearch: health.status, indices }, null, 2))
    checkpoint('original-search-verified')
    probe = `mx-insight-hub-recovery-${randomBytes(4).toString('hex')}`
    const publicTemplate = hub.find(d => d.metadata.name === 'mx-insight-hub-public').spec.template.spec
    const app = publicTemplate.containers[0]
    kube(['create', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: probe, namespace: 'mx-insight-hub' }, spec: {
      restartPolicy: 'Never', nodeName: node.metadata.name, hostNetwork: true, dnsPolicy: 'ClusterFirstWithHostNet',
      automountServiceAccountToken: false, tolerations: publicTemplate.tolerations,
      securityContext: publicTemplate.securityContext,
      containers: [{ name: 'check', image: app.image, imagePullPolicy: 'Never', command: ['node', '--input-type=module', '-e', PROBE_CODE],
        env: app.env, envFrom: app.envFrom, securityContext: app.securityContext,
        resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '1', memory: '256Mi' } } }],
    } }))
    await until(() => ['Succeeded', 'Failed'].includes(get('mx-insight-hub', `pod ${probe}`).status.phase), 'Hub image/schema/authentication probe', 120)
    const probeResult = JSON.parse(kube(['-n', 'mx-insight-hub', 'logs', probe]))
    console.log(JSON.stringify(probeResult))
    if (!probeResult.schemaCompatible || !probeResult.productDatabaseAuthentication) throw new Error('Deployed Hub image cannot safely serve this schema; API remains stopped')
    for (const name of ['mx-insight-hub-public', 'mx-insight-hub-admin']) {
      kube(['-n', 'mx-insight-hub', 'scale', `deployment/${name}`, '--replicas=1'])
      await until(() => {
        const value = get('mx-insight-hub', `deployment ${name}`)
        return value.status.observedGeneration >= value.metadata.generation && value.status.availableReplicas === 1
      }, `${name} readiness`, 240)
    }
    const adminToken = Buffer.from(secret.data.MX_INSIGHT_ADMIN_TOKEN || '', 'base64').toString()
    const response = await fetch('http://127.0.0.1:18151/internal/v1/admin/dashboard', {
      headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error('Restored Admin dashboard could not be authenticated')
    const dashboard = (await response.json()).data
    if (dashboard.tenants !== summary.tenants || dashboard.consumers !== summary.consumers) throw new Error('Admin dashboard does not show the verified original database')
    console.log(JSON.stringify({ restoredDashboard: { tenants: dashboard.tenants, consumers: dashboard.consumers, activeApiKeys: dashboard.activeApiKeys } }))
    checkpoint('data-and-api-restored-workers-paused')
    console.log('Hub data and APIs restored. Ingest/projector/classifier/retrieval remain at 0 for verification; no full rebuild or vectorization was started. Launcher/MX-H2I resources were not changed.')
  } finally {
    if (probe) {
      try { kube(['-n', 'mx-insight-hub', 'delete', 'pod', probe, '--ignore-not-found', '--wait=true', '--timeout=30s'], undefined, 45_000) }
      catch { console.error('Inspection Pod cleanup failed; inspect its status before resuming.') }
    }
  }
}

export async function recover(reportPath, resumeDirectory) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Run on the Internal Linux host as root')
  process.umask(0o077)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const identifier = validateReport(report)
  const root = realpathSync(report.source)
  if (root !== RETAINED_ROOT) throw new Error('Retained root resolves to an unexpected path')
  const pgdata = join(root, 'postgres/data/pgdata')
  validateLayout(pgdata)
  if (command('find', [pgdata, '-type', 'l', '-print', '-quit'])) throw new Error('Symlinked PostgreSQL data requires separate recovery')
  const nodes = get('', 'nodes').items
  const localIps = Object.values(networkInterfaces()).flat().filter(Boolean).map(item => item.address)
  if (nodes.length !== 1 || !nodes[0].status.addresses.some(a => a.address === hostname() || localIps.includes(a.address))) throw new Error('kubectl is not targeting this same single-node host')
  if (command('docker', ['info', '--format', '{{.Name}}']) !== hostname()) throw new Error('Docker is not local to this host')
  const node = nodes[0]
  const label = node.metadata.labels['kubernetes.io/hostname']
  if (!label || statSync(root).dev !== statSync('/data').dev || statSync(root).dev === statSync('/').dev) throw new Error('Original /data filesystem or node label is missing')
  const availableKiB = Number(command('df', ['-Pk', root]).split('\n').at(-1).trim().split(/\s+/)[3])
  if (!(availableKiB > 10 * 1024 * 1024)) throw new Error('Less than 10 GiB free on /data; stop before recovery')
  const hub = get('mx-insight-hub', 'deployments').items
  if (hub.length !== HUB_DEPLOYMENTS.length || hub.some(d => !HUB_DEPLOYMENTS.includes(d.metadata.name))) throw new Error('Unexpected Hub deployments; stop and inventory writers')
  if (get('mx-insight-hub', 'hpa').items.length || get('mx-insight-hub', 'cronjobs').items.length
      || get('mx-insight-hub', 'jobs').items.some(job => job.status.active > 0)) throw new Error('Hub has autoscaling, scheduled or active jobs; stop and reconcile them first')
  const pvs = get('', 'pv').items
  const claims = get('mx-common', 'pvc').items
  const replacements = replacementVolumes(pvs, claims, root, label)
  for (const [, , suffix] of VOLUMES) {
    const path = join(root, suffix)
    if (!statSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('A retained data/snapshot directory is missing or redirected by a symlink')
  }
  const esData = join(root, 'elasticsearch/data')
  if (!existsSync(join(esData, '_state')) && !existsSync(join(esData, 'nodes/0/_state'))) throw new Error('Retained Elasticsearch metadata is missing')
  unusedRoot(root, pvs, get('', 'pods -A').items)
  const secret = get('mx-insight-hub', 'secret mx-insight-hub-secrets')
  const productSecret = get('mx-common', 'secret mx-common-db-mx-insight-hub')
  const password = databaseCredential(secret, productSecret)
  const pepper = Buffer.from(secret.data.MX_INSIGHT_API_KEY_PEPPER || '', 'base64').toString()
  if (pepper.length < 32 || !secret.data.MX_INSIGHT_ADMIN_TOKEN) throw new Error('Current Hub Pepper or Admin Token is missing; values withheld')
  const postgres = get('mx-common', 'statefulset mx-common-postgres')
  const elasticsearch = get('mx-common', 'statefulset mx-common-elasticsearch')
  const pgImage = postgres.spec.template.spec.containers.find(c => c.name === 'postgres').image
  if (!elasticsearch.spec.template.spec.containers.find(c => c.name === 'elasticsearch').image.endsWith(':9.4.2')) throw new Error('Unexpected Elasticsearch version; compatibility review required')
  const imageId = command('docker', ['image', 'inspect', pgImage, '--format', '{{.Id}}'])
  const control = command('docker', ['run', '--rm', '--entrypoint=pg_controldata', ...containerIsolation(imageId,
    [`type=bind,source=${pgdata},target=/retained,readonly`]), '/retained'])
  if (!control.split('\n').some(line => /^Database system identifier:\s+/.test(line) && line.endsWith(identifier))
      || !/^Database cluster state:\s+shut down$/m.test(control)) throw new Error('Original PostgreSQL identity or clean shutdown no longer matches')

  let saved, previousState, resumeRoot
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  if (resumeDirectory) {
    resumeRoot = resolve(resumeDirectory)
    if (realpathSync(resumeRoot) !== resumeRoot || !/^\/data\/\.mx-hub-recovery-[a-zA-Z0-9]+$/.test(resumeRoot)
        || statSync(resumeRoot).uid !== 0 || (statSync(resumeRoot).mode & 0o077) !== 0) {
      throw new Error('Resume requires the original root-private recovery directory on /data')
    }
    const read = file => JSON.parse(readFileSync(join(resumeRoot, file), 'utf8'))
    previousState = read('state.json')
    validateResumeState(previousState, identifier)
    saved = { pvs: read('volumes.json'), common: read('mx-common.json'), hub: read('mx-insight-hub.json') }
    if (!isDeepStrictEqual(read('inspection.json'), report)) throw new Error('Resume inspection report changed')
    validateResumeResources(saved, { hub, storage: [postgres, elasticsearch], pvs, claims, secret, productSecret })
    if (nonterminal(get('mx-insight-hub', 'pods').items).length
        || get('mx-common', 'pods').items.some(p => /^(mx-common-postgres|mx-common-elasticsearch)-\d+$/.test(p.metadata.name))) {
      throw new Error('Resume refused: Hub or database Pods still exist')
    }
    unusedRoot(DEFAULT_ROOT, pvs, get('', 'pods -A').items)
    for (const [source, copy] of [[root, 'retained-before-recovery'], [DEFAULT_ROOT, 'default-before-recovery']]) {
      const copyRoot = join(resumeRoot, copy)
      for (const [, , suffix] of VOLUMES) {
        const path = join(copyRoot, suffix)
        if (!statSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('Recovery copy is missing or redirected')
      }
      validateLayout(join(copyRoot, 'postgres/data/pgdata'))
      const suffix = 'postgres/data/pgdata/global/pg_control'
      if (hash(join(source, suffix)) !== hash(join(copyRoot, suffix))) throw new Error('Database control changed since backup; resume refused')
      unusedRoot(copyRoot, pvs, get('', 'pods -A').items)
    }
  }

  const runtime = join(dirname(fileURLToPath(import.meta.url)), '../.runtime')
  mkdirSync(runtime, { recursive: true })
  const lock = join(runtime, 'internal-production-deploy.lock')
  try { mkdirSync(lock, { mode: 0o700 }) } catch { throw new Error('Deploy/recovery lock exists; inspect it before retrying') }
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
  const backup = resumeRoot || mkdtempSync('/data/.mx-hub-recovery-')
  chmodSync(backup, 0o700)
  const state = previousState || { phase: 'preflight', originalRoot: root, originalSystemIdentifier: identifier,
    previousRoot: DEFAULT_ROOT, originalReplicas: Object.fromEntries(hub.map(d => [d.metadata.name, d.spec.replicas ?? 1])) }
  const checkpoint = phase => { state.phase = phase; persist(join(backup, 'state.json'), state); console.log(`Recovery stage: ${phase}`) }
  let changed = false
  console.log(`Private recovery directory: ${backup}. Do not share its files.`)
  failureDirectory = backup
  try {
    if (resumeRoot) {
      // Repeat object checks under the deploy lock; do not recopy data or start
      // the empty database just to reconstruct a completed checkpoint.
      validateResumeResources(saved, { hub: get('mx-insight-hub', 'deployments').items,
        storage: get('mx-common', 'statefulsets').items, pvs: get('', 'pv').items,
        claims: get('mx-common', 'pvc').items, secret: get('mx-insight-hub', 'secret mx-insight-hub-secrets'),
        productSecret: get('mx-common', 'secret mx-common-db-mx-insight-hub') })
      changed = true
      console.log('Verified stopped workloads, unchanged original bindings/credentials and preserved database copies; continuing before volume replacement.')
    } else {
      for (const namespace of ['mx-common', 'mx-insight-hub']) {
        persist(join(backup, `${namespace}.json`), get(namespace, 'deployments,statefulsets,services,configmaps,secrets,pvc,jobs,networkpolicies'))
      }
      persist(join(backup, 'volumes.json'), pvs.filter(pv => VOLUMES.some(([name]) => name === pv.metadata.name)))
      persist(join(backup, 'inspection.json'), report)
      changed = true
      await stopHub()
      const otherDatabases = JSON.parse(psql(`SELECT coalesce(json_agg(datname), '[]'::json) FROM pg_database
        WHERE NOT datistemplate AND datname NOT IN ('postgres','mx_common','mx_insight_hub');`, 'mx_common'))
      if (otherDatabases.length) throw new Error('The current shared instance contains another product database; cross-product recovery review required')
      const current = JSON.parse(psql(`BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; ${hasDataSQL} COMMIT;`))
      if (current.records || current.requests) throw new Error('Current default-path database now has business data; preserve and reconcile both databases before switching')
      const currentIndices = JSON.parse(kube(['-n', 'mx-common', 'exec', 'statefulset/mx-common-elasticsearch', '-c', 'elasticsearch', '--',
        'curl', '-fsS', '--max-time', '10', 'http://127.0.0.1:9200/_cat/indices?format=json&h=index']))
      if (currentIndices.some(index => !index.index.startsWith('mx-insight-hub-') && !index.index.startsWith('.'))) {
        throw new Error('The current Elasticsearch contains another product index; cross-product recovery review required')
      }
      checkpoint('hub-stopped-current-db-empty')
      for (const name of ['mx-common-postgres', 'mx-common-elasticsearch']) kube(['-n', 'mx-common', 'scale', `statefulset/${name}`, '--replicas=0'])
      await until(() => !get('mx-common', 'pods').items.some(p => /^(mx-common-postgres|mx-common-elasticsearch)-\d+$/.test(p.metadata.name)), 'shared database Pods did not stop')
      unusedRoot(root, get('', 'pv').items, get('', 'pods -A').items)
      unusedRoot(DEFAULT_ROOT, get('', 'pv').items, get('', 'pods -A').items)
      const originalCopy = join(backup, 'retained-before-recovery')
      const freshCopy = join(backup, 'default-before-recovery')
      mkdirSync(originalCopy, { mode: 0o700 }); mkdirSync(freshCopy, { mode: 0o700 })
      for (const part of ['postgres', 'elasticsearch']) {
        // Old volumes use same-filesystem reflink exclusively. Source bytes and
        // both copies survive all subsequent credential/PV changes.
        command('cp', ['-a', '--reflink=always', '--', join(root, part), join(originalCopy, part)], undefined, 600_000)
        command('cp', ['-a', '--reflink=auto', '--', join(DEFAULT_ROOT, part), join(freshCopy, part)], undefined, 600_000)
      }
      if (hash(join(pgdata, 'global/pg_control')) !== hash(join(originalCopy, 'postgres/data/pgdata/global/pg_control'))) throw new Error('Original control file changed during backup')
      checkpoint('both-storage-copies-preserved')
    }
    if (nonterminal(get('mx-insight-hub', 'pods').items).length
        || get('mx-common', 'pods').items.some(p => /^(mx-common-postgres|mx-common-elasticsearch)-\d+$/.test(p.metadata.name))) {
      throw new Error('A writer restarted during backup; no bindings will be changed')
    }
    for (const [pvName, claimName] of VOLUMES) {
      if (get('', `pv ${pvName}`).metadata.uid !== pvs.find(p => p.metadata.name === pvName).metadata.uid
          || get('mx-common', `pvc ${claimName}`).metadata.uid !== claims.find(p => p.metadata.name === claimName).metadata.uid) {
        throw new Error('Storage bindings changed during backup; stop concurrent deployment before proceeding')
      }
    }
    checkpoint('storage-bindings-verified')
    patch('mx-common', 'statefulset', 'mx-common-postgres', { spec: { template: { spec: {
      containers: [{ name: 'postgres', command: postgresGuard(identifier) }],
    } } } })
    checkpoint('postgres-startup-guard-installed')
    patch('mx-common', 'statefulset', 'mx-common-elasticsearch', { spec: { template: { spec: {
      initContainers: [{ name: 'verify-retained-data', image: pgImage, imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-ec', 'test -d /retained/_state || test -d /retained/nodes/0/_state'],
        securityContext: { runAsUser: 1000, runAsGroup: 0, runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '100m', memory: '64Mi' } },
        volumeMounts: [{ name: 'data', mountPath: '/retained', readOnly: true }] }],
    } } } })
    checkpoint('storage-startup-guards-installed')
    // Delete only these three Retain bindings. Never delete/overwrite a host
    // directory, Secret, namespace or a Launcher resource.
    for (const [pv, pvc] of replacements) {
      checkpoint(`replacing-binding-${pv.metadata.name}`)
      kube(['-n', 'mx-common', 'delete', 'pvc', pvc.metadata.name, '--wait=true', '--timeout=120s'], undefined, 140_000)
      kube(['delete', 'pv', pv.metadata.name, '--wait=true', '--timeout=120s'], undefined, 140_000)
      kube(['create', '-f', '-'], JSON.stringify(pv))
      kube(['create', '-f', '-'], JSON.stringify(pvc))
    }
    checkpoint('retained-volumes-bound')
    kube(['-n', 'mx-common', 'scale', 'statefulset/mx-common-postgres', '--replicas=1'])
    await until(() => {
      const value = get('mx-common', 'statefulset mx-common-postgres')
      return value.status.observedGeneration >= value.metadata.generation && value.status.readyReplicas === 1
    }, 'original PostgreSQL readiness', 300)
    const summary = await verifyOriginalDatabase(identifier, report, pepper)
    // Current Kubernetes credentials may have been regenerated with the empty
    // cluster. Keep those Secrets stable and align only the Hub product role.
    // Password is stdin-only and child output is always withheld on error.
    psql(`SET log_statement='none'; SET log_min_error_statement='panic';
      ALTER ROLE mx_insight_hub WITH LOGIN PASSWORD '${password}';
      UPDATE control.search_settings SET startup_rebuild=false, updated_by='retained-data-recovery', updated_at=now() WHERE startup_rebuild=true;`)
    checkpoint('original-database-verified-hub-password-aligned')
    kube(['-n', 'mx-common', 'scale', 'statefulset/mx-common-elasticsearch', '--replicas=1'])
    await restoreSearchAndApis({ hub, node, secret, summary, checkpoint })
  } catch (error) {
    if (changed) {
      try { await stopHub() } catch { console.error('Could not confirm all Hub writers stopped; check Hub Pod status immediately.') }
    }
    console.error(`Recovery stopped at ${state.phase}. No automatic rollback. Originals and backups remain at their recorded paths.`)
    throw error
  } finally {
    failureDirectory = undefined
    if (readFileSync(join(lock, 'pid'), 'utf8') === String(process.pid)) { unlinkSync(join(lock, 'pid')); rmdirSync(lock) }
    console.log(`Recovery record: ${backup}/state.json (private; do not paste Secret backups).`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if ((args.length === 1 && args[0] !== '--help' && !args[0].startsWith('--'))
      || (args.length === 2 && ['--resume-before-rebind', '--resume-after-database'].includes(args[0]))) {
    try {
      if (args[0] === '--resume-after-database') await continueAfterDatabase(args[1])
      else {
        const resume = args[0] === '--resume-before-rebind' ? resolve(args[1]) : undefined
        await recover(resume ? join(resume, 'inspection.json') : args[0], resume)
      }
    } catch (error) {
      console.error(error.constructor === Error && !error.code ? error.message : 'Recovery stopped during validation; private details withheld')
      process.exitCode = 1
    }
  } else {
    console.log('Usage: node scripts/recover-retained-storage.mjs /data/.mx-hub-inspect-XXXXXX/report.json')
    console.log('Resume only BEFORE bindings change: node scripts/recover-retained-storage.mjs --resume-before-rebind /data/.mx-hub-recovery-XXXXXX')
    console.log('Continue AFTER database verification: node scripts/recover-retained-storage.mjs --resume-after-database /data/.mx-hub-recovery-XXXXXX')
    console.log('Explicit production recovery: stop Hub, preserve both data directories, rebind three Retain volumes, verify old data/credentials, restore APIs. Background workers remain paused.')
    if (!(args.length === 1 && args[0] === '--help')) process.exitCode = 2
  }
}
