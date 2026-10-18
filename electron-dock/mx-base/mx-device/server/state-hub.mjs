// One state producer per realm in the API process (V2-4). While anyone
// watches, it builds the /api/state payload at most once per interval (or
// sooner when poked after a write), diffs it against the previous one and
// streams the patch over SSE to every viewer. Polling clients get the same
// cached payload, so more viewers add no snapshot or planning work.
import { createGzip } from "node:zlib";
import { diffState } from "./state-patch.mjs";

const MAX_BUFFERED = 8 * 1024 * 1024; // a viewer this far behind reconnects

export class StateHub {
  /** build(channel, previous, {planning}) -> payload. A channel is a realm
   * ("sim") or a scoped view of one ("sim|ops", "sim|client:<id>"); writes
   * and pokes apply to every channel of their realm. */
  constructor(
    build,
    { intervalMs = 1000, planningMs = 3000, pingMs = 15000 } = {},
  ) {
    this.build = build;
    this.intervalMs = intervalMs;
    this.planningMs = planningMs;
    this.pingMs = pingMs;
    this.channels = new Map();
    this.stats = { builds: 0, patches: 0, bytes: 0 };
  }
  #channel(mode) {
    if (!this.channels.has(mode))
      this.channels.set(mode, {
        mode,
        realm: mode.split("|")[0],
        subs: new Set(),
        version: 0,
        payload: null,
        index: null,
        builtAt: 0,
        startedAt: -1, // when the cached payload's build began
        invalidatedAt: -1, // last write seen by this process
        building: null,
        buildingStartedAt: -1,
        plannedAt: -Infinity,
        loop: null,
        wake: null,
      });
    return this.channels.get(mode);
  }
  /** Rebuilds (shared by concurrent callers), diffs and broadcasts. */
  #refresh(ch) {
    ch.building ??= (async () => {
      const startedAt = performance.now();
      ch.buildingStartedAt = startedAt;
      try {
        // Plans every planningMs, or at once after a write in this process.
        const planning =
          !ch.payload ||
          startedAt - ch.plannedAt >= this.planningMs ||
          ch.invalidatedAt > ch.plannedAt;
        const payload = await this.build(ch.mode, ch.payload, { planning });
        if (planning) ch.plannedAt = startedAt;
        this.stats.builds++;
        ch.lastBuildMs = performance.now() - startedAt;
        const { patch, index } = diffState(ch.index, payload);
        ch.index = index;
        ch.payload = payload;
        ch.startedAt = startedAt;
        ch.builtAt = performance.now();
        if (patch && ch.version > 0) {
          ch.version++;
          this.stats.patches++;
          this.#broadcast(ch, "patch", { v: ch.version, ...patch });
        } else if (patch || ch.version === 0) ch.version++;
        return payload;
      } finally {
        ch.building = null;
      }
    })();
    return ch.building;
  }
  /** The latest payload: cached for one interval unless a write in this
   * process happened since its build began. */
  async current(mode) {
    const ch = this.#channel(mode);
    const fresh = () =>
      ch.payload &&
      ch.startedAt > ch.invalidatedAt &&
      performance.now() - ch.builtAt < this.intervalMs;
    if (fresh()) return ch.payload;
    if (ch.building && ch.buildingStartedAt <= ch.invalidatedAt)
      await ch.building.catch(() => {});
    if (fresh()) return ch.payload;
    return this.#refresh(ch);
  }
  /** A write happened here: later reads must not see an older build. */
  invalidate(mode) {
    const at = performance.now();
    this.#channel(mode).invalidatedAt = at;
    for (const ch of this.channels.values())
      if (ch.realm === mode) ch.invalidatedAt = at;
  }
  /** Something changed in this process: push it within ~50 ms. */
  poke(mode) {
    for (const ch of this.channels.values()) {
      if (ch.realm !== mode || !ch.subs.size || ch.pokeTimer) continue;
      ch.pokeTimer = setTimeout(() => {
        ch.pokeTimer = null;
        ch.wake?.();
      }, 50);
      ch.pokeTimer.unref?.();
    }
  }
  #send(res, event, data, id) {
    const text = `${id != null ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.stats.bytes += text.length;
    res.write(text);
    if (res.writableLength > MAX_BUFFERED) res.end();
  }
  #broadcast(ch, event, data) {
    for (const res of ch.subs) this.#send(res, event, data, ch.version);
  }
  /** Opens an SSE stream: a full snapshot first, then patches. */
  async subscribe(mode, req, res) {
    const ch = this.#channel(mode);
    const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(gzip ? { "Content-Encoding": "gzip" } : {}),
    });
    // Each event is flushed through gzip at once (patches compress ~10x).
    const zip = gzip ? createGzip() : null;
    if (zip) {
      zip.pipe(res);
      res.once("close", () => zip.destroy());
    }
    const sink = zip
      ? {
          write(text) {
            zip.write(text);
            zip.flush();
          },
          get writableLength() {
            return zip.writableLength + res.writableLength;
          },
          end: () => zip.end(),
        }
      : res;
    sink.write(`retry: 3000\n\n`);
    await this.current(mode);
    // Synchronously after the await: the snapshot and the subscription see
    // the same version, so no patch can fall between them.
    this.#send(
      sink,
      "snapshot",
      { v: ch.version, state: ch.payload },
      ch.version,
    );
    ch.subs.add(sink);
    const ping = setInterval(() => sink.write(": ping\n\n"), this.pingMs);
    ping.unref?.();
    const leave = () => {
      clearInterval(ping);
      ch.subs.delete(sink);
    };
    req.once("close", leave);
    res.once("close", leave);
    ch.loop ??= this.#run(ch);
  }
  async #run(ch) {
    try {
      while (ch.subs.size) {
        await new Promise((resolve) => {
          // A slow build stretches the interval: at most ~1/3 of a core.
          const timer = setTimeout(
            resolve,
            Math.max(this.intervalMs, (ch.lastBuildMs || 0) * 3),
          );
          ch.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        ch.wake = null;
        if (!ch.subs.size) break;
        try {
          await this.#refresh(ch);
        } catch {
          // Store unavailable: viewers keep the last state; retry next tick.
        }
      }
    } finally {
      ch.loop = null;
    }
  }
  viewers(mode) {
    return this.channels.get(mode)?.subs.size || 0;
  }
  close() {
    for (const ch of this.channels.values()) {
      for (const res of ch.subs) res.end();
      ch.subs.clear();
      ch.wake?.();
    }
  }
}
