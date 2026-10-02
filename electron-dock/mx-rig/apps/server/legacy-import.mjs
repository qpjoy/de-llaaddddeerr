import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { TERMINAL } from '../../packages/contracts/index.mjs'

const MARKER = 'legacy-import'

/**
 * Bring a deployment's file-based control state into PostgreSQL, once.
 *
 * Before 0.9 the policy, missions, tutorial progress and schedule slots lived
 * as JSON files in the state directory. Switching that deployment to the
 * shared store must not greet its admin with default settings and an empty
 * mission list, so the first start reads whatever files are there.
 *
 * Nothing already in the database is overwritten, the files are left exactly
 * as they were, and a marker row makes later starts skip the scan. Missions
 * that were unfinished when the files were last written are imported as
 * blocked, which is what the file store would have done on its next start.
 */
export async function importLegacyState({ pool, dataRoot, logger = console }) {
  const done = await pool.query('SELECT 1 FROM rig_state WHERE key = $1', [MARKER])
  if (done.rows[0]) return { skipped: true }
  const report = { settings: false, progress: false, missions: 0, schedule: 0 }

  for (const [key, file, field] of [
    ['settings', 'settings.json', 'settings'],
    ['system-progress', 'system-progress.json', 'progress']
  ]) {
    const value = await readJson(join(dataRoot, file))
    if (!value) continue
    const { rowCount } = await pool.query(
      `INSERT INTO rig_state (key, doc, version) VALUES ($1, $2::jsonb, 1)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    )
    report[field] = rowCount === 1
  }

  const missionDir = join(dataRoot, 'missions')
  let files = []
  try {
    files = (await readdir(missionDir)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  for (const name of files) {
    const row = await readJson(join(missionDir, name))
    if (!row?.id || !row.owner) continue
    if (!TERMINAL.has(row.status)) {
      row.status = 'blocked'
      row.pending = null
      row.stream = null
      row.graph = null
      row.events = [
        ...(row.events ?? []),
        {
          at: new Date().toISOString(),
          kind: 'interrupted',
          message: '迁移到共享存储时这项任务尚未结束；外部动作结果可能未知，请核验后创建新任务。'
        }
      ]
    }
    const { rowCount } = await pool.query(
      `INSERT INTO rig_missions (id, owner, surface, mode, status, doc, created_at)
       VALUES ($1, $2, 'internal', $3, $4, $5::jsonb, $6) ON CONFLICT (id) DO NOTHING`,
      [row.id, row.owner, row.mode ?? 'agent', row.status, JSON.stringify(row), row.createdAt]
    )
    report.missions += rowCount
  }

  const schedule = await readJson(join(dataRoot, 'schedule.json'))
  for (const [key, entry] of Object.entries(schedule ?? {})) {
    if (!entry?.lastFiredAt) continue
    const { rowCount } = await pool.query(
      `INSERT INTO rig_schedule_fires (orchestration_key, fired_for, claimed_by)
       VALUES ($1, $2, 'legacy-import') ON CONFLICT DO NOTHING`,
      [key, entry.lastFiredAt]
    )
    report.schedule += rowCount
  }

  await pool.query(
    `INSERT INTO rig_state (key, doc) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
    [MARKER, JSON.stringify({ at: new Date().toISOString(), ...report })]
  )
  if (report.settings || report.progress || report.missions || report.schedule)
    logger?.log?.(
      `[mx-rig] 已从状态目录导入：配置 ${report.settings ? '是' : '否'}，任务 ${report.missions} 项，定时记录 ${report.schedule} 条`
    )
  return report
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    // A file that cannot be parsed is left for a person to look at; it is not
    // a reason to refuse to start.
    console.error(`[mx-rig] 无法读取 ${file}，已跳过导入`)
    return null
  }
}
