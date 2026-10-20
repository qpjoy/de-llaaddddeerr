import type { AuditEvent } from '../types.js';

const MAX_EVENTS = 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 250;
const FAILURE_BACKOFF_MS = 5000;
const WARNING_INTERVAL_MS = 60_000;

type Warning = {
  event: 'audit.observation.degraded';
  reason: 'capacity' | 'oversize' | 'serialization' | 'write-failed' | 'closed';
  droppedEvents: number;
  failedEvents: number;
  bufferedEvents: number;
};

/** Best-effort observations only. Security mutations must keep their durable audit. */
export class ObservationalAuditQueue {
  private pending: Array<{ event: AuditEvent; bytes: number }> = [];
  // Include the in-flight batch in both limits, even if its database write hangs.
  private bufferedEvents = 0;
  private bufferedBytes = 0;
  private inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private retryAfter = 0;
  private lastWarningAt = -Infinity;
  private droppedEvents = 0;
  private failedEvents = 0;

  constructor(
    private readonly persist: (events: AuditEvent[]) => Promise<unknown>,
    private readonly warn: (warning: Warning) => void = (warning) => console.warn(JSON.stringify(warning))
  ) {}

  enqueue(event: AuditEvent): void {
    if (this.closed || this.bufferedEvents >= MAX_EVENTS) {
      this.drop(this.closed ? 'closed' : 'capacity');
      return;
    }
    try {
      const serialized = JSON.stringify(event);
      const bytes = Buffer.byteLength(serialized);
      if (bytes > MAX_EVENT_BYTES || this.bufferedBytes + bytes > MAX_BYTES) {
        this.drop(bytes > MAX_EVENT_BYTES ? 'oversize' : 'capacity');
        return;
      }
      // Own an immutable snapshot; response callers must not mutate queued metadata.
      this.pending.push({ event: JSON.parse(serialized) as AuditEvent, bytes });
      this.bufferedEvents += 1;
      this.bufferedBytes += bytes;
      this.schedule();
    } catch {
      this.drop('serialization');
    }
  }

  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.closed || !this.pending.length) return Promise.resolve();
    if (Date.now() < this.retryAfter) {
      this.schedule();
      return Promise.resolve();
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending.splice(0, BATCH_SIZE);
    this.inFlight = Promise.resolve()
      .then(() => this.persist(batch.map((entry) => entry.event)))
      .then(() => undefined)
      .catch(() => {
        // The outcome can be unknown after a connection failure. Do not retry or
        // create a growing retry backlog on the same disk that serves auth reads.
        this.failedEvents += batch.length;
        this.retryAfter = Date.now() + FAILURE_BACKOFF_MS;
        this.report('write-failed');
      })
      .finally(() => {
        this.bufferedEvents -= batch.length;
        this.bufferedBytes -= batch.reduce((sum, entry) => sum + entry.bytes, 0);
        this.inFlight = undefined;
        this.schedule();
      });
    return this.inFlight;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.droppedEvents += this.pending.length;
    this.bufferedEvents -= this.pending.length;
    this.bufferedBytes -= this.pending.reduce((sum, entry) => sum + entry.bytes, 0);
    if (this.pending.length) this.report('closed');
    this.pending = [];
    // Do not launch replacement work or wait indefinitely for a stuck DB write.
    // Its rejection remains handled by flush(). Pending observations are volatile.
  }

  private schedule(): void {
    if (this.closed || this.timer || this.inFlight || !this.pending.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, Math.max(FLUSH_INTERVAL_MS, this.retryAfter - Date.now()));
    this.timer.unref();
  }

  private drop(reason: Warning['reason']): void {
    this.droppedEvents += 1;
    this.report(reason);
  }

  private report(reason: Warning['reason']): void {
    if (Date.now() - this.lastWarningAt < WARNING_INTERVAL_MS) return;
    this.lastWarningAt = Date.now();
    try {
      // Counters only: neither event metadata nor SQL/connection errors are safe
      // to log (request IDs are caller-controlled and errors can contain secrets).
      this.warn({ event: 'audit.observation.degraded', reason,
        droppedEvents: this.droppedEvents, failedEvents: this.failedEvents,
        bufferedEvents: this.bufferedEvents });
    } catch { /* A logging failure must not become an authentication failure. */ }
  }
}
