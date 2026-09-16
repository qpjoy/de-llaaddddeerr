import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RigError } from '../../packages/contracts/index.mjs'
import { QUEST_IDS, SIGNALS } from './system.mjs'

const MAX_MEMBERS = 500

/**
 * 系统进度：每个成员领了哪些奖励、上报过哪些动作、看到过哪个版本。
 *
 * Deliberately the smallest possible record. It holds no goals, no mission
 * ids, no tool names and no page paths — a tutorial's progress file is not a
 * place to accumulate a second activity log. Everything in it is bounded by a
 * closed list (`QUEST_IDS`, `SIGNALS`), so the file cannot grow with traffic.
 *
 * One file with atomic replace, like `Settings`: this state is worth keeping
 * across restarts but not worth a database, and a torn write would be read
 * back as a member who never did anything.
 */
export class SystemProgress {
  constructor(file) {
    this.file = file
    this.value = { members: {} }
    this.queue = Promise.resolve()
  }
  async init() {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8'))
      this.value = { members: this.#clean(stored.members) }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return this
  }
  /** Drop anything a newer build no longer knows about, rather than replaying it. */
  #clean(members) {
    const out = {}
    for (const [owner, entry] of Object.entries(members ?? {}).slice(0, MAX_MEMBERS)) {
      if (typeof owner !== 'string' || owner.length > 200) continue
      const claimed = (Array.isArray(entry?.claimed) ? entry.claimed : []).filter((id) =>
        QUEST_IDS.includes(id)
      )
      const signals = {}
      for (const [name, at] of Object.entries(entry?.signals ?? {}))
        if (SIGNALS.includes(name) && typeof at === 'string') signals[name] = at
      out[owner] = {
        claimed: [...new Set(claimed)],
        signals,
        seenVersion: typeof entry?.seenVersion === 'string' ? entry.seenVersion : null
      }
    }
    return out
  }
  get(owner) {
    return this.value.members[owner] ?? { claimed: [], signals: {}, seenVersion: null }
  }
  #entry(owner) {
    if (typeof owner !== 'string' || !owner || owner.length > 200)
      throw new RigError('invalid_owner', '成员标识无效')
    const existing = this.value.members[owner]
    if (existing) return existing
    if (Object.keys(this.value.members).length >= MAX_MEMBERS)
      throw new RigError('capacity', '系统进度记录已满，请归档状态目录', 409)
    const fresh = { claimed: [], signals: {}, seenVersion: null }
    this.value.members[owner] = fresh
    return fresh
  }
  /**
   * Take a reward. `verified` comes from the evaluator, never from the client:
   * the only thing the request decides is which quest is being claimed.
   */
  async claim(owner, questId, verified) {
    if (!QUEST_IDS.includes(questId)) throw new RigError('quest_unknown', '任务不存在', 404)
    const entry = this.#entry(owner)
    if (entry.claimed.includes(questId)) return { entry: this.get(owner), changed: false }
    if (!verified) throw new RigError('quest_unverified', '这项任务还没有完成，无法领取', 409)
    entry.claimed.push(questId)
    await this.#persist()
    return { entry: this.get(owner), changed: true }
  }
  /**
   * Record a workbench-reported action.
   *
   * Only the first occurrence is kept, and an already-known signal writes
   * nothing: these fire on page opens, and a tutorial must not turn browsing
   * into disk traffic.
   */
  async signal(owner, name) {
    if (!SIGNALS.includes(name)) throw new RigError('signal_unknown', '未知的界面上报', 400)
    const entry = this.#entry(owner)
    if (entry.signals[name]) return { entry: this.get(owner), changed: false }
    entry.signals[name] = new Date().toISOString()
    await this.#persist()
    return { entry: this.get(owner), changed: true }
  }
  /** Remember which catalogue version this member has already been shown. */
  async seen(owner, version) {
    const entry = this.#entry(owner)
    if (entry.seenVersion === version) return { entry: this.get(owner), changed: false }
    entry.seenVersion = version
    await this.#persist()
    return { entry: this.get(owner), changed: true }
  }
  async #persist() {
    const json = JSON.stringify(this.value, null, 2)
    const operation = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temp, json, { mode: 0o600 })
      await rename(temp, this.file)
    })
    this.queue = operation.catch(() => {})
    await operation
  }
}
