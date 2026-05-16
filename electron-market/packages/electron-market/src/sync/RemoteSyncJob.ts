import type { MarketplaceDB } from '@qpjoy/marketplace-db';

import { RemoteClient, RemoteApiError, type VersionManifest } from './RemoteClient';

const META_RELEASE = 'marketplace.release';
const META_ETAG = 'marketplace.etag';
const META_MIGRATIONS_HEAD = 'marketplace.migrationsHead';

export interface RemoteSyncJobOptions {
  db: MarketplaceDB;
  client: RemoteClient;
  /** Poll interval in ms (default 10 min). 0 disables periodic polling. */
  intervalMs?: number;
  /** Randomized jitter +/- this many ms (default 30s). */
  jitterMs?: number;
  /** Apply migrations the server claims are newer than our local head. Default true. */
  applyMigrations?: boolean;
  /** Callback when a sync run finishes (success or failure). */
  onResult?: (result: SyncResult) => void;
}

export type SyncOutcome = 'ok' | 'skipped' | 'failed';

export interface SyncResult {
  outcome: SyncOutcome;
  startedAt: string;
  finishedAt: string;
  /** New release tag if the server bumped, else null. */
  newRelease: string | null;
  /** Entries pulled in this run (0 if etag matched). */
  entriesSynced: number;
  /** Migration versions applied this run. */
  migrationsApplied: number[];
  error: string | null;
}

/**
 * Periodic sync from the remote `electron-server`.
 *
 * Design:
 *   - `start()` schedules `run()` on an interval with jitter so a fleet of
 *     hosts doesn't hammer the server at the same instant.
 *   - `run()` is the same code path that the admin "sync now" button hits,
 *     so we never have two divergent sync implementations.
 *   - Failures are logged into `remote_sync.last_error` + plugin-level
 *     log; consecutive failures get exponential backoff via `failure_count`.
 *   - No state leaks past `run()` — the only persistent state is in the DB
 *     (`remote_sync` row + `meta_kv` etag/release tracking).
 */
export class RemoteSyncJob {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly opts: RemoteSyncJobOptions) {}

  start(): void {
    this.stopped = false;
    // Run once shortly after boot, then schedule.
    this.schedule(2_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async run(reason: 'startup' | 'interval' | 'manual' = 'manual'): Promise<SyncResult> {
    if (this.running) {
      return {
        outcome: 'skipped',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        newRelease: null,
        entriesSynced: 0,
        migrationsApplied: [],
        error: 'another sync is already in flight'
      };
    }

    this.running = true;
    const startedAt = new Date().toISOString();
    const result: SyncResult = {
      outcome: 'ok',
      startedAt,
      finishedAt: '',
      newRelease: null,
      entriesSynced: 0,
      migrationsApplied: [],
      error: null
    };

    try {
      const { db, client } = this.opts;
      const version = await client.getVersion();

      // 1. Migrations first — DB shape needs to match before we pull data.
      if (this.opts.applyMigrations !== false) {
        const localHead = Number(db.getMeta(META_MIGRATIONS_HEAD) ?? 0);
        if (version.migrationsHead > localHead) {
          result.migrationsApplied = await this.pullMigrations(version);
        }
      }

      // 2. Marketplace index.
      const prevEtag = db.getMeta(META_ETAG);
      const { index, etag } = await client.getMarketplaceIndex(prevEtag);

      if (index) {
        db.bulkUpsertEntries(
          index.entries.map((e) => ({
            id: e.id,
            npm: e.npm,
            name: e.name,
            description: e.description,
            latestVersion: e.latestVersion,
            manifestUrl: e.manifestUrl,
            tarballUrl: e.tarballUrl,
            homepage: e.homepage,
            author: e.author,
            category: e.category,
            verified: e.verified,
            bootstrap: e.bootstrap,
            visibility: e.visibility,
            specVersion: e.specVersion,
            metadata: e.metadata,
            source: 'remote',
            fetchedAt: new Date().toISOString()
          }))
        );
        result.entriesSynced = index.entries.length;
        if (etag) db.setMeta(META_ETAG, etag);
      }

      // 3. Bookkeeping.
      if (version.release !== db.getMeta(META_RELEASE)) {
        result.newRelease = version.release;
        db.setMeta(META_RELEASE, version.release);
      }
      db.setMeta(META_MIGRATIONS_HEAD, String(version.migrationsHead));

      this.recordSyncSuccess(version, reason);
    } catch (err) {
      result.outcome = 'failed';
      result.error = err instanceof Error ? err.message : String(err);
      this.recordSyncFailure(result.error);
    } finally {
      result.finishedAt = new Date().toISOString();
      this.running = false;
      this.opts.onResult?.(result);
      if (!this.stopped) this.schedule(this.nextDelayMs());
    }

    return result;
  }

  /* ─── internals ───────────────────────────────────────────────────── */

  private async pullMigrations(version: VersionManifest): Promise<number[]> {
    const applied: number[] = [];
    const localHead = Number(this.opts.db.getMeta(META_MIGRATIONS_HEAD) ?? 0);
    for (let v = localHead + 1; v <= version.migrationsHead; v++) {
      const remote = await this.opts.client.getMigration(v);
      this.opts.db.migrator.register({
        version: remote.version,
        name: remote.name,
        up: remote.up,
        down: remote.down ?? undefined
      });
      this.opts.db.migrator.up(remote.version);
      applied.push(v);
    }
    return applied;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.opts.intervalMs === 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.run('interval');
    }, delayMs);
  }

  private nextDelayMs(): number {
    const base = this.opts.intervalMs ?? 10 * 60 * 1000;
    const jitter = this.opts.jitterMs ?? 30_000;
    const sync = this.opts.db.getSync('marketplace');
    const failureCount = sync?.failureCount ?? 0;
    // Exponential backoff on failure: 1, 2, 4, 8, 16 minute multiplier (cap 16).
    const factor = failureCount === 0 ? 1 : Math.min(2 ** failureCount, 16);
    const offset = (Math.random() * 2 - 1) * jitter;
    return Math.max(60_000, base * factor + offset);
  }

  private recordSyncSuccess(version: VersionManifest, reason: string): void {
    this.opts.db.setSync('marketplace', {
      lastRelease: version.release,
      lastFetchedAt: new Date().toISOString(),
      failureCount: 0,
      lastError: null,
      data: { migrationsHead: version.migrationsHead, lastReason: reason }
    });
  }

  private recordSyncFailure(message: string): void {
    const prev = this.opts.db.getSync('marketplace');
    this.opts.db.setSync('marketplace', {
      lastRelease: prev?.lastRelease ?? null,
      lastFetchedAt: prev?.lastFetchedAt ?? null,
      failureCount: (prev?.failureCount ?? 0) + 1,
      lastError: message,
      data: prev?.data ?? null
    });
  }
}

/** Helper used by IPC + admin route to share one job instance. */
export interface RemoteSyncStatus {
  configured: boolean;
  baseUrl: string | null;
  lastRelease: string | null;
  lastFetchedAt: string | null;
  failureCount: number;
  lastError: string | null;
  knownReleaseFromMeta: string | null;
}

export function readSyncStatus(db: MarketplaceDB, baseUrl: string | null): RemoteSyncStatus {
  const row = db.getSync('marketplace');
  return {
    configured: Boolean(baseUrl),
    baseUrl,
    lastRelease: row?.lastRelease ?? null,
    lastFetchedAt: row?.lastFetchedAt ?? null,
    failureCount: row?.failureCount ?? 0,
    lastError: row?.lastError ?? null,
    knownReleaseFromMeta: db.getMeta(META_RELEASE)
  };
}

export { RemoteApiError } from './RemoteClient';
