import { AppError } from '../core/errors.mjs'
import { newId } from '../core/ids.mjs'

// In-process store. Used by the test suite and by `manage.sh local up` so the
// API can be exercised without a database. It implements the same interface as
// the PostgreSQL store; anything that works here must work there.

const clone = (value) => (value == null ? value : structuredClone(value))

export class MemoryStore {
  #apps = new Map()
  #channels = new Map()
  #auditEvents = []
  #secrets = new Map()
  #notifications = new Map()
  #suites = new Map()
  #catalogs = new Map() // `${appId}\u0000${catalogFile}` -> catalog metadata
  #cases = new Map() // `${appId}\u0000${caseId}` -> case
  #tasks = new Map()
  #runs = new Map()
  #runCases = [] // { runId, ...case }
  #steps = [] // { runId, caseId, seq, ... }
  #runEvents = new Map() // runId -> [{ seq, at, kind, payload }]
  #runners = new Map()
  #enrollments = new Map()
  #members = new Map()

  async close() {}

  async ping() {
    return true
  }

  // -- apps ------------------------------------------------------------------

  async createApp(input) {
    if ([...this.#apps.values()].some((app) => app.slug === input.slug)) {
      throw new AppError(409, 'app_exists', `App "${input.slug}" already exists`)
    }
    const app = {
      id: newId('app'),
      slug: input.slug,
      displayName: input.displayName,
      repoUrl: input.repoUrl ?? null,
      defaultBranch: input.defaultBranch ?? null,
      latestPackage: null,
      webhookSecret: null,
      surfaces: input.surfaces ?? [],
      catalogGlob: input.catalogGlob ?? null,
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    this.#apps.set(app.id, app)
    return clone(app)
  }

  async listApps() {
    return clone([...this.#apps.values()].sort((a, b) => a.slug.localeCompare(b.slug)))
  }

  async getApp(id) {
    return clone(this.#apps.get(id)) ?? null
  }

  async getAppBySlug(slug) {
    return clone([...this.#apps.values()].find((app) => app.slug === slug)) ?? null
  }

  /**
   * Remove an application and everything that hangs off it.
   *
   * Mirrors the ON DELETE CASCADE chain in 001_initial.sql, because the two
   * stores have to agree about what disappears — a memory-mode test that leaves
   * orphaned runs behind would prove the opposite of what it looks like it
   * proves. Returns the run ids so the caller can delete their artifacts, which
   * live on disk and no cascade can reach.
   */
  async deleteApp(id) {
    if (!this.#apps.delete(id)) return null
    const runIds = [...this.#runs.values()].filter((run) => run.appId === id).map((run) => run.id)
    for (const runId of runIds) this.#runs.delete(runId)
    for (const [suiteId, suite] of this.#suites) if (suite.appId === id) this.#suites.delete(suiteId)
    for (const [taskId, task] of this.#tasks) if (task.appId === id) this.#tasks.delete(taskId)
    for (const [key, entry] of this.#catalogs) if (entry.appId === id) this.#catalogs.delete(key)
    for (const [key, entry] of this.#cases) if (entry.appId === id) this.#cases.delete(key)
    for (const [secretId, secret] of this.#secrets) if (secret.appId === id) this.#secrets.delete(secretId)
    this.#runCases = this.#runCases.filter((entry) => !runIds.includes(entry.runId))
    this.#steps = this.#steps.filter((entry) => !runIds.includes(entry.runId))
    for (const runId of runIds) this.#runEvents.delete(runId)
    return { runIds }
  }

  async setWebhookSecret(appId, record) {
    const app = this.#apps.get(appId)
    if (!app) return null
    app.webhookSecret = record
    return clone(app)
  }

  async getWebhookSecret(appId) {
    return clone(this.#apps.get(appId)?.webhookSecret) ?? null
  }

  // Deduplicating retried webhook deliveries. Keyed on task + commit rather
  // than on the provider's delivery id, so it also covers the same sha arriving
  // by another route.
  async findRunByTaskAndSha(taskId, gitSha) {
    return (
      clone(
        [...this.#runs.values()].find(
          (run) => run.taskId === taskId && run.sourceRef?.gitSha === gitSha && run.trigger === 'webhook',
        ),
      ) ?? null
    )
  }

  async setLatestPackage(appId, pkg) {
    const app = this.#apps.get(appId)
    if (!app) return null
    app.latestPackage = pkg
    return clone(app)
  }

  // -- suites ----------------------------------------------------------------

  async createSuite(input) {
    const existing = [...this.#suites.values()].find(
      (suite) => suite.appId === input.appId && suite.slug === input.slug,
    )
    if (existing) throw new AppError(409, 'suite_exists', `Suite "${input.slug}" already exists`)
    const suite = {
      id: newId('ste'),
      appId: input.appId,
      slug: input.slug,
      displayName: input.displayName,
      engine: input.engine,
      surface: input.surface,
      runnerKind: input.runnerKind,
      runnerImage: input.runnerImage ?? null,
      workingDir: input.workingDir ?? null,
      targetMode: input.targetMode ?? 'external',
      kind: input.kind ?? 'test',
      artifactPath: input.artifactPath ?? null,
      repoUrl: input.repoUrl ?? null,
      defaultBranch: input.defaultBranch ?? null,
      requirements: input.requirements ?? {},
      command: input.command ?? [],
      retryPolicy: input.retryPolicy ?? {},
      secretRefs: input.secretRefs ?? [],
      writesData: Boolean(input.writesData),
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    this.#suites.set(suite.id, suite)
    return clone(suite)
  }

  // Mirrors the postgres store: only the keys present in `patch` are written,
  // so fixing one field cannot blank the others by omission.
  async updateSuite(id, patch) {
    const suite = this.#suites.get(id)
    if (!suite) return null
    const FIELDS = [
      'displayName', 'engine', 'surface', 'runnerKind', 'runnerImage', 'workingDir',
      'targetMode', 'kind', 'repoUrl', 'defaultBranch', 'artifactPath', 'writesData',
      'requirements', 'command', 'retryPolicy', 'secretRefs',
    ]
    for (const field of FIELDS) {
      if (field in patch) suite[field] = patch[field]
    }
    this.#suites.set(id, suite)
    return clone(suite)
  }

  /**
   * Remove a suite, and with it the tasks that pointed at it and the runs it
   * produced — the same cascade 001_initial.sql declares.
   *
   * Cases keep their `suiteSlug`: a case is registered by the test team, and
   * deleting the suite that happened to run it is not a reason to forget that
   * the case exists.
   */
  async deleteSuite(id) {
    if (!this.#suites.delete(id)) return null
    const runIds = [...this.#runs.values()].filter((run) => run.suiteId === id).map((run) => run.id)
    for (const runId of runIds) {
      this.#runs.delete(runId)
      this.#runEvents.delete(runId)
    }
    for (const [taskId, task] of this.#tasks) if (task.suiteId === id) this.#tasks.delete(taskId)
    this.#runCases = this.#runCases.filter((entry) => !runIds.includes(entry.runId))
    this.#steps = this.#steps.filter((entry) => !runIds.includes(entry.runId))
    return { runIds }
  }

  async listSuites(appId) {
    return clone(
      [...this.#suites.values()]
        .filter((suite) => suite.appId === appId)
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    )
  }

  async getSuite(id) {
    return clone(this.#suites.get(id)) ?? null
  }

  // -- cases -----------------------------------------------------------------

  #caseKey(appId, caseId) {
    return `${appId}\u0000${caseId}`
  }

  /**
   * Upsert a catalog file's cases. Cases previously seen from the same file but
   * absent now are retired, not deleted: historical runs still reference them.
   */
  async syncCatalog(
    appId,
    { catalogFile, schemaVersion, application, surface, suiteSlug, executionMode, coverage, cases },
  ) {
    const now = new Date().toISOString()
    const incoming = new Set()
    const catalog = {
      appId,
      catalogFile,
      schemaVersion,
      application,
      surface,
      suiteSlug,
      executionMode,
      coverage: coverage ?? {},
      syncedAt: now,
    }
    this.#catalogs.set(`${appId}\u0000${catalogFile}`, catalog)
    const result = { added: [], updated: [], retired: [], catalog: clone(catalog) }

    for (const entry of cases) {
      const key = this.#caseKey(appId, entry.caseId)
      incoming.add(entry.caseId)
      const existing = this.#cases.get(key)
      if (existing) {
        Object.assign(existing, entry, {
          appId,
          catalogFile,
          origin: 'catalog',
          lastSeenAt: now,
          retiredAt: null,
        })
        result.updated.push(entry.caseId)
      } else {
        this.#cases.set(key, {
          steps: [],
          ...entry,
          appId,
          catalogFile,
          origin: 'catalog',
          firstSeenAt: now,
          lastSeenAt: now,
          retiredAt: null,
        })
        result.added.push(entry.caseId)
      }
    }

    // Retirement is scoped to the file being synced, which is also what keeps a
    // repository sync from deleting cases a tester wrote in the UI: those carry
    // a different catalog_file and are never in scope here.
    for (const testCase of this.#cases.values()) {
      if (
        testCase.appId === appId &&
        testCase.catalogFile === catalogFile &&
        !incoming.has(testCase.caseId) &&
        !testCase.retiredAt
      ) {
        testCase.retiredAt = now
        result.retired.push(testCase.caseId)
      }
    }
    return result
  }

  async listCatalogs(appId) {
    return clone(
      [...this.#catalogs.values()]
        .filter((entry) => entry.appId === appId)
        .sort((a, b) => a.catalogFile.localeCompare(b.catalogFile)),
    )
  }

  async listCases(appId, { includeRetired = false, priority = null } = {}) {
    return clone(
      [...this.#cases.values()]
        .filter((entry) => entry.appId === appId)
        .filter((entry) => includeRetired || !entry.retiredAt)
        .filter((entry) => !priority || entry.priority === priority)
        .sort((a, b) => a.caseId.localeCompare(b.caseId)),
    )
  }

  // -- tasks -----------------------------------------------------------------

  async createTask(input) {
    const task = {
      id: newId('tsk'),
      runsOn: null,
      runnerId: null,
      caseFilter: null,
      ...input,
      lastRunId: null,
      createdAt: new Date().toISOString(),
    }
    this.#tasks.set(task.id, task)
    return clone(task)
  }

  async listTasks({ appId = null, enabled = null } = {}) {
    return clone(
      [...this.#tasks.values()]
        .filter((task) => !appId || task.appId === appId)
        .filter((task) => enabled === null || task.enabled === enabled)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    )
  }

  async getTask(id) {
    return clone(this.#tasks.get(id)) ?? null
  }

  async updateTask(id, patch) {
    const task = this.#tasks.get(id)
    if (!task) return null
    Object.assign(task, patch)
    return clone(task)
  }

  async deleteTask(id) {
    return this.#tasks.delete(id)
  }

  async dueTasks(now) {
    const cutoff = now.toISOString()
    return clone(
      [...this.#tasks.values()].filter(
        (task) => task.enabled && task.nextRunAt && task.nextRunAt <= cutoff,
      ),
    )
  }

  // -- runs ------------------------------------------------------------------

  async createRun(input) {
    const run = {
      id: newId('trun'),
      status: 'queued',
      runnerId: null,
      leaseUntil: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      totals: {},
      catalog: {},
      artifacts: {},
      blockedReason: null,
      appPackage: null,
      runsOn: null,
      assignedRunnerId: null,
      caseFilter: null,
      queuedAt: new Date().toISOString(),
      ...input,
    }
    this.#runs.set(run.id, run)
    return clone(run)
  }

  async getRun(id) {
    return clone(this.#runs.get(id)) ?? null
  }

  async getRunByTokenHash(hash) {
    return clone([...this.#runs.values()].find((run) => run.runTokenSha256 === hash)) ?? null
  }

  async listRuns({ appId = null, taskId = null, status = null, limit = 50 } = {}) {
    return clone(
      [...this.#runs.values()]
        .filter((run) => !appId || run.appId === appId)
        .filter((run) => !taskId || run.taskId === taskId)
        .filter((run) => !status || run.status === status)
        .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
        .slice(0, limit),
    )
  }

  async updateRun(id, patch) {
    const run = this.#runs.get(id)
    if (!run) return null
    Object.assign(run, patch)
    return clone(run)
  }

  /**
   * Hand the oldest matching queued run to a runner. Matching is by capability,
   * so an Electron suite is never handed to a Linux container and vice versa.
   */
  async claimRun({ runner, leaseMs, now, runTokenSha256 = null }) {
    const candidates = [...this.#runs.values()]
      .filter((run) => run.status === 'queued' || run.status === 'pending-runner')
      // A run destined for the platform's own capacity is never handed to a
      // person's laptop, even one that could technically run it: choosing
      // 「服务器静默跑」 means it must not depend on anyone being at their desk.
      // A machine registered as `kind: server` *is* that capacity — that is how
      // a deployment with no Kubernetes runs headless work at all.
      .filter((run) => (run.runsOn ?? 'any-runner') !== 'server' || runner.kind === 'server')
      // A pin names one machine. Without this the pin would be a suggestion,
      // and the run record would name a machine that never touched it.
      .filter((run) => !run.assignedRunnerId || run.assignedRunnerId === runner.id)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))

    for (const run of candidates) {
      const suite = this.#suites.get(run.suiteId)
      if (!suite || !runnerMatchesSuite(runner, suite)) continue
      run.status = 'running'
      run.runnerId = runner.id
      run.startedAt = now.toISOString()
      run.leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
      if (runTokenSha256) run.runTokenSha256 = runTokenSha256
      return { run: clone(run), suite: clone(suite) }
    }
    return null
  }

  async completeRun(runId, payload) {
    const run = this.#runs.get(runId)
    if (!run) return null
    Object.assign(run, payload.run)
    // The credential dies with the run: a crashed-and-restarted runner must not
    // be able to rewrite a result that is already recorded.
    run.runTokenSha256 = null
    this.#runCases = this.#runCases.filter((entry) => entry.runId !== runId)
    this.#steps = this.#steps.filter((entry) => entry.runId !== runId)
    for (const testCase of payload.cases) {
      this.#runCases.push({ runId, ...testCase })
      for (const step of testCase.steps ?? []) {
        this.#steps.push({ runId, caseId: testCase.caseId, ...step })
      }
    }
    return clone(run)
  }

  async listRunCases(runId) {
    return clone(this.#runCases.filter((entry) => entry.runId === runId))
  }

  async listSteps(runId, caseId) {
    return clone(
      this.#steps
        .filter((entry) => entry.runId === runId && entry.caseId === caseId)
        .sort((a, b) => a.seq - b.seq),
    )
  }

  /** Every step of a run, grouped by case id — one query for the whole report. */
  async listAllSteps(runId) {
    const grouped = new Map()
    for (const step of this.#steps.filter((entry) => entry.runId === runId)) {
      const list = grouped.get(step.caseId) ?? []
      list.push({
        seq: step.seq,
        label: step.label,
        status: step.status,
        offsetMs: step.offsetMs,
        durationMs: step.durationMs,
      })
      grouped.set(step.caseId, list)
    }
    for (const list of grouped.values()) list.sort((a, b) => a.seq - b.seq)
    return Object.fromEntries(grouped)
  }

  /**
   * Append progress events, numbering them here rather than trusting the
   * caller's numbering. Returns what was actually stored plus how many were
   * dropped, so the caller can record the truncation instead of hiding it.
   */
  async appendRunEvents(runId, events, { cap = Infinity } = {}) {
    const list = this.#runEvents.get(runId) ?? []
    this.#runEvents.set(runId, list)
    const stored = []
    let dropped = 0
    for (const event of events) {
      if (list.length >= cap) {
        dropped += 1
        continue
      }
      const record = {
        seq: (list.at(-1)?.seq ?? 0) + 1,
        at: event.at ?? new Date().toISOString(),
        kind: event.kind,
        payload: event.payload ?? {},
      }
      list.push(record)
      stored.push(clone(record))
    }
    return { events: stored, dropped, total: list.length }
  }

  async listRunEvents(runId, { afterSeq = 0, limit = 1000 } = {}) {
    const list = this.#runEvents.get(runId) ?? []
    return clone(list.filter((entry) => entry.seq > afterSeq).slice(0, limit))
  }

  /** Drop progress events older than the retention window. */
  async purgeRunEvents(before) {
    let removed = 0
    for (const [runId, list] of this.#runEvents) {
      const kept = list.filter((entry) => entry.at >= before)
      removed += list.length - kept.length
      if (kept.length === 0) this.#runEvents.delete(runId)
      else this.#runEvents.set(runId, kept)
    }
    return removed
  }

  async countRunEvents(runId) {
    return this.#runEvents.get(runId)?.length ?? 0
  }

  /** Runs nobody claimed inside the window, and runs whose runner went silent. */
  async sweepStaleRuns(now) {
    const stamp = now.toISOString()
    const expired = []
    const timedOut = []
    for (const run of this.#runs.values()) {
      if (
        (run.status === 'queued' || run.status === 'pending-runner') &&
        run.claimDeadline &&
        run.claimDeadline <= stamp
      ) {
        run.status = 'expired'
        run.finishedAt = stamp
        expired.push(run.id)
      } else if (run.status === 'running' && run.leaseUntil && run.leaseUntil <= stamp) {
        run.status = 'timeout'
        run.finishedAt = stamp
        run.blockedReason = 'Runner stopped reporting'
        timedOut.push(run.id)
      }
    }
    return { expired, timedOut }
  }

  // -- runners ---------------------------------------------------------------

  async registerRunner(input) {
    const existing = [...this.#runners.values()].find((runner) => runner.name === input.name)
    const runner = {
      id: existing?.id ?? newId('rnr'),
      ...input,
      status: 'idle',
      lastSeenAt: new Date().toISOString(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    this.#runners.set(runner.id, runner)
    return clone(runner)
  }

  // -- runner enrollment -----------------------------------------------------

  async createEnrollment(input) {
    const enrollment = {
      id: newId('enr'),
      usedAt: null,
      runnerId: null,
      createdAt: new Date().toISOString(),
      ...input,
    }
    this.#enrollments.set(enrollment.id, enrollment)
    return clone(enrollment)
  }

  async getEnrollment(id) {
    return clone(this.#enrollments.get(id)) ?? null
  }

  async getEnrollmentByCodeHash(hash) {
    return clone([...this.#enrollments.values()].find((entry) => entry.codeSha256 === hash)) ?? null
  }

  /**
   * Burn the code. Returns null if it was already used, which is what makes
   * two machines racing on the same code resolve to one winner.
   */
  async consumeEnrollment(id, { runnerId = null, usedAt = new Date().toISOString() } = {}) {
    const enrollment = this.#enrollments.get(id)
    if (!enrollment || enrollment.usedAt) return null
    enrollment.usedAt = usedAt
    enrollment.runnerId = runnerId
    return clone(enrollment)
  }

  /** Record which machine a burned code produced, for the page that is waiting. */
  async attachEnrollmentRunner(id, runnerId) {
    const enrollment = this.#enrollments.get(id)
    if (!enrollment) return null
    enrollment.runnerId = runnerId
    return clone(enrollment)
  }

  async deleteRunner(id) {
    return this.#runners.delete(id)
  }

  async getRunner(id) {
    return clone(this.#runners.get(id)) ?? null
  }

  async getRunnerByTokenHash(hash) {
    return clone([...this.#runners.values()].find((runner) => runner.tokenSha256 === hash)) ?? null
  }

  async touchRunner(id, status) {
    const runner = this.#runners.get(id)
    if (!runner) return null
    runner.status = status
    runner.lastSeenAt = new Date().toISOString()
    return clone(runner)
  }

  async listRunners() {
    return clone([...this.#runners.values()])
  }

  // -- members ---------------------------------------------------------------

  async getMember(principalId) {
    return clone(this.#members.get(principalId)) ?? null
  }

  async upsertMember({ principalId, displayName, launcherSub, role }) {
    const existing = this.#members.get(principalId)
    const member = {
      principalId,
      displayName,
      launcherSub: launcherSub ?? existing?.launcherSub ?? null,
      // An existing role is authoritative: re-login must never silently
      // re-grant or downgrade what an admin has set.
      role: existing?.role ?? role ?? 'viewer',
      lastSeenAt: new Date().toISOString(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    this.#members.set(principalId, member)
    return clone(member)
  }

  async setMemberRole(principalId, role) {
    const member = this.#members.get(principalId)
    if (!member) return null
    member.role = role
    return clone(member)
  }

  async touchMember(principalId) {
    const member = this.#members.get(principalId)
    if (member) member.lastSeenAt = new Date().toISOString()
    return clone(member) ?? null
  }

  async listMembers() {
    return clone(
      [...this.#members.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    )
  }

  // -- case authoring --------------------------------------------------------

  async upsertCase(appId, entry) {
    const key = this.#caseKey(appId, entry.caseId)
    const now = new Date().toISOString()
    const existing = this.#cases.get(key)
    const record = {
      ...(existing ?? { firstSeenAt: now, catalogFile: '__platform__', origin: 'platform' }),
      ...entry,
      appId,
      lastSeenAt: now,
      updatedAt: now,
      retiredAt: null,
    }
    this.#cases.set(key, record)
    return clone(record)
  }

  async getCase(appId, caseId) {
    return clone(this.#cases.get(this.#caseKey(appId, caseId))) ?? null
  }

  async retireCase(appId, caseId) {
    const record = this.#cases.get(this.#caseKey(appId, caseId))
    if (!record) return null
    record.retiredAt = new Date().toISOString()
    return clone(record)
  }

  /** Recent results for one case, newest first — the single-case trend view. */
  async caseHistory(appId, caseId, limit = 30) {
    return clone(
      this.#runCases
        .filter((entry) => entry.appId === appId && entry.caseId === caseId)
        .map((entry) => {
          const run = this.#runs.get(entry.runId)
          return {
            runId: entry.runId,
            status: entry.status,
            durationMs: entry.durationMs,
            finishedAt: run?.finishedAt ?? null,
            taskId: run?.taskId ?? null,
          }
        })
        .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))
        .slice(0, limit),
    )
  }

  // -- notifications ---------------------------------------------------------

  async createNotificationChannel(input) {
    const channel = {
      id: newId('nch'),
      appId: input.appId ?? null,
      name: input.name,
      kind: input.kind,
      config: input.config ?? {},
      events: input.events ?? ['failure', 'recovery', 'blocked'],
      enabled: input.enabled !== false,
      createdBy: input.createdBy ?? null,
      createdAt: new Date().toISOString(),
    }
    this.#channels.set(channel.id, channel)
    return clone(channel)
  }

  async listNotificationChannels({ enabled = null, appId = undefined } = {}) {
    return clone(
      [...this.#channels.values()].filter((channel) => {
        if (enabled !== null && channel.enabled !== enabled) return false
        if (appId !== undefined && channel.appId !== appId) return false
        return true
      }),
    )
  }

  async getNotificationChannel(id) {
    return clone(this.#channels.get(id)) ?? null
  }

  async updateNotificationChannel(id, patch) {
    const channel = this.#channels.get(id)
    if (!channel) return null
    Object.assign(channel, patch)
    return clone(channel)
  }

  async deleteNotificationChannel(id) {
    return this.#channels.delete(id)
  }

  async createNotification(input) {
    const row = {
      id: newId('ntf'),
      channelId: input.channelId,
      runId: input.runId ?? null,
      event: input.event,
      payload: input.payload ?? {},
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
    }
    this.#notifications.set(row.id, row)
    return clone(row)
  }

  async listPendingNotifications({ limit = 50 } = {}) {
    return clone(
      [...this.#notifications.values()]
        .filter((row) => row.status === 'pending')
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .slice(0, limit),
    )
  }

  async listNotifications({ runId = null, limit = 50 } = {}) {
    return clone(
      [...this.#notifications.values()]
        .filter((row) => (runId ? row.runId === runId : true))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit),
    )
  }

  async updateNotification(id, patch) {
    const row = this.#notifications.get(id)
    if (!row) return null
    Object.assign(row, patch)
    return clone(row)
  }

  // The previous *finished* run of the same task, which is what a transition is
  // measured against. Same task, not same suite: an hourly mock job and a
  // nightly real job on one suite are separate signals.
  async findPreviousFinishedRun(taskId, excludeRunId) {
    return (
      clone(
        [...this.#runs.values()]
          .filter(
            (run) =>
              run.taskId === taskId &&
              run.id !== excludeRunId &&
              run.finishedAt &&
              ['passed', 'failed', 'blocked'].includes(run.status),
          )
          .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0],
      ) ?? null
    )
  }

  // -- secrets ---------------------------------------------------------------

  async putSecret(input) {
    const key = `${input.appId}::${input.name}`
    const existing = this.#secrets.get(key)
    const record = {
      id: existing?.id ?? newId('sec'),
      appId: input.appId,
      name: input.name,
      ciphertext: input.ciphertext,
      iv: input.iv,
      tag: input.tag,
      description: input.description ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.#secrets.set(key, record)
    return clone(record)
  }

  async listSecrets(appId) {
    return clone([...this.#secrets.values()].filter((entry) => entry.appId === appId))
  }

  async deleteSecret(appId, name) {
    return this.#secrets.delete(`${appId}::${name}`)
  }

  // -- audit -----------------------------------------------------------------
  //
  // Append-only: there is no update or delete. A log that can be edited is not
  // evidence of anything.

  async createAuditEvent(input) {
    const event = {
      id: newId('aud'),
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      appId: input.appId ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      sourceIp: input.sourceIp ?? null,
      createdAt: new Date().toISOString(),
    }
    this.#auditEvents.push(event)
    return clone(event)
  }

  async listAuditEvents({ resourceType = null, resourceId = null, appId = null, limit = 100 } = {}) {
    return clone(
      this.#auditEvents
        .filter((event) => {
          if (resourceType && event.resourceType !== resourceType) return false
          if (resourceId && event.resourceId !== resourceId) return false
          if (appId && event.appId !== appId) return false
          return true
        })
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit),
    )
  }

  async findLastPassingRun(taskId, excludeRunId) {
    return (
      clone(
        [...this.#runs.values()]
          .filter((run) => run.taskId === taskId && run.id !== excludeRunId && run.status === 'passed')
          .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0],
      ) ?? null
    )
  }
}

export function runnerMatchesSuite(runner, suite) {
  const capabilities = runner.capabilities ?? {}
  const engines = capabilities.engines ?? []
  const surfaces = capabilities.surfaces ?? []
  if (!engines.includes(suite.engine)) return false
  if (!surfaces.includes(suite.surface)) return false
  const requiredOs = suite.requirements?.os
  if (Array.isArray(requiredOs) && requiredOs.length > 0 && !requiredOs.includes(runner.os)) {
    return false
  }
  return true
}
