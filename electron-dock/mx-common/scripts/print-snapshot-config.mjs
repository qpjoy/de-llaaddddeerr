#!/usr/bin/env node
//
// Emit the snapshot repository and SLM policy documents as JSON.
//
// The definitions live in code (src/elasticsearch/snapshots.mjs) so they are
// reviewable and testable; applying them goes through `kubectl exec ... curl`
// in manage.sh, which needs no port-forward and no cluster credentials on the
// operator's machine. This script is the seam between the two.
//
// Usage: node scripts/print-snapshot-config.mjs repository|policy <name>
import { fsRepository, s3Repository, dailySnapshotPolicy, DEFAULT_REPOSITORY } from '../src/index.mjs'

const [, , what, name] = process.argv

function repository() {
  const bucket = process.env.MX_COMMON_SNAPSHOT_S3_BUCKET
  // An S3 repository is used the moment one is configured: it is the only form
  // of this backup that survives losing the node.
  if (bucket) {
    return s3Repository({
      bucket,
      basePath: process.env.MX_COMMON_SNAPSHOT_S3_BASE_PATH || undefined,
      endpoint: process.env.MX_COMMON_SNAPSHOT_S3_ENDPOINT || undefined,
    })
  }
  return fsRepository({ location: process.env.MX_COMMON_SNAPSHOT_PATH || undefined })
}

function policy() {
  return dailySnapshotPolicy({
    repository: process.env.MX_COMMON_SNAPSHOT_REPOSITORY || DEFAULT_REPOSITORY,
    schedule: process.env.MX_COMMON_SNAPSHOT_SCHEDULE || undefined,
    expireAfter: process.env.MX_COMMON_SNAPSHOT_EXPIRE_AFTER || undefined,
    minCount: process.env.MX_COMMON_SNAPSHOT_MIN_COUNT
      ? Number(process.env.MX_COMMON_SNAPSHOT_MIN_COUNT)
      : undefined,
  })
}

if (what === 'repository') process.stdout.write(JSON.stringify(repository()))
else if (what === 'policy') process.stdout.write(JSON.stringify(policy()))
else {
  process.stderr.write(`unknown target: ${what || '(none)'}${name ? ` ${name}` : ''}\n`)
  process.exit(2)
}
