import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Durable invocation records, one JSON file per dispatchId. A record is
// written and fsynced as `accepted` before the process starts, so a runner
// that answers 404 has provably never started that dispatch (the Hub contract
// relies on this). Completed records stay for the retention window so a Hub
// whose answer was lost can still read the result.

export const DISPATCH_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

async function fsyncDir(dir) {
  let handle
  try {
    handle = await open(dir, 'r')
    await handle.sync()
  } catch {
    // Some filesystems refuse directory fsync; the file itself is synced.
  } finally {
    await handle?.close().catch(() => {})
  }
}

export class InvocationRegistry {
  constructor(dataDir) {
    // Absolute: adapters run with their work directory as cwd, so a relative
    // path handed to them would resolve a second time inside it.
    const root = resolve(dataDir)
    this.dir = join(root, 'invocations')
    this.workRoot = join(root, 'work')
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await mkdir(this.workRoot, { recursive: true, mode: 0o700 })
  }

  #path(id) {
    if (!DISPATCH_ID.test(id)) throw Object.assign(new Error('invalid dispatchId'), { code: 'invalid_dispatch_id' })
    return join(this.dir, `${id}.json`)
  }

  workDir(slotId, id) {
    if (!DISPATCH_ID.test(id)) throw Object.assign(new Error('invalid dispatchId'), { code: 'invalid_dispatch_id' })
    return join(this.workRoot, slotId, id)
  }

  async write(record) {
    const target = this.#path(record.dispatchId)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    const handle = await open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(JSON.stringify(record))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
    await fsyncDir(this.dir)
  }

  async read(id) {
    try {
      return JSON.parse(await readFile(this.#path(id), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async *all() {
    for (const name of await readdir(this.dir)) {
      if (name.endsWith('.tmp')) {
        // A write that never reached rename: the record it was replacing (or
        // its absence) is still the truth.
        await rm(join(this.dir, name), { force: true })
        continue
      }
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      if (!DISPATCH_ID.test(id)) continue
      let record = null
      try { record = await this.read(id) } catch { record = null }
      if (record) yield record
    }
  }

  // Remove finished records (and their work directories) past retention.
  async prune({ retentionMs, now = Date.now() }) {
    let removed = 0
    for await (const record of this.all()) {
      if (record.state !== 'completed') continue
      const finished = Date.parse(record.finishedAt || record.acceptedAt || '')
      if (Number.isFinite(finished) && now - finished < retentionMs) continue
      await rm(this.workDir(record.slotId, record.dispatchId), { recursive: true, force: true }).catch(() => {})
      await rm(this.#path(record.dispatchId), { force: true })
      removed += 1
    }
    return removed
  }

  async usageBytes() {
    let total = 0
    const walk = async dir => {
      let entries = []
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size
      }
    }
    await walk(this.dir)
    await walk(this.workRoot)
    return total
  }
}
