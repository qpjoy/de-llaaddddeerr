// 终端会话: MX Rig as a terminal Agent, working in a member's project.
//
// Nothing here is new machinery. It is the same local Runtime the desktop
// runs — the mission loop, one tool per step, per-call approval tied to the
// policy revision, the token budget, the mission record synced to the service
// for the team — given two things the desktop does not have: the project
// directory (WorkspaceTools) and a person at a keyboard instead of a window.
//
// The service stays what it is for the desktop: the model gateway (it holds
// the keys and meters the usage), the policy, and the record. Files, commands
// and the browser are all on this machine.
//
// This module has no TTY in it. A caller — the REPL, `mx-rig exec`, a test —
// asks a question and gets called back with what happens and with each
// approval to decide.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { RigError, TERMINAL } from '../contracts/index.mjs'
import { BrowserTools } from './browser.mjs'
import { progressLine, provisionFromEnv } from './browser-provision.mjs'
import { RigRuntime } from './engine.mjs'
import { ProcedureBench } from './procedure-bench.mjs'
import { projectBrief } from './project.mjs'
import { replayDocument } from './replay.mjs'
import { MissionStore } from './store.mjs'
import { MissionSync } from './sync.mjs'
import { ToolExecutor, toolByName } from './tools.mjs'
import { WorkspaceTools, commandSandbox } from './workspace.mjs'

export const TERMINAL_AGENT = 'test-engineer'
const MESSAGE_CHARS = 23_000
const EDIT_TOOLS = new Set(['workspace_write', 'workspace_edit'])

/**
 * What the next mission needs to know about the one it continues, when the
 * old one has used up its history. Taken from the record, not remembered.
 */
export function handover(row) {
  const lines = [`（接续上一项任务 ${row.id}，目标：「${String(row.goal).slice(0, 300)}」）`]
  const files = new Set()
  const commands = []
  let tool = null
  for (const event of row.events ?? []) {
    if (event.kind === 'tool_start') tool = event.data?.tool ?? null
    if (event.kind !== 'tool_result') continue
    const result = event.data?.result
    if (EDIT_TOOLS.has(tool) && result?.path) files.add(result.path)
    if (tool === 'workspace_run' && result?.command)
      commands.push(`${result.command} → 退出码 ${result.exitCode ?? '无'}${result.timedOut ? '（超时）' : ''}`)
  }
  if (files.size) lines.push(`改过的文件：${[...files].join('、')}`)
  if (commands.length) lines.push(`运行过的命令：\n${commands.slice(-10).join('\n')}`)
  if (row.testRunId) lines.push(`派发过的测试 run：${row.testRunId}`)
  if (row.result) lines.push(`上一项任务的结论：\n${String(row.result).slice(0, 2500)}`)
  return lines.join('\n')
}

/**
 * What a mission changed in the project — "2 个文件 +12 −3" — from its
 * record. Events after `since` only, so a follow-up reports its own changes.
 */
export function workspaceChanges(row, { since = 0 } = {}) {
  const files = new Map()
  let tool = null
  for (const event of (row.events ?? []).slice(since)) {
    if (event.kind === 'tool_start') tool = event.data?.tool ?? null
    if (event.kind !== 'tool_result' || !EDIT_TOOLS.has(tool)) continue
    const result = event.data?.result
    if (!result?.path || result.error) continue
    const entry = files.get(result.path) ?? { path: result.path, added: 0, removed: 0, created: false }
    entry.added += result.added ?? 0
    entry.removed += result.removed ?? 0
    entry.created ||= Boolean(result.created)
    files.set(result.path, entry)
  }
  const list = [...files.values()]
  return {
    files: list,
    added: list.reduce((sum, entry) => sum + entry.added, 0),
    removed: list.reduce((sum, entry) => sum + entry.removed, 0)
  }
}

export class TerminalSession {
  /**
   * @param {object} options
   * @param {object} options.client        a RigClient with the member's session
   * @param {string} options.owner         the member's principal id
   * @param {string} options.home          where this member's local missions live
   * @param {string} options.workspaceRoot the project directory
   * @param {object} [options.browser]     BrowserTools; made from `launcher` otherwise
   */
  constructor({
    client,
    owner,
    home,
    workspaceRoot,
    browser = null,
    launcher = undefined,
    headless = false,
    browsersDir = null,
    env = process.env,
    sync = true,
    // 'auto': commands run sandboxed where this machine can; 'off': as the member.
    sandbox = 'auto'
  }) {
    this.client = client
    this.owner = owner
    this.home = home
    this.env = env
    this.sandboxMode = sandbox
    this.workspace = new WorkspaceTools(workspaceRoot, { env })
    // The test browser: found on this computer, or downloaded once into
    // ~/.mx-rig/browsers, with the progress said in the terminal.
    if (!browser) {
      const provision = provisionFromEnv(env, { dir: browsersDir ?? join(home, 'browsers') })
      const seen = { step: -1 }
      provision.onProgress = (event) => {
        const text = progressLine(event, seen)
        if (text) this.#emit({ kind: 'note', text })
      }
      this.browser = new BrowserTools(join(home, 'artifacts'), launcher, { headless, provision })
    } else this.browser = browser
    this.syncing = sync
    this.missionId = null
    this.watching = null
    this.busy = false
    // What the person allowed for the rest of this session: exact commands,
    // and (like an "accept edits" mode) file changes.
    this.rules = { commands: new Set(), edits: false }
  }

  async init() {
    this.store = await new MissionStore(join(this.home, 'missions'), {
      onSaved: (row) => {
        this.sync?.markDirty(row.id)
        this.#observe(row)
      }
    }).init()
    if (this.syncing)
      this.sync = await new MissionSync({
        store: this.store,
        client: this.client,
        file: join(this.home, 'sync-state.json')
      }).init()
    this.runtime = new RigRuntime({
      store: this.store,
      client: this.client,
      executor: new ToolExecutor(this.client, this.browser, this.workspace),
      owner: this.owner
    })
    this.bench = new ProcedureBench({ client: this.client, runtime: this.runtime, browser: this.browser })
    await this.setSandbox(this.sandboxMode)
    await this.refresh()
    return this
  }

  /** Sandbox commands (where the machine can) or not; the member's own choice. */
  async setSandbox(mode) {
    this.workspace.sandbox = await commandSandbox({ root: this.workspace.root, mode, env: this.env })
    return this.workspace.sandbox
  }

  /** Re-read the policy and the Agent: an admin may have changed either. */
  async refresh() {
    this.config = await this.client.request('/api/rig/v1/execution-config')
    const agent = (this.config.agents ?? []).find((entry) => entry.key === TERMINAL_AGENT) ?? null
    this.agent = agent
    this.agentKey = agent?.key ?? null
    return this.config
  }

  /** What this session can and cannot do, for `/status` and `mx-rig status`. */
  status() {
    const allowed = this.config.policy.allowedTools
    const wanted = this.agent?.tools ?? []
    return {
      workspace: this.workspace.root,
      agent: this.agent ? { key: this.agent.key, displayName: this.agent.displayName } : null,
      model: this.config.model,
      tools: (this.agent?.effectiveTools ?? allowed).filter((name) => {
        const def = toolByName(name)
        return def && (!def.native || Boolean(this.browser.native?.supported))
      }),
      // What the terminal Agent is meant to have but the Internal policy withholds.
      missing: wanted.filter((name) => !allowed.includes(name)),
      browserOrigins: this.config.policy.browserOrigins,
      browserSites: this.config.policy.browserSites ?? 'ask',
      sandbox: { on: Boolean(this.workspace.sandbox?.on), reason: this.workspace.sandbox?.reason ?? '未启用' },
      mission: this.missionId
    }
  }

  current() {
    return this.missionId ? this.store.public(this.store.get(this.missionId, this.owner)) : null
  }

  /** The next question starts a new mission rather than continuing this one. */
  reset() {
    this.missionId = null
  }

  /** This project's terminal missions on this machine, newest first. */
  recent({ limit = 10 } = {}) {
    return this.store
      .list(this.owner)
      .filter((row) => row.client === 'terminal' && row.workspace === this.workspace.root)
      .slice(0, limit)
  }

  /** Continue an earlier mission of this project with the next question. */
  resume(id) {
    const row = this.store.get(id, this.owner)
    if (row.client !== 'terminal' || row.workspace !== this.workspace.root)
      throw new RigError('not_found', '这项任务不属于这个项目的终端会话', 404)
    this.missionId = row.id
    return this.store.public(row)
  }

  #emit(event) {
    try {
      this.watching?.onEvent(event)
    } catch {
      /* Presentation only: a rendering failure must not stop the mission. */
    }
  }

  /** Called on every durable save: turn the record's growth into callbacks. */
  #observe(row) {
    const watch = this.watching
    if (!watch) return
    if (!watch.id) {
      if (row.events.length) return
      watch.id = row.id
    }
    if (watch.id !== row.id) return
    const text = row.stream?.text ?? ''
    if (text.length > watch.shown.length && text.startsWith(watch.shown)) {
      const delta = text.slice(watch.shown.length)
      this.#emit({ kind: 'delta', text: delta })
      watch.shown = text
      watch.printed += delta
    }
    while (watch.seen < row.events.length) {
      const event = row.events[watch.seen]
      watch.seen += 1
      if (event.kind === 'thinking' || event.kind === 'tool_start') {
        // A new model turn or a tool: what streamed before belongs to the last one.
        watch.shown = ''
        watch.printed = ''
      }
      if (event.kind === 'tool_start') {
        const call = [...row.messages].reverse().find((message) => message.tool_calls?.length)
          ?.tool_calls[0]
        let args = null
        try {
          args = JSON.parse(call?.function?.arguments ?? 'null')
        } catch {
          /* Shown without arguments. */
        }
        this.#emit({ kind: 'event', event, call: { name: event.data?.tool, args } })
        continue
      }
      // The caller already printed what streamed; the answer tells it how much.
      this.#emit({
        kind: 'event',
        event,
        streamed: event.kind === 'answer' || event.kind === 'say' ? watch.printed : ''
      })
    }
  }

  async #approval(row, decide) {
    const call = row.pending
    // A takeover: the person works in the browser window, then hands back —
    // perhaps with a word for the Agent. Never the content of what they typed.
    if (call.name === 'takeover') {
      const answer = await decide({
        tool: 'takeover',
        title: call.by === 'agent' ? 'Agent 请你来操作浏览器' : '人工接管',
        args: {},
        reason: call.reason ?? null,
        preview: call.args?.说明 ?? null,
        takeover: true,
        always: null
      })
      const reply = typeof answer === 'object' && answer ? answer : { answer }
      return { approved: reply.answer === 'yes', note: reply.note ?? null }
    }
    if (call.name === 'workspace_run' && this.rules.commands.has(call.args?.command)) {
      this.#emit({ kind: 'auto', call, reason: '这条命令本会话内已允许' })
      return true
    }
    if (EDIT_TOOLS.has(call.name) && this.rules.edits) {
      this.#emit({ kind: 'auto', call, reason: '本会话内已允许改文件' })
      return true
    }
    const def = toolByName(call.name)
    const request = {
      tool: call.name,
      title: def?.title ?? call.name,
      args: call.args,
      preview: def?.workspace ? await this.workspace.preview(call.name, call.args) : (call.preview ?? null),
      // "Always" exists only for this machine's own project: a platform
      // dispatch or a click on a shared test environment is confirmed each time.
      always:
        call.name === 'workspace_run'
          ? '本会话内这条命令都直接执行'
          : EDIT_TOOLS.has(call.name)
            ? '本会话内改文件都直接执行'
            : null
    }
    const answer = await decide(request)
    if (answer === 'always' && request.always) {
      if (call.name === 'workspace_run') this.rules.commands.add(call.args.command)
      else this.rules.edits = true
    }
    return answer === 'yes' || (answer === 'always' && Boolean(request.always))
  }

  /**
   * One exchange: the person says something, the mission runs — asking for
   * each approval on the way — until it answers, blocks or is cancelled.
   *
   * @param {string} text
   * @param {object} handlers
   * @param {(event: object) => void} [handlers.onEvent]
   * @param {(request: object) => Promise<'yes'|'no'|'always'>} handlers.decide
   */
  async ask(text, { onEvent = () => {}, decide }) {
    if (this.busy) throw new RigError('busy', '上一个问题还在处理', 409)
    const goal = String(text ?? '').trim()
    if (!goal) throw new RigError('invalid_input', '说点什么吧')
    this.busy = true
    this.watching = { id: null, seen: 0, shown: '', printed: '', onEvent }
    try {
      const row = await this.#begin(goal)
      return await this.#follow(row.id, decide)
    } finally {
      this.watching = null
      this.busy = false
    }
  }

  /** Until the mission rests: each approval asked, each answer given. */
  async #follow(id, decide) {
    for (;;) {
      await this.runtime.job
      const row = this.store.get(id, this.owner)
      if (row.status === 'awaiting_approval' && row.pending) {
        const decision = await this.#approval(row, decide)
        const { approved, note = null } = typeof decision === 'object' ? decision : { approved: decision }
        await this.runtime.approve(row.id, row.pending.approvalId, approved, { note })
        continue
      }
      if (TERMINAL.has(row.status)) return this.store.public(row)
      await sleep(20)
    }
  }

  /**
   * 纠正措施 from the terminal. The bench replays the procedure to the step
   * before its failure and hands the page to the procedure medic; the session
   * follows that mission like any other — every approval asked here — and
   * then the bench proves the proposal on a clean page and posts it. Approving
   * it stays a separate decision.
   *
   * @returns {Promise<{mission: object, proposal: object|null}>}
   */
  async repair(procedureId, { runId = null, onEvent = () => {}, decide }) {
    if (this.busy) throw new RigError('busy', '上一个问题还在处理', 409)
    this.busy = true
    this.watching = { id: null, seen: 0, shown: '', printed: '', onEvent }
    try {
      let target = runId
      if (!target) {
        const { procedure } = await this.client.request(
          `/api/rig/v1/procedures/${encodeURIComponent(procedureId)}`
        )
        // The latest firing of this revision that failed in a way a repair can address.
        target =
          procedure.runs.find(
            (run) => run.revision === procedure.revision && run.verdict === 'failed' && run.repairable
          )?.id ?? null
        if (!target)
          throw new RigError('not_repairable', '这条规程的当前版本没有可以修正的失败试车；先 /fire 试车', 409)
      }
      const { mission } = await this.bench.repair(procedureId, target)
      this.watching.id = mission.id
      const row = await this.#follow(mission.id, decide)
      return { mission: row, proposal: await this.bench.settled(mission.id) }
    } finally {
      this.watching = null
      this.busy = false
    }
  }

  /** A person's decision on a proposal, from the terminal like from the page. */
  decideProposal(procedureId, proposalId, approved) {
    return this.client.request(
      `/api/rig/v1/procedures/${encodeURIComponent(procedureId)}/proposals/${encodeURIComponent(proposalId)}:decide`,
      { approved }
    )
  }

  async #begin(goal) {
    const current = this.missionId ? this.store.rows.get(this.missionId) : null
    if (current && TERMINAL.has(current.status)) {
      this.watching.id = current.id
      this.watching.seen = current.events.length
      // Where this exchange starts in the record, for "what changed this time".
      this.lastAskFrom = current.events.length
      try {
        await this.runtime.followup(current.id, { goal })
        return current
      } catch (error) {
        if (error.code !== 'history_budget') throw error
        this.#emit({ kind: 'note', text: '这项任务的历史已经很长，接着开一项新任务并带上交接摘要。' })
        return this.#start(goal, handover(current))
      }
    }
    return this.#start(goal, '')
  }

  async #start(goal, carried) {
    this.watching.id = null
    this.watching.seen = 0
    this.lastAskFrom = 0
    const { brief } = await projectBrief(this.workspace)
    const room = MESSAGE_CHARS - goal.length - 4
    const material = [carried, brief].filter(Boolean).join('\n\n').slice(0, Math.max(0, room))
    const mission = await this.runtime.start({
      mode: 'agent',
      ...(this.agentKey ? { agentKey: this.agentKey } : {}),
      goal: goal.slice(0, 8000),
      brief: material
    })
    this.missionId = mission.id
    this.watching.id = mission.id
    const row = this.store.get(mission.id, this.owner)
    // Saved with its next event: the workbench shows where it ran, and
    // `--continue` finds the missions of this project.
    row.client = 'terminal'
    row.workspace = this.workspace.root
    return row
  }

  /** Stop what is running now. */
  async cancel() {
    const id = this.watching?.id ?? this.missionId
    if (!id) return null
    return this.runtime.cancel(id)
  }

  // -- things a person asks for directly (slash commands) ---------------------

  /** Case drafts the current mission wrote, and importing them. */
  drafts() {
    return this.current()?.caseDrafts ?? []
  }

  async importDrafts(pick = null) {
    const drafts = this.drafts()
    const cases = pick ? drafts.filter((_draft, index) => pick.includes(index + 1)) : drafts
    if (!cases.length) throw new RigError('invalid_input', '这项任务没有用例草稿')
    return this.client.request('/api/rig/v1/cases:import', { cases })
  }

  /** The current mission's browser trail as a Playwright spec draft. */
  async exportSpec() {
    if (!this.missionId) throw new RigError('invalid_input', '还没有任务')
    return this.runtime.exportMission(this.missionId)
  }

  /** 固化: the current mission's browser trail as a procedure draft. */
  async capture({ title, app = null, caseId = null } = {}) {
    if (!this.missionId) throw new RigError('invalid_input', '还没有任务')
    return this.bench.capture(this.missionId, { title, app, caseId })
  }

  fire(id) {
    return this.bench.fire(id)
  }

  /**
   * The mission's browser steps as one HTML file that plays them back with
   * the cursor — written next to this member's missions, never into the project.
   */
  async replay(id = this.missionId) {
    if (!id) throw new RigError('invalid_input', '还没有任务')
    const row = this.store.public(this.store.get(id, this.owner))
    const root = this.browser.root
    const { html, frames } = await replayDocument(row, {
      readImage: (path) => (root ? readFile(join(root, path)) : Promise.resolve(null))
    })
    if (!frames) throw new RigError('invalid_input', '这项任务没有浏览器步骤可以回放')
    const dir = join(this.home, 'replays')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${id}.html`)
    await writeFile(path, html, { mode: 0o600 })
    return { path, frames }
  }

  fireAll({ app = null } = {}) {
    // A person at a terminal decides about repairs themselves.
    return this.bench.fireAll({ app, autoRepair: false })
  }

  async close() {
    try {
      await this.runtime?.close()
    } finally {
      await this.sync?.flush().catch(() => {})
      await this.sync?.close?.()
      await this.browser.close().catch(() => {})
    }
  }
}
