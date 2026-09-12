// Opportunistic byte-bounded LRU. Eviction never deletes the durable object.
export class MediaCache {
  constructor({ maxBytes = 64 * 1024 * 1024, maxObjectBytes = 1024 * 1024, ttlMs = 60000, maxEntries = 2048, now = Date.now } = {}) {
    if (![maxBytes, maxObjectBytes, ttlMs, maxEntries].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid cache limits')
    Object.assign(this, { maxBytes, maxObjectBytes, ttlMs, maxEntries, now })
    this.entries = new Map(); this.bytes = 0; this.hits = 0; this.misses = 0
  }
  delete(key) { const entry = this.entries.get(key); if (entry) this.bytes -= entry.body.length; this.entries.delete(key) }
  get(key) {
    const entry = this.entries.get(key)
    if (!entry || entry.expires <= this.now()) { this.delete(key); this.misses++; return null }
    this.entries.delete(key); this.entries.set(key, entry); this.hits++; return entry.body
  }
  metadata(key) { return this.entries.get(key)?.meta }
  set(key, body, meta) {
    if (body.length > this.maxObjectBytes || body.length > this.maxBytes || !this.ttlMs || !this.maxEntries) return
    this.delete(key)
    this.entries.set(key, { body, meta, expires: this.now() + this.ttlMs }); this.bytes += body.length
    this.prune()
  }
  prune() {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.delete(key)
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) this.delete(this.entries.keys().next().value)
  }
  stats() { return { bytes: this.bytes, entries: this.entries.size, hits: this.hits, misses: this.misses, maxBytes: this.maxBytes, ttlMs: this.ttlMs } }
}
