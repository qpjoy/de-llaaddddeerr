import { createHash } from 'node:crypto'
import { z } from 'zod'
import { RigError } from '../../packages/contracts/index.mjs'
import { readTestInput } from '../../packages/runtime/test-workspace.mjs'
import {
  assertPlacementPossible,
  resolvePlacement
} from '../../packages/test-platform/server/runner/placement.mjs'
import { runnerMatchesSuite } from '../../packages/test-platform/server/store/memory.mjs'

const planBody = z
  .object({
    expectedRevision: z.number().int().positive(),
    taskId: z.string().min(1).max(80),
    bindings: z
      .array(
        z
          .object({
            caseId: z.string().min(1).max(64),
            specPath: z.string().trim().min(1).max(240)
          })
          .strict()
      )
      .max(200)
      .default([]),
    // A commit of the project's own test repository (docs/23): the run checks
    // out exactly this commit on the machine that holds the repository.
    qaRef: z
      .object({
        branch: z.string().regex(/^(?:main|published|task\/[a-f0-9]{8})$/),
        commit: z.string().regex(/^[a-f0-9]{40}$/)
      })
      .strict()
      .optional()
  })
  .strict()
const dispatchBody = planBody.extend({
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.uuid()
})
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Object key order differs between JSON files and PostgreSQL jsonb.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value
const hash = (value) => digest(canonical(value))
const validSpec = (path) =>
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.split('/').some((part) => !part || part === '.' || part === '..') &&
  !/[\x00-\x1f*?\[\]{},:]/.test(path)

/** Only existing, administrator-configured suites can execute. No generated shell commands. */
export class WorkbenchExecutions {
  constructor({ store, caseBooks }) {
    Object.assign(this, { store, caseBooks })
  }

  async plan(mission, input) {
    const body = readTestInput(planBody, input)
    const book = await this.caseBooks.read(mission.id)
    if (book.revision !== body.expectedRevision || !book.confirmed)
      throw new RigError('cases_not_confirmed', '用例已变更或尚未确认，请重新核对当前版本', 409)
    const task = await this.store.getTask(body.taskId)
    if (!task || task.appId !== mission.workbench.appId || !task.enabled)
      throw new RigError('task_unavailable', '请选择本项目启用的执行计划', 409)
    const [suite, app] = await Promise.all([
      this.store.getSuite(task.suiteId),
      this.store.getApp(task.appId)
    ])
    if (
      !app ||
      app.enabled === false ||
      !suite ||
      suite.enabled === false ||
      suite.appId !== app.id ||
      (suite.kind && suite.kind !== 'test') ||
      !['cypress', 'playwright', 'playwright-electron'].includes(suite.engine)
    )
      throw new RigError(
        'suite_unavailable',
        '当前仅支持本项目启用的 Cypress / Playwright 测试套件',
        409
      )
    const workspace = /^rig-workspace:\/\//.test(suite.repoUrl ?? '')
    if (body.qaRef && !workspace)
      throw new RigError('not_workspace_suite', '只有「本机测试仓库」的执行计划能指定测试仓库的提交', 409)
    if (task.caseFilter)
      throw new RigError(
        'filtered_task',
        '当前按整套 Suite 执行，请选择未设置局部筛选的执行计划',
        409
      )
    const cases = book.cases.filter((entry) => entry.platforms.includes(suite.surface))
    if (!cases.length) throw new RigError('empty_scope', '已确认用例不包含此套件的平台', 409)
    const catalog = await this.store.listCases(app.id)
    const overrides = new Map(body.bindings.map((entry) => [entry.caseId, entry.specPath]))
    if (
      overrides.size !== body.bindings.length ||
      body.bindings.some((entry) => !cases.some((c) => c.caseId === entry.caseId))
    )
      throw new RigError('invalid_bindings', '脚本关联包含重复编号或本平台范围以外的用例')
    const bindings = cases.map((entry) => {
      const registered = catalog.find(
        (c) => c.caseId === entry.caseId && c.suiteSlug === suite.slug
      )
      const specPath =
        overrides.get(entry.caseId) ??
        registered?.specPath ??
        (!entry.suiteSlug || entry.suiteSlug === suite.slug ? entry.specPath : '')
      if (!specPath || !validSpec(specPath))
        throw new RigError(
          'binding_required',
          `请为 ${entry.caseId} 提供此平台在 ${suite.slug} 中的相对脚本路径（不接受 glob）`,
          409
        )
      return { caseId: entry.caseId, specPath }
    })
    // Keep only execution-affecting fields. lastRunId/timestamps must not invalidate a retry.
    const taskSnapshot = Object.fromEntries(
      [
        'id',
        'name',
        'profile',
        'track',
        'targetUrl',
        'runsOn',
        'runnerId',
        'claimWindowMinutes'
      ].map((key) => [key, task[key] ?? null])
    )
    const placement = resolvePlacement({ task, suite })
    const runner = placement.assignedRunnerId
      ? await this.store.getRunner(placement.assignedRunnerId)
      : null
    assertPlacementPossible({
      runsOn: placement.runsOn,
      suite,
      runner,
      runnerMatches: runnerMatchesSuite
    })
    const appSnapshot = Object.fromEntries(
      ['id', 'slug', 'displayName', 'repoUrl', 'defaultBranch'].map((key) => [
        key,
        app[key] ?? null
      ])
    )
    const suiteSnapshot = structuredClone(suite)
    delete suiteSnapshot.createdAt
    delete suiteSnapshot.updatedAt
    const manifest = {
      missionId: mission.id,
      revision: book.revision,
      confirmedAt: book.confirmedAt,
      confirmedBy: book.confirmedBy,
      platform: suite.surface,
      cases,
      bindings,
      task: taskSnapshot,
      suite: suiteSnapshot,
      app: appSnapshot,
      appPackage: suite.surface === 'electron' ? (app.latestPackage ?? null) : null,
      executionScope: 'suite',
      ...(body.qaRef ? { qaRef: body.qaRef } : {})
    }
    return { manifest, planHash: hash(manifest) }
  }

  async dispatch(mission, principal, input) {
    const body = readTestInput(dispatchBody, input)
    const id = `trun_wb_${digest([principal.id, mission.id, body.requestId]).slice(0, 32)}`
    const requestHash = hash(body)
    const existing = await this.store.getRun(id)
    if (existing) return this.retry(existing, requestHash)
    const { requestId, planHash, ...selection } = body
    const plan = await this.plan(mission, selection)
    if (plan.planHash !== planHash)
      throw new RigError('execution_plan_changed', '执行配置或用例已变化，请重新预览后派发', 409)
    const { manifest } = plan
    const { app, suite, task, appPackage } = manifest
    const run = await this.store.createRun({
      id,
      appId: app.id,
      suiteId: suite.id,
      taskId: task.id,
      engine: suite.engine,
      profile: task.profile,
      track: task.track,
      trigger: 'manual',
      targetUrl: task.targetUrl,
      createdBy: principal.id,
      appPackage,
      caseFilter: null,
      sourceRef: manifest.qaRef
        ? { ref: manifest.qaRef.commit, gitSha: manifest.qaRef.commit, branch: manifest.qaRef.branch }
        : appPackage?.gitSha
          ? { ref: app.defaultBranch, gitSha: appPackage.gitSha }
          : null,
      ...resolvePlacement({ task, suite }),
      workbench: { ...manifest, planHash, requestId, requestHash }
    })
    this.retry(run, requestHash)
    await this.store.updateTask(task.id, { lastRunId: run.id })
    return run
  }

  retry(run, requestHash) {
    if (run.workbench?.requestHash !== requestHash)
      throw new RigError('execution_request_conflict', '同一派发请求不能更换执行内容', 409)
    return run
  }

  async list(mission, runId = null) {
    let selected
    if (runId) {
      selected = await this.store.getRun(runId)
      if (!selected || selected.workbench?.missionId !== mission.id)
        throw new RigError('not_found', '本任务没有这次执行', 404)
    }
    const [tasks, suites, runs] = await Promise.all([
      selected ? [] : this.store.listTasks({ appId: mission.workbench.appId }),
      selected ? [] : this.store.listSuites(mission.workbench.appId),
      selected ? [selected] : this.store.listRuns({ missionId: mission.id, limit: 51 })
    ])
    return {
      tasks: tasks
        .filter((task) => task.enabled)
        .map((task) => ({ ...task, suite: suites.find((s) => s.id === task.suiteId) })),
      hasMore: runs.length > 50,
      runs: await Promise.all(
        runs.slice(0, 50).map(async (run, index) => {
          const { workbench } = run
          const metadata = {
            ...Object.fromEntries(
              ['id', 'status', 'profile', 'track', 'queuedAt', 'sourceRef', 'blockedReason'].map(
                (key) => [key, run[key] ?? null]
              )
            ),
            caseCount: workbench.cases.length,
            revision: workbench.revision,
            platform: workbench.platform,
            suiteName: workbench.suite.slug,
            planHash: workbench.planHash
          }
          // Only expand one run. Fifty full case/step histories can exceed the desktop's response budget.
          if (index > 0) return metadata
          const results = await this.store.listRunCases(run.id)
          return {
            ...metadata,
            coverage: workbench.cases.map((entry) => ({
              caseId: entry.caseId,
              title: entry.title,
              expectedSpec: workbench.bindings.find((b) => b.caseId === entry.caseId).specPath,
              result: (() => {
                const result = results.find((c) => c.caseId === entry.caseId)
                return result
                  ? {
                      status: result.status,
                      specPath: result.specPath,
                      errorText: result.errorText
                    }
                  : null
              })()
            })),
            extraCases: results.filter(
              (c) => !workbench.cases.some((entry) => entry.caseId === c.caseId)
            ).length
          }
        })
      )
    }
  }
}

export async function workbenchExecutionRoutes({
  projectAccess,
  req,
  res,
  path,
  url,
  principal,
  missions,
  executions,
  readJson,
  sendJson,
  requireRole
}) {
  const match = /^\/api\/rig\/v1\/missions\/([a-f0-9-]{36})\/executions(?::(plan|dispatch))?$/.exec(
    path
  )
  if (!match) return false
  const mission = await missions.get(match[1], principal.id)
  if (!mission.workbench) throw new RigError('not_test_task', '任务未关联测试项目', 409)
  if (req.method === 'GET' && !match[2]) {
    sendJson(res, 200, await executions.list(mission, url.searchParams.get('run')))
    return true
  }
  if (req.method === 'POST' && match[2]) {
    requireRole(principal, 'operator')
    await projectAccess?.mission(mission, 'write')
    const body = await readJson(req, 1024 * 1024)
    sendJson(
      res,
      match[2] === 'dispatch' ? 202 : 200,
      match[2] === 'dispatch'
        ? { run: await executions.dispatch(mission, principal, body) }
        : await executions.plan(mission, body)
    )
    return true
  }
  throw new RigError('not_found', '接口不存在', 404)
}
