#!/usr/bin/env node
// Explicit Internal incident recovery. Does not call deploy, migrations,
// provisioning, Launcher, source connectors, or any full-data rebuild.
import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
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

function command(binary, args, input, timeout = 30_000) {
  try {
    return execFileSync(binary, args, { input, encoding: 'utf8', timeout,
      maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' } }).trim()
  } catch { throw new Error(`${binary} ${args.includes('psql') ? 'database operation' : args[0]} failed; private output withheld`) }
}
function kube(args, input, timeout) { return command('kubectl', ['--request-timeout=20s', ...args], input, timeout) }
function get(ns, kind) { return JSON.parse(kube([...(ns ? ['-n', ns] : []), 'get', ...kind.split(' '), '-o', 'json'])) }
function persist(file, value) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flush: true })
  renameSync(`${file}.tmp`, file)
}
function patch(ns, kind, name, value) { kube(['-n', ns, 'patch', kind, name, '--type=strategic', '--patch-file=/dev/stdin'], JSON.stringify(value)) }
function psql(sql, database = 'mx_insight_hub') {
  return kube(['-n', 'mx-common', 'exec', '-i', 'statefulset/mx-common-postgres', '--',
    'psql', '-X', '-w', '-qAt', '-U', 'mx_common', '-d', database, '-v', 'ON_ERROR_STOP=1'], sql, 60_000)
}
const hasDataSQL = `SELECT json_build_object('records', EXISTS(SELECT 1 FROM core.canonical_records), 'requests', EXISTS(SELECT 1 FROM public.usage_requests));`
const samplesSQL = `SELECT coalesce(json_agg(s), '[]'::json) FROM (
  SELECT v.api_key_id AS id, v.envelope, k.key_digest AS digest FROM api_key_vault v
  JOIN api_keys k ON k.id=v.api_key_id ORDER BY v.created_at DESC LIMIT 10) s;`

async function until(check, description, seconds = 180) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await check()) return
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

export async function recover(reportPath) {
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
  const password = databaseCredential(secret, get('mx-common', 'secret mx-common-db-mx-insight-hub'))
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

  const runtime = join(dirname(fileURLToPath(import.meta.url)), '../.runtime')
  mkdirSync(runtime, { recursive: true })
  const lock = join(runtime, 'internal-production-deploy.lock')
  try { mkdirSync(lock, { mode: 0o700 }) } catch { throw new Error('Deploy/recovery lock exists; inspect it before retrying') }
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
  const backup = mkdtempSync('/data/.mx-hub-recovery-')
  chmodSync(backup, 0o700)
  const state = { phase: 'preflight', originalRoot: root, originalSystemIdentifier: identifier,
    previousRoot: DEFAULT_ROOT, originalReplicas: Object.fromEntries(hub.map(d => [d.metadata.name, d.spec.replicas ?? 1])) }
  const checkpoint = phase => { state.phase = phase; persist(join(backup, 'state.json'), state); console.log(`Recovery stage: ${phase}`) }
  let changed = false
  let probe
  console.log(`Private recovery directory: ${backup}. Do not share its files.`)
  try {
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
    const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
    if (hash(join(pgdata, 'global/pg_control')) !== hash(join(originalCopy, 'postgres/data/pgdata/global/pg_control'))) throw new Error('Original control file changed during backup')
    checkpoint('both-storage-copies-preserved')
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
    patch('mx-common', 'statefulset', 'mx-common-postgres', { spec: { template: { spec: {
      containers: [{ name: 'postgres', command: postgresGuard(identifier) }],
    } } } })
    patch('mx-common', 'statefulset', 'mx-common-elasticsearch', { spec: { template: { spec: {
      initContainers: [{ name: 'verify-retained-data', image: pgImage, imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-ec', 'test -d /retained/_state || test -d /retained/nodes/0/_state'],
        securityContext: { runAsUser: 1000, runAsGroup: 0, runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '100m', memory: '64Mi' } },
        volumeMounts: [{ name: 'data', mountPath: '/retained', readOnly: true }] }],
    } } } })
    // Delete only these three Retain bindings. Never delete/overwrite a host
    // directory, Secret, namespace or a Launcher resource.
    for (const [pv, pvc] of replacements) {
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
    // Current Kubernetes credentials may have been regenerated with the empty
    // cluster. Keep those Secrets stable and align only the Hub product role.
    // Password is stdin-only and child output is always withheld on error.
    psql(`SET log_statement='none'; SET log_min_error_statement='panic';
      ALTER ROLE mx_insight_hub WITH LOGIN PASSWORD '${password}';
      UPDATE control.search_settings SET startup_rebuild=false, updated_by='retained-data-recovery', updated_at=now() WHERE startup_rebuild=true;`)
    checkpoint('original-database-verified-hub-password-aligned')
    kube(['-n', 'mx-common', 'scale', 'statefulset/mx-common-elasticsearch', '--replicas=1'])
    await until(() => {
      const value = get('mx-common', 'statefulset mx-common-elasticsearch')
      return value.status.observedGeneration >= value.metadata.generation && value.status.readyReplicas === 1
    }, 'original Elasticsearch readiness', 600)
    const es = path => JSON.parse(kube(['-n', 'mx-common', 'exec', 'statefulset/mx-common-elasticsearch', '-c', 'elasticsearch', '--', 'curl', '-fsS', '--max-time', '20', `http://127.0.0.1:9200${path}`]))
    let health
    await until(() => {
      try { health = es('/_cluster/health'); return ['yellow', 'green'].includes(health.status) } catch { return false }
    }, 'Elasticsearch shard recovery', 600)
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
  } catch (error) {
    if (probe) {
      try { kube(['-n', 'mx-insight-hub', 'delete', 'pod', probe, '--ignore-not-found', '--wait=true', '--timeout=30s'], undefined, 45_000); probe = null } catch { /* Finally retries cleanup. */ }
    }
    if (changed) {
      try { await stopHub() } catch { console.error('Could not confirm all Hub writers stopped; check Hub Pod status immediately.') }
    }
    console.error(`Recovery stopped at ${state.phase}. No automatic rollback. Originals and backups remain at their recorded paths.`)
    throw error
  } finally {
    if (probe) { try { kube(['-n', 'mx-insight-hub', 'delete', 'pod', probe, '--ignore-not-found', '--wait=true', '--timeout=30s'], undefined, 45_000) } catch { console.error('Inspection Pod cleanup failed; inspect its status.') } }
    if (readFileSync(join(lock, 'pid'), 'utf8') === String(process.pid)) { unlinkSync(join(lock, 'pid')); rmdirSync(lock) }
    console.log(`Recovery record: ${backup}/state.json (private; do not paste Secret backups).`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] === '--help') {
    console.log('Usage: node scripts/recover-retained-storage.mjs /data/.mx-hub-inspect-XXXXXX/report.json')
    console.log('Explicit production recovery: stop Hub, preserve both data directories, rebind three Retain volumes, verify old data/credentials, restore APIs. Background workers remain paused.')
    if (process.argv.length !== 3) process.exitCode = 2
  } else {
    try { await recover(process.argv[2]) } catch (error) {
      console.error(error.constructor === Error && !error.code ? error.message : 'Recovery stopped during validation; private details withheld')
      process.exitCode = 1
    }
  }
}
