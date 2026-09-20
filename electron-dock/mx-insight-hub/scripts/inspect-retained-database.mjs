#!/usr/bin/env node
// Incident inspection only: never rebind volumes or start Hub processes.
import {
  chmodSync, chownSync, existsSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { hostname, networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { openApiKey } from '../server/core/key-vault.mjs'

export function pepperEvidence(samples, pepper) {
  let matched = 0
  for (const sample of samples) {
    try {
      // Neither decrypted secrets nor envelopes belong in the report.
      const secret = openApiKey(sample.envelope, sample.id, pepper)
      const digest = createHmac('sha256', pepper).update(secret).digest('hex')
      if (digest === sample.digest) matched++
    } catch { /* A failed authentication is evidence, not a printable error. */ }
  }
  return {
    verdict: !samples.length ? 'UNVERIFIED_NO_VAULT_SAMPLES'
      : matched === samples.length ? 'MATCHED_SAMPLES'
        : matched ? 'MIXED_SAMPLES' : 'NO_MATCH_OR_DAMAGED_SAMPLES',
    sampled: samples.length, matched,
  }
}

export function overlap(a, b) {
  return a === '/' || b === '/' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

export function validateLayout(pgdata) {
  if (readFileSync(join(pgdata, 'PG_VERSION'), 'utf8').trim() !== '16') {
    throw new Error('Only an existing PostgreSQL 16 directory is supported')
  }
  if (!statSync(join(pgdata, 'base')).isDirectory()
      || !statSync(join(pgdata, 'global/pg_control')).isFile()
      || statSync(join(pgdata, 'global/pg_control')).size === 0) {
    throw new Error('Existing PostgreSQL base/control files are missing')
  }
  for (const name of ['standby.signal', 'recovery.signal', 'backup_label']) {
    if (existsSync(join(pgdata, name))) throw new Error(`Source has ${name}; separate recovery review required`)
  }
}

function run(command, args, input, timeout = 30_000) {
  try {
    return execFileSync(command, args, {
      input, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
    }).trim()
  } catch {
    // Child output may contain configuration values. Do not include it.
    throw new Error(`${command} operation failed; child output withheld`)
  }
}

function kube(args) { return run('kubectl', ['--request-timeout=15s', ...args]) }
function json(text) { return JSON.parse(text) }
function canonical(path) { return realpathSync(path) }
function controlHash(pgdata) {
  return createHash('sha256').update(readFileSync(join(pgdata, 'global/pg_control'))).digest('hex')
}

function requireUnusedSource(pgdata) {
  const sourceStat = statSync(pgdata)
  for (const entry of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      if (readFileSync(`/proc/${entry}/comm`, 'utf8').trim() !== 'postgres') continue
      const cwd = statSync(`/proc/${entry}/cwd`)
      if (cwd.dev === sourceStat.dev && cwd.ino === sourceStat.ino) {
        throw new Error('A PostgreSQL process is using the retained directory; refusing a live file copy')
      }
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue
      throw error
    }
  }
  const volumes = json(kube(['get', 'pv', '-o', 'json'])).items
  const pods = json(kube(['get', 'pods', '-A', '-o', 'json'])).items
  const claims = new Map(volumes.filter(pv => pv.spec.hostPath && pv.spec.claimRef).map(pv => [
    `${pv.spec.claimRef.namespace}/${pv.spec.claimRef.name}`, pv.spec.hostPath.path,
  ]))
  for (const pod of pods.filter(pod => !['Succeeded', 'Failed'].includes(pod.status.phase))) {
    for (const volume of pod.spec.volumes || []) {
      const path = volume.hostPath?.path || claims.get(`${pod.metadata.namespace}/${volume.persistentVolumeClaim?.claimName}`)
      if (path && existsSync(path) && overlap(canonical(path), pgdata)) {
        throw new Error('A non-terminal Kubernetes Pod references the retained directory; inspection stopped')
      }
    }
  }
  const containers = run('docker', ['ps', '-q']).split(/\s+/).filter(Boolean)
  if (containers.length) {
    for (const container of json(run('docker', ['inspect', ...containers]))) {
      for (const mount of container.Mounts || []) {
        if (mount.RW && mount.Source && existsSync(mount.Source) && overlap(canonical(mount.Source), pgdata)) {
          throw new Error('A running Docker container can write the retained directory; inspection stopped')
        }
      }
    }
  }
}

export function containerIsolation(image, mounts) {
  return ['--pull=never', '--network=none', '--read-only', '--user=999:999',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--cpus=1',
    '--memory=1g', '--memory-swap=1g', '--pids-limit=128',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=64m,mode=1777',
    ...mounts.flatMap(mount => ['--mount', mount]), image]
}

export async function inspect(rootArgument, parentArgument = '/data') {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Run on the Internal Linux host as root')
  process.umask(0o077)
  const root = canonical(rootArgument)
  if (!root.endsWith('/mx-common/k8s') || root === '/var/lib/mx-common/k8s') {
    throw new Error('Expected the retained mx-common/k8s root, not the current default root')
  }
  const pgdata = canonical(join(root, 'postgres/data/pgdata'))
  if (!pgdata.startsWith(`${root}/`)) throw new Error('PGDATA escapes the retained root')
  validateLayout(pgdata)
  // Symlinked WAL or tablespaces must not escape the isolated copy.
  if (run('find', [pgdata, '-type', 'l', '-print', '-quit'])) throw new Error('Source contains symlinks; separate tablespace/WAL review required')
  const nodes = json(kube(['get', 'nodes', '-o', 'json'])).items
  const localAddresses = Object.values(networkInterfaces()).flat().filter(Boolean).map(item => item.address)
  if (nodes.length !== 1 || !nodes[0].status.addresses.some(address =>
    address.address === hostname() || localAddresses.includes(address.address))) {
    throw new Error('kubectl must target this same single-node Internal host')
  }
  if (run('docker', ['info', '--format', '{{.Name}}']) !== hostname()) {
    throw new Error('Docker daemon must run on this same host')
  }
  const parent = canonical(parentArgument)
  if ([parent, pgdata].some(path => /[,\r\n]/.test(path))) throw new Error('Paths with commas or line breaks are unsupported')
  if (overlap(parent, pgdata) && parent.startsWith(pgdata)) throw new Error('Inspection parent must be outside PGDATA')
  if (statSync(parent).dev !== statSync(pgdata).dev) throw new Error('Inspection copy must be on the same filesystem for reflink')
  const freeKiB = Number(run('df', ['-Pk', parent]).split('\n').at(-1).trim().split(/\s+/)[3])
  if (!Number.isFinite(freeKiB) || freeKiB < 2 * 1024 * 1024) throw new Error('At least 2 GiB free space is required for clone recovery')
  const availableKiB = Number(readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m)?.[1])
  if (!Number.isFinite(availableKiB) || availableKiB < 2 * 1024 * 1024) throw new Error('At least 2 GiB available host memory is required for the bounded inspection container')
  requireUnusedSource(pgdata)
  const secret = json(kube(['-n', 'mx-insight-hub', 'get', 'secret', 'mx-insight-hub-secrets', '-o', 'json']))
  const pepper = Buffer.from(secret.data?.MX_INSIGHT_API_KEY_PEPPER || '', 'base64').toString('utf8')
  if (pepper.length < 32) throw new Error('Current Hub Secret has no usable Pepper; no values printed')
  const imageTag = kube(['-n', 'mx-common', 'get', 'statefulset', 'mx-common-postgres', '-o', 'jsonpath={.spec.template.spec.containers[0].image}'])
  const image = run('docker', ['image', 'inspect', imageTag, '--format', '{{.Id}}'])
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Existing PostgreSQL image ID unavailable; no image will be pulled')

  const work = mkdtempSync(join(parent, '.mx-hub-inspect-'))
  chmodSync(work, 0o700)
  const clone = join(work, 'pgdata')
  const name = `mx-hub-inspect-${randomBytes(6).toString('hex')}`
  let launched = false
  const before = controlHash(pgdata)
  console.log(`Inspection directory: ${work} (private; contains a database copy)`)
  console.log('Creating a reflink copy; no fallback to a full 31 GB copy, no writes to the retained directory.')
  const cleanup = () => {
    if (!launched) return
    try { run('docker', ['stop', '--time=30', name], undefined, 40_000) } catch { /* Removal below also stops only our container. */ }
    try { run('docker', ['rm', '-f', name]); launched = false } catch {
      process.exitCode = 1
      console.error(`Could not remove inspection container ${name}; stop it explicitly. Production workloads were not changed.`)
    }
  }
  const interrupted = () => { cleanup(); process.exit(130) }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    try { run('cp', ['-a', '--reflink=always', '--', pgdata, clone], undefined, 300_000) } catch {
      throw new Error('Reflink copy failed; source unchanged, no full-copy fallback. Check filesystem reflink support and space before proceeding')
    }
    requireUnusedSource(pgdata)
    if (before !== controlHash(pgdata) || before !== controlHash(clone)) throw new Error('Control file changed while copying; clone will not start')
    const cloneMount = `type=bind,source=${clone},target=/inspection/pgdata`
    const control = run('docker', ['run', '--rm', '--entrypoint=pg_controldata',
      ...containerIsolation(image, [`${cloneMount},readonly`]), '/inspection/pgdata'])
    const controlSummary = control.split('\n').filter(line => /^(Database system identifier|Database cluster state|Time of latest checkpoint):/.test(line))
    console.log(controlSummary.join('\n'))
    // Only files within our newly created copy are changed.
    if (existsSync(join(clone, 'postmaster.pid'))) unlinkSync(join(clone, 'postmaster.pid'))
    if (existsSync(join(clone, 'postgresql.auto.conf'))) renameSync(join(clone, 'postgresql.auto.conf'), join(work, 'original-postgresql.auto.conf'))
    const config = join(work, 'postgresql.conf')
    const hba = join(work, 'pg_hba.conf')
    writeFileSync(config, "listen_addresses = ''\nunix_socket_directories = '/tmp'\nshared_buffers = '64MB'\nmax_connections = 20\nmax_worker_processes = 0\nmax_parallel_workers = 0\nautovacuum = off\narchive_mode = off\nshared_preload_libraries = ''\ndefault_transaction_read_only = on\nlog_statement = 'none'\nlog_min_error_statement = 'panic'\n")
    writeFileSync(hba, 'local all all trust\n')
    for (const file of [config, hba]) { chmodSync(file, 0o600); chownSync(file, 999, 999) }
    launched = true // Also clean up if docker created the container but run failed.
    run('docker', ['run', '--detach', '--name', name, '--entrypoint=postgres',
      ...containerIsolation(image, [cloneMount,
        `type=bind,source=${config},target=/inspection/postgresql.conf,readonly`,
        `type=bind,source=${hba},target=/inspection/pg_hba.conf,readonly`]),
      '-D', '/inspection/pgdata', '-c', 'config_file=/inspection/postgresql.conf',
      '-c', 'hba_file=/inspection/pg_hba.conf'])
    const query = sql => run('docker', ['exec', '-i', name, 'psql', '-X', '-w', '-qAt',
      '-h', '/tmp', '-U', 'mx_common', '-d', 'mx_insight_hub', '-v', 'ON_ERROR_STOP=1'],
    `BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; ${sql}; COMMIT;`, 20_000)
    let ready = false
    for (let i = 0; i < 120; i++) {
      try { if (query('SELECT 1') === '1') { ready = true; break } } catch { /* Recovery may still be running. */ }
      if (run('docker', ['inspect', '--format', '{{.State.Running}}', name]) !== 'true') break
      await sleep(1000)
    }
    if (!ready) throw new Error('Isolated clone did not become queryable; original data was not started or modified')
    const summary = json(query(`SELECT json_build_object(
      'databaseBytes', pg_database_size(current_database()),
      'tenants', (SELECT count(*) FROM public.tenants),
      'consumers', (SELECT count(*) FROM public.consumers),
      'allApiKeys', (SELECT count(*) FROM public.api_keys),
      'hasStoredRecords', EXISTS(SELECT 1 FROM core.canonical_records),
      'hasRequestHistory', EXISTS(SELECT 1 FROM public.usage_requests),
      'latestRequestAt', (SELECT created_at FROM public.usage_requests ORDER BY created_at DESC LIMIT 1),
      'canonicalPlannerEstimate', (SELECT reltuples::bigint FROM pg_class WHERE oid='core.canonical_records'::regclass)
    )`))
    let samples = []
    if (query("SELECT to_regclass('public.api_key_vault') IS NOT NULL") === 't') {
      samples = json(query(`SELECT coalesce(json_agg(s), '[]'::json) FROM (
        SELECT v.api_key_id AS id, v.envelope, k.key_digest AS digest
        FROM public.api_key_vault v JOIN public.api_keys k ON k.id=v.api_key_id
        ORDER BY v.created_at DESC LIMIT 10
      ) s`))
    }
    if (before !== controlHash(pgdata)) throw new Error('Original control file changed during inspection; another writer may have started. Do not use this clone for recovery')
    const report = { source: root, control: controlSummary, database: summary,
      pepper: { source: 'current Kubernetes mx-insight-hub-secrets', ...pepperEvidence(samples, pepper) },
      originalControlFileUnchanged: before === controlHash(pgdata),
      limitations: 'Bounded record/key evidence only; not a full integrity check, independent backup or completed recovery.' }
    writeFileSync(join(work, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify(report, null, 2))
    console.log('Inspection complete. No PV, PVC, Secret, production workload or source data was changed.')
  } finally {
    if (launched) {
      try {
        const log = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 })
        writeFileSync(join(work, 'postgres-private.log'), `${log.stdout || ''}${log.stderr || ''}`, { mode: 0o600 })
      } catch { /* Diagnostic file only. */ }
    }
    cleanup()
    process.removeListener('SIGINT', interrupted)
    process.removeListener('SIGTERM', interrupted)
    console.log(`Private clone retained at ${work}; do not share this directory or its configuration/log files.`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, parent, ...extra] = process.argv.slice(2)
  if (!root || root === '--help' || extra.length) {
    console.log('Usage: node scripts/inspect-retained-database.mjs <retained-mx-common/k8s> [inspection-parent=/data]')
    console.log('Linux root only. Clones offline PG16 using same-filesystem reflink; starts only an isolated copy; never restores production.')
    if (!root || extra.length) process.exitCode = 2
  } else {
    try { await inspect(root, parent) } catch (error) {
      // Native IO/JSON errors can include source contents; emit only controlled errors.
      console.error(error.constructor === Error && !error.code ? error.message : 'Inspection failed during local data validation; no secret values printed')
      process.exitCode = 1
    }
  }
}
