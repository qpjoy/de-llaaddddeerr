// Long-poll support for GET /v1/jobs/:id/wait (V2-5). All waiters share one
// status query per interval (whatever their number), and a write handled in
// this process checks at once. Waiting never touches a device.
import { FINAL } from "./client-settlement.mjs";

export class JobWaiter {
  constructor(store, { intervalMs = 500 } = {}) {
    this.store = store;
    this.intervalMs = intervalMs;
    this.waiters = new Map(); // `${mode}|${id}` -> Set<resolve>
    this.loop = null;
  }
  /** Resolves with the final status, or null on timeout or abort. */
  wait(mode, id, timeoutMs, signal) {
    return new Promise((resolve) => {
      const key = `${mode}|${id}`;
      if (!this.waiters.has(key)) this.waiters.set(key, new Set());
      const set = this.waiters.get(key);
      const done = (status) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        set.delete(done);
        if (!set.size) this.waiters.delete(key);
        resolve(status);
      };
      const abort = () => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      set.add(done);
      this.loop ??= this.#run();
    });
  }
  /** Something was written here: check now instead of at the next tick. */
  nudge() {
    if (!this.waiters.size) return;
    clearTimeout(this.timer);
    this.wake?.();
  }
  async #check() {
    const byMode = new Map();
    for (const key of this.waiters.keys()) {
      const [mode, id] = key.split("|");
      if (!byMode.has(mode)) byMode.set(mode, []);
      byMode.get(mode).push(id);
    }
    for (const [mode, ids] of byMode) {
      const statuses = await this.store.jobStatuses(mode, ids);
      for (const id of ids) {
        const status = statuses.get(id);
        // A job that does not exist (any more) ends the wait too.
        if (status === undefined || FINAL.has(status))
          for (const done of [...(this.waiters.get(`${mode}|${id}`) || [])])
            done(status ?? null);
      }
    }
  }
  async #run() {
    try {
      while (this.waiters.size) {
        try {
          await this.#check();
        } catch {
          // Store unavailable: waiters time out on their own.
        }
        if (!this.waiters.size) break;
        await new Promise((r) => {
          this.wake = r;
          this.timer = setTimeout(r, this.intervalMs);
          this.timer.unref?.();
        });
      }
    } finally {
      this.loop = null;
    }
  }
  close() {
    for (const set of this.waiters.values())
      for (const done of [...set]) done(null);
  }
}
