#!/usr/bin/env node
// Read-only evidence collector. No full-table scans, WAL switch, cloud writes,
// restore, or printed configuration/credentials. It is NOT a restore drill.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { describeSnapshotPolicy } from '../../mx-common/src/elasticsearch/snapshots.mjs'

export const postgresEvidenceSql = `BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT json_build_object(
  'version', current_setting('server_version'),
  'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
  'databaseBytes', pg_database_size('mx_insight_hub'),
  'archiveMode', current_setting('archive_mode'),
  'archiveConfigured', (current_setting('archive_command') <> '' OR current_setting('archive_library') <> ''),
  'archivedCount', archived_count,
  'failedCount', failed_count,
  'lastArchivedAt', last_archived_time,
  'lastFailedAt', last_failed_time,
  'statisticsResetAt', stats_reset
) FROM pg_stat_archiver;
COMMIT;`

const time = value => {
  const n = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(n) && n > 0 ? n : null
}
// PostgreSQL system identifiers exceed JS's safe integer range. Keep their
// original decimal token when parsing pgBackRest JSON (Node >= 22.18).
export function parseEvidence(text) {
  return JSON.parse(text, (key, value, context) => key === 'system-id' && typeof value === 'number'
    ? context.source : value)
}
export function summarizePostgres(pg, info, { now = Date.now(), maxAgeHours = 36 } = {}) {
  const stanza = Array.isArray(info) ? info.find(s => s.name === 'mx-common') : null
  const databases = stanza?.db ?? []
  const backups = stanza?.backup?.filter(b => b.error === false && b.timestamp?.stop > 0
    && databases.some(db => String(db['system-id']) === pg?.systemIdentifier
      && db.id === b.database?.id && db['repo-key'] === b.database?.['repo-key'])) ?? []
  const latest = backups.sort((a, b) => b.timestamp.stop - a.timestamp.stop)[0]
  const stop = latest ? Number(latest.timestamp.stop) * 1000 : null
  const age = stop && stop <= now ? (now - stop) / 3_600_000 : null
  const archived = time(pg?.lastArchivedAt)
  const failed = time(pg?.lastFailedAt)
  const archivingEnabled = ['on', 'always'].includes(pg?.archiveMode) && pg?.archiveConfigured === true
  const archiveHasSuccess = archived !== null && archived <= now && !(failed && failed >= archived)
  const recentBackup = stanza?.status?.code === 0 && age !== null && age <= maxAgeHours
  return {
    reachable: !!pg,
    version: pg?.version ?? null,
    systemIdentifier: pg?.systemIdentifier ?? null,
    databaseBytes: pg?.databaseBytes ?? null,
    archivingEnabled,
    archiveHasSuccess,
    lastArchivedAt: archived && archived <= now ? new Date(archived).toISOString() : null,
    lastFailedAt: failed && failed <= now ? new Date(failed).toISOString() : null,
    recentPgBackRestBackup: recentBackup,
    latestBackup: latest ? { label: latest.label, type: latest.type, ageHours: age === null ? null : Math.round(age * 10) / 10 } : null,
    limitation: 'Matched-cluster archive stats and pgBackRest metadata do not prove an unbroken off-node WAL chain or a successful restore. Idle databases can have old archive timestamps.',
  }
}

export function summarizeSearch(policy, repository, options) {
  const health = describeSnapshotPolicy(policy, options)
  return {
    ...health,
    repositoryType: repository?.type ?? null,
    remoteRepositoryConfigured: repository?.type === 's3',
    limitation: 'SLM success is evidence only; verify repository contents and restore on an isolated cluster. Filesystem snapshots may be on the same disk.',
  }
}

export function collectEvidence({ run, now = Date.now(), maxAgeHours = 36, policyName = 'mx-common-daily' }) {
  if (!/^[a-z0-9_-]+$/.test(policyName)) throw new Error('invalid snapshot policy name')
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('invalid maximum backup age')
  const failures = []
  const read = (label, command, args) => {
    try { return parseEvidence(run(command, args)) } catch { failures.push(label); return null }
  }
  const exec = (pod, container, args) => ['--request-timeout=20s', '-n', 'mx-common', 'exec', pod, '-c', container, '--', ...args]
  const pg = read('postgres-query', 'kubectl', exec('mx-common-postgres-0', 'postgres',
    ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'mx_common', '-d', 'mx_common', '-c', postgresEvidenceSql]))
  const info = read('pgbackrest-info (not installed/configured or inaccessible)', 'kubectl', exec('mx-common-postgres-0', 'postgres',
    ['pgbackrest', '--stanza=mx-common', '--output=json', 'info']))
  const es = uri => ['curl', '-fsS', '--max-time', '10', `http://127.0.0.1:9200${uri}`]
  const policies = read('elasticsearch-slm', 'kubectl', exec('mx-common-elasticsearch-0', 'elasticsearch', es(`/_slm/policy/${policyName}`)))
  const policy = policies?.[policyName]
  const repositoryName = policy?.policy?.repository
  const repositories = repositoryName && /^[a-zA-Z0-9_-]+$/.test(repositoryName)
    ? read('elasticsearch-repository', 'kubectl', exec('mx-common-elasticsearch-0', 'elasticsearch', es(`/_snapshot/${repositoryName}`))) : null
  const postgres = summarizePostgres(pg, info, { now, maxAgeHours })
  const elasticsearch = summarizeSearch(policy, repositories?.[repositoryName], { now, staleAfterHours: maxAgeHours })
  return {
    checkedAt: new Date(now).toISOString(),
    basicBackupEvidencePresent: postgres.archivingEnabled && postgres.archiveHasSuccess && postgres.recentPgBackRestBackup && elasticsearch.healthy && elasticsearch.remoteRepositoryConfigured,
    disasterRecoveryVerified: false,
    postgres, elasticsearch, unavailableChecks: failures,
    stillRequires: ['off-node WAL chain and restore drill', 'encrypted configuration/secret escrow and decryption drill', 'new-host storage enrollment and application/ledger validation'],
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/backup-readiness.mjs\nRead-only Kubernetes evidence; exit 2 = backup evidence incomplete, 0 = basic evidence only, not proven DR.\nOptional MX_COMMON_SNAPSHOT_POLICY and MX_COMMON_SNAPSHOT_STALE_HOURS (default 36).')
  } else {
    try {
      if (process.argv.length !== 2) throw new Error('unexpected arguments')
      console.error('Reading backup metadata only; no data export or cloud operations.')
      const report = collectEvidence({
        run: (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }),
        maxAgeHours: Number(process.env.MX_COMMON_SNAPSHOT_STALE_HOURS || 36),
        policyName: process.env.MX_COMMON_SNAPSHOT_POLICY || 'mx-common-daily',
      })
      console.log(JSON.stringify(report, null, 2))
      if (!report.basicBackupEvidencePresent) process.exitCode = 2
    } catch { console.error('Backup inspection failed; configuration and subprocess output withheld.'); process.exitCode = 1 }
  }
}
