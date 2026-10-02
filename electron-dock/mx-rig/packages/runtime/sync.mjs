import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// Mirrors the service's limit (apps/server/schemas.mjs). A record larger than
// this is trimmed here rather than refused there.
export const SYNC_RECORD_BYTES = 512 * 1024
const BATCH = 20
const DEBOUNCE_MS = 1_500
const MAX_BACKOFF_MS = 60_000

/**
 * The part of a desktop mission the service may keep.
 *
 * Model transcript, checkpoint and raw evidence stay on this machine. When the
 * rest is still too large — long tool results in the event log — the oldest
 * events lose their data first, then the oldest events themselves, and the
 * record says so rather than pretending to be complete.
 */
export function compactForSync(row, limit = SYNC_RECORD_BYTES) {
  const { messages, graph, evidence, skippedCalls, stream, crew, ...record } = row
  const copy = structuredClone(record)
  const size = () => Buffer.byteLength(JSON.stringify(copy))
  for (const event of copy.events ?? []) {
    if (size() <= limit) break
    if (event.data !== undefined) {
      event.data = { truncated: true }
      copy.truncated = true
    }
  }
  while (size() > limit && (copy.events?.length ?? 0) > 1) {
    copy.events.shift()
    copy.truncated = true
  }
  return copy
}

/**
 * Send what the local Runtime saved to the service, eventually.
 *
 * An outbox, not a live link: each save marks the mission dirty, a short
 * debounce batches bursts (streaming saves many times a second), and a failed
 * send is retried with backoff. What was last confirmed is kept on disk, so a
 * mission finished while the service was unreachable is sent after the next
 * sign-in. A service that does not know the sync route turns syncing off
 * quietly — the desktop works the same without it.
 */
export class MissionSync {
  constructor({ store, client, file, logger = null }) {
    this.store = store
    this.client = client
    this.file = file
    this.logger = logger
    this.confirmed = {}
    this.dirty = new Set()
    this.timer = null
    this.backoff = DEBOUNCE_MS
    this.flushing = null
    this.disabled = false
    this.closed = false
  }
  async init() {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8'))
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) this.confirmed = stored
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    // Anything saved after it was last confirmed goes out again.
    for (const row of this.store.rows.values())
      if (!this.confirmed[row.id] || this.confirmed[row.id] < (row.updatedAt ?? row.createdAt))
        this.dirty.add(row.id)
    if (this.dirty.size) this.#schedule(0)
    return this
  }
  markDirty(id) {
    if (this.disabled || this.closed) return
    this.dirty.add(id)
    this.#schedule(DEBOUNCE_MS)
  }
  #schedule(delay) {
    if (this.timer || this.disabled || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch(() => {})
    }, delay)
    this.timer.unref?.()
  }
  /** Send everything dirty now. Resolves when this round is done, sent or not. */
  async flush() {
    if (this.flushing) return this.flushing
    this.flushing = this.#flush().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }
  async #flush() {
    while (this.dirty.size && !this.disabled) {
      const ids = [...this.dirty].slice(0, BATCH)
      const rows = ids.map((id) => this.store.rows.get(id)).filter(Boolean)
      const stamps = Object.fromEntries(rows.map((row) => [row.id, row.updatedAt ?? row.createdAt]))
      try {
        if (rows.length)
          await this.client.request('/api/rig/v1/missions:sync', {
            missions: rows.map((row) => compactForSync(row))
          })
      } catch (error) {
        if (error.status === 404) {
          this.disabled = true
          this.logger?.('当前服务不支持任务同步，桌面任务只保存在本机')
          return
        }
        // Unreachable, signed out or refused: keep them and try later.
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
        if (!this.closed) this.#schedule(this.backoff)
        return
      }
      this.backoff = DEBOUNCE_MS
      for (const id of ids) {
        // A save that landed while this batch was in flight keeps it dirty.
        const row = this.store.rows.get(id)
        if (!row || (row.updatedAt ?? row.createdAt) === stamps[id]) this.dirty.delete(id)
        if (row) this.confirmed[id] = stamps[id]
      }
      await this.#persist()
    }
  }
  async #persist() {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(this.confirmed), { mode: 0o600 })
    await rename(temp, this.file)
  }
  /** One last attempt, bounded, then stop. Sign-out must not wait on the network. */
  async close(timeoutMs = 3_000) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.disabled && this.dirty.size)
      await Promise.race([
        this.flush(),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.())
      ])
    this.closed = true
  }
}
