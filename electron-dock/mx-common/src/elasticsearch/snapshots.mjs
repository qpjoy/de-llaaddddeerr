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

/** S3-compatible repository, for when off-node durability actually exists. */
export function s3Repository({ bucket, basePath = 'mx-common/elasticsearch', endpoint, pathStyleAccess = true }) {
  if (!bucket) throw new Error('an S3 repository requires a bucket')
  return {
    type: 's3',
    settings: {
      bucket,
      base_path: basePath,
      compress: true,
      ...(endpoint ? { endpoint, path_style_access: pathStyleAccess } : {}),
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

    const lastSuccess = policy.last_success?.time
    const lastFailure = policy.last_failure?.time
    const ageHours = lastSuccess ? (Date.now() - Number(lastSuccess)) / 3_600_000 : null

    return {
      configured: true,
      // Never taken a snapshot yet is not healthy, it is unproven.
      healthy: ageHours !== null && ageHours <= staleAfterHours,
      lastSuccessAt: lastSuccess ? new Date(Number(lastSuccess)).toISOString() : null,
      lastSuccessAgeHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      lastFailureAt: lastFailure ? new Date(Number(lastFailure)).toISOString() : null,
      snapshotsTaken: policy.stats?.snapshots_taken ?? 0,
      snapshotsFailed: policy.stats?.snapshots_failed ?? 0,
      reason: ageHours === null
        ? 'no successful snapshot has been taken yet'
        : ageHours > staleAfterHours
          ? `last successful snapshot was ${Math.round(ageHours)}h ago`
          : 'ok',
    }
  } catch (error) {
    return { configured: false, healthy: false, reason: error.message }
  }
}
