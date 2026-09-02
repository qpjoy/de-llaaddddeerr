import pg from 'pg'
import { AppError } from '../core/errors.mjs'
import { newId } from '../core/ids.mjs'

// PostgreSQL store against the `mx_test` database (specs/02-domain-model.md).
// Same interface as MemoryStore.

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null)

function mapApp(row) {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch ?? null,
    latestPackage: row.latest_package ?? null,
    webhookSecret: row.webhook_secret ?? null,
    surfaces: row.surfaces ?? [],
    catalogGlob: row.catalog_glob,
    enabled: row.enabled,
    createdAt: iso(row.created_at),
  }
}

function mapSuite(row) {
  return {
    id: row.id,
    appId: row.app_id,
    slug: row.slug,
    displayName: row.display_name,
    engine: row.engine,
    surface: row.surface,
    kind: row.kind ?? 'test',
    artifactPath: row.artifact_path ?? null,
    repoUrl: row.repo_url ?? null,
    defaultBranch: row.default_branch ?? null,
    runnerKind: row.runner_kind,
    runnerImage: row.runner_image,
    workingDir: row.working_dir ?? null,
    targetMode: row.target_mode ?? 'external',
    requirements: row.requirements ?? {},
    command: row.command ?? [],
    retryPolicy: row.retry_policy ?? {},
    secretRefs: row.secret_refs ?? [],
    writesData: row.writes_data,
    enabled: row.enabled,
    createdAt: iso(row.created_at),
  }
}

function mapSecret(row) {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    ciphertext: row.ciphertext,
    iv: row.iv,
    tag: row.tag,
    description: row.description,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function mapAuditEvent(row) {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    appId: row.app_id,
    before: row.before ?? null,
    after: row.after ?? null,
    sourceIp: row.source_ip,
    createdAt: iso(row.created_at),
  }
}

function mapChannel(row) {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    kind: row.kind,
    config: row.config ?? {},
    events: row.events ?? [],
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  }
}

function mapNotification(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    runId: row.run_id,
    event: row.event,
    payload: row.payload ?? {},
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    deliveredAt: iso(row.delivered_at),
  }
}

function mapCase(row) {
  return {
    appId: row.app_id,
    caseId: row.case_id,
    title: row.title,
    priority: row.priority,
    tags: row.tags ?? [],
    tracks: row.tracks ?? [],
    specPath: row.spec_path,
    suiteSlug: row.suite_slug,
    requirementRef: row.requirement_ref,
    catalogFile: row.catalog_file,
    origin: row.origin,
    steps: row.steps ?? [],
    preconditions: row.preconditions,
    notes: row.notes,
    createdBy: row.created_by,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    retiredAt: iso(row.retired_at),
  }
}

function mapMember(row) {
  return {
    principalId: row.principal_id,
    displayName: row.display_name,
    role: row.role,
    launcherSub: row.launcher_sub,
    lastSeenAt: iso(row.last_seen_at),
    createdAt: iso(row.created_at),
  }
}

function mapTask(row) {
  return {
    id: row.id,
    appId: row.app_id,
    suiteId: row.suite_id,
    name: row.name,
    profile: row.profile,
    track: row.track,
    targetUrl: row.target_url,
    scheduleKind: row.schedule_kind,
    cronExpr: row.cron_expr,
    runAt: iso(row.run_at),
    timezone: row.timezone,
    claimWindowMinutes: row.claim_window_minutes,
    enabled: row.enabled,
    nextRunAt: iso(row.next_run_at),
    lastRunId: row.last_run_id,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  }
}

function mapRun(row) {
  return {
    id: row.id,
    appId: row.app_id,
    suiteId: row.suite_id,
    taskId: row.task_id,
    profile: row.profile,
    track: row.track,
    engine: row.engine,
    status: row.status,
    trigger: row.trigger,
    targetUrl: row.target_url,
    sourceRef: row.source_ref ?? {},
    appPackage: row.app_package ?? null,
    runnerId: row.runner_id,
    runTokenSha256: row.run_token_sha256,
    artifacts: row.artifacts ?? {},
    totals: row.totals ?? {},
    catalog: row.catalog ?? {},
    queuedAt: iso(row.queued_at),
    claimDeadline: iso(row.claim_deadline),
    leaseUntil: iso(row.lease_until),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    durationMs: row.duration_ms,
    blockedReason: row.blocked_reason,
    createdBy: row.created_by,
  }
}

function mapRunCase(row) {
  return {
    caseId: row.case_id,
    status: row.status,
    attempts: row.attempts,
    durationMs: row.duration_ms,
    errorText: row.error_text,
    specPath: row.spec_path,
    title: row.title,
  }
}

function mapRunner(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    os: row.os,
    arch: row.arch,
    capabilities: row.capabilities ?? {},
    ownerPrincipal: row.owner_principal,
    tokenSha256: row.token_sha256,
    status: row.status,
    lastSeenAt: iso(row.last_seen_at),
  }
}

export class PostgresStore {
  constructor(pool) {
    this.pool = pool
  }

  async close() {
    await this.pool.end()
  }

  async ping() {
    await this.pool.query('SELECT 1')
    return true
  }

  async #tx(handler) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await handler(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  // -- apps ------------------------------------------------------------------

  async createApp(input) {
    const id = newId('app')
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO mxt_apps
           (id, slug, display_name, repo_url, default_branch, surfaces, catalog_glob)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
        [
          id,
          input.slug,
          input.displayName,
          input.repoUrl ?? null,
          input.defaultBranch ?? null,
          JSON.stringify(input.surfaces ?? []),
          input.catalogGlob ?? null,
        ],
      )
      return mapApp(rows[0])
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'app_exists', `App "${input.slug}" already exists`)
      }
      throw error
    }
  }

  async listApps() {
    const { rows } = await this.pool.query('SELECT * FROM mxt_apps ORDER BY slug')
    return rows.map(mapApp)
  }

  async getApp(id) {
    const { rows } = await this.pool.query('SELECT * FROM mxt_apps WHERE id = $1', [id])
    return rows[0] ? mapApp(rows[0]) : null
  }

  async getAppBySlug(slug) {
    const { rows } = await this.pool.query('SELECT * FROM mxt_apps WHERE slug = $1', [slug])
    return rows[0] ? mapApp(rows[0]) : null
  }

  async setWebhookSecret(appId, record) {
    const { rows } = await this.pool.query(
      'UPDATE mxt_apps SET webhook_secret = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *',
      [appId, JSON.stringify(record)],
    )
    return rows[0] ? mapApp(rows[0]) : null
  }

  async getWebhookSecret(appId) {
    const { rows } = await this.pool.query('SELECT webhook_secret FROM mxt_apps WHERE id = $1', [appId])
    return rows[0]?.webhook_secret ?? null
  }

  async findRunByTaskAndSha(taskId, gitSha) {
    const { rows } = await this.pool.query(
      `SELECT * FROM mxt_runs
       WHERE task_id = $1 AND source_ref ->> 'gitSha' = $2 AND trigger = 'webhook'
       LIMIT 1`,
      [taskId, gitSha],
    )
    return rows[0] ? mapRun(rows[0]) : null
  }

  async setLatestPackage(appId, pkg) {
    const { rows } = await this.pool.query(
      'UPDATE mxt_apps SET latest_package = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *',
      [appId, JSON.stringify(pkg)],
    )
    return rows[0] ? mapApp(rows[0]) : null
  }

  // -- suites ----------------------------------------------------------------

  async createSuite(input) {
    const id = newId('ste')
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO mxt_suites
           (id, app_id, slug, display_name, engine, surface, runner_kind, runner_image,
            working_dir, target_mode, kind, repo_url, default_branch, artifact_path,
            requirements, command, retry_policy, secret_refs, writes_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19)
         RETURNING *`,
        [
          id,
          input.appId,
          input.slug,
          input.displayName,
          input.engine,
          input.surface,
          input.runnerKind,
          input.runnerImage ?? null,
          input.workingDir ?? null,
          input.targetMode ?? 'external',
          input.kind ?? 'test',
          input.repoUrl ?? null,
          input.defaultBranch ?? null,
          input.artifactPath ?? null,
          JSON.stringify(input.requirements ?? {}),
          JSON.stringify(input.command ?? []),
          JSON.stringify(input.retryPolicy ?? {}),
          JSON.stringify(input.secretRefs ?? []),
          Boolean(input.writesData),
        ],
      )
      return mapSuite(rows[0])
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'suite_exists', `Suite "${input.slug}" already exists`)
      }
      throw error
    }
  }

  // Partial update of a suite. Only the columns actually present in `patch` are
  // written, so a caller fixing one field cannot blank the rest by omission.
  //
  // A suite that was registered wrong — the wrong command, the wrong repository
  // — was previously only fixable in the database. That is not an operation a
  // test lead can be asked to perform, and it made every onboarding script's
  // "already exists, skipping" a permanent decision.
  async updateSuite(id, patch) {
    const columns = {
      displayName: 'display_name',
      engine: 'engine',
      surface: 'surface',
      runnerKind: 'runner_kind',
      runnerImage: 'runner_image',
      workingDir: 'working_dir',
      targetMode: 'target_mode',
      kind: 'kind',
      repoUrl: 'repo_url',
      defaultBranch: 'default_branch',
      artifactPath: 'artifact_path',
      writesData: 'writes_data',
    }
    const json = {
      requirements: 'requirements',
      command: 'command',
      retryPolicy: 'retry_policy',
      secretRefs: 'secret_refs',
    }
    const sets = []
    const values = [id]
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue
      values.push(patch[key] ?? null)
      sets.push(`${column} = $${values.length}`)
    }
    for (const [key, column] of Object.entries(json)) {
      if (!(key in patch)) continue
      values.push(JSON.stringify(patch[key]))
      sets.push(`${column} = $${values.length}::jsonb`)
    }
    if (sets.length === 0) return this.getSuite(id)
    const { rows } = await this.pool.query(
      `UPDATE mxt_suites SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      values,
    )
    return rows[0] ? mapSuite(rows[0]) : null
  }

  async listSuites(appId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM mxt_suites WHERE app_id = $1 ORDER BY slug',
      [appId],
    )
    return rows.map(mapSuite)
  }

  async getSuite(id) {
    const { rows } = await this.pool.query('SELECT * FROM mxt_suites WHERE id = $1', [id])
    return rows[0] ? mapSuite(rows[0]) : null
  }

  // -- cases -----------------------------------------------------------------

  async syncCatalog(appId, { catalogFile, cases }) {
    return this.#tx(async (client) => {
      const result = { added: [], updated: [], retired: [] }
      for (const entry of cases) {
        const { rows } = await client.query(
          `INSERT INTO mxt_cases
             (app_id, case_id, title, priority, tags, tracks, spec_path, suite_slug,
              requirement_ref, catalog_file)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10)
           ON CONFLICT (app_id, case_id) DO UPDATE SET
             origin = 'catalog',
             title = EXCLUDED.title,
             priority = EXCLUDED.priority,
             tags = EXCLUDED.tags,
             tracks = EXCLUDED.tracks,
             spec_path = EXCLUDED.spec_path,
             suite_slug = EXCLUDED.suite_slug,
             requirement_ref = EXCLUDED.requirement_ref,
             catalog_file = EXCLUDED.catalog_file,
             last_seen_at = now(),
             retired_at = NULL
           RETURNING (xmax = 0) AS inserted`,
          [
            appId,
            entry.caseId,
            entry.title,
            entry.priority,
            JSON.stringify(entry.tags ?? []),
            JSON.stringify(entry.tracks ?? ['functional']),
            entry.specPath ?? null,
            entry.suiteSlug ?? null,
            entry.requirementRef ?? null,
            catalogFile,
          ],
        )
        // `xmax = 0` distinguishes an INSERT from an UPDATE inside an upsert:
        // on a fresh row no transaction has ever locked it.
        ;(rows[0].inserted ? result.added : result.updated).push(entry.caseId)
      }

      // Retire, never delete: a run from six months ago still points here.
      // Scoped to this catalog file, which is also what keeps a repository sync
      // from removing cases a tester wrote in the UI — those carry a different
      // catalog_file and are never in scope.
      const ids = cases.map((entry) => entry.caseId)
      const { rows: retired } = await client.query(
        `UPDATE mxt_cases SET retired_at = now()
          WHERE app_id = $1 AND catalog_file = $2 AND retired_at IS NULL
            AND NOT (case_id = ANY($3::text[]))
        RETURNING case_id`,
        [appId, catalogFile, ids],
      )
      result.retired = retired.map((row) => row.case_id)
      return result
    })
  }

  async listCases(appId, { includeRetired = false, priority = null } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM mxt_cases
        WHERE app_id = $1
          AND ($2::boolean OR retired_at IS NULL)
          AND ($3::text IS NULL OR priority = $3)
        ORDER BY case_id`,
      [appId, includeRetired, priority],
    )
    return rows.map(mapCase)
  }

  // -- tasks -----------------------------------------------------------------

  async createTask(input) {
    const id = newId('tsk')
    const { rows } = await this.pool.query(
      `INSERT INTO mxt_tasks
         (id, app_id, suite_id, name, profile, track, target_url, schedule_kind,
          cron_expr, run_at, timezone, claim_window_minutes, enabled, next_run_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        id,
        input.appId,
        input.suiteId,
        input.name,
        input.profile,
        input.track,
        input.targetUrl ?? null,
        input.scheduleKind,
        input.cronExpr ?? null,
        input.runAt ?? null,
        input.timezone,
        input.claimWindowMinutes,
        input.enabled !== false,
        input.nextRunAt ?? null,
        input.createdBy ?? null,
      ],
    )
    return mapTask(rows[0])
  }

  async listTasks({ appId = null, enabled = null } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM mxt_tasks
        WHERE ($1::text IS NULL OR app_id = $1)
          AND ($2::boolean IS NULL OR enabled = $2)
        ORDER BY created_at`,
      [appId, enabled],
    )
    return rows.map(mapTask)
  }

  async getTask(id) {
    const { rows } = await this.pool.query('SELECT * FROM mxt_tasks WHERE id = $1', [id])
    return rows[0] ? mapTask(rows[0]) : null
  }

  async updateTask(id, patch) {
    const columns = {
      name: 'name',
      profile: 'profile',
      track: 'track',
      targetUrl: 'target_url',
      scheduleKind: 'schedule_kind',
      cronExpr: 'cron_expr',
      runAt: 'run_at',
      timezone: 'timezone',
      claimWindowMinutes: 'claim_window_minutes',
      enabled: 'enabled',
      nextRunAt: 'next_run_at',
      lastRunId: 'last_run_id',
    }
    const assignments = []
    const values = [id]
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(patch, key)) continue
      values.push(patch[key])
      assignments.push(`${column} = $${values.length}`)
    }
    if (assignments.length === 0) return this.getTask(id)
    const { rows } = await this.pool.query(
      `UPDATE mxt_tasks SET ${assignments.join(', ')}, updated_at = now()
        WHERE id = $1 RETURNING *`,
      values,
    )
    return rows[0] ? mapTask(rows[0]) : null
  }

  async deleteTask(id) {
    const { rowCount } = await this.pool.query('DELETE FROM mxt_tasks WHERE id = $1', [id])
    return rowCount > 0
  }

  async dueTasks(now) {
    const { rows } = await this.pool.query(
      `SELECT * FROM mxt_tasks WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1`,
      [now],
    )
    return rows.map(mapTask)
  }

  // -- runs ------------------------------------------------------------------

  async createRun(input) {
    const id = newId('trun')
    const { rows } = await this.pool.query(
      `INSERT INTO mxt_runs
         (id, app_id, suite_id, task_id, profile, track, engine, status, trigger,
          target_url, source_ref, app_package, claim_deadline, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14) RETURNING *`,
      [
        id,
        input.appId,
        input.suiteId,
        input.taskId ?? null,
        input.profile,
        input.track,
        input.engine,
        input.status ?? 'queued',
        input.trigger,
        input.targetUrl ?? null,
        JSON.stringify(input.sourceRef ?? {}),
        input.appPackage ? JSON.stringify(input.appPackage) : null,
        input.claimDeadline ?? null,
        input.createdBy ?? null,
      ],
    )
    return mapRun(rows[0])
  }

  async getRun(id) {
    const { rows } = await this.pool.query('SELECT * FROM mxt_runs WHERE id = $1', [id])
    return rows[0] ? mapRun(rows[0]) : null
  }

  async getRunByTokenHash(hash) {
    const { rows } = await this.pool.query(
      'SELECT * FROM mxt_runs WHERE run_token_sha256 = $1',
      [hash],
    )
    return rows[0] ? mapRun(rows[0]) : null
  }

  async listRuns({ appId = null, taskId = null, status = null, limit = 50 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM mxt_runs
        WHERE ($1::text IS NULL OR app_id = $1)
          AND ($2::text IS NULL OR task_id = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY queued_at DESC LIMIT $4`,
      [appId, taskId, status, Math.min(limit, 200)],
    )
    return rows.map(mapRun)
  }

  async updateRun(id, patch) {
    const columns = {
      status: 'status',
      runnerId: 'runner_id',
      leaseUntil: 'lease_until',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      durationMs: 'duration_ms',
      blockedReason: 'blocked_reason',
      targetUrl: 'target_url',
      runTokenSha256: 'run_token_sha256',
    }
    const jsonColumns = { totals: 'totals', catalog: 'catalog', artifacts: 'artifacts' }
    const assignments = []
    const values = [id]
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(patch, key)) continue
      values.push(patch[key])
      assignments.push(`${column} = $${values.length}`)
    }
    for (const [key, column] of Object.entries(jsonColumns)) {
      if (!Object.hasOwn(patch, key)) continue
      values.push(JSON.stringify(patch[key] ?? {}))
      assignments.push(`${column} = $${values.length}::jsonb`)
    }
    if (assignments.length === 0) return this.getRun(id)
    const { rows } = await this.pool.query(
      `UPDATE mxt_runs SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
      values,
    )
    return rows[0] ? mapRun(rows[0]) : null
  }

  /**
   * Atomically hand one matching run to a runner.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes several runners polling at once safe:
   * each transaction takes a different row instead of blocking on the same one,
   * so no run is ever handed out twice.
   */
  async claimRun({ runner, leaseMs, now, runTokenSha256 = null }) {
    return this.#tx(async (client) => {
      const capabilities = runner.capabilities ?? {}
      const { rows } = await client.query(
        `SELECT r.* FROM mxt_runs r
           JOIN mxt_suites s ON s.id = r.suite_id
          WHERE r.status IN ('queued','pending-runner')
            AND s.engine = ANY($1::text[])
            AND s.surface = ANY($2::text[])
            AND (
              -- Containment rather than jsonb_array_length: PostgreSQL does not
              -- promise to short-circuit OR, and jsonb_array_length raises on a
              -- non-array. Containment and equality return false instead, so a
              -- malformed requirements blob cannot turn every claim into a 500.
              NOT (s.requirements ? 'os')
              OR s.requirements->'os' = '[]'::jsonb
              OR s.requirements->'os' @> to_jsonb($3::text)
            )
          ORDER BY r.queued_at
          FOR UPDATE OF r SKIP LOCKED
          LIMIT 1`,
        [capabilities.engines ?? [], capabilities.surfaces ?? [], runner.os],
      )
      if (!rows[0]) return null
      const { rows: updated } = await client.query(
        `UPDATE mxt_runs
            SET status = 'running', runner_id = $2, started_at = $3, lease_until = $4,
                run_token_sha256 = COALESCE($5, run_token_sha256)
          WHERE id = $1 RETURNING *`,
        [rows[0].id, runner.id, now, new Date(now.getTime() + leaseMs), runTokenSha256],
      )
      const { rows: suiteRows } = await client.query('SELECT * FROM mxt_suites WHERE id = $1', [
        updated[0].suite_id,
      ])
      return { run: mapRun(updated[0]), suite: mapSuite(suiteRows[0]) }
    })
  }

  async completeRun(runId, payload) {
    return this.#tx(async (client) => {
      const { run } = payload
      const { rows } = await client.query(
        `UPDATE mxt_runs SET
           status = $2, finished_at = $3, duration_ms = $4, totals = $5::jsonb,
           catalog = $6::jsonb, artifacts = $7::jsonb, blocked_reason = $8,
           -- Which commit was actually tested. Written here rather than left at
           -- whatever the run was created with, because the runner reads it back
           -- after checkout and that is the only value that describes what ran.
           source_ref = $9::jsonb,
           -- The credential dies with the run: a crashed-and-restarted runner
           -- must not be able to rewrite a result already recorded.
           lease_until = NULL, run_token_sha256 = NULL
         WHERE id = $1 RETURNING *`,
        [
          runId,
          run.status,
          run.finishedAt,
          run.durationMs,
          JSON.stringify(run.totals ?? {}),
          JSON.stringify(run.catalog ?? {}),
          JSON.stringify(run.artifacts ?? {}),
          run.blockedReason ?? null,
          JSON.stringify(run.sourceRef ?? {}),
        ],
      )
      if (!rows[0]) return null

      // A retried complete must not double-insert. Delete first, then write.
      await client.query('DELETE FROM mxt_run_cases WHERE run_id = $1', [runId])
      await client.query('DELETE FROM mxt_steps WHERE run_id = $1', [runId])

      for (const testCase of payload.cases) {
        await client.query(
          `INSERT INTO mxt_run_cases
             (run_id, app_id, case_id, status, attempts, duration_ms, error_text, spec_path, title)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            runId,
            rows[0].app_id,
            testCase.caseId,
            testCase.status,
            testCase.attempts ?? 1,
            testCase.durationMs ?? null,
            testCase.errorText ?? null,
            testCase.specPath ?? null,
            testCase.title ?? null,
          ],
        )
        for (const step of testCase.steps ?? []) {
          await client.query(
            `INSERT INTO mxt_steps (run_id, case_id, seq, label, status, offset_ms, duration_ms)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              runId,
              testCase.caseId,
              step.seq,
              step.label,
              step.status,
              step.offsetMs ?? null,
              step.durationMs ?? null,
            ],
          )
        }
      }
      return mapRun(rows[0])
    })
  }

  async listRunCases(runId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM mxt_run_cases WHERE run_id = $1 ORDER BY case_id',
      [runId],
    )
    return rows.map(mapRunCase)
  }

  async listSteps(runId, caseId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM mxt_steps WHERE run_id = $1 AND case_id = $2 ORDER BY seq',
      [runId, caseId],
    )
    return rows.map((row) => ({
      seq: row.seq,
      label: row.label,
      status: row.status,
      offsetMs: row.offset_ms,
      durationMs: row.duration_ms,
    }))
  }

  /** Every step of a run, grouped by case id — one query for the whole report. */
  async listAllSteps(runId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM mxt_steps WHERE run_id = $1 ORDER BY case_id, seq',
      [runId],
    )
    const grouped = {}
    for (const row of rows) {
      ;(grouped[row.case_id] ??= []).push({
        seq: row.seq,
        label: row.label,
        status: row.status,
        offsetMs: row.offset_ms,
        durationMs: row.duration_ms,
      })
    }
    return grouped
  }

  async sweepStaleRuns(now) {
    const { rows: expired } = await this.pool.query(
      `UPDATE mxt_runs SET status = 'expired', finished_at = $1
        WHERE status IN ('queued','pending-runner')
          AND claim_deadline IS NOT NULL AND claim_deadline <= $1
      RETURNING id`,
      [now],
    )
    const { rows: timedOut } = await this.pool.query(
      `UPDATE mxt_runs
          SET status = 'timeout', finished_at = $1, blocked_reason = 'Runner stopped reporting'
        WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= $1
      RETURNING id`,
      [now],
    )
    return { expired: expired.map((row) => row.id), timedOut: timedOut.map((row) => row.id) }
  }

  // -- runners ---------------------------------------------------------------

  async registerRunner(input) {
    const id = newId('rnr')
    const { rows } = await this.pool.query(
      `INSERT INTO mxt_runners (id, name, kind, os, arch, capabilities, owner_principal, token_sha256, status, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'idle',now())
       ON CONFLICT (name) DO UPDATE SET
         kind = EXCLUDED.kind, os = EXCLUDED.os, arch = EXCLUDED.arch,
         capabilities = EXCLUDED.capabilities, owner_principal = EXCLUDED.owner_principal,
         token_sha256 = EXCLUDED.token_sha256, status = 'idle', last_seen_at = now()
       RETURNING *`,
      [
        id,
        input.name,
        input.kind,
        input.os,
        input.arch ?? null,
        JSON.stringify(input.capabilities ?? {}),
        input.ownerPrincipal ?? null,
        input.tokenSha256,
      ],
    )
    return mapRunner(rows[0])
  }

  async getRunnerByTokenHash(hash) {
    const { rows } = await this.pool.query('SELECT * FROM mxt_runners WHERE token_sha256 = $1', [
      hash,
    ])
    return rows[0] ? mapRunner(rows[0]) : null
  }

  async touchRunner(id, status) {
    const { rows } = await this.pool.query(
      'UPDATE mxt_runners SET status = $2, last_seen_at = now() WHERE id = $1 RETURNING *',
      [id, status],
    )
    return rows[0] ? mapRunner(rows[0]) : null
  }

  async listRunners() {
    const { rows } = await this.pool.query('SELECT * FROM mxt_runners ORDER BY name')
    return rows.map(mapRunner)
  }

  // -- members ---------------------------------------------------------------

  async getMember(principalId) {
    const { rows } = await this.pool.query('SELECT * FROM mxt_members WHERE principal_id = $1', [
      principalId,
    ])
    return rows[0] ? mapMember(rows[0]) : null
  }

  async upsertMember({ principalId, displayName, launcherSub, role }) {
    const { rows } = await this.pool.query(
      `INSERT INTO mxt_members (principal_id, display_name, launcher_sub, role, last_seen_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (principal_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         launcher_sub = COALESCE(EXCLUDED.launcher_sub, mxt_members.launcher_sub),
         -- Role is NOT overwritten on re-login: what an admin granted stands.
         last_seen_at = now()
       RETURNING *`,
      [principalId, displayName, launcherSub ?? null, role ?? 'viewer'],
    )
    return mapMember(rows[0])
  }

  async setMemberRole(principalId, role) {
    const { rows } = await this.pool.query(
      'UPDATE mxt_members SET role = $2 WHERE principal_id = $1 RETURNING *',
      [principalId, role],
    )
    return rows[0] ? mapMember(rows[0]) : null
  }

  async touchMember(principalId) {
    const { rows } = await this.pool.query(
      'UPDATE mxt_members SET last_seen_at = now() WHERE principal_id = $1 RETURNING *',
      [principalId],
    )
    return rows[0] ? mapMember(rows[0]) : null
  }

  async listMembers() {
    const { rows } = await this.pool.query('SELECT * FROM mxt_members ORDER BY display_name')
    return rows.map(mapMember)
  }

  // -- case authoring --------------------------------------------------------

  async upsertCase(appId, entry) {
    const { rows } = await this.pool.query(
      `INSERT INTO mxt_cases
         (app_id, case_id, title, priority, tags, tracks, spec_path, suite_slug,
          requirement_ref, catalog_file, origin, steps, preconditions, notes, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
       ON CONFLICT (app_id, case_id) DO UPDATE SET
         title = EXCLUDED.title,
         priority = EXCLUDED.priority,
         tags = EXCLUDED.tags,
         tracks = EXCLUDED.tracks,
         spec_path = EXCLUDED.spec_path,
         suite_slug = EXCLUDED.suite_slug,
         requirement_ref = EXCLUDED.requirement_ref,
         steps = EXCLUDED.steps,
         preconditions = EXCLUDED.preconditions,
         notes = EXCLUDED.notes,
         last_seen_at = now(),
         updated_at = now(),
         retired_at = NULL
       RETURNING *`,
      [
        appId,
        entry.caseId,
        entry.title,
        entry.priority,
        JSON.stringify(entry.tags ?? []),
        JSON.stringify(entry.tracks ?? ['functional']),
        entry.specPath ?? null,
        entry.suiteSlug ?? null,
        entry.requirementRef ?? null,
        entry.catalogFile ?? '__platform__',
        entry.origin ?? 'platform',
        JSON.stringify(entry.steps ?? []),
        entry.preconditions ?? null,
        entry.notes ?? null,
        entry.createdBy ?? null,
      ],
    )
    return mapCase(rows[0])
  }

  async getCase(appId, caseId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM mxt_cases WHERE app_id = $1 AND case_id = $2',
      [appId, caseId],
    )
    return rows[0] ? mapCase(rows[0]) : null
  }

  async retireCase(appId, caseId) {
    const { rows } = await this.pool.query(
      'UPDATE mxt_cases SET retired_at = now() WHERE app_id = $1 AND case_id = $2 RETURNING *',
      [appId, caseId],
    )
    return rows[0] ? mapCase(rows[0]) : null
  }

  async caseHistory(appId, caseId, limit = 30) {
    const { rows } = await this.pool.query(
      `SELECT rc.run_id, rc.status, rc.duration_ms, r.finished_at, r.task_id
         FROM mxt_run_cases rc
         JOIN mxt_runs r ON r.id = rc.run_id
        WHERE rc.app_id = $1 AND rc.case_id = $2
        ORDER BY rc.id DESC
        LIMIT $3`,
      [appId, caseId, Math.min(limit, 200)],
    )
    return rows.map((row) => ({
      runId: row.run_id,
      status: row.status,
      durationMs: row.duration_ms,
      finishedAt: iso(row.finished_at),
      taskId: row.task_id,
    }))
  }

  // -- notifications ---------------------------------------------------------

  async createNotificationChannel(input) {
    const { rows } = await this.pool.query(
      `INSERT INTO mxt_notification_channels (id, app_id, name, kind, config, events, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING *`,
      [
        newId('nch'),
        input.appId ?? null,
        input.name,
        input.kind,
        JSON.stringify(input.config ?? {}),
        JSON.stringify(input.events ?? ['failure', 'recovery', 'blocked']),
        input.enabled !== false,
        input.createdBy ?? null,
      ],
    )
    return mapChannel(rows[0])
  }

  async listNotificationChannels({ enabled = null, appId = undefined } = {}) {
    const where = []
    const values = []
    if (enabled !== null) {
      values.push(enabled)
      where.push(`enabled = $${values.length}`)
    }
    if (appId !== undefined) {
      if (appId === null) {
        where.push('app_id IS NULL')
      } else {
        values.push(appId)
        where.push(`app_id = $${values.length}`)
      }
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM mxt_notification_channels
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at`,
      values,
    )
    return rows.map(mapChannel)
  }

  async getNotificationChannel(id) {
    const { rows } = await this.pool.query('SELECT * FROM mxt_notification_channels WHERE id = $1', [id])
    return rows[0] ? mapChannel(rows[0]) : null
  }

  async updateNotificationChannel(id, patch) {
    const { rows } = await this.pool.query(
      `UPDATE mxt_notification_channels
         SET name = COALESCE($2, name),
             config = COALESCE($3::jsonb, config),
             events = COALESCE($4::jsonb, events),
             enabled = COALESCE($5, enabled),
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        id,
        patch.name ?? null,
        patch.config ? JSON.stringify(patch.config) : null,
        patch.events ? JSON.stringify(patch.events) : null,
        patch.enabled ?? null,
      ],
    )
    return rows[0] ? mapChannel(rows[0]) : null
  }

  async deleteNotificationChannel(id) {
    const { rowCount } = await this.pool.query('DELETE FROM mxt_notification_channels WHERE id = $1', [id])
    return rowCount > 0
  }

  async createNotification(input) {
    const { rows } = await this.pool.query(
      `INSERT INTO mxt_notifications (id, channel_id, run_id, event, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
      [newId('ntf'), input.channelId, input.runId ?? null, input.event, JSON.stringify(input.payload ?? {})],
    )
    return mapNotification(rows[0])
  }

  async listPendingNotifications({ limit = 50 } = {}) {
    // FOR UPDATE SKIP LOCKED is not used: the scheduler is single-replica by
    // design (30-server.yaml pins replicas to 1). If that ever changes, this is
    // the query that has to change with it.
    const { rows } = await this.pool.query(
      `SELECT * FROM mxt_notifications WHERE status = 'pending' ORDER BY created_at LIMIT $1`,
      [limit],
    )
    return rows.map(mapNotification)
  }

  async listNotifications({ runId = null, limit = 50 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM mxt_notifications
       ${runId ? 'WHERE run_id = $2' : ''}
       ORDER BY created_at DESC LIMIT $1`,
      runId ? [limit, runId] : [limit],
    )
    return rows.map(mapNotification)
  }

  async updateNotification(id, patch) {
    const { rows } = await this.pool.query(
      `UPDATE mxt_notifications
         SET status = COALESCE($2, status),
             attempts = COALESCE($3, attempts),
             last_error = $4,
             delivered_at = COALESCE($5, delivered_at)
       WHERE id = $1 RETURNING *`,
      [id, patch.status ?? null, patch.attempts ?? null, patch.lastError ?? null, patch.deliveredAt ?? null],
    )
    return rows[0] ? mapNotification(rows[0]) : null
  }

  async findPreviousFinishedRun(taskId, excludeRunId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM mxt_runs
       WHERE task_id = $1 AND id <> $2 AND finished_at IS NOT NULL
         AND status IN ('passed','failed','blocked')
       ORDER BY finished_at DESC LIMIT 1`,
      [taskId, excludeRunId],
    )
    return rows[0] ? mapRun(rows[0]) : null
  }

  // -- secrets ---------------------------------------------------------------

  async putSecret(input) {
    const { rows } = await this.pool.query(
      `INSERT INTO mxt_secrets (id, app_id, name, ciphertext, iv, tag, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (app_id, name) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext,
             iv = EXCLUDED.iv,
             tag = EXCLUDED.tag,
             description = COALESCE(EXCLUDED.description, mxt_secrets.description),
             updated_at = now()
       RETURNING *`,
      [
        newId('sec'),
        input.appId,
        input.name,
        input.ciphertext,
        input.iv,
        input.tag,
        input.description ?? null,
        input.createdBy ?? null,
      ],
    )
    return mapSecret(rows[0])
  }

  async listSecrets(appId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM mxt_secrets WHERE app_id = $1 ORDER BY name',
      [appId],
    )
    return rows.map(mapSecret)
  }

  async deleteSecret(appId, name) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM mxt_secrets WHERE app_id = $1 AND name = $2',
      [appId, name],
    )
    return rowCount > 0
  }

  // -- audit -----------------------------------------------------------------

  async createAuditEvent(input) {
    const { rows } = await this.pool.query(
      `INSERT INTO mxt_audit_events
         (id, actor_id, actor_name, action, resource_type, resource_id, app_id, before, after, source_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) RETURNING *`,
      [
        newId('aud'),
        input.actorId ?? null,
        input.actorName ?? null,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.appId ?? null,
        input.before ? JSON.stringify(input.before) : null,
        input.after ? JSON.stringify(input.after) : null,
        input.sourceIp ?? null,
      ],
    )
    return mapAuditEvent(rows[0])
  }

  async listAuditEvents({ resourceType = null, resourceId = null, appId = null, limit = 100 } = {}) {
    const where = []
    const values = [limit]
    for (const [column, value] of [
      ['resource_type', resourceType],
      ['resource_id', resourceId],
      ['app_id', appId],
    ]) {
      if (value) {
        values.push(value)
        where.push(`${column} = $${values.length}`)
      }
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM mxt_audit_events
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC LIMIT $1`,
      values,
    )
    return rows.map(mapAuditEvent)
  }

  async findLastPassingRun(taskId, excludeRunId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM mxt_runs
       WHERE task_id = $1 AND id <> $2 AND status = 'passed'
       ORDER BY finished_at DESC LIMIT 1`,
      [taskId, excludeRunId],
    )
    return rows[0] ? mapRun(rows[0]) : null
  }

}

export function createPostgresStore({ connectionString, maxConnections = 10 }) {
  const pool = new pg.Pool({
    connectionString,
    max: maxConnections,
    application_name: 'mx-test-framework',
    statement_timeout: 30_000,
    idleTimeoutMillis: 30_000,
  })
  return new PostgresStore(pool)
}
