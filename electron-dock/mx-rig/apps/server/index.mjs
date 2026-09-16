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
import { buildInsights } from './insights.mjs'
import { SYSTEM_VERSION, evaluateSystem, questById, systemFacts } from './system.mjs'
import { SystemProgress } from './system-progress.mjs'
import { planDispatch } from './dispatch-intent.mjs'
import { runnerIsOnline } from '../../packages/test-platform/server/runner/placement.mjs'
import { AGENT_CATEGORIES } from './agent-presets.mjs'
import {
  adminConfigBody,
  dispatchPlanBody,
  egressActivateBody,
  loginBody,
  missionApproveBody,
  missionCancelBody,
  missionFollowupBody,
  missionStartBody,
  modelTurnBody,
  orchestrationPreviewBody,
  parseBody,
  probeBody,
  systemClaimBody,
  systemSeenBody,
  systemSignalBody
} from './schemas.mjs'
import {
  NODE_TYPES,
  OrchestrationError,
  validateOrchestration
} from '../../packages/graph/orchestration.mjs'
import { compileOrchestration } from '../../packages/runtime/orchestration-graph.mjs'
import { RigError, TOOL_NAMES, safeMessage } from '../../packages/contracts/index.mjs'
import { MissionStore } from '../../packages/runtime/store.mjs'
import { RigRuntime } from '../../packages/runtime/engine.mjs'
import { RigClient } from '../../packages/runtime/client.mjs'
import { ToolExecutor, DEFINITIONS, TOOL_GROUPS } from '../../packages/runtime/tools.mjs'
import { syncDesignAssets } from '../../scripts/design-assets.mjs'
import { hostname } from 'node:os'

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
  conclude: async () => {}
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
  await syncDesignAssets()
  const kernel = await createRuntime(config, { schedule: options.schedule ?? true })
  const dataRoot = resolve(env.MX_RIG_STATE_DIR || resolve(root, '.runtime/control'))
  const settings = await new Settings(resolve(dataRoot, 'settings.json')).init()
  const missions = await new MissionStore(resolve(dataRoot, 'missions')).init()
  const progress = await new SystemProgress(resolve(dataRoot, 'system-progress.json')).init()
  const gateway = new ModelGateway(settings, options.modelOptions)
  const sessions = new Map()
  // Built once from the same module the runtime compiles, so the drawing and
  // the execution can never describe different graphs.
  const missionShape = new RigRuntime({
    store: missions,
    client: null,
    executor: new ToolExecutor(null),
    owner: 'shape'
  }).describe()
  let origin
  const runtimeFor = (principal) => {
    const owner = principal.id
    let entry = sessions.get(owner)
    if (!entry) throw new RigError('session_missing', '请重新登录', 401)
    return entry.runtime
  }
  const register = async (principal, token) => {
    const current = sessions.get(principal.id)
    if (current) {
      current.client.token = token
      return
    }
    if (sessions.size >= 40) throw new RigError('session_limit', '工作台会话已满', 429)
    const client = new RigClient({ url: origin, token })
    sessions.set(principal.id, {
      client,
      runtime: new RigRuntime({
        store: missions,
        client,
        executor: new ToolExecutor(client),
        owner: principal.id
      })
    })
  }
  // Unattended orchestrations. They run as the service principal, on their own
  // runtime, and only one at a time: a schedule that overlaps itself would
  // queue missions nobody asked for.
  const scheduleState = await new ScheduleState(resolve(dataRoot, 'schedule.json')).init()
  let scheduler = null
  let scheduleRuntime = null
  const tick = async (now = new Date()) => {
    const due = dueOrchestrations(settings.value.orchestrations || [], scheduleState.value, now)
    if (!due.length) return []
    if (!scheduleRuntime) {
      const client = new RigClient({ url: origin, token: config.adminToken })
      scheduleRuntime = new RigRuntime({
        store: missions,
        client,
        executor: new ToolExecutor(client),
        owner: (await kernel.identity.resolve(config.adminToken, '127.0.0.1')).id
      })
    }
    const started = []
    for (const { spec, firedFor } of due) {
      if (scheduleRuntime.active) break
      // Recorded before the mission starts: a tick that overlaps the next one
      // must not fire the same slot twice, even if starting fails.
      await scheduleState.record(spec.key, firedFor)
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
      if (req.headers.origin && req.headers.origin !== `${config.publicUrl || origin}`)
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
        const principal = await kernel.identity.resolve(result.token, source)
        await register(principal, result.token)
        // Browser clients only receive an HttpOnly cookie. Native login uses its own route below.
        sendJson(
          res,
          200,
          { member: result.member },
          { 'set-cookie': sessionCookie(result.token, { secure: config.secureCookies }) }
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
      const token = bearerToken(req)
      const principal = await kernel.identity.resolve(token, source)
      if (path === '/api/rig/v1/me' && req.method === 'GET') {
        sendJson(res, 200, { principal })
        return
      }
      if (path === '/api/rig/v1/config' && req.method === 'GET') {
        sendJson(res, 200, settings.public())
        return
      }
      if (path === '/api/rig/v1/tools' && req.method === 'GET') {
        const allowed = settings.value.allowedTools
        sendJson(res, 200, {
          groups: TOOL_GROUPS,
          categories: AGENT_CATEGORIES,
          tools: DEFINITIONS.map(({ name, title, group, description, effect, local }) => ({
            name,
            title,
            group,
            description,
            effect,
            surface: local ? 'desktop' : 'internal',
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
          kernel.store.listRuns({ limit: 400 }),
          kernel.store.listApps(),
          kernel.store.listTasks(),
          kernel.store.listRunners()
        ])
        const cases = (await Promise.all(apps.map((app) => kernel.store.listCases(app.id)))).flat()
        // Case-level health reads the most recent decided runs only. The whole
        // window would be one query per run, which is the wrong trade for a
        // page someone refreshes.
        const sampled = runs
          .filter((run) => ['passed', 'failed', 'flaky'].includes(run.status))
          .slice(0, 40)
        const runCasesByRun = new Map(
          await Promise.all(
            sampled.map(async (run) => [run.id, await kernel.store.listRunCases(run.id)])
          )
        )
        sendJson(res, 200, {
          insights: buildInsights({
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
          sampledRuns: sampled.length
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
          const entry = progress.get(principal.id)
          return evaluateSystem({
            facts: systemFacts({
              apps,
              tasks,
              runs,
              runners: runners.map((runner) => ({ ...runner, online: runnerIsOnline(runner) })),
              missions: missions.list(principal.id),
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
          nodeTypes: NODE_TYPES
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
        const body = parseBody(modelTurnBody, await readJson(req, 256_000))
        sendJson(res, 200, await gateway.turn(principal.id, body, controller.signal))
        return
      }
      if (path === '/api/rig/v1/model/turn:stream' && req.method === 'POST') {
        requireRole(principal, 'operator')
        const controller = new AbortController()
        res.on('close', () => {
          if (!res.writableEnded) controller.abort()
        })
        const body = parseBody(modelTurnBody, await readJson(req, 256_000))
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
        await sessions.get(principal.id)?.runtime.close()
        sessions.delete(principal.id)
        sendJson(
          res,
          200,
          { ok: true },
          { 'set-cookie': clearSessionCookie({ secure: config.secureCookies }) }
        )
        return
      }
      if (path === '/api/rig/v1/missions' && req.method === 'GET') {
        sendJson(res, 200, { missions: missions.list(principal.id) })
        return
      }
      requireRole(principal, 'operator')
      await register(principal, token)
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
    async close() {
      if (scheduler) clearInterval(scheduler)
      await scheduleRuntime?.close()
      kernel.stopScheduler()
      await Promise.all([...sessions.values()].map((s) => s.runtime.close()))
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
