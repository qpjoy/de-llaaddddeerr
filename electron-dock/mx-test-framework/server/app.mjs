import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

import { recordAudit } from './audit.mjs'
import { assertSchedulable } from './core/cron.mjs'
import { AppError } from './core/errors.mjs'
import {
  bearerToken,
  enumValue,
  gitRef,
  optionalString,
  readJson,
  readRawBody,
  relativeDir,
  requiredString,
  clearSessionCookie,
  routeMatch,
  sendJson,
  sessionCookie,
  stringArray,
  suiteCommand,
} from './core/http.mjs'
import { newToken, sha256 } from './core/ids.mjs'
import { sanitizeUrl } from './core/redact.mjs'
import { requireRole, ROLES } from './identity/index.mjs'
import { completeBuildRun, findBuildArtifact } from './ingest/build.mjs'
import { junitToSummary } from './ingest/junit.mjs'
import { NOTIFY_KINDS, adapterFor, redactChannel } from './notify/adapters.mjs'
import { enqueueForRun } from './notify/dispatch.mjs'
import { NOTIFY_EVENTS } from './notify/events.mjs'
import { compareWithCatalog, normalizeSourceRef, normalizeSummary } from './ingest/summary.mjs'
import { renderReport } from './report.mjs'
import {
  decryptSecret,
  encryptSecret,
  redactValues,
  requireSecretKey,
  resolveSuiteSecrets,
  secretName,
} from './secrets.mjs'
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
import { parsePush, taskBranch, verifySignature } from './webhooks.mjs'

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u
// The platform does not care what runs the tests, only that it reports through
// the contract (JUnit XML or summary.json, exit code 0/1/2). Each entry here
// exists to pick a default image and nothing else; `generic` covers everything
// not listed, and requires the suite to name its own image.
const ENGINES = ['cypress', 'playwright', 'playwright-electron', 'pytest', 'k6', 'generic']
const SURFACES = ['web', 'electron']
const RUNNER_KINDS = ['server', 'local']
// Where the system under test comes from. `self` means the suite starts its own
// target — 罗盘's `pnpm e2e:local` builds the SPA and serves it on loopback — so
// asking a task for a target URL would be asking for a value nothing reads.
const TARGET_MODES = ['external', 'self']
// What a suite produces. `build` runs a command on a capability-matched machine
// and keeps the artefact rather than a result — see ADR-0006. Declared now so
// that adding it later does not mean backfilling every stored suite.
const SUITE_KINDS = ['test', 'build']
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

  /** A suite of this app, addressed by slug or by id — whichever the caller has. */
  async function requireSuite(appId, ref) {
    const suites = await store.listSuites(appId)
    const suite = suites.find((entry) => entry.slug === ref || entry.id === ref)
    if (!suite) {
      throw new AppError(404, 'suite_not_found', `找不到套件 "${ref}"`, {
        hint: suites.length
          ? `这个应用现有套件：${suites.map((entry) => entry.slug).join('、')}`
          : '这个应用还没有登记任何套件。',
      })
    }
    return suite
  }

  /**
   * Why a run nobody has claimed is still sitting there.
   *
   * A run whose suite declares an engine no registered machine offers waits
   * forever, and the platform used to say only `pending-runner`. There is no
   * way to work that out from the outside: the engine list lives on the runner
   * registration, the requirement lives on the suite, and the match happens in
   * a SQL predicate. The first time it bit, the answer was a missing `generic`
   * in one runner's capabilities — five minutes of reading query plans to learn
   * something the platform already knew.
   *
   * Returns null for runs that are not waiting, so the field only appears when
   * it has something to say.
   */
  async function explainPending(run, suite) {
    if (!suite) return null
    if (run.status !== 'pending-runner' && run.status !== 'queued') return null
    if (suite.runnerKind !== 'local') return null

    const runners = await store.listRunners()
    const wantedOs = Array.isArray(suite.requirements?.os) ? suite.requirements.os : []
    const reasons = []
    const eligible = []
    for (const runner of runners) {
      const engines = runner.capabilities?.engines ?? []
      const surfaces = runner.capabilities?.surfaces ?? []
      const missing = []
      if (!engines.includes(suite.engine)) missing.push(`引擎 ${suite.engine}`)
      if (!surfaces.includes(suite.surface)) missing.push(`形态 ${suite.surface}`)
      if (wantedOs.length > 0 && !wantedOs.includes(runner.os)) {
        missing.push(`系统 ${wantedOs.join('/')}（这台是 ${runner.os}）`)
      }
      if (missing.length === 0) eligible.push(runner.name)
      else reasons.push({ runner: runner.name, missing })
    }

    if (eligible.length > 0) {
      return {
        eligibleRunners: eligible,
        message: `有 ${eligible.length} 台执行机能接：${eligible.join('、')}。还没被认领，通常是它们没在运行 mxt-runner watch。`,
      }
    }
    if (runners.length === 0) {
      return {
        eligibleRunners: [],
        rejected: [],
        message: '还没有任何执行机注册。在目标机器上运行 mxt-runner register。',
      }
    }
    return {
      eligibleRunners: [],
      rejected: reasons,
      message: `注册的 ${runners.length} 台执行机都不满足这条套件的要求：${reasons
        .map((entry) => `${entry.runner} 缺 ${entry.missing.join('、')}`)
        .join('；')}。`,
    }
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

  /**
   * Strictly the run-scoped token — a runner's long-lived token is refused.
   *
   * `requireRunScope` accepts either, which is right for uploading artifacts
   * and reporting a result: those are the runner's own work and a re-auth after
   * a crash is convenient. Credentials are different. ADR-0005's whole argument
   * is that a run-scoped, self-expiring token keeps the blast radius at "this
   * one execution"; letting a long-lived token fetch the same credentials
   * hands that back, because a leaked runner token would then be enough to read
   * the test account's password at any time.
   */
  async function requireRunToken(request, runId) {
    const presented = bearerToken(request)
    if (!presented) throw new AppError(401, 'unauthorized', '需要执行凭据')
    const run = await store.getRunByTokenHash(sha256(presented))
    if (run && run.id === runId) return run
    throw new AppError(403, 'forbidden', '下发密钥需要本次执行的 run token', {
      hint: '执行机的长期 token 不能用来取密钥。',
    })
  }

  /**
   * Create runs for every webhook task of this app whose branch matches.
   *
   * Two properties this has to hold:
   *
   * 1. **The run is pinned to the pushed commit.** That is the entire value of
   *    triggering on a push — "this result belongs to exactly that sha" — and
   *    without it the run would test whatever the branch tip happened to be by
   *    the time a machine picked it up.
   * 2. **The repository comes from the app record, never from the payload.**
   *    A delivery naming a different repo would otherwise be a way to make the
   *    platform fetch and execute someone else's code. The signature makes that
   *    unlikely; not reading the field makes it impossible.
   */
  async function triggerWebhookTasks({ app, push }) {
    const tasks = (await store.listTasks({ appId: app.id, enabled: true })).filter(
      (task) => task.scheduleKind === 'webhook',
    )
    const created = []

    for (const task of tasks) {
      const suite = await store.getSuite(task.suiteId)
      if (!suite) continue
      // A task fires only on the branch it would actually check out. Making
      // those two independent builds a trap: a task that runs on a push to one
      // branch while testing another.
      if (taskBranch({ suite, app }) !== push.branch) continue

      // Providers retry deliveries, and the same sha can arrive twice by other
      // routes as well. Re-running a commit on purpose is still possible — the
      // manual path does not go through here.
      const existing = await store.findRunByTaskAndSha(task.id, push.gitSha)
      if (existing) continue

      const now = new Date()
      const appPackage = suite.surface === 'electron' ? (app.latestPackage ?? null) : null
      const run = await store.createRun({
        appId: app.id,
        suiteId: suite.id,
        taskId: task.id,
        profile: task.profile,
        track: task.track,
        engine: suite.engine,
        status: suite.runnerKind === 'local' ? 'pending-runner' : 'queued',
        trigger: 'webhook',
        targetUrl: task.targetUrl,
        appPackage,
        sourceRef: { ref: push.branch, gitSha: push.gitSha },
        claimDeadline: claimDeadlineFor(task, suite, now),
        createdBy: 'webhook',
      })
      await store.updateTask(task.id, { lastRunId: run.id })
      created.push(run.id)
    }
    return created
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
      handler: async ({ principal, params, body, request }) => {
        requireRole(principal, 'admin')
        const role = enumValue(body, 'role', ROLES)
        const before = await store.getMember(params.principalId)
        const member = await store.setMemberRole(params.principalId, role)
        if (!member) throw new AppError(404, 'member_not_found', '找不到该成员')
        // Who can create a suite is who can decide what runs on real machines,
        // so a role change is part of the same trail as the suites themselves.
        await recordAudit(store, {
          principal,
          request,
          action: 'member.role_change',
          resourceType: 'member',
          resourceId: member.id ?? params.principalId,
          before: before ? { role: before.role } : null,
          after: { role: member.role },
        })
        return { status: 200, body: { member } }
      },
    },

    // -- apps & suites -------------------------------------------------------
    { method: 'GET', pattern: '/api/v1/apps', handler: async () => ({ status: 200, body: { apps: await store.listApps() } }) },
    {
      method: 'POST',
      pattern: '/api/v1/apps',
      handler: async ({ body, principal, request }) => {
        requireRole(principal, 'admin')
        const created = await store.createApp({
          slug: slug(body, 'slug'),
          displayName: requiredString(body, 'displayName'),
          repoUrl: optionalString(body, 'repoUrl', { maxLength: 500 }),
          // Which ref a run checks out when the run itself does not name one.
          // Named per app so that "test the release branch" and "test main"
          // are two apps' worth of configuration rather than two codebases.
          defaultBranch: gitRef(body, 'defaultBranch'),
          surfaces: stringArray(body.surfaces, { maxItems: 5, maxLength: 20 }).filter((entry) =>
            SURFACES.includes(entry),
          ),
          catalogGlob: optionalString(body, 'catalogGlob', { maxLength: 240 }),
        })
        // repoUrl and defaultBranch decide which code every suite of this app
        // checks out, so they belong in the same trail as the suites.
        await recordAudit(store, {
          principal,
          request,
          action: 'app.create',
          resourceType: 'app',
          resourceId: created.id,
          appId: created.id,
          after: created,
        })
        return { status: 201, body: { app: created } }
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/apps/:app/packages',
      handler: async ({ params, body, principal, request }) => {
        // Jenkins calls this after building a desktop installer. It publishes
        // the artefact and stops there — it does not start a test run. MXT
        // decides when to test, which is what keeps mx-base off MXT's critical
        // path (mx-base ADR-0001).
        requireRole(principal, 'operator')
        const app = await requireApp(params.app)
        const sha256 = requiredString(body, 'sha256', { maxLength: 64 })
        if (!/^[0-9a-f]{64}$/iu.test(sha256)) {
          throw new AppError(400, 'invalid_request', 'sha256 必须是 64 位十六进制')
        }
        const pkg = {
          // A runner downloads this and executes it, so the URL gets the same
          // scrutiny as any other target address.
          url: targetUrl(body, 'url', { required: true }),
          sha256: sha256.toLowerCase(),
          filename: optionalString(body, 'filename', { maxLength: 200 }),
          version: optionalString(body, 'version', { maxLength: 64 }),
          gitSha: optionalString(body, 'gitSha', { maxLength: 64 }),
          publishedAt: new Date().toISOString(),
        }
        const previous = app.latestPackage ?? null
        await store.setLatestPackage(app.id, pkg)
        // A published build is downloaded and executed on someone's own
        // machine. "Which build was that, who published it, and what did it
        // replace" has to be answerable afterwards.
        await recordAudit(store, {
          principal,
          request,
          action: 'package.publish',
          resourceType: 'package',
          resourceId: app.id,
          appId: app.id,
          before: previous,
          after: pkg,
        })
        return { status: 201, body: { package: pkg } }
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
      handler: async ({ params, body, principal, request }) => {
        requireRole(principal, 'admin')
        const app = await requireApp(params.app)
        const requirements = {}
        const os = stringArray(body.requirements?.os, { maxItems: 3, maxLength: 12 })
        if (os.length > 0) requirements.os = os
        const suite = await store.createSuite({
          appId: app.id,
          slug: slug(body, 'slug'),
          displayName: requiredString(body, 'displayName'),
          engine: enumValue(body, 'engine', ENGINES),
          surface: enumValue(body, 'surface', SURFACES),
          runnerKind: enumValue(body, 'runnerKind', RUNNER_KINDS, 'server'),
          runnerImage: optionalString(body, 'runnerImage', { maxLength: 240 }),
          // Where in the checkout this suite's project lives. po-frontend
          // keeps package.json and cypress/ under po-frontend/, so a suite
          // that assumed the repository root could not even install.
          workingDir: relativeDir(body, 'workingDir'),
          targetMode: enumValue(body, 'targetMode', TARGET_MODES, 'external'),
          kind: enumValue(body, 'kind', SUITE_KINDS, 'test'),
          // A test team's own repository, when the tests are not co-located
          // with the code under test. Falls back to the app's repo.
          repoUrl: optionalString(body, 'repoUrl', { maxLength: 500 }),
          defaultBranch: gitRef(body, 'defaultBranch'),
          // Where a `build` suite leaves what it built, relative to workingDir.
          // A glob so the repository under test needs no change: asking it to
          // copy the installer somewhere platform-specific would put this
          // platform back inside someone else's repo.
          artifactPath: optionalString(body, 'artifactPath', { maxLength: 240 }),
          requirements,
          command: suiteCommand(body.command),
          retryPolicy: {
            maxAttempts: Math.min(3, Math.max(1, Number(body.retryPolicy?.maxAttempts) || 1)),
          },
          secretRefs: stringArray(body.secretRefs, { maxItems: 10, maxLength: 120 }),
          writesData: body.writesData === true,
        })
        // The command, the image and the repository together decide what code
        // runs on a real machine holding a platform-issued token. This is the
        // record ADR-0007 promised when it removed the command allowlist.
        await recordAudit(store, {
          principal,
          request,
          action: 'suite.create',
          resourceType: 'suite',
          resourceId: suite.id,
          appId: app.id,
          after: suite,
        })
        return { status: 201, body: { suite } }
      },
    },
    {
      // Correct a suite that was registered wrong.
      //
      // Without this, an onboarding script's "already exists, skipping" was a
      // permanent decision: the only way to change a command or point a suite
      // at the test team's repository was to edit the database by hand. That is
      // not an operation a test lead can be asked to perform.
      //
      // Every field goes through the *same* validators as create — a suite that
      // could not have been registered this way must not be reachable by
      // patching either.
      method: 'PATCH',
      pattern: '/api/v1/apps/:app/suites/:suite',
      handler: async ({ params, body, principal, request }) => {
        requireRole(principal, 'admin')
        const app = await requireApp(params.app)
        const before = await requireSuite(app.id, params.suite)

        const patch = {}
        const put = (key, value) => {
          if (value !== undefined) patch[key] = value
        }
        if ('displayName' in body) put('displayName', requiredString(body, 'displayName'))
        if ('engine' in body) put('engine', enumValue(body, 'engine', ENGINES))
        if ('surface' in body) put('surface', enumValue(body, 'surface', SURFACES))
        if ('runnerKind' in body) put('runnerKind', enumValue(body, 'runnerKind', RUNNER_KINDS, before.runnerKind))
        if ('runnerImage' in body) put('runnerImage', optionalString(body, 'runnerImage', { maxLength: 240 }))
        if ('workingDir' in body) put('workingDir', relativeDir(body, 'workingDir'))
        if ('targetMode' in body) put('targetMode', enumValue(body, 'targetMode', TARGET_MODES, before.targetMode))
        if ('kind' in body) put('kind', enumValue(body, 'kind', SUITE_KINDS, before.kind))
        if ('repoUrl' in body) put('repoUrl', optionalString(body, 'repoUrl', { maxLength: 500 }))
        if ('defaultBranch' in body) put('defaultBranch', gitRef(body, 'defaultBranch'))
        if ('artifactPath' in body) put('artifactPath', optionalString(body, 'artifactPath', { maxLength: 240 }))
        if ('command' in body) put('command', suiteCommand(body.command))
        if ('secretRefs' in body) put('secretRefs', stringArray(body.secretRefs, { maxItems: 10, maxLength: 120 }))
        if ('writesData' in body) put('writesData', body.writesData === true)
        if ('requirements' in body) {
          const requirements = {}
          const os = stringArray(body.requirements?.os, { maxItems: 3, maxLength: 12 })
          if (os.length > 0) requirements.os = os
          put('requirements', requirements)
        }
        if ('retryPolicy' in body) {
          put('retryPolicy', {
            maxAttempts: Math.min(3, Math.max(1, Number(body.retryPolicy?.maxAttempts) || 1)),
          })
        }

        const suite = await store.updateSuite(before.id, patch)
        // `before` and `after` both recorded: the command and the repository
        // decide what code runs on a real machine holding a platform-issued
        // token, so "what did it used to say" is the question an incident asks.
        await recordAudit(store, {
          principal,
          request,
          action: 'suite.update',
          resourceType: 'suite',
          resourceId: suite.id,
          appId: app.id,
          before,
          after: suite,
        })
        return { status: 200, body: { suite } }
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
        const scheduleKind = enumValue(schedule, 'kind', ['manual', 'once', 'cron', 'webhook'], 'manual')
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
          targetUrl: targetUrl(body, 'targetUrl', {
            required: suite.surface === 'web' && suite.targetMode !== 'self',
          }),
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
        const app = await store.getApp(task.appId)
        const now = new Date()
        // Snapshot the build at dispatch rather than resolving it at claim
        // time. A desktop run can wait hours for a machine to come online, and
        // if a newer installer is published meanwhile, the run must still be
        // the run of the build it was created for.
        const appPackage = suite.surface === 'electron' ? (app?.latestPackage ?? null) : null
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
          appPackage,
          sourceRef: appPackage?.gitSha ? { ref: app?.defaultBranch ?? null, gitSha: appPackage.gitSha } : null,
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

    // -- webhooks ------------------------------------------------------------
    {
      method: 'PUT',
      pattern: '/api/v1/apps/:app/webhook-secret',
      handler: async ({ params, body, principal, request }) => {
        requireRole(principal, 'admin')
        const app = await requireApp(params.app)
        const value = requiredString(body, 'secret', { maxLength: 200 })
        await store.setWebhookSecret(app.id, encryptSecret(requireSecretKey(config.secretKey), value))
        await recordAudit(store, {
          principal,
          request,
          action: 'webhook.secret_set',
          resourceType: 'app',
          resourceId: app.id,
          appId: app.id,
          after: { webhookSecret: '[set]' },
        })
        return {
          status: 200,
          body: {
            url: `${(config.publicUrl || config.selfUrl).replace(/\/$/u, '')}/webhooks/v1/git/${app.slug}`,
            note: '把这个地址和刚设置的密钥填进仓库的 webhook 配置，事件选 push。',
          },
        }
      },
    },
    {
      method: 'POST',
      pattern: '/webhooks/v1/git/:app',
      // The only unauthenticated route in the platform. The signature is the
      // authentication, and it is checked against the raw bytes — parsing first
      // and re-serialising would verify a different string than the one signed.
      auth: 'none',
      rawBody: true,
      handler: async ({ params, request }) => {
        const app = await requireApp(params.app)
        const raw = await readRawBody(request)

        const stored = await store.getWebhookSecret(app.id)
        verifySignature({
          body: raw,
          signature: request.headers['x-hub-signature-256'],
          secret: stored ? decryptSecret(requireSecretKey(config.secretKey), stored) : null,
        })

        let payload
        try {
          payload = JSON.parse(raw.toString('utf8'))
        } catch {
          throw new AppError(400, 'invalid_json', 'webhook payload 不是合法 JSON')
        }

        const parsed = parsePush({ event: request.headers['x-github-event'], payload })
        // Unrelated events answer 200 and stop. An endpoint that 4xx's on every
        // star and comment turns the provider's UI red and gets the whole hook
        // switched off by whoever notices.
        if (!parsed) return { status: 200, body: { ignored: true } }
        if (parsed.kind === 'ping') return { status: 200, body: { pong: true } }

        const triggered = await triggerWebhookTasks({ app, push: parsed })
        logger?.log?.(
          `[webhook] ${app.slug} ${parsed.branch}@${parsed.gitSha.slice(0, 12)} → ${triggered.length} 个任务`,
        )
        return { status: 202, body: { branch: parsed.branch, gitSha: parsed.gitSha, runs: triggered } }
      },
    },

    // -- secrets -------------------------------------------------------------
    {
      method: 'GET',
      pattern: '/api/v1/apps/:app/secrets',
      handler: async ({ params, principal }) => {
        requireRole(principal, 'admin')
        const app = await requireApp(params.app)
        // Names only. There is no route that returns a value to a person: once
        // set, a secret is write-only from the outside. Anyone who needs the
        // value has it already, and anyone who does not should not get it back
        // out of the platform.
        return {
          status: 200,
          body: {
            secrets: (await store.listSecrets(app.id)).map((entry) => ({
              name: entry.name,
              description: entry.description,
              updatedAt: entry.updatedAt,
            })),
          },
        }
      },
    },
    {
      method: 'PUT',
      pattern: '/api/v1/apps/:app/secrets/:name',
      handler: async ({ params, body, principal, request }) => {
        requireRole(principal, 'admin')
        const app = await requireApp(params.app)
        const name = secretName(params.name)
        const value = requiredString(body, 'value', { maxLength: 4096 })
        const record = await store.putSecret({
          appId: app.id,
          name,
          ...encryptSecret(requireSecretKey(config.secretKey), value),
          description: optionalString(body, 'description', { maxLength: 200 }),
          createdBy: principal.id,
        })
        // The name and the fact of the change are auditable; the value is not
        // passed to recordAudit at all.
        await recordAudit(store, {
          principal,
          request,
          action: 'secret.put',
          resourceType: 'secret',
          resourceId: record.id,
          appId: app.id,
          after: { name, description: record.description },
        })
        return { status: 204, body: null }
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/v1/apps/:app/secrets/:name',
      handler: async ({ params, principal, request }) => {
        requireRole(principal, 'admin')
        const app = await requireApp(params.app)
        const name = secretName(params.name)
        const removed = await store.deleteSecret(app.id, name)
        if (!removed) throw new AppError(404, 'secret_not_found', `找不到密钥 ${name}`)
        await recordAudit(store, {
          principal,
          request,
          action: 'secret.delete',
          resourceType: 'secret',
          resourceId: name,
          appId: app.id,
          before: { name },
        })
        return { status: 204, body: null }
      },
    },
    {
      method: 'GET',
      pattern: '/runner/v1/runs/:runId/secrets',
      auth: 'runToken',
      handler: async ({ run }) => {
        // Fetched at runtime with the run-scoped token rather than baked into
        // the Job manifest. A manifest is readable by anyone who can run
        // `kubectl get job -o yaml`; this token dies with the run.
        if (run.status !== 'running') {
          throw new AppError(409, 'run_not_running', `这次执行是「${run.status}」，不再下发密钥`)
        }
        const suite = await store.getSuite(run.suiteId)
        return {
          status: 200,
          body: {
            secrets: await resolveSuiteSecrets({
              store,
              key: config.secretKey,
              suite,
              appId: run.appId,
            }),
          },
        }
      },
    },

    // -- audit ---------------------------------------------------------------
    {
      method: 'GET',
      pattern: '/api/v1/audit',
      handler: async ({ url, principal }) => {
        // Admin only: the records contain configuration diffs, which say more
        // about how the platform is wired than a viewer needs to know.
        requireRole(principal, 'admin')
        const appSlug = url.searchParams.get('app')
        const app = appSlug ? await requireApp(appSlug) : null
        return {
          status: 200,
          body: {
            events: await store.listAuditEvents({
              resourceType: url.searchParams.get('resource'),
              resourceId: url.searchParams.get('id'),
              appId: app?.id ?? null,
              limit: Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100)),
            }),
          },
        }
      },
    },

    // -- notification channels -----------------------------------------------
    {
      method: 'GET',
      pattern: '/api/v1/notification-channels',
      handler: async () => ({
        status: 200,
        // Redacted: a 飞书 bot URL *is* the credential — the token is a path
        // segment — so anyone who could read it back could post to the group.
        body: { channels: (await store.listNotificationChannels()).map(redactChannel) },
      }),
    },
    {
      method: 'POST',
      pattern: '/api/v1/notification-channels',
      handler: async ({ body, principal, request }) => {
        requireRole(principal, 'admin')
        const kind = enumValue(body, 'kind', NOTIFY_KINDS)
        const appSlug = optionalString(body, 'app', { maxLength: 64 })
        const app = appSlug ? await requireApp(appSlug) : null
        const events = stringArray(body.events, { maxItems: 5, maxLength: 20 }).filter((entry) =>
          NOTIFY_EVENTS.includes(entry),
        )
        const channel = await store.createNotificationChannel({
          appId: app?.id ?? null,
          name: requiredString(body, 'name', { maxLength: 96 }),
          kind,
          // Validated by the adapter, so a malformed webhook fails here rather
          // than silently never delivering anything.
          config: adapterFor(kind).validate(body.config),
          events: events.length > 0 ? events : NOTIFY_EVENTS,
          enabled: body.enabled !== false,
          createdBy: principal.id,
        })
        // Redirecting alerts is how a change stays unnoticed, so who added a
        // channel is part of the same trail. `redactChannel` first: the bot URL
        // *is* the credential and must not be copied into the audit table.
        await recordAudit(store, {
          principal,
          request,
          action: 'channel.create',
          resourceType: 'channel',
          resourceId: channel.id,
          appId: channel.appId,
          after: redactChannel(channel),
        })
        return { status: 201, body: { channel: redactChannel(channel) } }
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/v1/notification-channels/:channelId',
      handler: async ({ params, principal, request }) => {
        requireRole(principal, 'admin')
        // Read before deleting: "what was removed" is the whole value of the
        // record, and after the delete there is nothing left to describe.
        const existing = await store.getNotificationChannel(params.channelId)
        const removed = await store.deleteNotificationChannel(params.channelId)
        if (!removed) throw new AppError(404, 'channel_not_found', '找不到该通知渠道')
        await recordAudit(store, {
          principal,
          request,
          action: 'channel.delete',
          resourceType: 'channel',
          resourceId: params.channelId,
          appId: existing?.appId ?? null,
          before: existing ? redactChannel(existing) : null,
        })
        return { status: 204, body: null }
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/notification-channels/:channelId:test',
      handler: async ({ params, principal }) => {
        requireRole(principal, 'admin')
        const channel = await store.getNotificationChannel(params.channelId)
        if (!channel) throw new AppError(404, 'channel_not_found', '找不到该通知渠道')
        // Queued rather than sent inline, so the test exercises the same path a
        // real alert takes. A test that succeeds through a different code path
        // proves nothing about the real one.
        const queued = await store.createNotification({
          channelId: channel.id,
          runId: null,
          event: 'recovery',
          payload: {
            event: 'recovery',
            title: `✅ 测试消息 · ${channel.name}`,
            totals: { tests: 0, passed: 0, failed: 0, notRun: 0 },
            failedCases: [],
            failedCasesOmitted: 0,
            runUrl: config.publicUrl || null,
            taskName: '这是一条测试消息，收到即说明渠道配置正确',
          },
        })
        return { status: 202, body: { notificationId: queued.id, note: '已入队，下一次调度循环发出（最多 1 分钟）' } }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/notifications',
      handler: async ({ url }) => ({
        status: 200,
        body: {
          notifications: await store.listNotifications({
            runId: url.searchParams.get('run'),
            limit: 50,
          }),
        },
      }),
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
        return {
          status: 200,
          body: { run, app, suite, task, pending: await explainPending(run, suite) },
        }
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
      handler: async ({ body, principal, request }) => {
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
        // Registering a machine means it can claim runs and receive the
        // credentials those runs carry, so it belongs in the trail. The token
        // is never passed to the audit record — `scrub` would redact it anyway,
        // but the safe thing is not to hand it over in the first place.
        await recordAudit(store, {
          principal,
          request,
          action: 'runner.register',
          resourceType: 'runner',
          resourceId: runner.id,
          after: { name: runner.name, kind: runner.kind, os: runner.os, arch: runner.arch, capabilities: runner.capabilities },
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
            suite: {
              slug: suite.slug,
              engine: suite.engine,
              surface: suite.surface,
              workingDir: suite.workingDir ?? null,
              // A local runner needs both to know it is building rather than
              // testing, and where to find what it built.
              kind: suite.kind ?? 'test',
              artifactPath: suite.artifactPath ?? null,
            },
            // What to check out. A local runner that is not told this can only
            // execute whatever a person left in a directory, which makes the
            // run record unable to say which code it tested.
            app: {
              slug: app?.slug ?? null,
              // The suite's own test repository wins. A test team owning its
              // specs elsewhere is the normal case, not the exception.
              repoUrl: suite.repoUrl ?? app?.repoUrl ?? null,
            },
            sourceRef: run.sourceRef?.ref ?? suite.defaultBranch ?? app?.defaultBranch ?? null,
            // A desktop suite exercises a built installer, not the source tree.
            // The checksum travels with it because the runner is about to
            // execute this file on someone's own machine.
            appPackage: run.appPackage ?? null,
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
      handler: async ({ run, body }) => {
        const completed = await completeRun({ store, artifacts, run, body, config })
        // Queue only — delivery happens on the scheduler tick. A runner
        // reporting its result must not wait on someone else's chat server,
        // and a slow webhook must not look like a slow test run.
        await enqueueForRun({ store, run: completed, config, logger }).catch((error) => {
          // A notification that cannot be queued must never fail the run that
          // was already recorded successfully.
          logger?.error?.(`[notify] 入队失败 ${completed.id}: ${error.message}`)
        })
        return { status: 200, body: { run: completed } }
      },
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

    // A test run downloads the installer a build run produced.
    //
    // Authenticated with a *runner* token rather than a person's: the machine
    // that will execute this installer is by definition already trusted to run
    // test code on real hardware, and downloading the application it is about
    // to launch is strictly less privilege than that. A run-scoped token cannot
    // work here — the file belongs to a different run.
    const packageRoute = routeMatch(url.pathname, '/runner/v1/runs/:runId/package')
    if (packageRoute && request.method === 'GET') {
      await requireRunner(request)
      const buildRun = await requireRun(packageRoute.runId)
      const file = await findBuildArtifact(artifacts, buildRun.id)
      if (!file) throw new AppError(404, 'package_not_found', '这次构建没有产物')
      await artifacts.serve(buildRun.id, file.path, request, response)
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
        else if (route.auth === 'runToken') context.run = await requireRunToken(request, params.runId)
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

      // The package download also streams, but it is authenticated as a machine
      // rather than a person, so it must not pass through `identity.resolve` —
      // a runner has no user identity to resolve. `handleSpecial` does its own
      // `requireRunner` for this route.
      if (url.pathname.startsWith('/runner/v1/runs/')) {
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
  const artifactsRoot = `${config.artifactsDir}/runs`
  const artifactsDir = `${artifactsRoot}/${run.id}`
  const env = {
    MXT_RUN_ID: run.id,
    MXT_APP: app?.slug ?? '',
    MXT_SUITE: suite.slug,
    MXT_TRACK: run.track,
    MXT_PROFILE: run.profile,
    // The run's own directory. Everything the platform collects is read from
    // here.
    MXT_ARTIFACTS_DIR: artifactsDir,
    E2E_RUN_ID: run.id,
    E2E_TRACK: run.track,
    E2E_PROFILE: run.profile,
    // compass's convention, and it is *not* the same variable in disguise:
    // `scripts/e2e-runtime.mjs` treats E2E_ARTIFACTS_DIR as a **root** and
    // writes to `<root>/<E2E_RUN_ID>`. Setting it to the run directory made the
    // suite write to `.../<runId>/<runId>`, where the platform then found no
    // summary.json and reported a perfectly good run as blocked.
    E2E_ARTIFACTS_DIR: artifactsRoot,
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
/**
 * Remove issued credential values from everything a run recorded.
 *
 * Walks the normalized result rather than the raw payload so that it covers the
 * JUnit path and the summary.json path with one pass — a second place to do
 * this is a second place to forget one of them.
 */
function redactIssuedSecrets(normalized, values) {
  normalized.blockedReason = redactValues(normalized.blockedReason, values)
  for (const testCase of normalized.cases) {
    testCase.title = redactValues(testCase.title, values)
    testCase.errorText = redactValues(testCase.errorText, values)
    for (const step of testCase.steps ?? []) {
      step.label = redactValues(step.label, values)
    }
  }
}

/**
 * Close out a `kind: build` run.
 *
 * Separate from the test path on purpose — see ingest/build.mjs. What it shares
 * is the platform's oldest rule, in its build-shaped form: a command that
 * exited 0 without producing an artefact is `blocked`, not a success.
 */
async function completeBuild({ store, artifacts, run, exitCode, config, sourceRef }) {
  // Provenance first: the package the build publishes takes its version and its
  // gitSha from the run, so a run whose source_ref is still `{}` produces a
  // 200 MB installer that cannot be traced to a commit.
  const withRef = sourceRef ? { ...run, sourceRef } : run
  const outcome = await completeBuildRun({ store, artifacts, run: withRef, exitCode, config })
  const finishedAt = new Date()
  const startedAt = run.startedAt ? new Date(run.startedAt) : finishedAt
  return store.completeRun(run.id, {
    run: {
      status: outcome.status,
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      blockedReason: outcome.blockedReason,
      totals: {},
      catalog: {},
      ...(sourceRef ? { sourceRef } : {}),
      artifacts: outcome.package ? { package: `package/${outcome.package.filename}` } : {},
      // The token dies with the run, exactly as it does for a test run.
      runTokenSha256: null,
    },
    cases: [],
  })
}

export async function completeRun({ store, artifacts, run, body, config = null }) {
  const exitCode = Number.isInteger(body?.exitCode) ? body.exitCode : null

  // A build run takes a different path entirely. It has no cases, so running it
  // through the test pipeline would record "0 tests" and a catalog report
  // claiming every registered case went unexecuted — true, meaningless, and it
  // would poison the drift numbers for the suites that do test things.
  const runSuite = run.suiteId ? await store.getSuite(run.suiteId) : null
  if (runSuite?.kind === 'build') {
    // Same validation as the test path: a sha the runner did not actually check
    // out is worse than none, so it goes through the same normaliser rather
    // than being trusted because it arrived on a different route.
    return completeBuild({
      store,
      artifacts,
      run,
      exitCode,
      config,
      sourceRef: normalizeSourceRef(body?.sourceRef),
    })
  }

  // JUnit XML is the generic path: a suite in any language reports through it
  // without the platform learning anything about that language. `summary` wins
  // when both are present, because it carries steps and per-case artifacts that
  // JUnit has no way to express.
  const summary = body?.summary ?? (body?.junit ? junitToSummary(body.junit) : body?.summary)
  const normalized = normalizeSummary(summary, exitCode)

  // Strip the exact credentials this platform issued for the run.
  //
  // core/redact.mjs guesses from shape — `Bearer ...`, `password=...` — and
  // cannot catch a framework that prints a password on its own terms
  // ("login failed for user qa with hunter2"). Here the values are known, so
  // they can be removed wherever they appear. Best-effort on purpose: a result
  // that is already recorded must not be lost because a key was rotated and an
  // old value no longer decrypts.
  if (config?.secretKey) {
    try {
      const suite = await store.getSuite(run.suiteId)
      const issued = Object.values(
        await resolveSuiteSecrets({ store, key: config.secretKey, suite, appId: run.appId }),
      )
      if (issued.length > 0) redactIssuedSecrets(normalized, issued)
    } catch {
      // A missing or unreadable secret is reported when the run asks for it,
      // not here, where it would cost the result.
    }
  }

  // Scope the catalog to this run's suite.
  //
  // The catalog belongs to the application, but a run belongs to one suite of
  // it. Comparing an Electron run against the web suite's cases reports every
  // one of them as `notRun` — true in the narrowest sense, useless in every
  // other, and it makes the `notRun` signal worthless the moment an app has a
  // second suite. 罗盘 has three.
  //
  // Cases with no suite are still counted: a registered case attached to
  // nothing is exactly the kind of thing that should not be able to hide from
  // every run by being unassigned.
  const suiteSlug = runSuite?.slug ?? null
  const catalogCases = (await store.listCases(run.appId)).filter(
    (entry) => !entry.suiteSlug || !suiteSlug || entry.suiteSlug === suiteSlug,
  )
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
      // What the runner actually checked out. Merged over whatever the run was
      // created with: a webhook run is created pinned to a sha, and if the
      // checkout ended up somewhere else, the checkout is the truth.
      // Provenance is merged from both places the runner can report it.
      //
      // It arrives inside the summary for suites that write summary.json, and
      // at the top level of the completion body for every suite — including the
      // ones that report JUnit and therefore have no summary at all. Reading
      // only the summary lost the sha for exactly those suites, which is the
      // third time this field has been quietly dropped on a path nobody had
      // exercised end to end. The top level wins: it is what the runner
      // actually checked out.
      sourceRef: {
        ...(run.sourceRef ?? {}),
        ...(normalized.sourceRef ?? {}),
        ...(normalizeSourceRef(body?.sourceRef) ?? {}),
      },
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
