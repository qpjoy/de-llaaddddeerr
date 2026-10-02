// What the service does for procedure regression: coordinate, never execute.
//
// - /api/rig/v1/station/runs/:runId/…  — a station, holding the run token it
//   got when it claimed the run, reads the batch and reports each replay.
//   The token is the one the test kernel issued for that run and nothing
//   more: it cannot read another run, and it dies when the run completes.
// - /api/rig/v1/procedure-tasks …       — members set up regression: which
//   app, when (a cron expression the kernel's scheduler owns), and where
//   (any station, or a station registered as team capacity).
//
// The batch itself is the app's active web procedures that implement a
// catalog case. A procedure without a case has nowhere to report in a run.

import { z } from 'zod'
import { RigError } from '../../packages/contracts/index.mjs'
import { requireRole } from '../../packages/test-platform/server/identity/index.mjs'
import { sha256 } from '../../packages/test-platform/server/core/ids.mjs'
import { replay } from './procedure-routes.mjs'
import { parseBody } from './schemas.mjs'

const RUN = 'trun_[A-Za-z0-9]{8,64}'
const BATCH = new RegExp(`^/api/rig/v1/station/runs/(${RUN})/procedures$`)
const REPORT = new RegExp(`^/api/rig/v1/station/runs/(${RUN})/procedures/(prc_[a-f0-9]{18})/runs$`)
const TASK_RUN = /^\/api\/rig\/v1\/procedure-tasks\/([A-Za-z0-9_-]{4,80}):run$/

const taskBody = z
  .object({
    app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    name: z.string().min(1).max(120),
    cronExpr: z.string().min(1).max(120).nullable().default(null),
    timezone: z.string().min(1).max(64).optional(),
    runsOn: z.enum(['any-runner', 'server']).default('any-runner')
  })
  .strict()

/** The procedures a batch replays, in a stable order. */
export async function batchFor(procedures, { app, surface = 'web' }) {
  return (await procedures.store.list({ app }))
    .filter((doc) => doc.status === 'active' && doc.caseId && doc.surface === surface)
    .sort((a, b) => a.caseId.localeCompare(b.caseId))
    .map(({ id, revision, title, app: slug, caseId, surface: kind, baseUrl, variables, steps }) => ({
      id,
      revision,
      title,
      app: slug,
      caseId,
      surface: kind,
      baseUrl,
      variables,
      steps
    }))
}

/** Station routes. Called before member authentication: they carry a run token. */
export async function stationRoutes({ req, res, path, kernel, procedures, settings, bearer, readJson, sendJson }) {
  const batch = BATCH.exec(path)
  const report = REPORT.exec(path)
  if (!batch && !report) return false
  const runId = (batch ?? report)[1]
  const token = bearer(req)
  const run = token ? await kernel.store.getRunByTokenHash(sha256(token)) : null
  // One answer for "not yours" and "not there", as the kernel gives it.
  if (!run || run.id !== runId) throw new RigError('forbidden', '这次执行不属于当前工位', 403)
  if (run.status !== 'running') throw new RigError('run_not_running', `这次执行是「${run.status}」`, 409)
  const suite = await kernel.store.getSuite(run.suiteId)
  if (suite?.engine !== 'rig-procedure') throw new RigError('wrong_engine', '这次执行不是试验规程回归', 409)
  const app = await kernel.store.getApp(run.appId)

  if (batch && req.method === 'GET') {
    await settings.refresh()
    // Range Safety travels with the batch: a headless station has no member
    // session to read the policy with, and must still obey it.
    const { browserOrigins, browserSites, productionHosts, egress } = settings.public({ egressEndpoints: true }).policy
    sendJson(res, 200, {
      app: app.slug,
      procedures: await batchFor(procedures, { app: app.slug, surface: suite.surface }),
      // In `ask` mode each procedure also reaches the sites it was saved with.
      policy: { browserOrigins, browserSites, productionHosts, egress }
    })
    return true
  }
  if (report && req.method === 'POST') {
    const body = parseBody(z.object({ run: replay }).strict(), await readJson(req, 400_000))
    const doc = await procedures.get(report[2])
    if (doc.app !== app.slug) throw new RigError('forbidden', '这条规程不属于这次执行的应用', 403)
    const { run: entry } = await procedures.recordRun(
      doc.id,
      // Already part of the batch run: recorded against it, not as a run of its own.
      { ...body.run, kernelRunId: run.id },
      `runner:${run.runnerId}`
    )
    sendJson(res, 201, { run: entry })
    return true
  }
  throw new RigError('not_found', '接口不存在', 404)
}

/** Regression set-up for members. */
export async function procedureTaskRoutes({ req, res, path, principal, kernel, procedures, readJson, sendJson }) {
  if (!path.startsWith('/api/rig/v1/procedure-tasks')) return false
  const invoke = (method, target, body) =>
    kernel.app.invoke({ method, path: target, body, principal, source: 'rig-procedures' })

  if (path === '/api/rig/v1/procedure-tasks' && req.method === 'GET') {
    const [{ tasks }, { runners }, { apps }] = await Promise.all([
      invoke('GET', '/api/v1/tasks'),
      invoke('GET', '/api/v1/runners'),
      invoke('GET', '/api/v1/apps')
    ])
    const suites = new Map()
    for (const app of apps)
      for (const suite of await kernel.store.listSuites(app.id)) suites.set(suite.id, { suite, app })
    const regression = tasks
      .filter((task) => suites.get(task.suiteId)?.suite.engine === 'rig-procedure')
      .map((task) => ({ ...task, app: suites.get(task.suiteId).app.slug }))
    const lastRuns = new Map()
    for (const task of regression)
      if (task.lastRunId) {
        const found = await kernel.store.getRun(task.lastRunId).catch(() => null)
        if (found) lastRuns.set(task.id, { id: found.id, status: found.status, finishedAt: found.finishedAt })
      }
    const covered = new Map()
    for (const doc of await procedures.store.list())
      if (doc.status === 'active' && doc.caseId && doc.app && doc.surface === 'web')
        covered.set(doc.app, (covered.get(doc.app) ?? 0) + 1)
    sendJson(res, 200, {
      tasks: regression.map((task) => ({ ...task, lastRun: lastRuns.get(task.id) ?? null })),
      stations: runners
        .filter((runner) => (runner.capabilities?.engines ?? []).includes('rig-procedure'))
        .map((runner) => ({
          id: runner.id,
          name: runner.name,
          kind: runner.kind,
          online: runner.online,
          status: runner.status,
          lastSeenAt: runner.lastSeenAt ?? null,
          mine: runner.mine
        })),
      apps: [...covered].map(([slug, count]) => ({ slug, procedures: count }))
    })
    return true
  }

  requireRole(principal, 'operator')
  if (path === '/api/rig/v1/procedure-tasks' && req.method === 'POST') {
    const body = parseBody(taskBody, await readJson(req, 4_000))
    await invoke('POST', `/api/v1/apps/${body.app}/procedure-suite`, {})
    const { task } = await invoke('POST', '/api/v1/tasks', {
      app: body.app,
      suite: 'rig-procedures',
      name: body.name,
      runsOn: body.runsOn,
      schedule: body.cronExpr
        ? { kind: 'cron', cronExpr: body.cronExpr, ...(body.timezone ? { timezone: body.timezone } : {}) }
        : { kind: 'manual' }
    })
    sendJson(res, 201, { task })
    return true
  }
  const match = TASK_RUN.exec(path)
  if (match && req.method === 'POST') {
    sendJson(res, 201, await invoke('POST', `/api/v1/tasks/${match[1]}:run`, {}))
    return true
  }
  throw new RigError('not_found', '接口不存在', 404)
}
