// Snapshot repository and lifecycle (SLM) definitions.
//
// What these snapshots are for, stated plainly so nobody over-trusts them:
//
// The default repository is a filesystem PVC on the SAME node that holds the
// index data. That protects against the failures people actually hit — an index
// deleted by mistake, a bad mapping change, a reindex that went wrong, segment
// corruption. It does NOT protect against losing the machine. Off-node
// durability requires an S3-compatible repository, which is why `s3Repository`
// exists below and why the fs one carries this warning in its metadata.
//
// It is also worth remembering that every MX search index is a rebuildable
// projection of PostgreSQL (ADR-0005). A snapshot here is a fast restore path,
// never the only copy. That is what makes an fs repository a reasonable default
// rather than a false sense of safety.

export const DEFAULT_REPOSITORY = 'mx-common-snapshots'

/**
 * Filesystem repository. `location` must be inside a path listed in the
 * cluster's `path.repo`, or Elasticsearch refuses to register it.
 */
export function fsRepository({ location = '/usr/share/elasticsearch/snapshots' } = {}) {
  return {
    type: 'fs',
    settings: {
      location,
      compress: true,
      // Bound restore/snapshot bandwidth so a large restore cannot starve
      // live indexing on a single shared node.
      max_snapshot_bytes_per_sec: '80mb',
      max_restore_bytes_per_sec: '80mb',
    },
  }
}

/** Named S3 client; credentials belong in the Elasticsearch keystore. */
export function s3ClientSettings({ client = 'mx_backup', endpoint, region, pathStyleAccess = false } = {}) {
  if (!/^[a-z][a-z0-9_]*$/.test(client)) throw new Error('invalid S3 client name')
  let url
  try { url = new URL(endpoint) } catch { throw new Error('S3 endpoint must be a complete HTTP(S) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') throw new Error('invalid S3 endpoint; credentials and paths are not allowed')
  if (!/^[a-z0-9-]+$/.test(region ?? '')) throw new Error('explicit S3 signing region is required')
  if (typeof pathStyleAccess !== 'boolean') throw new Error('S3 path style must be a boolean')
  if (/(^|\.)aliyuncs\.com$/.test(url.hostname) && (pathStyleAccess || url.protocol !== 'https:')) {
    throw new Error('Alibaba OSS requires HTTPS and virtual-hosted access (path style false)')
  }
  return {
    [`s3.client.${client}.endpoint`]: url.origin,
    [`s3.client.${client}.region`]: region,
    [`s3.client.${client}.path_style_access`]: pathStyleAccess,
  }
}

/** S3 repository API settings; endpoint/region are CLIENT settings in ES 9. */
export function s3Repository({ bucket, basePath = 'mx-common/elasticsearch', client = 'mx_backup', readonly = false } = {}) {
  if (!bucket) throw new Error('an S3 repository requires a bucket')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('invalid S3 bucket')
  if (!/^[a-z][a-z0-9_]*$/.test(client)) throw new Error('invalid S3 client name')
  if (!/^[a-zA-Z0-9_/-]+$/.test(basePath) || basePath.startsWith('/') || basePath.endsWith('/') || basePath.includes('//')) {
    throw new Error('S3 base path must be an explicit non-root prefix')
  }
  if (typeof readonly !== 'boolean') throw new Error('S3 readonly must be a boolean')
  return {
    type: 's3',
    settings: {
      bucket, base_path: basePath, client, readonly, compress: true,
      max_snapshot_bytes_per_sec: '40mb', max_restore_bytes_per_sec: '80mb',
    },
  }
}

/**
 * Daily snapshot policy.
 *
 * Retention here expires SNAPSHOTS, which is unrelated to the ILM policy's
 * refusal to delete INDICES. Keeping every snapshot forever fills the
 * repository and eventually stops new snapshots from being taken — the failure
 * mode where you discover the backup broke months ago. Expiring old snapshots
 * removes nothing from the live cluster.
 *
 * `min_count` is the safety net: retention never drops below it even if every
 * snapshot is older than `expireAfter`, so a cluster that sat idle past the
 * expiry window is not left with zero restore points.
 */
export function dailySnapshotPolicy({
  repository = DEFAULT_REPOSITORY,
  // 01:30 daily. ES cron has a seconds field.
  schedule = '0 30 1 * * ?',
  indices = ['mx-*'],
  expireAfter = '30d',
  minCount = 7,
  maxCount = 60,
} = {}) {
  return {
    name: '<mx-common-daily-{now/d}>',
    schedule,
    repository,
    config: {
      indices,
      // Snapshots are incremental at the segment level, so a daily full-index
      // snapshot costs roughly the segments that changed since yesterday.
      ignore_unavailable: false,
      // `partial: false` makes an unavailable shard fail the snapshot loudly.
      // A partial snapshot that reports success is worse than no snapshot,
      // because it will be trusted at restore time.
      partial: false,
      // Cluster state (index templates, ILM policies, SLM policies themselves)
      // is deliberately excluded: mx-common reconciles all of it from code on
      // every deploy, so capturing it here would add a second, staler source of
      // truth and make restoring into another cluster clobber its settings.
      include_global_state: false,
    },
    retention: {
      expire_after: expireAfter,
      min_count: minCount,
      max_count: maxCount,
    },
  }
}

/**
 * Reconcile repository and policies. Idempotent; safe on every deploy.
 *
 * Returns a report rather than throwing on a policy failure, for the same
 * reason index reconcile does: backup configuration is important but must not
 * be able to fail a deploy of a service that is otherwise healthy.
 */
export async function ensureSnapshots(client, {
  repositoryName = DEFAULT_REPOSITORY,
  repository = fsRepository(),
  policies = { 'mx-common-daily': dailySnapshotPolicy({ repository: repositoryName }) },
  logger = console,
} = {}) {
  const report = { repository: null, policies: {}, error: null }
  try {
    await client.putSnapshotRepository(repositoryName, repository)
    report.repository = repositoryName
    for (const [name, policy] of Object.entries(policies)) {
      await client.request('PUT', `/_slm/policy/${encodeURIComponent(name)}`, policy)
      report.policies[name] = policy.schedule
    }
    logger?.log?.(
      `[mx-common] snapshot policy ready: ${Object.keys(policies).join(', ')} -> ${repositoryName}`,
    )
  } catch (error) {
    report.error = error.message
    logger?.warn?.(`[mx-common] snapshot reconcile failed: ${error.message}`)
  }
  return report
}

/** Trigger a policy immediately; used by the deploy smoke and by operators. */
export function executePolicy(client, name) {
  return client.request('POST', `/_slm/policy/${encodeURIComponent(name)}/_execute`)
}

/**
 * Backup health, in the terms an operator actually needs.
 *
 * `lastSuccessAgeHours` is the number that matters: a policy can exist, be
 * scheduled, and have been failing silently for weeks. Reporting only
 * "configured: true" is how that goes unnoticed.
 */
export async function snapshotHealth(client, { policyName = 'mx-common-daily', staleAfterHours = 36 } = {}) {
  try {
    const policies = await client.request('GET', `/_slm/policy/${encodeURIComponent(policyName)}`)
    const policy = policies?.[policyName]
    if (!policy) return { configured: false, healthy: false, reason: 'policy is not registered' }

    return describeSnapshotPolicy(policy, { staleAfterHours })
  } catch (error) {
    return { configured: false, healthy: false, reason: error.message }
  }
}

/** Pure, redacted policy evaluation. One ancient success is not backup health. */
export function describeSnapshotPolicy(policy, { staleAfterHours = 36, now = Date.now() } = {}) {
  if (!Number.isFinite(staleAfterHours) || staleAfterHours <= 0) throw new Error('invalid snapshot freshness threshold')
  if (!policy) return { configured: false, healthy: false, reason: 'policy is not registered' }
  const success = Number(policy.last_success?.time)
  const failure = Number(policy.last_failure?.time)
  const valid = Number.isFinite(success) && success > 0 && success <= now
  const age = valid ? (now - success) / 3_600_000 : null
  const recentFailure = Number.isFinite(failure) && failure > 0 && (!valid || failure >= success)
  return {
    configured: true,
    healthy: valid && age <= staleAfterHours && !recentFailure,
    lastSuccessAt: valid ? new Date(success).toISOString() : null,
    lastSuccessAgeHours: age === null ? null : Math.round(age * 10) / 10,
    lastFailureAt: Number.isFinite(failure) && failure > 0 && failure <= now ? new Date(failure).toISOString() : null,
    snapshotsTaken: policy.stats?.snapshots_taken ?? 0,
    snapshotsFailed: policy.stats?.snapshots_failed ?? 0,
    reason: !valid ? 'no successful snapshot with a valid timestamp'
      : recentFailure ? 'latest attempt failed after the last success'
      : age > staleAfterHours ? `last successful snapshot was ${Math.round(age)}h ago` : 'ok',
  }
}
