// Host Agent (V2-3): one per host, connecting out to the center over HTTP
// (long-poll for grants, batched idempotent reports). It owns the Device Gate
// and drives a Driver; it never decides what to run. Each command comes as a
// "run" directive in the answer to the previous report, so without the
// center the Agent finishes the command in hand and then waits: a partition
// stops it at the next safe point by construction.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DeviceGate } from "./gate.mjs";
import { AGENT_PROTOCOL } from "../agent-lease.mjs";

class CenterError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const FATAL = new Set([401, 403]);

export class HostAgent {
  /** center: base URL; token: the Agent token; devices: [{ serial, apps }]. */
  constructor({
    center,
    token,
    driver,
    devices,
    fetch = globalThis.fetch,
    version = "sim-agent/1",
    instanceId = randomUUID(),
    pollWaitMs = 20000,
    retryMs = 500,
    maxBuffer = 1000,
    log = () => {},
  }) {
    Object.assign(this, {
      center: center.replace(/\/$/, ""),
      token,
      driver,
      devices,
      fetchImpl: fetch,
      version,
      instanceId,
      pollWaitMs,
      retryMs,
      maxBuffer,
      log,
    });
    this.gate = new DeviceGate();
    this.leases = new Map(); // attemptId -> lease
    this.outbox = []; // reports not acknowledged yet (bounded)
    this.deviceIds = new Map(); // serial -> deviceId
    this.serials = new Map(); // deviceId -> serial
    this.config = { heartbeatMs: 5000, leaseMs: 20000, graceMs: 15000 };
    this.running = false;
    this.connected = false;
    this.aborts = new Set();
    this.stats = { commands: 0, rejected: 0, lateReports: 0 };
  }
  async #post(path, body, timeoutMs = 10000) {
    const abort = new AbortController();
    this.aborts.add(abort);
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.center}/agent/v1/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new CenterError(response.status, value.error || "中心拒绝请求");
      this.connected = true;
      return value;
    } catch (error) {
      if (!(error instanceof CenterError)) this.connected = false;
      if (FATAL.has(error.status)) {
        this.log(`中心拒绝 Agent 凭证：${error.message}`);
        this.running = false;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.aborts.delete(abort);
    }
  }
  async start() {
    this.running = true;
    await this.#hello();
    this.loops = [this.#heartbeatLoop(), this.#pollLoop()];
  }
  /** Graceful stop: no new leases; leases in hand end at their next report. */
  async stop() {
    this.running = false;
    for (const abort of this.aborts) abort.abort();
    for (const lease of this.leases.values()) lease.wake?.();
    await Promise.allSettled([
      ...(this.loops || []),
      ...[...this.leases.values()].map((l) => l.done),
    ]);
  }
  /** Crash (tests): everything stops at once and nothing more is reported. */
  kill() {
    this.running = false;
    this.killed = true;
    for (const abort of this.aborts) abort.abort();
    for (const lease of this.leases.values()) lease.wake?.();
  }
  async #hello() {
    for (let n = 0; this.running; n++) {
      try {
        const value = await this.#post("hello", {
          protocol: AGENT_PROTOCOL,
          instanceId: this.instanceId,
          version: this.version,
          driver: this.driver.kind,
          capabilities: ["lease", "seq", "stop", "signal", "buffer"],
          devices: this.devices.map((d) => ({
            serial: d.serial,
            ...this.driver.capabilities(d),
          })),
          leases: [...this.leases.values()].map((l) => ({
            attemptId: l.attemptId,
            token: l.token,
          })),
        });
        Object.assign(this.config, {
          heartbeatMs: value.heartbeatMs,
          leaseMs: value.leaseMs,
          graceMs: value.graceMs,
        });
        this.deviceIds = new Map(
          value.devices.map((d) => [d.serial, d.deviceId]),
        );
        this.serials = new Map(
          value.devices.map((d) => [d.deviceId, d.serial]),
        );
        this.pending = value.pending;
        return value;
      } catch (error) {
        if (FATAL.has(error.status)) return null;
        await sleep(Math.min(5000, this.retryMs * 2 ** Math.min(n, 4)));
      }
    }
  }
  async #heartbeatLoop() {
    while (this.running) {
      await sleep(this.config.heartbeatMs);
      if (!this.running) break;
      try {
        const value = await this.#post("heartbeat", {
          instanceId: this.instanceId,
          clockMs: Date.now(),
          buffered: this.outbox.length,
          leases: [...this.leases.values()].map((l) => ({
            attemptId: l.attemptId,
            token: l.token,
          })),
        });
        for (const s of value.leases) {
          const lease = this.leases.get(s.attemptId);
          if (!lease || lease.token !== s.token) continue;
          if (s.status === "ok")
            this.gate.renew(lease.deviceId, lease.token, s.leaseMs);
          else {
            // The center no longer backs this lease: start nothing more.
            this.gate.revoke(lease.deviceId, lease.token);
            lease.wake?.();
          }
          if (s.stop) {
            lease.stopRequested = true;
            lease.wake?.();
          }
        }
        // Each heartbeat that gets through also flushes late reports.
        await this.#flush();
      } catch (error) {
        // Instance unknown to the center (it restarted or we were replaced).
        if (error.status === 409) await this.#hello();
      }
    }
  }
  async #pollLoop() {
    while (this.running) {
      let inbox;
      try {
        inbox = await this.#post(
          "poll",
          { waitMs: this.pollWaitMs },
          this.pollWaitMs + 5000,
        );
      } catch {
        if (this.running) await sleep(this.retryMs);
        continue;
      }
      for (const grant of inbox.grants) this.#onGrant(grant);
      for (const control of inbox.controls) {
        const lease = this.leases.get(control.attemptId);
        if (lease?.token === control.token) {
          lease.stopRequested = true;
          lease.wake?.();
        }
      }
    }
  }
  #onGrant(grant) {
    const held = this.leases.get(grant.attemptId);
    if (held?.token === grant.token) return; // already running this lease
    const serial = grant.serial ?? this.serials.get(grant.deviceId);
    const device = this.devices.find((d) => d.serial === serial);
    const caps = device && this.driver.capabilities(device);
    const capable =
      caps &&
      caps.apps.includes(grant.job.appId) &&
      grant.job.plan.every((step) => caps.commands.includes(step.code));
    const verdict = !capable
      ? { ok: false, reason: device ? "capability" : "device-fault" }
      : this.gate.grant(grant.deviceId, {
          attemptId: grant.attemptId,
          token: grant.token,
          generation: grant.generation,
          leaseMs: grant.leaseMs,
        });
    if (!verdict.ok) {
      this.stats.rejected++;
      // A stale token is simply ignored; the center already moved on.
      if (verdict.reason !== "stale-token")
        void this.#deliver({
          type: "lease.reject",
          attemptId: grant.attemptId,
          token: grant.token,
          reason: verdict.reason,
        }).catch(() => {});
      return;
    }
    const lease = {
      attemptId: grant.attemptId,
      deviceId: grant.deviceId,
      serial,
      token: grant.token,
      generation: grant.generation,
      job: grant.job,
    };
    this.leases.set(lease.attemptId, lease);
    lease.done = this.#runLease(lease)
      .catch((error) => this.log(`租约执行异常：${error.message}`))
      .finally(() => {
        this.gate.release(lease.deviceId, lease.token);
        if (this.leases.get(lease.attemptId) === lease)
          this.leases.delete(lease.attemptId);
      });
  }
  /** Delivers one report; resolves with the center's result. */
  async #deliver(message) {
    const m = { ...message, id: message.id || randomUUID() };
    const value = await this.#post("report", { messages: [m] });
    return value.results[0];
  }
  /** Lease message that needs an answer before anything else may start. It is
   * retried while the lease can still be backed; then it stays in the bounded
   * buffer and is reported later as evidence. */
  async #exchange(lease, message) {
    const m = {
      ...message,
      id: randomUUID(),
      attemptId: lease.attemptId,
      token: lease.token,
      generation: lease.generation,
    };
    this.outbox.push(m);
    if (this.outbox.length > this.maxBuffer) this.outbox.shift();
    for (let n = 0; this.running; n++) {
      try {
        const result = await this.#deliver(m);
        if (result?.retry) {
          await sleep(this.retryMs);
          continue;
        }
        this.outbox = this.outbox.filter((x) => x !== m);
        return result?.directive || null;
      } catch (error) {
        if (FATAL.has(error.status)) return null;
        if (
          this.gate.expired(lease.deviceId, lease.token, this.config.graceMs)
        ) {
          this.log(`租约 ${lease.attemptId} 已过期，回执留在缓冲区稍后补报`);
          return null;
        }
        await sleep(Math.min(2000, this.retryMs * 2 ** Math.min(n, 3)));
      }
    }
    return null;
  }
  async #flush() {
    for (const m of [...this.outbox]) {
      if (this.leases.has(m.attemptId)) continue; // its runner is delivering it
      try {
        await this.#deliver(m);
        this.outbox = this.outbox.filter((x) => x !== m);
        this.stats.lateReports++;
      } catch {
        return;
      }
    }
  }
  #nap(lease, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      lease.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  async #runLease(lease) {
    const ctx = () => ({
      deviceId: lease.deviceId,
      serial: lease.serial,
      token: lease.token,
    });
    let directive = await this.#exchange(lease, { type: "lease.accept" });
    while (directive && this.running) {
      if (directive.generation) lease.generation = directive.generation;
      if (directive.action === "run") {
        const c = directive.command;
        const gate = this.gate.begin(lease.deviceId, {
          token: c.token,
          seq: c.seq,
        });
        let receipt = null,
          error = gate.ok ? null : gate.reason,
          hung = false;
        if (gate.ok) {
          const abort = new AbortController();
          const limit = Math.max(
            5000,
            c.definition?.timeoutMs || (c.estimateMs || 3000) * 4,
          );
          const timer = setTimeout(() => {
            hung = true;
            abort.abort();
          }, limit);
          try {
            receipt = await this.driver.execute(c, {
              ...ctx(),
              seq: c.seq,
              signal: abort.signal,
            });
            this.stats.commands++;
          } catch (e) {
            // A timeout is never a success: the center records unknown.
            error = hung ? "timeout" : e.code || "driver-error";
          } finally {
            clearTimeout(timer);
            this.gate.end(lease.deviceId, lease.token);
          }
          if (this.killed) return;
          if (receipt?.signal) {
            const { signal: kind, ...rest } = receipt;
            receipt = rest;
            void this.#deliver({
              type: "signal",
              deviceId: lease.deviceId,
              appId: c.appId,
              kind,
            }).catch(() => {});
          }
        }
        directive = await this.#exchange(lease, {
          type: "command.finished",
          commandId: c.id,
          seq: c.seq,
          receipt,
          error,
        });
      } else if (directive.action === "wait") {
        await this.#nap(lease, directive.waitMs);
        if (this.killed) return;
        directive = await this.#exchange(lease, { type: "lease.next" });
      } else if (directive.action === "stop") {
        const evidence = {
          ...(await this.driver.stop?.(ctx())),
          reset: await this.driver.reset?.(ctx(), lease.job.appId),
        };
        directive = await this.#exchange(lease, {
          type: "attempt.stopped",
          evidence,
        });
      } else directive = null; // yield, done, drop
    }
  }
}
