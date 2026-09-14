import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RigError, TERMINAL } from '../contracts/index.mjs'

export class MissionStore {
  constructor(root) {
    this.root = root
    this.rows = new Map()
    this.queue = Promise.resolve()
  }
  async init() {
    await mkdir(this.root, { recursive: true })
    for (const file of await readdir(this.root)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue
      const row = JSON.parse(await readFile(join(this.root, file), 'utf8'))
      this.rows.set(row.id, row)
      if (!TERMINAL.has(row.status)) {
        row.status = 'blocked'
        row.pending = null
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
    const { messages, ...visible } = row
    return structuredClone(visible)
  }
  async create(owner, input) {
    if (this.list(owner).length >= 500)
      throw new RigError('capacity', '已达到 500 项本地任务上限，请归档工作目录', 409)
    const row = {
      id: randomUUID(),
      owner,
      goal: input.goal,
      mode: input.mode,
      status: 'queued',
      createdAt: new Date().toISOString(),
      events: [],
      messages: [],
      pending: null,
      result: null,
      policyRevision: null
    }
    this.rows.set(row.id, row)
    await this.save(row)
    return row
  }
  async save(row) {
    const json = JSON.stringify(row, null, 2)
    const file = join(this.root, `${row.id}.json`)
    const next = this.queue.then(async () => {
      const temp = `${file}.${randomUUID()}.tmp`
      await writeFile(temp, json, { mode: 0o600 })
      await rename(temp, file)
    })
    this.queue = next.catch(() => {})
    return next
  }
}
