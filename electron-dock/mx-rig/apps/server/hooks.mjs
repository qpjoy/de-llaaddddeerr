// 钩子（Hooks）: Rig acting on its own when something happens.
//
// Two events, two actions:
//
// - a run ends failed / blocked  →  a read-only triage Agent reads the
//   evidence and files a structured conclusion (on the service);
// - a procedure fails in a regression pass  →  a repair is started for it
//   (on the desktop that ran the pass; the proposal still needs a person).
//
// What keeps this safe to leave running:
//
// - a hook mission can only use read-effect tools: it never dispatches,
//   cancels or clicks anything, so it never needs a person to confirm;
// - every (rule, subject) is claimed once — a primary key in PostgreSQL —
//   however many replicas notice the same failure;
// - each rule has an hourly cap; beyond it a failure is logged as skipped,
//   not queued for later;
// - one hook mission at a time, as its own principal, so it never competes
//   with a member's own mission;
// - only failures after the rule was created count: enabling a hook does not
//   re-triage history.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { RigError, safeMessage } from '../../packages/contracts/index.mjs'
import { toolByName } from '../../packages/runtime/tools.mjs'
import { DocumentConflict, documentFor } from './state-documents.mjs'

export const HOOK_PRINCIPAL = Object.freeze({
  kind: 'service',
  id: 'rig-hooks',
  displayName: '钩子',
  role: 'operator'
})

const RUN_STATUSES = ['failed', 'blocked', 'flaky', 'timeout', 'expired']
const TERMINAL = new Set([
  'passed',
  'failed',
  'flaky',
  'blocked',
  'timeout',
  'expired',
  'cancelled'
])
const MISSION_DONE = new Set(['completed', 'failed', 'blocked', 'cancelled'])
const WINDOW_MS = 60 * 60 * 1000
const FIRE_LIMIT = 500
const STATUS_WORD = {
  failed: '失败',
  blocked: '受阻',
  flaky: '不稳定',
  timeout: '超时',
  expired: '过期'
}

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
const ruleInput = z
  .object({
    id: z
      .string()
      .regex(/^hk_[a-f0-9]{12}$/)
      .optional(),
    name: z.string().min(1).max(80),
    enabled: z.boolean().default(true),
    event: z.enum(['run.finished', 'procedure.failed']),
    statuses: z.array(z.enum(RUN_STATUSES)).min(1).max(5).default(['failed']),
    apps: z.array(slug).max(20).default([]),
    includeProcedureRuns: z.boolean().default(false),
    agentKey: z.string().min(1).max(64).default('failure-triage'),
    maxPerHour: z.number().int().min(1).max(60).default(6),
    notify: z.boolean().default(false)
  })
  .strict()
export const hooksBody = z
  .object({ version: z.number().int().min(0), rules: z.array(z.unknown()).max(20) })
  .strict()

/** An Agent a hook may run: every tool it can reach only reads. */
export function readOnlyAgent(agent) {
  return (
    Boolean(agent?.enabled !== false && agent.tools?.length) &&
    agent.tools.every((name) => toolByName(name)?.effect === 'read')
  )
}

export class HookRules {
  constructor(source) {
    this.document = documentFor(source)
    this.value = { rules: [] }
    this.version = 0
  }
  async init() {
    return this.refresh()
  }
  async refresh() {
    const { value, version } = await this.document.load()
    this.value = value ?? { rules: [] }
    this.version = version
    return this
  }
  /**
   * Replace the rule list. Rules keep their id and creation time across
   * edits; a new rule gets both now, so it only reacts to what happens next.
   */
  async save({ version, rules }, { by, settings, now = new Date() }) {
    await this.refresh()
    if (version !== this.version) throw new DocumentConflict()
    const existing = new Map(this.value.rules.map((rule) => [rule.id, rule]))
    const next = rules.map((raw, index) => {
      const parsed = ruleInput.safeParse(raw)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new RigError(
          'invalid_hook',
          `第 ${index + 1} 条钩子不合法：${issue.path.join('.')} ${issue.message}`
        )
      }
      const rule = parsed.data
      if (rule.event === 'run.finished') {
        let agent
        try {
          agent = settings.agent(rule.agentKey)
        } catch {
          throw new RigError(
            'invalid_hook',
            `钩子「${rule.name}」用的 Agent ${rule.agentKey} 不存在或已停用`
          )
        }
        if (!readOnlyAgent(agent))
          throw new RigError(
            'invalid_hook',
            `钩子「${rule.name}」只能用只读的 Agent：${agent.displayName} 带有需要确认的工具`
          )
      }
      const before = rule.id ? existing.get(rule.id) : null
      return {
        ...rule,
        action: rule.event === 'run.finished' ? 'triage' : 'repair',
        id: before?.id ?? `hk_${randomBytes(6).toString('hex')}`,
        createdAt: before?.createdAt ?? now.toISOString(),
        createdBy: before?.createdBy ?? by,
        updatedAt: now.toISOString(),
        updatedBy: by
      }
    })
    this.version = await this.document.save({ rules: next }, this.version)
    this.value = { rules: next }
    return this.public()
  }
  public() {
    return { version: this.version, rules: this.value.rules }
  }
}

/** Does this rule care about this finished run? */
export function matches(rule, run, appSlug) {
  if (!rule.enabled || rule.event !== 'run.finished') return false
  if (!rule.statuses.includes(run.status)) return false
  if (rule.apps.length && !rule.apps.includes(appSlug)) return false
  // A procedure replay — one recorded from a desktop, or a batch a station
  // ran — has its own repair loop; triaging it too is opt-in.
  const procedureRun = run.trigger === 'rig-procedure' || run.engine === 'rig-procedure'
  if (procedureRun && !rule.includeProcedureRuns) return false
  return true
}

// -- the log of what hooks did ----------------------------------------------------

export class FileFireStore {
  constructor(file) {
    this.file = file
    this.fires = []
    this.queue = Promise.resolve()
  }
  async init() {
    try {
      this.fires = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return this
  }
  #persist() {
    const json = JSON.stringify(this.fires.slice(0, FIRE_LIMIT))
    const write = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(temp, json, { mode: 0o600 })
      await rename(temp, this.file)
    })
    this.queue = write.catch(() => {})
    return write
  }
  #find(ruleId, subjectId) {
    return this.fires.find((fire) => fire.ruleId === ruleId && fire.subjectId === subjectId)
  }
  async claim(fire) {
    if (this.#find(fire.ruleId, fire.subjectId)) return false
    this.fires.unshift(fire)
    await this.#persist()
    return true
  }
  async countSince(ruleId, since) {
    return this.fires.filter(
      (fire) => fire.ruleId === ruleId && fire.status !== 'skipped' && fire.createdAt >= since
    ).length
  }
  async nextPending() {
    return [...this.fires].reverse().find((fire) => fire.status === 'pending') ?? null
  }
  async transition(ruleId, subjectId, from, patch) {
    const fire = this.#find(ruleId, subjectId)
    if (!fire || fire.status !== from) return false
    Object.assign(fire, patch)
    await this.#persist()
    return true
  }
  async update(ruleId, subjectId, patch) {
    const fire = this.#find(ruleId, subjectId)
    if (!fire) return null
    Object.assign(fire, patch)
    await this.#persist()
    return fire
  }
  async running() {
    return this.fires.filter((fire) => fire.status === 'running')
  }
  async recent(limit = 50) {
    return this.fires.slice(0, limit).map((fire) => structuredClone(fire))
  }
}

export class PgFireStore {
  constructor(pool) {
    this.pool = pool
  }
  async claim(fire) {
    const { rowCount } = await this.pool.query(
      `INSERT INTO rig_hook_fires (rule_id, subject_id, status, doc, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5)
       ON CONFLICT (rule_id, subject_id) DO NOTHING`,
      [fire.ruleId, fire.subjectId, fire.status, JSON.stringify(fire), fire.createdAt]
    )
    return rowCount === 1
  }
  async countSince(ruleId, since) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM rig_hook_fires
        WHERE rule_id = $1 AND status <> 'skipped' AND created_at >= $2`,
      [ruleId, since]
    )
    return rows[0].n
  }
  async nextPending() {
    const { rows } = await this.pool.query(
      `SELECT doc FROM rig_hook_fires WHERE status = 'pending' ORDER BY created_at LIMIT 1`
    )
    return rows[0]?.doc ?? null
  }
  /** Compare-and-set on status: the replica whose update lands owns the step. */
  async transition(ruleId, subjectId, from, patch) {
    const { rowCount } = await this.pool.query(
      `UPDATE rig_hook_fires
          SET status = COALESCE($4, status), doc = doc || $5::jsonb, updated_at = now()
        WHERE rule_id = $1 AND subject_id = $2 AND status = $3`,
      [ruleId, subjectId, from, patch.status ?? null, JSON.stringify(patch)]
    )
    return rowCount === 1
  }
  async update(ruleId, subjectId, patch) {
    const { rows } = await this.pool.query(
      `UPDATE rig_hook_fires
          SET status = COALESCE($3, status), doc = doc || $4::jsonb, updated_at = now()
        WHERE rule_id = $1 AND subject_id = $2 RETURNING doc`,
      [ruleId, subjectId, patch.status ?? null, JSON.stringify(patch)]
    )
    return rows[0]?.doc ?? null
  }
  async running() {
    const { rows } = await this.pool.query(
      `SELECT doc FROM rig_hook_fires WHERE status = 'running'`
    )
    return rows.map((row) => row.doc)
  }
  async recent(limit = 50) {
    const { rows } = await this.pool.query(
      `SELECT doc FROM rig_hook_fires ORDER BY created_at DESC LIMIT $1`,
      [limit]
    )
    return rows.map((row) => row.doc)
  }
}

// -- the runner ------------------------------------------------------------------

export class HookRunner {
  /**
   * @param {object}   deps
   * @param {HookRules} deps.rules
   * @param {object}   deps.fires     FileFireStore | PgFireStore
   * @param {object}   deps.kernel    the test kernel (store + app.invoke)
   * @param {object}   deps.missions  mission store (reads hook missions back)
   * @param {Function} deps.runtime   () => the hook principal's runtime
   */
  constructor({ rules, fires, kernel, missions, runtime, logger = console }) {
    this.rules = rules
    this.fires = fires
    this.kernel = kernel
    this.missions = missions
    this.runtime = runtime
    this.logger = logger
  }

  async tick(now = new Date()) {
    await this.rules.refresh()
    const report = { claimed: 0, skipped: 0, settled: 0, started: null }
    const rules = this.rules.value.rules.filter(
      (rule) => rule.enabled && rule.event === 'run.finished'
    )
    if (rules.length) await this.#detect(rules, now, report)
    report.settled = await this.#settle()
    report.started = await this.#startNext()
    return report
  }

  async #detect(rules, now, report) {
    const runs = await this.kernel.store.listRuns({ limit: 100 })
    const apps = new Map()
    const appSlug = async (appId) => {
      if (!apps.has(appId)) apps.set(appId, (await this.kernel.store.getApp(appId))?.slug ?? null)
      return apps.get(appId)
    }
    const since = new Date(now.getTime() - WINDOW_MS).toISOString()
    for (const run of runs) {
      if (!TERMINAL.has(run.status) || !run.finishedAt) continue
      if (run.finishedAt < since) continue
      const slugOf = await appSlug(run.appId)
      for (const rule of rules) {
        if (run.finishedAt < rule.createdAt || !matches(rule, run, slugOf)) continue
        const used = await this.fires.countSince(rule.id, since)
        const status = used >= rule.maxPerHour ? 'skipped' : 'pending'
        const task = run.taskId
          ? await this.kernel.store.getTask(run.taskId).catch(() => null)
          : null
        const claimed = await this.fires.claim({
          ruleId: rule.id,
          ruleName: rule.name,
          subjectId: run.id,
          kind: 'triage',
          status,
          ...(status === 'skipped' ? { reason: `超过每小时 ${rule.maxPerHour} 次的上限` } : {}),
          run: {
            id: run.id,
            status: run.status,
            app: slugOf,
            task: task?.name ?? null,
            trigger: run.trigger
          },
          createdAt: now.toISOString(),
          updatedAt: now.toISOString()
        })
        if (claimed) report[status === 'skipped' ? 'skipped' : 'claimed'] += 1
      }
    }
  }

  /** Close out hook missions that ended, on whichever replica ran them. */
  async #settle() {
    let settled = 0
    const runtime = this.runtime()
    for (const fire of await this.fires.running()) {
      if (!fire.missionId) continue
      const row = await Promise.resolve()
        .then(() => this.missions.get(fire.missionId, HOOK_PRINCIPAL.id))
        .catch(() => null)
      if (!row) continue
      if (row.status === 'awaiting_approval') {
        // Nothing a hook runs should wait on a person; if it does, the rule
        // is misconfigured and the mission is stopped, not left hanging.
        await runtime.cancel(row.id).catch(() => {})
        await this.fires.update(fire.ruleId, fire.subjectId, {
          status: 'failed',
          reason: '任务停在了人工确认上；钩子任务必须能无人值守完成',
          updatedAt: new Date().toISOString()
        })
        settled += 1
        continue
      }
      if (!MISSION_DONE.has(row.status)) continue
      const finding = row.finding
        ? {
            verdict: row.finding.verdict,
            confidence: row.finding.confidence,
            summary: row.finding.summary,
            nextStep: row.finding.nextStep ?? null,
            unverified: row.finding.unverified ?? 0
          }
        : null
      const done = row.status === 'completed'
      await this.fires.update(fire.ruleId, fire.subjectId, {
        status: done ? 'done' : 'failed',
        finding,
        answer: String(row.result ?? '').slice(0, 400) || null,
        ...(done
          ? {}
          : { reason: String(row.events?.at(-1)?.message ?? row.status).slice(0, 300) }),
        updatedAt: new Date().toISOString()
      })
      settled += 1
      const rule = this.rules.value.rules.find((entry) => entry.id === fire.ruleId)
      if (done && rule?.notify) await this.#notify(fire, finding, row).catch(() => {})
    }
    return settled
  }

  async #notify(fire, finding, row) {
    const verdictWord = {
      'product-defect': '产品缺陷',
      'environment-blocked': '环境受阻',
      'case-issue': '用例问题',
      flaky: '不稳定',
      inconclusive: '证据不足'
    }
    await this.kernel.app.invoke({
      method: 'POST',
      path: '/api/v1/notifications:debrief',
      body: {
        app: fire.run.app ?? undefined,
        runId: fire.run.id,
        message: {
          title: `执行 ${fire.run.id} ${STATUS_WORD[fire.run.status] ?? fire.run.status} · 钩子「${fire.ruleName}」`,
          taskName: fire.run.task ?? '',
          status: fire.run.status,
          note: finding
            ? `Agent 判断（不是测试结论）：${verdictWord[finding.verdict] ?? finding.verdict}（置信度 ${finding.confidence}）${finding.summary}${
                finding.unverified ? `；有 ${finding.unverified} 个引用未核实，需要复核` : ''
              }`
            : `Agent 没有提交结构化结论：${String(row.result ?? '').slice(0, 200)}`
        }
      },
      principal: HOOK_PRINCIPAL,
      source: 'rig-hooks'
    })
  }

  /** One hook mission at a time, as the hook principal. */
  async #startNext() {
    const runtime = this.runtime()
    if (runtime.active) return null
    const next = await this.fires.nextPending()
    if (!next) return null
    const rule = this.rules.value.rules.find((entry) => entry.id === next.ruleId)
    if (!rule?.enabled) {
      await this.fires.transition(next.ruleId, next.subjectId, 'pending', {
        status: 'skipped',
        reason: '钩子已停用或删除',
        updatedAt: new Date().toISOString()
      })
      return null
    }
    // The status change is the claim: of several replicas, one starts it.
    if (
      !(await this.fires.transition(next.ruleId, next.subjectId, 'pending', {
        status: 'running',
        updatedAt: new Date().toISOString()
      }))
    )
      return null
    try {
      const mission = await runtime.start({
        mode: 'agent',
        agentKey: rule.agentKey,
        goal: goalFor(rule, next.run)
      })
      await this.fires.update(next.ruleId, next.subjectId, { missionId: mission.id })
      return mission
    } catch (error) {
      if (error.code === 'busy') {
        // Another replica's hook mission is still open; try again next tick.
        await this.fires.transition(next.ruleId, next.subjectId, 'running', { status: 'pending' })
        return null
      }
      await this.fires.update(next.ruleId, next.subjectId, {
        status: 'failed',
        reason: `无法启动任务：${safeMessage(error)}`,
        updatedAt: new Date().toISOString()
      })
      return null
    }
  }

  /** A procedure repair the desktop ran for a hook, recorded like any fire. */
  async report(fire, by) {
    const rule = this.rules.value.rules.find((entry) => entry.id === fire.ruleId)
    if (!rule || rule.event !== 'procedure.failed')
      throw new RigError('not_found', '钩子不存在或不是规程修正钩子', 404)
    const now = new Date().toISOString()
    const entry = {
      ...fire,
      ruleName: rule.name,
      kind: 'repair',
      reportedBy: by,
      createdAt: now,
      updatedAt: now
    }
    const claimed = await this.fires.claim(entry)
    return claimed ? entry : null
  }
}

function goalFor(rule, run) {
  return [
    `钩子「${rule.name}」：执行 ${run.id} 已结束，状态 ${STATUS_WORD[run.status] ?? run.status}${
      run.app ? `（应用 ${run.app}${run.task ? `，计划「${run.task}」` : ''}）` : ''
    }。`,
    '读取这次执行的结果、失败用例与步骤、产物和执行机状态，判断原因并提交结构化结论。',
    '这是自动发起的只读任务：只读取，不派发、不取消任何执行。'
  ].join('\n')
}

// -- API -------------------------------------------------------------------------

const reportBody = z
  .object({
    fire: z
      .object({
        ruleId: z.string().regex(/^hk_[a-f0-9]{12}$/),
        subjectId: z.string().regex(/^prr_[a-f0-9]{18}$/),
        status: z.enum(['done', 'failed', 'skipped']),
        procedure: z.object({ id: z.string().max(40), title: z.string().max(200) }).strict(),
        missionId: z.string().uuid().nullable().default(null),
        proposalId: z.string().max(40).nullable().default(null),
        validation: z.enum(['passed', 'failed', 'blocked']).nullable().default(null),
        reason: z.string().max(300).nullable().default(null)
      })
      .strict()
  })
  .strict()

export async function hookRoutes(context) {
  const { req, res, path, principal, hooks, settings, requireRole, parseBody, readJson, sendJson } =
    context
  if (!path.startsWith('/api/rig/v1/hooks')) return false
  if (path === '/api/rig/v1/hooks' && req.method === 'GET') {
    await hooks.rules.refresh()
    sendJson(res, 200, {
      ...hooks.rules.public(),
      fires: await hooks.fires.recent(60),
      // What a triage hook may run: Agents whose every tool only reads.
      agents: settings.value.agents
        .filter(readOnlyAgent)
        .map(({ key, displayName }) => ({ key, displayName }))
    })
    return true
  }
  if (path === '/api/rig/v1/hooks' && req.method === 'POST') {
    requireRole(principal, 'admin')
    const body = parseBody(hooksBody, await readJson(req, 50_000))
    sendJson(res, 200, await hooks.rules.save(body, { by: principal.id, settings }))
    return true
  }
  if (path === '/api/rig/v1/hooks:tick' && req.method === 'POST') {
    requireRole(principal, 'admin')
    sendJson(res, 200, { tick: await hooks.tick() })
    return true
  }
  if (path === '/api/rig/v1/hooks/fires:report' && req.method === 'POST') {
    requireRole(principal, 'operator')
    const body = parseBody(reportBody, await readJson(req, 10_000))
    await hooks.rules.refresh()
    sendJson(res, 201, { fire: await hooks.report(body.fire, principal.id) })
    return true
  }
  throw new RigError('not_found', '接口不存在', 404)
}
