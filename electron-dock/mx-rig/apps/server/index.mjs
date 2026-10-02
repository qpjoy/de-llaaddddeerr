import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRuntime } from '../../packages/test-platform/server/index.mjs'
import { loadConfig } from '../../packages/test-platform/server/config.mjs'
import {
  readJson,
  sendJson,
  bearerToken,
  sessionCookie,
  clearSessionCookie,
  directClientAddress
} from '../../packages/test-platform/server/core/http.mjs'
import { requireRole } from '../../packages/test-platform/server/identity/index.mjs'
import { Settings } from './settings.mjs'
import { ModelGateway } from './model.mjs'
import { mapExternalEnvironment } from './environment.mjs'
import { observeEgress } from './egress.mjs'
import { ScheduleState, dueOrchestrations } from './orchestration-schedule.mjs'
import { buildInsights, missionInsights, runsInWindow } from './insights.mjs'
import { SYSTEM_VERSION, evaluateSystem, questById, systemFacts } from './system.mjs'
import { SystemProgress } from './system-progress.mjs'
import { planDispatch } from './dispatch-intent.mjs'
import { runnerIsOnline } from '../../packages/test-platform/server/runner/placement.mjs'
import { AGENT_CATEGORIES } from './agent-presets.mjs'
import {
  adminConfigBody,
  dispatchPlanBody,
  flightDraftBody,
  egressActivateBody,
  loginBody,
  missionApproveBody,
  missionCancelBody,
  missionFollowupBody,
  missionStartBody,
  missionSyncBody,
  SYNCED_MISSION_BYTES,
  modelTurnBody,
  orchestrationPreviewBody,
  parseBody,
  probeBody,
  systemClaimBody,
  systemSeenBody,
  systemSignalBody
} from './schemas.mjs'
import {
  GATE_METRICS,
  NODE_TYPES,
  OrchestrationError,
  PREFLIGHT_CHECKS,
  STAGES,
  validateOrchestration
} from '../../packages/graph/orchestration.mjs'
import { compileOrchestration } from '../../packages/runtime/orchestration-graph.mjs'
import { RigError, TOOL_NAMES, safeMessage } from '../../packages/contracts/index.mjs'
import { MissionStore } from '../../packages/runtime/store.mjs'
import { RigRuntime } from '../../packages/runtime/engine.mjs'
import { ToolExecutor, DEFINITIONS, TOOL_GROUPS } from '../../packages/runtime/tools.mjs'
import { syncDesignAssets } from '../../scripts/design-assets.mjs'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { PgMissionStore } from './pg-missions.mjs'
import { PgDocument } from './state-documents.mjs'
import { SharedScheduleState } from './orchestration-schedule.mjs'
import { InProcessClient } from './in-process-client.mjs'
import { FileProcedureStore, PgProcedureStore, Procedures } from './procedure-store.mjs'
import { procedureRoutes } from './procedure-routes.mjs'
import { procedureTaskRoutes, stationRoutes } from './station-routes.mjs'
import {
  FileFireStore,
  HOOK_PRINCIPAL,
  HookRules,
  HookRunner,
  PgFireStore,
  hookRoutes
} from './hooks.mjs'
import { importLegacyState } from './legacy-import.mjs'
import { draftFlightPlan } from './flight-director.mjs'
import { exportPlaywright } from '../../packages/runtime/export.mjs'

// Server-side runtimes kept per member. They are cheap to rebuild — nothing a
// paused or finished mission needs lives in them — so past this many, idle
// ones are dropped rather than anyone being refused.
const RUNTIME_CACHE = 200
// How often this replica renews its claim on the missions it executes and
// learns about stops requested elsewhere; and how often it closes missions
// whose executing replica has gone quiet.
const HEARTBEAT_MS = 5_000
const SWEEP_MS = 30_000
const SERVICE_PRINCIPAL = Object.freeze({
  kind: 'service',
  id: 'service-admin',
  displayName: '服务管理员',
  role: 'admin'
})

const root = fileURLToPath(new URL('../../', import.meta.url))
// Drawing a graph must never execute one. These handlers exist so a spec can
// be compiled purely for its shape.
const COMPILE_PROBE = Object.freeze({
  prepareTool: async () => ({}),
  branch: async () => {},
  fanout: async () => {},
  subflow: async () => ({}),
  checkpoint: async () => {},
  analyze: async () => ({}),
  finish: async () => '',
  act: async () => ({}),
  rejected: async () => {},
  conclude: async () => {},
  preflight: async () => ({}),
  dispatchFlight: async () => ({}),
  awaitFlight: async () => ({}),
  explore: async () => ({}),
  gate: async () => ({}),
  debrief: async () => ({}),
  scrub: async () => {},
  nogo: async () => {}
})
const webRoot = fileURLToPath(new URL('../web/', import.meta.url))
export function configuration(env = process.env) {
  const mapped = mapExternalEnvironment(env, {})
  mapped.MXT_HOST ||= '127.0.0.1'
  mapped.MXT_PORT ||= '8791'
  mapped.MXT_ARTIFACTS_DIR ||= resolve(root, '.runtime/artifacts')
  mapped.MXT_SELF_URL ||= 'http://127.0.0.1:8791'
  const config = loadConfig(mapped)
  if (!config.adminToken)
    throw new RigError(
      'admin_required',
      '必须配置 MX_RIG_ADMIN_TOKEN；本地体验使用 npm run dev',
      500
    )
  return config
}

export async function start(env = process.env, options = {}) {
  const config = options.config || configuration(env)
  await syncDesignAssets({ readOnly: env.NODE_ENV === 'production' })
  const kernel = await createRuntime(config, { schedule: options.schedule ?? true })
  const dataRoot = resolve(env.MX_RIG_STATE_DIR || resolve(root, '.runtime/control'))
  // With PostgreSQL, the control plane's own state lives next to the test
  // domain and every replica sees the same missions, policy and schedule.
  // Memory mode (local development, tests) keeps the single-process files.
  const shared = config.storeDriver === 'postgres'
  const pool = shared ? kernel.store.pool : null
  const instance = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
  if (shared) await importLegacyState({ pool, dataRoot })
  const settings = await new Settings(
    shared ? new PgDocument(pool, 'settings') : resolve(dataRoot, 'settings.json')
  ).init()
  const missions = shared
    ? await new PgMissionStore(pool, { instance }).init()
    : await new MissionStore(resolve(dataRoot, 'missions')).init()
  const procedures = new Procedures(
    shared
      ? new PgProcedureStore(pool)
      : await new FileProcedureStore(resolve(dataRoot, 'procedures')).init()
  )
  const progress = await new SystemProgress(
    shared ? new PgDocument(pool, 'system-progress') : resolve(dataRoot, 'system-progress.json')
  ).init()
  const gateway = new ModelGateway(settings, options.modelOptions)
  const runtimes = new Map()
  // Built once from the same module the runtime compiles, so the drawing and
  // the execution can never describe different graphs.
  const missionShape = new RigRuntime({
    store: missions,
    client: null,
    executor: new ToolExecutor(null),
    owner: 'shape'
  }).describe()
  let origin
  let sameServer = () => false
  const newRuntime = (principal) => {
    const client = new InProcessClient({ principal, kernel, settings, gateway })
    return new RigRuntime({
      store: missions,
      client,
      executor: new ToolExecutor(client),
      owner: principal.id
    })
  }
  /**
   * The member's runtime on this replica, created on first use. It acts as the
   * member in-process — no token is kept — and holds only what it is
   * executing right now, so it can be rebuilt on any replica at any time.
   */
  const runtimeFor = (principal) => {
    const existing = runtimes.get(principal.id)
    if (existing) {
      runtimes.delete(principal.id)
      runtimes.set(principal.id, existing)
      return existing
    }
    if (runtimes.size >= RUNTIME_CACHE)
      for (const [owner, runtime] of runtimes) {
        if (runtime.active) continue
        runtimes.delete(owner)
        runtime.close().catch(() => {})
        if (runtimes.size < RUNTIME_CACHE) break
      }
    if (runtimes.size >= RUNTIME_CACHE)
      throw new RigError('session_limit', '同时执行的任务过多，请稍后再试', 429)
    const runtime = newRuntime(principal)
    runtimes.set(principal.id, runtime)
    return runtime
  }
  // Unattended orchestrations. They run as the service principal, on their own
  // runtime, and only one at a time: a schedule that overlaps itself would
  // queue missions nobody asked for.
  const scheduleState = await (
    shared
      ? new SharedScheduleState(pool, { claimant: instance })
      : new ScheduleState(resolve(dataRoot, 'schedule.json'))
  ).init()
  // 钩子: rules in a shared document, what they did in its own log, and one
  // runtime of their own so a hook never competes with a member's mission.
  const hookRules = await new HookRules(
    shared ? new PgDocument(pool, 'hooks') : resolve(dataRoot, 'hooks.json')
  ).init()
  const hookFires = shared
    ? new PgFireStore(pool)
    : await new FileFireStore(resolve(dataRoot, 'hook-fires.json')).init()
  let hookRuntime = null
  const hooks = new HookRunner({
    rules: hookRules,
    fires: hookFires,
    kernel,
    missions,
    runtime: () => (hookRuntime ??= newRuntime(HOOK_PRINCIPAL))
  })
  let hookTimer = null
  let scheduler = null
  let heartbeat = null
  let sweeper = null
  let scheduleRuntime = null
  const tick = async (now = new Date()) => {
    await settings.refresh()
    await scheduleState.refresh()
    const due = dueOrchestrations(settings.value.orchestrations || [], scheduleState.value, now)
    if (!due.length) return []
    scheduleRuntime ??= newRuntime(SERVICE_PRINCIPAL)
    const started = []
    for (const { spec, firedFor } of due) {
      if (scheduleRuntime.active) break
      // Claimed before the mission starts: a tick that overlaps the next one
      // must not fire the same slot twice, even if starting fails — and with
      // several replicas, only the one whose claim lands fires it at all.
      if (!(await scheduleState.claim(spec.key, firedFor))) continue
      try {
        started.push(
          await scheduleRuntime.start({
            mode: 'orchestration',
            goal: `定时执行编排：${spec.displayName}`,
            orchestrationKey: spec.key,
            inputs: {}
          })
        )
      } catch (error) {
        console.error(`定时编排 ${spec.key} 启动失败：${safeMessage(error)}`)
      }
    }
    return started
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    if (path === '/') {
      res.writeHead(302, { location: '/rig/' })
      res.end()
      return
    }
    if (path === '/rig' || path.startsWith('/rig/')) {
      const files = {
        '/rig': 'index.html',
        '/rig/': 'index.html',
        '/rig/app.js': 'app.js',
        '/rig/views.js': 'views.js',
        '/rig/graph-view.js': 'graph-view.js',
        '/rig/style.css': 'style.css',
        '/rig/activity.js': 'activity.js',
        '/rig/replay.js': 'replay.js',
        '/rig/replay.css': 'replay.css',
        // Served from the copy the design sync wrote, so the workbench and the
        // test console cannot end up on two versions of the design system.
        '/rig/vendor/styles.css': 'vendor/styles.css',
        '/rig/vendor/tokens.css': 'vendor/tokens.css'
      }
      if (!files[path]) {
        res.writeHead(404)
        res.end()
        return
      }
      const file = files[path]
      try {
        const body = await readFile(resolve(webRoot, file))
        res.writeHead(200, {
          'content-type': file.endsWith('.css')
            ? 'text/css'
            : file.endsWith('.js')
              ? 'text/javascript'
              : 'text/html; charset=utf-8',
          // Revalidate every load. These files change with the deployment and
          // carry no version in their path, so a heuristically cached copy
          // leaves an operator on an older workbench than the API they are
          // talking to.
          'cache-control': 'no-cache',
          'content-security-policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          'x-content-type-options': 'nosniff'
        })
        res.end(body)
      } catch {
        res.writeHead(500)
        res.end()
      }
      return
    }
    // Preserve the complete, separately owned test API and classic console.
    if (!path.startsWith('/api/rig/')) {
      if (path === '/test-center/') req.url = '/'
      return kernel.app(req, res)
    }
    try {
      if (req.headers.origin && !sameServer(req.headers.origin))
        throw new RigError('origin_denied', '请求来源不允许', 403)
      if (
        req.method === 'POST' &&
        !String(req.headers['content-type'] || '').startsWith('application/json')
      )
        throw new RigError('json_required', '请求需要 JSON', 415)
      const source = directClientAddress(req)
      if (path === '/api/rig/v1/login' && req.method === 'POST') {
        const body = parseBody(loginBody, await readJson(req, 16_000))
        const result = await kernel.identity.login({
          username: body.account,
          password: body.password,
          source
        })
        // Browser clients only receive an HttpOnly cookie. Native login uses its own route below.
        sendJson(
          res,
          200,
          { member: result.member },
          {
            'set-cookie': sessionCookie(result.token, {
              secure: config.secureCookies,
              ...(result.expiresIn ? { maxAgeSeconds: result.expiresIn } : {})
            })
          }
        )
        return
      }
      if (path === '/api/rig/v1/native-login' && req.method === 'POST') {
        if (req.headers.origin) throw new RigError('native_only', '使用工作台登录入口', 403)
        const body = parseBody(loginBody, await readJson(req, 16_000))
        const result = await kernel.identity.login({
          username: body.account,
          password: body.password,
          source
        })
        sendJson(res, 200, result)
        return
      }
      // A station reporting a procedure batch holds a run token, not a
      // member session.
      if (
        await stationRoutes({
          req,
          res,
          path,
          kernel,
          procedures,
          settings,
          bearer: bearerToken,
          readJson,
          sendJson
        })
      )
        return
      const token = bearerToken(req)
      const principal = await kernel.identity.resolve(token, source)
      // Another replica may have saved new settings; at most one version
      // check per second per replica.
      await settings.refresh()
      if (
        await procedureTaskRoutes({
          req,
          res,
          path,
          principal,
          kernel,
          procedures,
          readJson,
          sendJson
        })
      )
        return
      if (path === '/api/rig/v1/me' && req.method === 'GET') {
        sendJson(res, 200, { principal })
        return
      }
      if (path === '/api/rig/v1/config' && req.method === 'GET') {
        sendJson(res, 200, settings.public())
        return
      }
      if (
        await hookRoutes({
          req,
          res,
          path,
          principal,
          hooks,
          settings,
          requireRole,
          parseBody,
          readJson,
          sendJson
        })
      )
        return
      if (
        await procedureRoutes({
          req,
          res,
          path,
          url,
          principal,
          procedures,
          kernel,
          missions,
          readJson,
          sendJson
        })
      )
        return
      if (path === '/api/rig/v1/tools' && req.method === 'GET') {
        const allowed = settings.value.allowedTools
        sendJson(res, 200, {
          groups: TOOL_GROUPS,
          categories: AGENT_CATEGORIES,
          tools: DEFINITIONS.map(({ name, title, group, description, effect, local, workspace }) => ({
            name,
            title,
            group,
            description,
            effect,
            surface: local ? 'desktop' : workspace ? 'terminal' : 'internal',
            allowed: allowed.includes(name)
          }))
        })
        return
      }
      if (path === '/api/rig/v1/insights' && req.method === 'GET') {
        // Read through the kernel's store rather than over HTTP: this is one
        // page's worth of aggregation, and a round trip per collection would
        // make the dashboard the slowest thing in the product.
        const days = Math.min(90, Math.max(1, Number(url.searchParams.get('window')) || 14))
        const timeZone = url.searchParams.get('timezone') || 'Asia/Shanghai'
        const now = new Date()
        const [runs, apps, tasks, runners] = await Promise.all([
          kernel.store.listRuns({ limit: 200 }),
          kernel.store.listApps(),
          kernel.store.listTasks(),
          kernel.store.listRunners()
        ])
        const cases = (await Promise.all(apps.map((app) => kernel.store.listCases(app.id)))).flat()
        // Case-level health reads the most recent decided runs only. The whole
        // window would be one query per run, which is the wrong trade for a
        // page someone refreshes.
        const sampled = runsInWindow(runs, {
          from: new Date(now.getTime() - days * 86_400_000),
          to: now
        })
          .filter((run) => ['passed', 'failed', 'flaky'].includes(run.status))
          .slice(0, 40)
        const runCasesByRun = new Map(
          await Promise.all(
            sampled.map(async (run) => [run.id, await kernel.store.listRunCases(run.id)])
          )
        )
        // Server and desktop missions share one record now, so what the
        // Agents concluded and checked can sit next to the test numbers.
        const recentMissions = await missions.recent({
          since: new Date(now.getTime() - days * 86_400_000).toISOString(),
          limit: 500
        })
        const operator = ['operator', 'admin'].includes(principal.role)
        sendJson(res, 200, {
          insights: {
            ...buildInsights({
              runs,
              cases,
              tasks,
              apps,
              runners: runners.map((runner) => ({ ...runner, online: runnerIsOnline(runner) })),
              runCasesByRun,
              windowDays: days,
              timeZone,
              now
            }),
            missions: missionInsights(recentMissions, { windowDays: days, now, detail: operator })
          },
          sampledRuns: sampled.length,
          sample: { runLimit: 200, caseRunLimit: 40, potentiallyTruncated: runs.length === 200 }
        })
        return
      }
      if (path.startsWith('/api/rig/v1/system')) {
        // The tutorial is for everyone who can log in, viewers included: it
        // teaches the product, and reading it changes nothing.
        const state = async () => {
          const [runs, apps, tasks, runners] = await Promise.all([
            kernel.store.listRuns({ limit: 200 }),
            kernel.store.listApps(),
            kernel.store.listTasks(),
            kernel.store.listRunners()
          ])
          await progress.refresh()
          const entry = progress.get(principal.id)
          return evaluateSystem({
            facts: systemFacts({
              apps,
              tasks,
              runs,
              runners: runners.map((runner) => ({ ...runner, online: runnerIsOnline(runner) })),
              missions: await missions.list(principal.id),
              config: { ...settings.public(), egress: settings.egress(env) },
              signals: entry.signals
            }),
            progress: entry
          })
        }
        if (path === '/api/rig/v1/system' && req.method === 'GET') {
          sendJson(res, 200, { system: await state() })
          return
        }
        if (path === '/api/rig/v1/system/signal' && req.method === 'POST') {
          const body = parseBody(systemSignalBody, await readJson(req, 2000))
          await progress.signal(principal.id, body.signal)
          sendJson(res, 200, { system: await state() })
          return
        }
        if (path === '/api/rig/v1/system/claim' && req.method === 'POST') {
          const body = parseBody(systemClaimBody, await readJson(req, 2000))
          if (!questById(body.questId)) throw new RigError('quest_unknown', '任务不存在', 404)
          // Verification is recomputed here, from platform state — the request
          // only says which quest is being claimed, never that it is done.
          const before = await state()
          const quest = before.quests.find((entry) => entry.id === body.questId)
          await progress.claim(principal.id, body.questId, Boolean(quest?.done))
          sendJson(res, 200, { system: await state(), claimed: body.questId })
          return
        }
        if (path === '/api/rig/v1/system/seen' && req.method === 'POST') {
          const body = parseBody(systemSeenBody, await readJson(req, 2000))
          await progress.seen(principal.id, body.version || SYSTEM_VERSION)
          sendJson(res, 200, { system: await state() })
          return
        }
      }
      if (path === '/api/rig/v1/flight-plans:draft' && req.method === 'POST') {
        // A sentence becomes a draft flight plan. Nothing runs: the member
        // reviews it, then runs it once or (as admin) saves it.
        requireRole(principal, 'operator')
        const body = parseBody(flightDraftBody, await readJson(req, 8000))
        const [apps, tasks] = await Promise.all([kernel.store.listApps(), kernel.store.listTasks()])
        const suites = (
          await Promise.all(apps.map((app) => kernel.store.listSuites(app.id)))
        ).flat()
        const policy = settings.value
        const controller = new AbortController()
        res.on('close', () => {
          if (!res.writableEnded) controller.abort()
        })
        const draft = await draftFlightPlan({
          text: body.text,
          tasks,
          apps,
          suites,
          procedures: await procedures.list(),
          desktop: body.surface === 'desktop',
          // A site nobody listed is asked about in the mission, so the tools
          // being on is enough — unless the admin allows the list only.
          browserReady:
            policy.allowedTools.includes('browser_open') &&
            (policy.browserSites !== 'list' || policy.browserOrigins.length > 0),
          browserOrigins: policy.browserOrigins,
          browserSites: policy.browserSites,
          turn: settings.public().model.configured
            ? (turnBody, signal) => gateway.turn(principal.id, turnBody, signal)
            : null,
          signal: controller.signal
        })
        const { expanded, warnings } = validateOrchestration(draft.spec, {
          resolve: settings.resolver()
        })
        sendJson(res, 200, {
          draft: {
            ...draft,
            warnings: [...draft.warnings, ...warnings],
            graph: compileOrchestration(expanded, COMPILE_PROBE, { layout: {} }).describe()
          }
        })
        return
      }
      if (path === '/api/rig/v1/dispatch:plan' && req.method === 'POST') {
        requireRole(principal, 'operator')
        const body = parseBody(dispatchPlanBody, await readJson(req, 8000))
        const [apps, tasks, runners] = await Promise.all([
          kernel.store.listApps(),
          kernel.store.listTasks(),
          kernel.store.listRunners()
        ])
        const config = settings.public()
        // Planning only reads catalogues the member can already see, calls no
        // model, and starts nothing: the result is a request body they confirm.
        sendJson(res, 200, {
          plan: planDispatch({
            text: body.text,
            apps,
            tasks: tasks.filter((task) => task.enabled !== false),
            orchestrations: config.orchestrations,
            agents: config.agents,
            runnersOnline: runners.filter((runner) => runnerIsOnline(runner)).length,
            modelConfigured: config.model.configured,
            native: body.surface === 'desktop'
          })
        })
        return
      }
      if (path === '/api/rig/v1/graph' && req.method === 'GET') {
        // The shape the orchestration view draws comes from the compiled graph
        // the runtime executes, not from a diagram kept alongside it.
        const wanted = url.searchParams.get('orchestration')
        sendJson(res, 200, {
          graph: wanted
            ? compileOrchestration(settings.expanded(wanted), COMPILE_PROBE).describe()
            : missionShape,
          nodeTypes: NODE_TYPES,
          // The flight-plan vocabulary, so the editor never keeps a second copy.
          flight: { stages: STAGES, gateMetrics: GATE_METRICS, preflightChecks: PREFLIGHT_CHECKS }
        })
        return
      }
      if (path === '/api/rig/v1/admin/orchestrations:preview' && req.method === 'POST') {
        requireRole(principal, 'admin')
        const body = parseBody(orchestrationPreviewBody, await readJson(req, 64_000))
        // Compile the draft without storing it, so the editor can show the
        // real graph and the real error while it is still being written.
        try {
          const { spec, expanded, warnings } = validateOrchestration(body.orchestration, {
            toolNames: TOOL_NAMES,
            agentKeys: settings.value.agents.map((agent) => agent.key),
            // A draft may reference a saved subflow, so resolve against what
            // is stored — the draft itself is not in that list yet.
            resolve: settings.resolver()
          })
          sendJson(res, 200, {
            graph: compileOrchestration(expanded, COMPILE_PROBE).describe(),
            warnings,
            spec
          })
        } catch (error) {
          throw error instanceof OrchestrationError
            ? new RigError('invalid_orchestration', error.message)
            : new RigError(
                'invalid_orchestration',
                `编排结构无效（${error?.issues?.[0]?.path?.join('.') ?? ''}${error?.issues?.[0]?.message ?? '格式不符'}）`
              )
        }
        return
      }
      if (path === '/api/rig/v1/egress' && req.method === 'GET') {
        requireRole(principal, 'operator')
        sendJson(res, 200, {
          egress: observeEgress({ env, hostname: hostname(), managed: settings.egress(env) }),
          note: 'MX Rig 只为自己的模型调用与隔离浏览器选择通道；不设置系统代理、路由、DNS、PAC 或 NRPT。'
        })
        return
      }
      if (path === '/api/rig/v1/admin/egress:activate' && req.method === 'POST') {
        requireRole(principal, 'admin')
        const body = parseBody(egressActivateBody, await readJson(req, 4000))
        // A switch is a policy change: it issues a new revision, so approvals
        // reviewed against the previous channel stop being valid.
        const config = await settings.activateEgress(body.activeId ?? null)
        sendJson(res, 200, { config, egress: settings.egress(env) })
        return
      }
      if (path === '/api/rig/v1/execution-config' && req.method === 'GET') {
        requireRole(principal, 'operator')
        // The local Runtime needs the browser channel's address to launch its
        // isolated browser on it; `/config` deliberately withholds endpoints.
        sendJson(res, 200, settings.public({ egressEndpoints: true }))
        return
      }
      if (path === '/api/rig/v1/admin/config') {
        requireRole(principal, 'admin')
        if (req.method === 'GET') {
          sendJson(res, 200, settings.value)
          return
        }
        if (req.method === 'POST') {
          const body = parseBody(adminConfigBody, await readJson(req, 256_000))
          sendJson(res, 200, await settings.update(body))
          return
        }
      }
      if (path === '/api/rig/v1/admin/providers:probe' && req.method === 'POST') {
        requireRole(principal, 'admin')
        const body = parseBody(probeBody, await readJson(req, 4000))
        const controller = new AbortController()
        res.on('close', () => {
          if (!res.writableEnded) controller.abort()
        })
        sendJson(res, 200, { probe: await gateway.probe(body.providerId, controller.signal) })
        return
      }
      if (path === '/api/rig/v1/model/turn' && req.method === 'POST') {
        requireRole(principal, 'operator')
        const controller = new AbortController()
        res.on('close', () => {
          if (!res.writableEnded) controller.abort()
        })
        // Room for one inline screenshot for a vision-capable provider.
        const body = parseBody(modelTurnBody, await readJson(req, 2_000_000))
        sendJson(res, 200, await gateway.turn(principal.id, body, controller.signal))
        return
      }
      if (path === '/api/rig/v1/model/turn:stream' && req.method === 'POST') {
        requireRole(principal, 'operator')
        const controller = new AbortController()
        res.on('close', () => {
          if (!res.writableEnded) controller.abort()
        })
        const body = parseBody(modelTurnBody, await readJson(req, 2_000_000))
        // NDJSON, one event per line: any number of `{delta}` lines, then one
        // `{message}` line. Headers go out on the first write, so a failure
        // before the first token still answers with a normal status and JSON
        // error instead of a 200 that contains an apology.
        let open = false
        const start = () => {
          if (open) return
          open = true
          res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store',
            // A buffering reverse proxy would turn this back into one blob.
            'x-accel-buffering': 'no'
          })
        }
        try {
          const result = await gateway.turn(principal.id, body, controller.signal, (delta) => {
            start()
            res.write(`${JSON.stringify({ delta })}\n`)
          })
          start()
          res.write(`${JSON.stringify(result)}\n`)
          res.end()
        } catch (error) {
          if (!open) throw error
          res.write(
            `${JSON.stringify({
              error: {
                code: error.code || 'model_error',
                message: error.status && error.status < 500 ? error.message : safeMessage(error)
              }
            })}\n`
          )
          res.end()
        }
        return
      }
      if (path === '/api/rig/v1/logout' && req.method === 'POST') {
        // Ends a Rig-issued session on the server; a Launcher token or the
        // service admin token is left alone. Missions are not tied to a
        // session any more: one started from this browser keeps its state and
        // can be picked up after the next sign-in, from any workbench.
        await kernel.identity.logout(token)
        sendJson(
          res,
          200,
          { ok: true },
          { 'set-cookie': clearSessionCookie({ secure: config.secureCookies }) }
        )
        return
      }
      if (path === '/api/rig/v1/missions' && req.method === 'GET') {
        sendJson(res, 200, { missions: await missions.list(principal.id) })
        return
      }
      const exportMatch = /^\/api\/rig\/v1\/missions\/([a-f0-9-]{36})\/export$/.exec(path)
      if (exportMatch && req.method === 'GET') {
        // Reading one's own mission as a script draft changes nothing, so it
        // needs no more than being able to see the mission.
        const row = await missions.get(exportMatch[1], principal.id)
        sendJson(res, 200, { export: exportPlaywright(missions.public(row)) })
        return
      }
      requireRole(principal, 'operator')
      if (path === '/api/rig/v1/missions:sync' && req.method === 'POST') {
        // A desktop reporting what its own Runtime ran, so the team and the
        // web workbench see it too. Stored for reading; never executed here.
        const body = parseBody(missionSyncBody, await readJson(req, 20 * SYNCED_MISSION_BYTES))
        for (const entry of body.missions)
          if (Buffer.byteLength(JSON.stringify(entry)) > SYNCED_MISSION_BYTES)
            throw new RigError('mission_too_large', '单项任务记录超过同步上限', 413)
        sendJson(res, 200, { synced: await missions.syncDesktop(principal.id, body.missions) })
        return
      }
      const runtime = runtimeFor(principal)
      if (path === '/api/rig/v1/missions' && req.method === 'POST') {
        const body = parseBody(missionStartBody, await readJson(req, 16_000))
        sendJson(res, 201, { mission: await runtime.start(body) })
        return
      }
      const match = /^\/api\/rig\/v1\/missions\/([a-f0-9-]{36})\/(approve|cancel|followup)$/.exec(
        path
      )
      if (match && req.method === 'POST') {
        const raw = await readJson(req, 16_000)
        const schema = {
          approve: missionApproveBody,
          cancel: missionCancelBody,
          followup: missionFollowupBody
        }[match[2]]
        const body = parseBody(schema, raw)
        const mission =
          match[2] === 'followup'
            ? await runtime.followup(match[1], body)
            : match[2] === 'cancel'
              ? await runtime.cancel(match[1])
              : await runtime.approve(match[1], body.approvalId, body.approved)
        sendJson(res, 200, { mission })
        return
      }
      throw new RigError('not_found', '接口不存在', 404)
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        sendJson(res, error.status || 500, {
          error: {
            code: error.code || 'internal_error',
            message: error.status && error.status < 500 ? error.message : safeMessage(error)
          }
        })
    }
  })
  await new Promise((yes, no) => {
    server.once('error', no)
    server.listen(config.port, config.host, yes)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  // The pages this server serves itself, under every name that reaches it:
  // its public address, and this machine's loopback names on its own port —
  // a service opened to the LAN is still opened as 127.0.0.1 on its own host.
  // No other site can be served from these, so cross-site requests stay out.
  const own = new Set(
    [config.publicUrl || origin, origin, `http://localhost:${server.address().port}`, `http://[::1]:${server.address().port}`].filter(
      Boolean
    )
  )
  sameServer = (value) => own.has(String(value).replace(/\/$/, ''))
  if (shared) {
    // Renew this replica's claim on what it executes, and stop anything
    // someone asked to stop from another replica while it was mid-call.
    heartbeat = setInterval(() => {
      missions
        .heartbeat()
        .then((ids) => {
          for (const id of ids)
            for (const runtime of [...runtimes.values(), scheduleRuntime, hookRuntime])
              if (runtime?.interrupt(id)) break
        })
        .catch((error) => console.error(`任务心跳失败：${safeMessage(error)}`))
    }, HEARTBEAT_MS).unref()
    sweeper = setInterval(() => {
      missions.sweep().catch((error) => console.error(`任务回收失败：${safeMessage(error)}`))
    }, SWEEP_MS).unref()
  }
  if (options.schedule ?? true)
    hookTimer = setInterval(
      () => {
        hooks.tick().catch((error) => console.error(`钩子检查失败：${safeMessage(error)}`))
      },
      Number(env.MX_RIG_HOOK_TICK_MS) || 20_000
    ).unref()
  if (options.schedule ?? true)
    scheduler = setInterval(
      () => {
        tick().catch((error) => console.error(`定时编排检查失败：${safeMessage(error)}`))
      },
      Number(env.MX_RIG_ORCHESTRATION_TICK_MS) || 30_000
    ).unref()
  return {
    server,
    kernel,
    settings,
    missions,
    origin,
    scheduleState,
    tick,
    hooks,
    instance,
    async close() {
      if (hookTimer) clearInterval(hookTimer)
      if (scheduler) clearInterval(scheduler)
      if (heartbeat) clearInterval(heartbeat)
      if (sweeper) clearInterval(sweeper)
      await scheduleRuntime?.close()
      await hookRuntime?.close()
      kernel.stopScheduler()
      await Promise.all([...runtimes.values()].map((runtime) => runtime.close()))
      await new Promise((yes) => server.close(yes))
      await kernel.store.close()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await start()
  console.log(`MX Rig Internal service: ${runtime.origin}/rig/`)
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () =>
      runtime.close().catch(() => {
        process.exitCode = 1
      })
    )
}
