import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RigError, TERMINAL } from '../contracts/index.mjs'

/**
 * A desktop mission as the service keeps it: readable, never executable.
 *
 * The transcript, checkpoint and raw evidence stay on the machine that ran it;
 * the owner is always the member who sent it, whatever the record claims.
 */
export function syncedRecord(owner, input) {
  const { messages, graph, evidence, skippedCalls, stream, crew, ...visible } = input
  return { ...structuredClone(visible), owner, surface: 'desktop', pending: null }
}

export class MissionStore {
  /**
   * @param {string} root
   * @param {{ onSaved?: (row: object) => void }} [options] called after every
   *   durable save; the desktop uses it to know what to send to the service.
   */
  constructor(root, { onSaved } = {}) {
    this.root = root
    this.rows = new Map()
    this.queue = Promise.resolve()
    this.onSaved = onSaved
  }
  async init() {
    await mkdir(this.root, { recursive: true })
    for (const file of await readdir(this.root)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue
      const row = JSON.parse(await readFile(join(this.root, file), 'utf8'))
      this.rows.set(row.id, row)
      // A desktop's copy is that desktop's to update; this process never ran it.
      if (row.surface === 'desktop') continue
      if (!TERMINAL.has(row.status)) {
        row.status = 'blocked'
        row.pending = null
        // Partial text from a turn that will never finish is not an answer.
        row.stream = null
        // Drop the graph checkpoint too: resuming an approval whose page or
        // browser context is gone would replay an action against a different
        // world than the one the user reviewed.
        row.graph = null
        row.events.push({
          at: new Date().toISOString(),
          kind: 'interrupted',
          message: 'Runtime 已重启；外部动作结果可能未知，请核验后创建新任务，不自动重放。'
        })
        await this.save(row)
      }
    }
    return this
  }
  list(owner) {
    return [...this.rows.values()]
      .filter((row) => row.owner === owner)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((row) => this.public(row))
  }
  get(id, owner) {
    const row = this.rows.get(id)
    if (!row || row.owner !== owner) throw new RigError('not_found', '任务不存在', 404)
    return row
  }
  public(row) {
    // `messages` is the model transcript, `graph` the executor checkpoint and
    // `evidence` the raw tool output kept for an analysis step: none is part
    // of the workbench contract, and the UI already shows tool results as
    // events. `trace` is kept because the orchestration view renders it.
    const { messages, graph, evidence, skippedCalls, crew, ...visible } = row
    return structuredClone(visible)
  }
  /** Every owner's missions, newest first, for reports. Never includes transcripts. */
  recent({ limit = 200, since = null } = {}) {
    return [...this.rows.values()]
      .filter((row) => !since || row.createdAt >= new Date(since).toISOString())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((row) => this.public(row))
  }
  async create(owner, input) {
    if (this.list(owner).length >= 500)
      throw new RigError('capacity', '已达到 500 项本地任务上限，请归档工作目录', 409)
    const row = {
      id: randomUUID(),
      owner,
      goal: input.goal,
      mode: input.mode,
      agentKey: input.agentKey ?? null,
      orchestrationKey: input.orchestrationKey ?? null,
      inputs: input.inputs ?? null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      events: [],
      messages: [],
      pending: null,
      result: null,
      policyRevision: null,
      trace: [],
      evidence: [],
      graph: null
    }
    this.rows.set(row.id, row)
    await this.save(row)
    return row
  }
  /** Store what a desktop reported, unless the id belongs to someone or something else. */
  async syncDesktop(owner, rows) {
    let stored = 0
    for (const input of rows) {
      const existing = this.rows.get(input.id)
      if (existing && (existing.surface !== 'desktop' || existing.owner !== owner)) continue
      if (existing?.updatedAt && input.updatedAt && existing.updatedAt > input.updatedAt) continue
      if (!existing && this.list(owner).length >= 500) break
      const row = syncedRecord(owner, input)
      this.rows.set(row.id, row)
      await this.save(row)
      stored += 1
    }
    return stored
  }
  async save(row) {
    if (row.surface !== 'desktop') row.updatedAt = new Date().toISOString()
    const json = JSON.stringify(row, null, 2)
    const file = join(this.root, `${row.id}.json`)
    const next = this.queue.then(async () => {
      const temp = `${file}.${randomUUID()}.tmp`
      await writeFile(temp, json, { mode: 0o600 })
      await rename(temp, file)
    })
    this.queue = next.catch(() => {})
    await next
    try {
      this.onSaved?.(row)
    } catch {
      /* Bookkeeping for sync must never fail a save. */
    }
  }
}
