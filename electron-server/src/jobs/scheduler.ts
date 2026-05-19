/**
 * In-process scheduler for the npm sync job.
 *
 * Lives next to the Fastify process — no system cron, no sidecar. The
 * server boots, runs an immediate sync (if `SYNC_ON_BOOT=1`), then loops
 * on `SYNC_INTERVAL_MS` (default 1 hour) with a small jitter so a fleet
 * of instances doesn't hammer npm at the same instant.
 *
 * One run at a time (mutex). Each result is recorded in `audit_logs`
 * so the admin "审计" page surfaces the history.
 *
 * Environment:
 *   SYNC_ENABLED      = "1"  → run periodically (default on)
 *                       "0"  → never run (use manual API trigger only)
 *   SYNC_ON_BOOT      = "1"  → kick the first sync ~3s after server start
 *   SYNC_INTERVAL_MS  = 3600000  (1 hour default; clamped to ≥ 60s)
 *   SYNC_JITTER_MS    = 30000    (± 30s by default)
 */
import { auditStore } from '../data/index.js';
import { runSync, type SyncOptions, type SyncReport } from './sync-npm.js';

export type SchedulerStatus = {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  jitterMs: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastReport: SyncReport | null;
  lastError: string | null;
  nextRunAt: string | null;
};

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly onBoot: boolean;

  private lastStartedAt: string | null = null;
  private lastFinishedAt: string | null = null;
  private lastReport: SyncReport | null = null;
  private lastError: string | null = null;
  private nextRunAt: string | null = null;

  constructor() {
    this.enabled = process.env.SYNC_ENABLED !== '0';
    this.onBoot = process.env.SYNC_ON_BOOT !== '0';
    this.intervalMs = Math.max(60_000, Number(process.env.SYNC_INTERVAL_MS ?? 3_600_000));
    this.jitterMs = Math.max(0, Number(process.env.SYNC_JITTER_MS ?? 30_000));
  }

  start(): void {
    if (!this.enabled) return;
    this.stopped = false;
    const initial = this.onBoot ? 3_000 : this.intervalMs;
    this.schedule(initial);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status(): SchedulerStatus {
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      jitterMs: this.jitterMs,
      lastStartedAt: this.lastStartedAt,
      lastFinishedAt: this.lastFinishedAt,
      lastReport: this.lastReport,
      lastError: this.lastError,
      nextRunAt: this.nextRunAt
    };
  }

  /**
   * Manual one-shot. If a periodic run is in flight, returns the awaitable
   * for that run — never two parallel syncs touching the same data files.
   */
  async runNow(reason: string = 'manual', opts: SyncOptions = {}): Promise<SyncReport> {
    if (this.running) {
      // Spin-wait briefly for the in-flight run, then return its report.
      while (this.running) await new Promise((r) => setTimeout(r, 250));
      if (this.lastReport) return this.lastReport;
      throw new Error('sync ended without a report');
    }
    return this.runOnce(reason, opts);
  }

  /* ─── internals ─────────────────────────────────────────────────────── */

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      void this.runOnce('interval').finally(() => this.schedule(this.computeDelay()));
    }, delayMs);
  }

  private computeDelay(): number {
    const offset = (Math.random() * 2 - 1) * this.jitterMs;
    return Math.max(60_000, this.intervalMs + offset);
  }

  private async runOnce(reason: string, opts: SyncOptions = {}): Promise<SyncReport> {
    this.running = true;
    this.lastStartedAt = new Date().toISOString();
    this.lastError = null;
    try {
      // eslint-disable-next-line no-console
      console.log(`[scheduler] sync start (reason=${reason})`);
      const report = await runSync(opts);
      this.lastReport = report;
      this.lastFinishedAt = new Date().toISOString();
      // eslint-disable-next-line no-console
      console.log(
        `[scheduler] sync done: release=${report.release} accepted=${report.acceptedPlugins} rejected=${report.rejected.length} (${report.durationMs}ms)`
      );

      // Audit log — admin UI sees it via /api/v1/admin/audit.
      await auditStore
        .insert({
          actorUserId: null,
          actorIp: null,
          action: 'system.sync',
          targetKind: 'marketplace',
          targetId: report.release,
          meta: {
            reason,
            acceptedPlugins: report.acceptedPlugins,
            scannedPackages: report.scannedPackages,
            rejectedCount: report.rejected.length,
            durationMs: report.durationMs
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[scheduler] failed to write audit log:', err);
        });

      return report;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastFinishedAt = new Date().toISOString();
      // eslint-disable-next-line no-console
      console.error('[scheduler] sync failed:', this.lastError);
      await auditStore
        .insert({
          actorUserId: null,
          actorIp: null,
          action: 'system.sync.fail',
          targetKind: 'marketplace',
          targetId: null,
          meta: { reason, error: this.lastError }
        })
        .catch(() => undefined);
      throw err;
    } finally {
      this.running = false;
    }
  }
}

/** Singleton kept private to this module; routes get at it via getScheduler(). */
let instance: SyncScheduler | null = null;

export function initScheduler(): SyncScheduler {
  if (!instance) instance = new SyncScheduler();
  return instance;
}

export function getScheduler(): SyncScheduler | null {
  return instance;
}
