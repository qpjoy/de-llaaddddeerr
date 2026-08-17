import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

import { assertSchedulable } from './core/cron.mjs'
import { AppError } from './core/errors.mjs'
import {
  bearerToken,
  enumValue,
  optionalString,
  readJson,
  requiredString,
  clearSessionCookie,
  routeMatch,
  sendJson,
  sessionCookie,
  stringArray,
} from './core/http.mjs'
import { newToken, sha256 } from './core/ids.mjs'
import { sanitizeUrl } from './core/redact.mjs'
import { requireRole, ROLES } from './identity/index.mjs'
import { compareWithCatalog, normalizeSummary } from './ingest/summary.mjs'
import { renderReport } from './report.mjs'
import {
  CASE_ID_PATTERN,
  PLATFORM_CATALOG,
  PRIORITIES,
  TRACKS,
  decorateCases,
  exportCatalog,
  parseCaseInput,
} from './routes/cases.mjs'
import { claimDeadlineFor, computeNextRunAt } from './scheduler.mjs'

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u
const ENGINES = ['cypress', 'playwright', 'playwright-electron']
const SURFACES = ['web', 'electron']
const RUNNER_KINDS = ['server', 'local']
const PROFILES = ['mock', 'real']

const webRoot = resolve(fileURLToPath(new URL('../web', import.meta.url)))

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function slug(body, name) {
  const value = requiredString(body, name, { maxLength: 64 })
  if (!SLUG_PATTERN.test(value)) {
    throw new AppError(400, 'invalid_request', `${name} 只能用小写字母、数字和连字符`, {
      hint: '例如 compass、compass-web-functional。',
    })
  }
  return value
}

function targetUrl(body, name = 'targetUrl', { required = false } = {}) {
  const raw = optionalString(body, name, { maxLength: 500 })
  if (!raw) {
    if (required) {
      throw new AppError(400, 'invalid_request', `${name} 是必填的`, {
        hint: 'Web 类型的 suite 必须指定被测地址，例如 https://compass.example.internal。',
      })
    }
    return null
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new AppError(400, 'invalid_request', `${name} 必须是完整的 HTTP(S) 地址`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AppError(400, 'invalid_request', `${name} 必须是 http 或 https`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(400, 'invalid_request', `${name} 不能带账号密码、查询参数或锚点`, {
      hint: '凭据请配置成 suite 的 secretRefs，不要写进地址。',
    })
  }
  return sanitizeUrl(raw)
}

function parseCatalogFile(body) {
  const version = Number(body?.schemaVersion)
  if (version !== 1 && version !== 2) {
    throw new AppError(400, 'invalid_request', 'schemaVersion 必须是 1 或 2')
  }
  if (!Array.isArray(body.cases) || body.cases.length === 0) {
    throw new AppError(400, 'invalid_request', 'cases 必须是非空数组')
  }
  const catalogFile = optionalString(body, 'catalogFile', { maxLength: 240 }) || 'catalog.json'
  if (catalogFile === PLATFORM_CATALOG) {
    throw new AppError(400, 'invalid_request', `catalogFile 不能是保留名 ${PLATFORM_CATALOG}`, {
      hint: '这个名字留给界面上编写的用例，同步仓库目录不会动它们。',
    })
  }
  const defaultSuiteSlug = optionalString(body, 'suite', { maxLength: 96 })
  const seen = new Set()
  const cases = []

  for (const entry of body.cases) {
    const caseId = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (!CASE_ID_PATTERN.test(caseId)) {
      throw new AppError(400, 'invalid_case_id', `用例编号 "${caseId}" 不符合规范`, {
        hint: '格式是 <应用>-<端>-<业务域>-<三位序号>，例如 LP-FE-AUTH-001。',
      })
    }
    if (seen.has(caseId)) {
      throw new AppError(400, 'invalid_request', `目录里出现重复编号 "${caseId}"`)
    }
    seen.add(caseId)
    if (entry.retired === true) continue
    cases.push({
      caseId,
      title: String(entry.title ?? caseId).slice(0, 300),
      priority: PRIORITIES.includes(entry.priority) ? entry.priority : 'unprioritized',
      tags: stringArray(entry.tags, { maxItems: 30, maxLength: 80 }),
      tracks: (Array.isArray(entry.tracks) ? entry.tracks : ['functional']).filter((track) =>
        TRACKS.includes(track),
      ),
      specPath: optionalString(entry, 'spec', { maxLength: 240 }),
      suiteSlug: optionalString(entry, 'suite', { maxLength: 96 }) || defaultSuiteSlug,
      requirementRef: optionalString(entry, 'requirementRef', { maxLength: 96 }),
    })
  }
  return { catalogFile, cases }
}

export function createApp({ store, config, identity, artifacts, logger = console }) {
  async function requireApp(appSlug) {
    const app = await store.getAppBySlug(appSlug)
    if (!app) {
      const existing = (await store.listApps()).map((entry) => entry.slug)
      throw new AppError(404, 'app_not_found', `找不到应用 "${appSlug}"`, {
        hint: existing.length
          ? `现有应用：${existing.join('、')}`
          : '还没有注册任何应用。在「应用」页面新建一个，或运行 manage.sh seed 灌入示例数据。',
      })
    }
    return app
  }

  async function requireRun(runId) {
    const run = await store.getRun(runId)
    if (!run) throw new AppError(404, 'run_not_found', '找不到这次执行')
    return run
  }

  /** A runner presenting either its long-lived token or a run-scoped one. */
  async function requireRunner(request) {
    const presented = bearerToken(request)
    if (!presented) throw new AppError(401, 'unauthorized', '需要执行机凭据')
    const runner = await store.getRunnerByTokenHash(sha256(presented))
    if (!runner || runner.status === 'disabled') {
      throw new AppError(401, 'unauthorized', '执行机凭据无效或已停用')
    }
    return runner
  }

  /**
   * A run-scoped credential. It can only touch its own run, and `completeRun`
   * clears it, so a restarted container cannot rewrite a recorded result.
   */
  async function requireRunScope(request, runId) {
    const presented = bearerToken(request)
    if (!presented) throw new AppError(401, 'unauthorized', '需要执行凭据')
    const hash = sha256(presented)

    const byRunToken = await store.getRunByTokenHash(hash)
    if (byRunToken && byRunToken.id === runId) return byRunToken

    const runner = await store.getRunnerByTokenHash(hash)
    if (runner) {
      const run = await store.getRun(runId)
      if (run && run.runnerId === runner.id) return run
    }
    // Deliberately the same answer whether the run is missing or simply
    // someone else's: distinguishing them would let a runner enumerate run ids
    // by watching 404 flip to 403.
    throw new AppError(403, 'forbidden', '这次执行不属于当前执行机')
  }

  async function recentCaseResults(appId) {
    const runs = await store.listRuns({ appId, limit: 20 })
    const recent = new Map()
    for (const run of runs.filter((entry) => entry.finishedAt)) {
      for (const entry of await store.listRunCases(run.id)) {
        if (!recent.has(entry.caseId)) {
          recent.set(entry.caseId, { ...entry, runId: run.id, finishedAt: run.finishedAt })
        }
      }
    }
    return recent
  }

  const routes = [
    // -- health & discovery --------------------------------------------------
    { method: 'GET', pattern: '/healthz', auth: 'none', handler: async () => ({ status: 200, body: { status: 'ok' } }) },
    {
      method: 'GET',
      pattern: '/readyz',
      auth: 'none',
      handler: async () => {
        await store.ping()
        return { status: 200, body: { status: 'ready', store: config.storeDriver } }
      },
    },
    {
      // A landing page for the API: what this service is, what exists in it
      // right now, and where to go next. An empty install should still tell you
      // what to do rather than answering 404.
      method: 'GET',
      pattern: '/api/v1',
      auth: 'none',
      handler: async () => {
        const apps = await store.listApps()
        return {
          status: 200,
          body: {
            service: 'mx-test-framework',
            description: '内部 e2e 测试平台：建任务、跑任务、看报告和录像。',
            ui: '/',
            docs: '/docs',
            loginRequired: identity.loginEnabled,
            apps: apps.map((entry) => ({ slug: entry.slug, name: entry.displayName })),
            nextStep: apps.length
              ? '打开界面创建任务，或 GET /api/v1/tasks 查看已有任务。'
              : '还没有应用。运行 `manage.sh seed` 灌入示例数据，或在界面「应用」页面新建。',
            endpoints: {
              apps: '/api/v1/apps',
              cases: '/api/v1/apps/:app/cases',
              tasks: '/api/v1/tasks',
              runs: '/api/v1/runs',
              report: '/api/v1/runs/:runId/report',
            },
          },
        }
      },
    },

    // -- auth ----------------------------------------------------------------
    {
      method: 'POST',
      pattern: '/api/v1/auth/login',
      auth: 'none',
      handler: async ({ body }) => {
        const result = await identity.login({
          username: requiredString(body, 'username', { maxLength: 120 }),
          password: requiredString(body, 'password', { maxLength: 200 }),
        })
        return {
          status: 200,
          body: result,
          headers: { 'set-cookie': sessionCookie(result.token, { secure: config.secureCookies }) },
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/auth/logout',
      auth: 'none',
      handler: async () => ({
        status: 200,
        body: { ok: true },
        headers: { 'set-cookie': clearSessionCookie() },
      }),
    },
    {
      method: 'GET',
      pattern: '/api/v1/auth/me',
      handler: async ({ principal }) => ({ status: 200, body: { member: principal } }),
    },
    {
      method: 'GET',
      pattern: '/api/v1/members',
      handler: async ({ principal }) => {
        requireRole(principal, 'admin')
        return { status: 200, body: { members: await store.listMembers() } }
      },
    },
    {
      method: 'PATCH',
      pattern: '/api/v1/members/:principalId',
      handler: async ({ principal, params, body }) => {
        requireRole(principal, 'admin')
        const role = enumValue(body, 'role', ROLES)
        const member = await store.setMemberRole(params.principalId, role)
        if (!member) throw new AppError(404, 'member_not_found', '找不到该成员')
        return { status: 200, body: { member } }
      },
    },

    // -- apps & suites -------------------------------------------------------
    { method: 'GET', pattern: '/api/v1/apps', handler: async () => ({ status: 200, body: { apps: await store.listApps() } }) },
    {
      method: 'POST',
      pattern: '/api/v1/apps',
      handler: async ({ body, principal }) => {
        requireRole(principal, 'admin')
        return {
          status: 201,
          body: {
            app: await store.createApp({
              slug: slug(body, 'slug'),
              displayName: requiredString(body, 'displayName'),
              repoUrl: optionalString(body, 'repoUrl', { maxLength: 500 }),
              surfaces: stringArray(body.surfaces, { maxItems: 5, maxLength: 20 }).filter((entry) =>
                SURFACES.includes(entry),
              ),
              catalogGlob: optionalString(body, 'catalogGlob', { maxLength: 240 }),
            }),
          },
        }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/apps/:app/suites',
      handler: async ({ params }) => {
        const app = await requireApp(params.app)
        return { status: 200, body: { suites: await store.listSuites(app.id) } }
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/apps/:app/suites',
      handler: async ({ params, body, principal }) => {
        requireRole(principal, 'admin')
        const app = await requireApp(params.app)
        const requirements = {}
        const os = stringArray(body.requirements?.os, { maxItems: 3, maxLength: 12 })
        if (os.length > 0) requirements.os = os
        return {
          status: 201,
          body: {
            suite: await store.createSuite({
              appId: app.id,
              slug: slug(body, 'slug'),
              displayName: requiredString(body, 'displayName'),
              engine: enumValue(body, 'engine', ENGINES),
              surface: enumValue(body, 'surface', SURFACES),
              runnerKind: enumValue(body, 'runnerKind', RUNNER_KINDS, 'server'),
              runnerImage: optionalString(body, 'runnerImage', { maxLength: 240 }),
              requirements,
              command: stringArray(body.command, { maxItems: 20, maxLength: 200 }),
              retryPolicy: {
                maxAttempts: Math.min(3, Math.max(1, Number(body.retryPolicy?.maxAttempts) || 1)),
              },
              secretRefs: stringArray(body.secretRefs, { maxItems: 10, maxLength: 120 }),
              writesData: body.writesData === true,
            }),
          },
        }
      },
    },

    // -- cases ---------------------------------------------------------------
    {
      method: 'GET',
      pattern: '/api/v1/apps/:app/cases',
      handler: async ({ params, url }) => {
        const app = await requireApp(params.app)
        const cases = await store.listCases(app.id, {
          includeRetired: url.searchParams.get('retired') === 'true',
          priority: url.searchParams.get('priority'),
        })
        return {
          status: 200,
          body: { cases: decorateCases(cases, await recentCaseResults(app.id)) },
        }
      },
    },
    {
      // Write a case in the UI. It becomes a real catalog entry immediately and
      // reports `notRun` until a spec claims the id.
      method: 'POST',
      pattern: '/api/v1/apps/:app/cases',
      handler: async ({ params, body, principal }) => {
        requireRole(principal, 'operator')
        const app = await requireApp(params.app)
        const input = parseCaseInput(body)
        const existing = await store.getCase(app.id, input.caseId)
        if (existing && !existing.retiredAt) {
          throw new AppError(409, 'case_exists', `用例编号 ${input.caseId} 已存在`, {
            hint: `它叫「${existing.title}」。换一个序号，或直接编辑那条。`,
          })
        }
        return {
          status: 201,
          body: {
            case: await store.upsertCase(app.id, {
              ...input,
              origin: 'platform',
              catalogFile: PLATFORM_CATALOG,
              createdBy: principal.id,
            }),
          },
        }
      },
    },
    {
      method: 'PUT',
      pattern: '/api/v1/apps/:app/cases/:caseId',
      handler: async ({ params, body, principal }) => {
        requireRole(principal, 'operator')
        const app = await requireApp(params.app)
        const existing = await store.getCase(app.id, params.caseId)
        if (!existing) throw new AppError(404, 'case_not_found', '找不到该用例')
        if (existing.origin === 'catalog') {
          throw new AppError(409, 'case_owned_by_repo', '这条用例来自代码仓库，不能在界面上改', {
            hint: '它的真相在 git 里。改仓库中的目录文件后重新同步即可。',
          })
        }
        const input = parseCaseInput({ ...body, caseId: params.caseId }, { existing })
        return {
          status: 200,
          body: {
            case: await store.upsertCase(app.id, {
              ...input,
              origin: 'platform',
              catalogFile: PLATFORM_CATALOG,
              createdBy: existing.createdBy ?? principal.id,
            }),
          },
        }
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/v1/apps/:app/cases/:caseId',
      handler: async ({ params, principal }) => {
        requireRole(principal, 'operator')
        const app = await requireApp(params.app)
        const retired = await store.retireCase(app.id, params.caseId)
        if (!retired) throw new AppError(404, 'case_not_found', '找不到该用例')
        // Retired, not deleted: historical runs still reference this id.
        return { status: 200, body: { case: retired } }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/apps/:app/cases/:caseId/history',
      handler: async ({ params }) => {
        const app = await requireApp(params.app)
        return {
          status: 200,
          body: { history: await store.caseHistory(app.id, params.caseId) },
        }
      },
    },
    {
      // Hand-off file: what testers wrote here, in the shape the repository
      // expects, so an engineer can commit it and implement the specs.
      method: 'GET',
      pattern: '/api/v1/apps/:app/cases:export',
      handler: async ({ params }) => {
        const app = await requireApp(params.app)
        const cases = await store.listCases(app.id)
        return {
          status: 200,
          body: exportCatalog(
            app,
            cases.filter((entry) => entry.origin === 'platform'),
          ),
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/apps/:app/catalog:sync',
      handler: async ({ params, body, principal }) => {
        requireRole(principal, 'operator')
        const app = await requireApp(params.app)
        const parsed = parseCatalogFile(body)
        const diff = await store.syncCatalog(app.id, parsed)
        return { status: 200, body: { catalogFile: parsed.catalogFile, ...diff } }
      },
    },

    // -- tasks ---------------------------------------------------------------
    {
      method: 'GET',
      pattern: '/api/v1/tasks',
      handler: async ({ url }) => {
        const appSlug = url.searchParams.get('app')
        const app = appSlug ? await requireApp(appSlug) : null
        const enabledParam = url.searchParams.get('enabled')
        return {
          status: 200,
          body: {
            tasks: await store.listTasks({
              appId: app?.id ?? null,
              enabled: enabledParam === null ? null : enabledParam === 'true',
            }),
          },
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/tasks',
      handler: async ({ body, principal }) => {
        requireRole(principal, 'operator')
        const app = await requireApp(requiredString(body, 'app', { maxLength: 64 }))
        const suiteSlug = requiredString(body, 'suite', { maxLength: 96 })
        const suites = await store.listSuites(app.id)
        const suite = suites.find((entry) => entry.slug === suiteSlug)
        if (!suite) {
          throw new AppError(404, 'suite_not_found', `找不到 suite "${suiteSlug}"`, {
            hint: suites.length
              ? `${app.slug} 现有：${suites.map((entry) => entry.slug).join('、')}`
              : `${app.slug} 还没有配置 suite，需要管理员先建一个。`,
          })
        }

        const schedule = body.schedule ?? {}
        const scheduleKind = enumValue(schedule, 'kind', ['manual', 'once', 'cron'], 'manual')
        const timezone = optionalString(schedule, 'timezone', { maxLength: 64 }) || config.defaultTimezone
        let cronExpr = null
        let runAt = null
        if (scheduleKind === 'cron') {
          cronExpr = requiredString(schedule, 'cronExpr', { maxLength: 120 })
          assertSchedulable(cronExpr, timezone)
        }
        if (scheduleKind === 'once') {
          const parsed = new Date(requiredString(schedule, 'runAt', { maxLength: 40 }))
          if (Number.isNaN(parsed.getTime())) {
            throw new AppError(400, 'task_schedule_invalid', 'schedule.runAt 必须是 ISO 时间')
          }
          runAt = parsed.toISOString()
        }

        const draft = {
          appId: app.id,
          suiteId: suite.id,
          name: requiredString(body, 'name'),
          profile: enumValue(body, 'profile', PROFILES, 'mock'),
          track: enumValue(body, 'track', TRACKS, 'functional'),
          targetUrl: targetUrl(body, 'targetUrl', { required: suite.surface === 'web' }),
          scheduleKind,
          cronExpr,
          runAt,
          timezone,
          claimWindowMinutes: Math.min(10_080, Math.max(5, Number(body.claimWindowMinutes) || 720)),
          enabled: body.enabled !== false,
          createdBy: principal.id,
        }
        draft.nextRunAt = computeNextRunAt(draft)
        return { status: 201, body: { task: await store.createTask(draft) } }
      },
    },
    {
      method: 'PATCH',
      pattern: '/api/v1/tasks/:taskId',
      handler: async ({ params, body, principal }) => {
        requireRole(principal, 'operator')
        const task = await store.getTask(params.taskId)
        if (!task) throw new AppError(404, 'task_not_found', '找不到该任务')
        const patch = {}
        if (Object.hasOwn(body, 'name')) patch.name = requiredString(body, 'name')
        if (Object.hasOwn(body, 'enabled')) patch.enabled = body.enabled === true
        if (Object.hasOwn(body, 'targetUrl')) patch.targetUrl = targetUrl(body)
        if (Object.hasOwn(body, 'profile')) patch.profile = enumValue(body, 'profile', PROFILES)
        if (Object.hasOwn(body, 'track')) patch.track = enumValue(body, 'track', TRACKS)
        if (body.schedule?.kind === 'manual') {
          patch.scheduleKind = 'manual'
          patch.cronExpr = null
        } else if (body.schedule?.cronExpr) {
          patch.cronExpr = requiredString(body.schedule, 'cronExpr', { maxLength: 120 })
          patch.scheduleKind = 'cron'
          patch.timezone = optionalString(body.schedule, 'timezone', { maxLength: 64 }) || task.timezone
          assertSchedulable(patch.cronExpr, patch.timezone)
        }
        // Any change to schedule or enablement invalidates the stored fire time;
        // recompute from the merged task, never from the patch alone.
        patch.nextRunAt = computeNextRunAt({ ...task, ...patch })
        return { status: 200, body: { task: await store.updateTask(task.id, patch) } }
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/v1/tasks/:taskId',
      handler: async ({ params, principal }) => {
        requireRole(principal, 'operator')
        const deleted = await store.deleteTask(params.taskId)
        if (!deleted) throw new AppError(404, 'task_not_found', '找不到该任务')
        return { status: 204, body: null }
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/tasks/:taskId:run',
      handler: async ({ params, principal }) => {
        requireRole(principal, 'operator')
        const task = await store.getTask(params.taskId)
        if (!task) throw new AppError(404, 'task_not_found', '找不到该任务')
        const suite = await store.getSuite(task.suiteId)
        if (!suite) throw new AppError(404, 'suite_not_found', '找不到该 suite')
        const now = new Date()
        const run = await store.createRun({
          appId: task.appId,
          suiteId: suite.id,
          taskId: task.id,
          profile: task.profile,
          track: task.track,
          engine: suite.engine,
          status: suite.runnerKind === 'local' ? 'pending-runner' : 'queued',
          trigger: 'manual',
          targetUrl: task.targetUrl,
          claimDeadline: claimDeadlineFor(task, suite, now),
          createdBy: principal.id,
        })
        await store.updateTask(task.id, { lastRunId: run.id })
        return {
          status: 202,
          body: {
            run,
            note:
              suite.runnerKind === 'local'
                ? '已排队，等待一台可用的执行机认领。没有在线执行机时会一直等到认领窗口结束。'
                : '已排队，服务端执行机会尽快开始。',
          },
        }
      },
    },

    // -- runs ----------------------------------------------------------------
    {
      method: 'GET',
      pattern: '/api/v1/runs',
      handler: async ({ url }) => {
        const appSlug = url.searchParams.get('app')
        const app = appSlug ? await requireApp(appSlug) : null
        return {
          status: 200,
          body: {
            runs: await store.listRuns({
              appId: app?.id ?? null,
              taskId: url.searchParams.get('task'),
              status: url.searchParams.get('status'),
              limit: Number(url.searchParams.get('limit')) || 50,
            }),
          },
        }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/runs/:runId',
      handler: async ({ params }) => {
        const run = await requireRun(params.runId)
        const [app, suite, task] = await Promise.all([
          store.getApp(run.appId),
          run.suiteId ? store.getSuite(run.suiteId) : null,
          run.taskId ? store.getTask(run.taskId) : null,
        ])
        return { status: 200, body: { run, app, suite, task } }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/runs/:runId/cases',
      handler: async ({ params }) => {
        await requireRun(params.runId)
        const [cases, steps] = await Promise.all([
          store.listRunCases(params.runId),
          store.listAllSteps(params.runId),
        ])
        return {
          status: 200,
          body: { cases: cases.map((entry) => ({ ...entry, steps: steps[entry.caseId] ?? [] })) },
        }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/runs/:runId/cases/:caseId/steps',
      handler: async ({ params }) => {
        await requireRun(params.runId)
        return { status: 200, body: { steps: await store.listSteps(params.runId, params.caseId) } }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/runs/:runId/artifacts',
      handler: async ({ params }) => {
        await requireRun(params.runId)
        return { status: 200, body: { artifacts: await artifacts.list(params.runId) } }
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/runs/:runId:cancel',
      handler: async ({ params, principal }) => {
        requireRole(principal, 'operator')
        const run = await requireRun(params.runId)
        if (['passed', 'failed', 'flaky', 'blocked', 'expired', 'cancelled'].includes(run.status)) {
          throw new AppError(409, 'run_not_cancellable', `这次执行已经是「${run.status}」，不能取消`)
        }
        return {
          status: 200,
          body: {
            run: await store.updateRun(run.id, {
              status: 'cancelled',
              finishedAt: new Date().toISOString(),
            }),
          },
        }
      },
    },

    // -- runner face ---------------------------------------------------------
    {
      method: 'POST',
      pattern: '/runner/v1/runners:register',
      handler: async ({ body, principal }) => {
        requireRole(principal, 'operator')
        const token = newToken('mxt-rnr')
        const runner = await store.registerRunner({
          name: requiredString(body, 'name', { maxLength: 96 }),
          kind: enumValue(body, 'kind', RUNNER_KINDS, 'local'),
          os: enumValue(body, 'os', ['linux', 'windows', 'macos']),
          arch: optionalString(body, 'arch', { maxLength: 16 }),
          capabilities: {
            engines: stringArray(body.engines, { maxItems: 5, maxLength: 32 }).filter((entry) =>
              ENGINES.includes(entry),
            ),
            surfaces: stringArray(body.surfaces, { maxItems: 5, maxLength: 20 }).filter((entry) =>
              SURFACES.includes(entry),
            ),
            concurrency: Math.min(16, Math.max(1, Number(body.concurrency) || 1)),
          },
          ownerPrincipal: principal.id,
          tokenSha256: sha256(token),
        })
        // Returned once; only the hash is kept.
        return { status: 201, body: { runner: { ...runner, tokenSha256: undefined }, token } }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/runners',
      handler: async () => {
        const runners = await store.listRunners()
        return {
          status: 200,
          body: { runners: runners.map((entry) => ({ ...entry, tokenSha256: undefined })) },
        }
      },
    },
    {
      method: 'POST',
      pattern: '/runner/v1/runs:claim',
      auth: 'runner',
      handler: async ({ runner }) => {
        const now = new Date()
        const runToken = newToken('mxt-run')
        const claimed = await store.claimRun({
          runner,
          leaseMs: config.runLeaseMs,
          now,
          runTokenSha256: sha256(runToken),
        })
        if (!claimed) {
          await store.touchRunner(runner.id, 'idle')
          return { status: 204, body: null }
        }
        await store.touchRunner(runner.id, 'busy')
        const { run, suite } = claimed
        const app = await store.getApp(run.appId)
        return {
          status: 200,
          body: {
            runId: run.id,
            suite: { slug: suite.slug, engine: suite.engine, surface: suite.surface },
            command: suite.command,
            leaseSeconds: Math.floor(config.runLeaseMs / 1000),
            runToken,
            env: runnerEnv({ run, suite, app, config }),
          },
        }
      },
    },
    {
      method: 'POST',
      pattern: '/runner/v1/runs/:runId/heartbeat',
      auth: 'runScope',
      handler: async ({ run }) => {
        if (run.status !== 'running') {
          throw new AppError(409, 'run_not_running', `这次执行是「${run.status}」，无法续租`)
        }
        const leaseUntil = new Date(Date.now() + config.runLeaseMs).toISOString()
        await store.updateRun(run.id, { leaseUntil })
        return { status: 200, body: { leaseUntil } }
      },
    },
    {
      method: 'PUT',
      pattern: '/runner/v1/runs/:runId/artifacts/*',
      auth: 'runScope',
      rawBody: true,
      handler: async ({ run, params, request }) => {
        const bytes = await artifacts.write(run.id, params['*'], request)
        return { status: 201, body: { path: params['*'], bytes } }
      },
    },
    {
      method: 'POST',
      pattern: '/runner/v1/runs/:runId:complete',
      auth: 'runScope',
      handler: async ({ run, body }) => ({
        status: 200,
        body: { run: await completeRun({ store, artifacts, run, body }) },
      }),
    },
  ]

  // Routes whose response is not JSON are handled separately: they stream, set
  // their own content type, or render HTML.
  async function handleSpecial(request, response, url) {
    const report = routeMatch(url.pathname, '/api/v1/runs/:runId/report')
    if (report && request.method === 'GET') {
      const run = await requireRun(report.runId)
      const [rawCases, steps, files, app, suite] = await Promise.all([
        store.listRunCases(run.id),
        store.listAllSteps(run.id),
        artifacts.list(run.id),
        store.getApp(run.appId),
        run.suiteId ? store.getSuite(run.suiteId) : null,
      ])
      const html = renderReport({
        run,
        app,
        suite,
        artifacts: files,
        cases: rawCases.map((entry) => ({ ...entry, steps: steps[entry.caseId] ?? [] })),
        redacted: url.searchParams.get('redacted') === 'true',
        brand: url.searchParams.get('brand'),
      })
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(html)
      return true
    }

    const artifactRoute = routeMatch(url.pathname, '/api/v1/runs/:runId/artifacts/*')
    if (artifactRoute && request.method === 'GET') {
      await requireRun(artifactRoute.runId)
      await artifacts.serve(artifactRoute.runId, artifactRoute['*'], request, response)
      return true
    }
    return false
  }

  return async function handle(request, response) {
    let url
    try {
      url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
    } catch {
      sendJson(response, 400, { error: { code: 'invalid_request', message: 'URL 格式错误' } })
      return
    }

    try {
      // Static assets and the SPA shell need no credentials; the data behind
      // them does.
      if (await serveStatic(request, response, url)) return

      for (const route of routes) {
        if (route.method !== request.method) continue
        const params = routeMatch(url.pathname, route.pattern)
        if (!params) continue

        const context = { params, url, request, body: {} }
        if (route.auth === 'runner') context.runner = await requireRunner(request)
        else if (route.auth === 'runScope') context.run = await requireRunScope(request, params.runId)
        else if (route.auth !== 'none') context.principal = await identity.resolve(bearerToken(request))

        if (!route.rawBody && ['POST', 'PATCH', 'PUT'].includes(request.method)) {
          context.body = await readJson(request)
        }
        const result = await route.handler(context)
        if (result.status === 204) {
          response.writeHead(204).end()
          return
        }
        sendJson(response, result.status, result.body, result.headers ?? {})
        return
      }

      if (url.pathname.startsWith('/api/v1/runs/')) {
        // Reports and artifacts stream or render HTML rather than returning
        // JSON, so they sit outside the route table — but they authenticate
        // first, before any work or any bytes.
        await identity.resolve(bearerToken(request))
        if (await handleSpecial(request, response, url)) return
      }

      // Unknown non-API path: hand it to the SPA so client-side routes survive
      // a hard refresh. A path with a file extension is an asset request, not a
      // route — answering those with the HTML shell turns a missing stylesheet
      // into a page that renders unstyled with no error anywhere.
      const looksLikeAsset = /\.[a-z0-9]{2,5}$/iu.test(url.pathname)
      if (
        request.method === 'GET' &&
        !looksLikeAsset &&
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/runner/')
      ) {
        if (await serveStatic(request, response, new URL('/index.html', url))) return
      }
      sendJson(response, 404, {
        error: { code: 'not_found', message: '没有这个接口', details: { hint: '接口清单见 GET /api/v1' } },
      })
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      if (error instanceof AppError) {
        sendJson(response, error.status, {
          error: { code: error.code, message: error.message, ...(error.details ?? {}) },
        })
        return
      }
      logger.error?.(`[api] ${request.method} ${url.pathname} failed: ${error.stack || error}`)
      sendJson(response, 500, { error: { code: 'internal_error', message: '服务器内部错误' } })
    }
  }
}

async function serveStatic(request, response, url) {
  if (request.method !== 'GET') return false
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname
  if (pathname.startsWith('/api/') || pathname.startsWith('/runner/')) return false

  // The API contract lives beside the code; serving it means the docs page can
  // never describe a different version than the one running.
  if (pathname === '/openapi.yaml') {
    const spec = resolve(webRoot, '../contracts/openapi.yaml')
    try {
      const info = await stat(spec)
      response.writeHead(200, {
        'content-type': 'text/yaml; charset=utf-8',
        'content-length': info.size,
      })
      await pipeline(createReadStream(spec), response)
      return true
    } catch {
      return false
    }
  }

  // The design system ships as CSS in node_modules; serve it from there rather
  // than vendoring a copy that can drift from the version actually installed.
  // `styles.css` opens with `@import "./tokens.css"`, so the sibling has to be
  // reachable at the same URL prefix or every colour falls back to nothing.
  const vendored = {
    '/vendor/neon-void.css': '@qpjoy/ui-design-neon-void/styles.css',
    '/vendor/tokens.css': '@qpjoy/ui-design-neon-void/tokens.css',
  }[pathname]

  let target
  if (vendored) {
    try {
      target = fileURLToPath(import.meta.resolve(vendored))
    } catch {
      return false
    }
  } else {
    target = resolve(webRoot, `.${pathname}`)
    if (target !== webRoot && !target.startsWith(webRoot + sep)) return false
  }

  let info
  try {
    info = await stat(target)
  } catch {
    return false
  }
  if (!info.isFile()) return false

  response.writeHead(200, {
    'content-type': STATIC_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': pathname === '/index.html' ? 'no-cache' : 'public, max-age=300',
  })
  await pipeline(createReadStream(target), response)
  return true
}

/**
 * Variables handed to a runner at claim time.
 *
 * The `E2E_*` aliases are what let compass onboard unchanged: its existing
 * `scripts/e2e-run.mjs` reads those names, so the platform speaks them too
 * rather than asking that repository to rename anything.
 */
export function runnerEnv({ run, suite, app, config }) {
  const artifactsDir = `${config.artifactsDir}/runs/${run.id}`
  const env = {
    MXT_RUN_ID: run.id,
    MXT_APP: app?.slug ?? '',
    MXT_SUITE: suite.slug,
    MXT_TRACK: run.track,
    MXT_PROFILE: run.profile,
    MXT_ARTIFACTS_DIR: artifactsDir,
    E2E_RUN_ID: run.id,
    E2E_TRACK: run.track,
    E2E_PROFILE: run.profile,
    E2E_ARTIFACTS_DIR: artifactsDir,
  }
  if (run.targetUrl) {
    env.MXT_BASE_URL = run.targetUrl
    env.E2E_BASE_URL = run.targetUrl
  }
  return env
}

/**
 * Ingest a runner's summary and close out the run.
 *
 * Order matters: normalize (which redacts and lets the exit code override a
 * stale `status`), then reconcile against the catalog so a case that silently
 * stopped running shows as `notRun` instead of vanishing from the counts.
 */
export async function completeRun({ store, artifacts, run, body }) {
  const exitCode = Number.isInteger(body?.exitCode) ? body.exitCode : null
  const normalized = normalizeSummary(body?.summary, exitCode)
  const catalogCases = await store.listCases(run.appId)
  const { cases, catalog } = compareWithCatalog(catalogCases, normalized.cases)

  const finishedAt = new Date()
  const startedAt = run.startedAt ? new Date(run.startedAt) : finishedAt
  const files = artifacts ? await artifacts.list(run.id).catch(() => []) : []

  return store.completeRun(run.id, {
    run: {
      status: normalized.status,
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      totals: { ...normalized.totals, notRun: catalog.counts.notRun },
      catalog: { ...catalog, duplicates: normalized.duplicates },
      artifacts: {
        root: `runs/${run.id}`,
        // Recorded from what actually landed on disk, not from what the runner
        // claimed it wrote.
        files: files.map((entry) => entry.path),
        expired: false,
      },
      blockedReason: normalized.blockedReason,
    },
    // `notRun` rows are written, not dropped: they are how a trend query shows
    // that a case stopped running rather than silently losing it.
    cases,
  })
}
