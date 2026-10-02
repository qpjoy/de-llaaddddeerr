// 试验台: a desktop station doing procedure work for the service.
//
// Three jobs, all on the same browser station the Agent uses:
//
// - fire:    replay a procedure exactly as written and report the result;
// - capture: turn a mission this desktop ran into a procedure draft, from the
//            full local record (the synced copy may be trimmed);
// - repair:  replay up to the step that failed, hand the page — as it is — to
//            the 规程维护员 crew, and when it proposes new steps, prove them
//            with a full replay before the proposal reaches a person.
//
// The station runs one thing at a time: a procedure never shares the browser
// with a mission in flight.

import { randomBytes } from 'node:crypto'
import { RigError } from '../contracts/index.mjs'
import { ProcedurePlayer, describeStep, pickBody, procedureFromMission } from './procedure.mjs'

const runName = (kind) => `${kind}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
const SETTLE_POLL_MS = 1_000
const SETTLE_LIMIT_MS = 6 * 60 * 60 * 1000
// How long an automatic repair may take before it is stopped.
const AUTO_REPAIR_MS = 15 * 60 * 1000

export class ProcedureBench {
  constructor({ client, runtime, browser, pollMs = SETTLE_POLL_MS }) {
    this.client = client
    this.runtime = runtime
    this.browser = browser
    this.player = new ProcedurePlayer(browser)
    this.pollMs = pollMs
    this.busy = false
    this.settling = new Map()
  }

  async #exclusive(work) {
    if (this.busy || this.runtime.active)
      throw new RigError('station_busy', '浏览器工位正在执行任务或另一条规程，请稍后再试', 409)
    this.busy = true
    try {
      return await work()
    } finally {
      this.busy = false
    }
  }

  async #policy() {
    return (await this.client.request('/api/rig/v1/execution-config')).policy
  }

  async #procedure(id) {
    return (await this.client.request(`/api/rig/v1/procedures/${encodeURIComponent(id)}`)).procedure
  }

  /** 试车: the procedure as written, start to finish, reported to the service. */
  fire(id) {
    return this.#exclusive(async () => {
      const procedure = await this.#procedure(id)
      const policy = await this.#policy()
      await this.browser.close()
      try {
        const result = await this.player.run(procedure, { policy, runId: runName('fire') })
        return await this.client.request(`/api/rig/v1/procedures/${encodeURIComponent(id)}/runs`, {
          run: { ...result, station: 'desktop' }
        })
      } finally {
        await this.browser.close()
      }
    })
  }

  /**
   * A regression pass: every active procedure, one after another, each
   * recorded like a single firing. One that cannot run is reported and the
   * pass goes on.
   */
  async fireAll({ app = null, autoRepair = true, repairTimeoutMs = AUTO_REPAIR_MS } = {}) {
    const { procedures } = await this.client.request('/api/rig/v1/procedures')
    const active = procedures.filter(
      (entry) => entry.status === 'active' && (!app || entry.app === app)
    )
    const results = []
    for (const entry of active) {
      try {
        const { run, kernelRun } = await this.fire(entry.id)
        results.push({
          id: entry.id,
          title: entry.title,
          app: entry.app,
          runId: run.id,
          verdict: run.verdict,
          repairable: run.repairable,
          failedStep: run.failedStep,
          kernelRunId: kernelRun?.id ?? null
        })
      } catch (error) {
        results.push({ id: entry.id, title: entry.title, verdict: 'error', error: error.message })
      }
    }
    return {
      results,
      passed: results.filter((entry) => entry.verdict === 'passed').length,
      total: results.length,
      repairs: autoRepair ? await this.#autoRepair(results, repairTimeoutMs) : []
    }
  }

  /**
   * The 「规程试车失败 → 自动修正」 hook, run by the desktop that just ran
   * the pass. Each repair still ends as a proposal a person approves; only
   * starting it is automatic. Unattended means pre-authorised: without the
   * admin's permission for mission grants, nothing is started.
   */
  async #autoRepair(results, timeoutMs) {
    let rules = []
    try {
      rules = (await this.client.request('/api/rig/v1/hooks')).rules.filter(
        (rule) => rule.enabled && rule.event === 'procedure.failed'
      )
    } catch {
      return [] // a service without hooks
    }
    const failures = results.filter((entry) => entry.verdict === 'failed' && entry.repairable)
    if (!rules.length || !failures.length) return []
    const policy = await this.#policy()
    const outcomes = []
    for (const rule of rules) {
      let budget = rule.maxPerHour
      for (const failure of failures) {
        if (rule.apps.length && !rule.apps.includes(failure.app)) continue
        if (outcomes.some((entry) => entry.runId === failure.runId)) continue
        let outcome
        if (!policy.browserPreauth)
          outcome = { status: 'skipped', reason: '自动修正需要管理员在执行策略里允许任务级预授权' }
        else if (budget <= 0)
          outcome = { status: 'skipped', reason: `超过每小时 ${rule.maxPerHour} 次的上限` }
        else {
          budget -= 1
          outcome = await this.#repairUnattended(failure, timeoutMs)
        }
        outcome = {
          ruleId: rule.id,
          id: failure.id,
          title: failure.title,
          runId: failure.runId,
          ...outcome
        }
        outcomes.push(outcome)
        await this.client
          .request('/api/rig/v1/hooks/fires:report', {
            fire: {
              ruleId: rule.id,
              subjectId: failure.runId,
              status: outcome.status,
              procedure: { id: failure.id, title: failure.title },
              missionId: outcome.missionId ?? null,
              proposalId: outcome.proposalId ?? null,
              validation: outcome.validation ?? null,
              reason: outcome.reason ?? null
            }
          })
          .catch(() => {})
      }
    }
    return outcomes
  }

  async #repairUnattended(failure, timeoutMs) {
    let missionId = null
    try {
      const { mission } = await this.repair(failure.id, failure.runId)
      missionId = mission.id
      let timer
      const expired = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      })
      const proposal = await Promise.race([this.settled(missionId), expired]).finally(() =>
        clearTimeout(timer)
      )
      if (proposal === 'timeout') {
        await this.runtime.cancel(missionId).catch(() => {})
        await this.settled(missionId)
        return { status: 'failed', missionId, reason: '修正任务超时，已停止' }
      }
      if (!proposal) return { status: 'failed', missionId, reason: '修正任务没有提交判断' }
      return {
        status: 'done',
        missionId,
        proposalId: proposal.id,
        verdict: proposal.verdict,
        validation: proposal.validation?.verdict ?? null
      }
    } catch (error) {
      return { status: 'failed', missionId, reason: error.message }
    }
  }

  /** 固化: this desktop's own mission record becomes a procedure draft. */
  async capture(missionId, { title, app = null, caseId = null } = {}) {
    const row = this.runtime.store.public(this.runtime.store.get(missionId, this.runtime.owner))
    const { procedure, warnings } = procedureFromMission(row, { title, app, caseId })
    const created = await this.client.request('/api/rig/v1/procedures', { procedure })
    return { procedure: created.procedure, warnings }
  }

  /**
   * 纠正措施. Starts the repair mission and returns it; the rest happens as
   * the mission goes, because it may stop for a person's confirmation.
   */
  repair(id, runId) {
    return this.#exclusive(async () => {
      const procedure = await this.#procedure(id)
      const run = procedure.runs.find((entry) => entry.id === runId)
      if (!run) throw new RigError('not_found', '试车记录不存在', 404)
      if (run.revision !== procedure.revision)
        throw new RigError(
          'procedure_conflict',
          '规程已经修改过，这次失败针对的是旧版本；请先重新试车',
          409
        )
      if (run.verdict !== 'failed' || !run.repairable)
        throw new RigError(
          'not_repairable',
          run.verdict === 'blocked'
            ? '这次试车受阻于环境，不是规程能修的；先解决环境问题再试车'
            : '这次试车没有可以修正的失败',
          409
        )
      const policy = await this.#policy()
      await this.browser.close()
      // To the step before the failure, and leave the page there.
      const lead = await this.player.run(procedure, {
        policy,
        runId: runName('repair'),
        stopBefore: run.failedStep
      })
      if (lead.verdict !== 'partial') {
        await this.browser.close()
        throw new RigError(
          'repair_lead_failed',
          `重放到失败步骤之前时，第 ${lead.failedStep + 1} 步就已经失败（${lead.failure?.message}）；请先重新试车，看最新的失败位置`,
          409
        )
      }
      const failed = procedure.steps[run.failedStep]
      const mission = await this.runtime.start({
        mode: 'agent',
        agentKey: 'procedure-medic',
        goal: `修正试验规程「${procedure.title}」：第 ${run.failedStep + 1} 步「${describeStep(failed)}」失败`,
        brief: repairBrief(procedure, run),
        procedure: { id: procedure.id, revision: procedure.revision, ...pickBody(procedure) },
        // Clicks within the allowed test origins need no confirmation each,
        // when the admin allows grants at all; the repair is the person's act.
        grants: { browserWrites: true }
      })
      this.#watch(mission.id)
      return { mission }
    })
  }

  #watch(missionId) {
    if (this.settling.has(missionId)) return this.settling.get(missionId)
    const done = (async () => {
      const deadline = Date.now() + SETTLE_LIMIT_MS
      while (Date.now() < deadline) {
        await this.runtime.job
        const row = this.runtime.store.get(missionId, this.runtime.owner)
        if (row.status === 'completed') return this.settle(missionId)
        if (['blocked', 'cancelled', 'failed'].includes(row.status)) return null
        await new Promise((resolve) => setTimeout(resolve, this.pollMs))
      }
      return null
    })()
      .catch(() => null)
      .finally(() => this.settling.delete(missionId))
    this.settling.set(missionId, done)
    return done
  }

  /** Waits for a repair started here to be posted, or to end without a proposal. */
  settled(missionId) {
    return this.settling.get(missionId) ?? Promise.resolve(null)
  }

  /**
   * The repair mission ended. Its proposal is proven on a clean station and
   * posted with the proof; a judgement without steps is posted as it is.
   */
  async settle(missionId) {
    const store = this.runtime.store
    const row = store.get(missionId, this.runtime.owner)
    if (!row.proposal || !row.procedureBase || row.proposalPosted) return null
    const base = row.procedureBase
    let validation = null
    if (row.proposal.steps) {
      const policy = await this.#policy()
      await this.browser.close()
      try {
        const { station, ...result } = await this.player.run(
          { ...base, steps: row.proposal.steps },
          { policy, runId: runName('validate') }
        )
        void station
        validation = result
      } finally {
        await this.browser.close()
      }
    }
    const posted = await this.client.request(
      `/api/rig/v1/procedures/${encodeURIComponent(base.id)}/proposals`,
      {
        proposal: {
          baseRevision: base.revision,
          verdict: row.proposal.verdict,
          rationale: row.proposal.rationale,
          steps: row.proposal.steps,
          missionId,
          validation
        }
      }
    )
    row.proposalPosted = true
    await this.runtime.event(
      row,
      'proposal',
      validation
        ? `修正已${validation.verdict === 'passed' ? '通过' : '未通过'}验证试车，已提交给规程负责人审批`
        : '判断已提交给规程负责人',
      { proposalId: posted.proposal.id, validation: validation?.verdict ?? null }
    )
    return posted.proposal
  }
}

/** What the crew needs on top of the page it is looking at. */
export function repairBrief(procedure, run) {
  const failure = run.failure ?? {}
  return [
    `规程：${procedure.title}（第 ${procedure.revision} 版）${procedure.baseUrl ? `，目标 ${procedure.baseUrl}` : ''}`,
    procedure.caseId ? `对应用例：${procedure.caseId}` : null,
    `失败：第 ${run.failedStep + 1} 步，${failure.code}：${failure.message}`,
    `浏览器已经按规程执行完前 ${run.failedStep} 步，页面停在失败步骤之前。先 browser_snapshot 看当前页面。`,
    '当前规程步骤（修正时在此基础上改，保持 JSON 格式；变量 {{name}} 原样保留）：',
    JSON.stringify(procedure.steps, null, 1),
    Object.keys(procedure.variables ?? {}).length
      ? `规程变量：${JSON.stringify(procedure.variables)}`
      : null
  ]
    .filter(Boolean)
    .join('\n')
}
