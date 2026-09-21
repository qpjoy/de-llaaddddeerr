// Applies pending control-plane schema work and clears pre-publication debris,
// before the service starts taking traffic. Safe to run repeatedly; it never
// deletes an object, a manifest, or a job.
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { MediaJobs } from './jobs.mjs'
import { ArchiveCatalog } from './archive-catalog.mjs'
import { Settings } from './settings.mjs'

const stateDir = process.env.MX_STATIC_STATE_DIR || '/state'
const dataDir = process.env.MX_STATIC_DATA_DIR || '/data'
const report = {}

// Opening each store applies its CREATE/ALTER statements, including the
// archive size column backfill.
const jobs = new MediaJobs(stateDir)
try {
  report.jobs = jobs.db.prepare('SELECT state,count(*) AS n FROM jobs GROUP BY state').all()
    .reduce((totals, row) => ({ ...totals, [row.state]: row.n }), {})
  jobs.db.exec('PRAGMA optimize')
} finally { jobs.close() }

const archive = new ArchiveCatalog(stateDir)
try {
  const backfilled = archive.db.prepare("UPDATE objects SET size=coalesce(json_extract(meta,'$.size'),0) WHERE size=0 AND meta IS NOT NULL").run().changes
  report.archive = { objects: archive.db.prepare('SELECT count(*) AS n FROM objects').get().n, sizeBackfilled: backfilled }
  archive.db.exec('PRAGMA optimize')
} finally { archive.close() }

const settings = new Settings(stateDir)
try { report.settings = Object.keys(settings.read()).length } finally { settings.close() }

// Staged downloads that a crash left behind reference nothing at all.
const staging = join(dataDir, '.staging')
const stale = (await readdir(staging).catch(() => [])).filter(name => name.endsWith('.part'))
for (const name of stale) await unlink(join(staging, name)).catch(() => {})
report.stagedRemoved = stale.length

console.log(JSON.stringify(report))
