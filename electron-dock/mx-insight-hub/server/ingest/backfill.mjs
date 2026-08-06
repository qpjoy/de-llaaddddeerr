// Backfill Hub canonical data from content Night-All has already collected.
//
// Why this is not a database-to-database copy: Night-All owns collection,
// providers and the physical schema (ADR-0001). Reading its tables directly
// would couple the Hub to a layout that changes whenever a provider does. The
// export endpoint returns the same stable envelope as `/data/search`, so both
// paths land in `ingestSearchResult` and produce byte-identical canonical rows.
//
// Duplication is not a concern, and not because this code avoids it:
// `core.canonical_records` is unique on (dataset_id, platform, object_type,
// external_id), and an unchanged `payload_sha256` produces no revision and no
// outbox event. Re-running a completed backfill is therefore a no-op that costs
// only the read. That is the property worth protecting — dedup lives in a
// constraint, not in a worker's bookkeeping.

const DEFAULT_PAGE_SIZE = 200

export function cursorId(platform) {
  return `backfill:night-all:${platform}`
}

export class NightAllBackfill {
  constructor({ store, adapter, queue, pageSize = DEFAULT_PAGE_SIZE, logger = console }) {
    this.store = store
    this.adapter = adapter
    this.queue = queue
    this.pageSize = pageSize
    this.logger = logger
  }

  /**
   * Drain one platform, resuming from the durable cursor.
   *
   * The cursor is saved after each page is ingested, never before. A crash
   * mid-page therefore replays that page on restart, which the uniqueness
   * constraint absorbs. Saving first would skip it — the failure mode that
   * actually loses data.
   *
   * `maxPages` bounds one invocation so a long backfill yields between chunks
   * instead of holding a job lease for hours.
   */
  async runPlatform(platform, { maxPages = 50, since = null, onProgress = null, signal = null } = {}) {
    const id = cursorId(platform)
    const saved = await this.queue.getCursor(id)
    let cursor = saved?.position?.cursor ?? null
    let pages = 0
    let ingested = 0
    let changed = 0

    while (pages < maxPages && !signal?.aborted) {
      let page
      try {
        page = await this.adapter.exportContents({
          platform,
          cursor,
          since: cursor ? null : (since ?? saved?.position?.since ?? null),
          limit: this.pageSize,
        })
      } catch (error) {
        await this.queue.saveCursor(id, saved?.position ?? {}, {
          status: 'failed',
          error: String(error.message || error).slice(0, 1_000),
        })
        throw error
      }

      const items = page.raw?.data?.items ?? []
      if (items.length === 0) {
        await this.queue.saveCursor(id, { cursor, since, completedAt: new Date().toISOString() }, {
          status: 'idle',
        })
        break
      }

      // Reuse the live-path ingest verbatim. `queryFingerprint` is null because
      // a backfilled row was not observed through any particular query, and
      // recording a fake one would corrupt the observation history that
      // rank/metrics analysis depends on.
      const result = await this.store.ingestSearchResult({
        platform,
        rawPayload: page.raw,
        queryFingerprint: null,
        requestId: null,
      })
      ingested += result.ingested
      changed += result.changed

      cursor = page.raw?.data?.pageInfo?.nextCursor ?? null
      pages += 1
      await this.queue.saveCursor(id, { cursor, since }, {
        status: cursor ? 'running' : 'idle',
        processedDelta: result.ingested,
      })
      onProgress?.({ platform, pages, ingested, changed, cursor })

      if (!cursor) break
    }

    return { platform, pages, ingested, changed, cursor, done: !cursor }
  }

  /** Reset a platform's cursor so the next run starts from `since` (or zero). */
  async reset(platform, { since = null } = {}) {
    return this.queue.saveCursor(cursorId(platform), { cursor: null, since }, { status: 'idle' })
  }

  async status(platforms) {
    const cursors = await Promise.all(
      platforms.map(async (platform) => {
        const cursor = await this.queue.getCursor(cursorId(platform))
        return [platform, cursor && {
          status: cursor.status,
          processed: Number(cursor.processed_count),
          position: cursor.position,
          lastError: cursor.last_error,
          updatedAt: cursor.updated_at,
        }]
      }),
    )
    return Object.fromEntries(cursors)
  }
}
