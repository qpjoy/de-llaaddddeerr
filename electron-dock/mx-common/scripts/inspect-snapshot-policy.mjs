#!/usr/bin/env node
import fs from 'node:fs'
import { describeSnapshotPolicy } from '../src/elasticsearch/snapshots.mjs'
try {
  const policies = JSON.parse(fs.readFileSync(0, 'utf8'))
  const health = describeSnapshotPolicy(policies[process.argv[2] || 'mx-common-daily'], {
    staleAfterHours: Number(process.env.MX_COMMON_SNAPSHOT_STALE_HOURS || 36),
  })
  console.log(JSON.stringify(health))
  if (!health.healthy) process.exitCode = 1
} catch {
  console.error('Snapshot health could not be verified; raw response withheld')
  process.exitCode = 1
}
