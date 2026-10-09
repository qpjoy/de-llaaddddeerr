import { setTimeout as sleep } from "node:timers/promises";
import {
  claim,
  sweep,
  markDispatch,
  checkpoint,
  finish,
  recordProbe,
} from "./model.mjs";
import {
  callPoC,
  observation,
  simulatedResult,
  validateResult,
} from "./transport.mjs";

export class Engine {
  constructor(
    store,
    {
      workerId = "local-worker",
      instanceId = null,
      call = callPoC,
      simDelay = 2200,
      realDelay = 2000,
    } = {},
  ) {
    this.store = store;
    this.workerId = workerId;
    this.instanceId = instanceId;
    this.call = call;
    this.simDelay = simDelay;
    this.realDelay = realDelay;
    this.inflight = new Map();
    this.stopped = false;
    this.lastError = null;
  }
  async probe(device) {
    if (device.mode !== "real") return;
    let obs;
    try {
      obs = observation(await this.call(device, "state"));
    } catch {
      obs = {
        reachable: false,
        idle: false,
        error: "接口不可达或响应未通过核验",
      };
    }
    return this.store.atomic(
      (s, now) => recordProbe(s, now, "real", device.id, device.revision, obs),
      { mode: "real" },
    );
  }
  async execute({ device, job, attempt: a }) {
    const options = { mode: job.mode, jobId: job.id, attemptId: a.id };
    const atomic = (fn) => this.store.atomic(fn, options);
    try {
      if (job.mode === "real") {
        const body = await this.call(device, "state");
        if (!observation(body).idle) {
          await atomic((s, n) =>
            finish(s, n, a, {
              error: "设备未报告空闲",
              blockedBeforeDispatch: true,
            }),
          );
          return;
        }
      }
      const pages = [],
        count = job.operation === "search" ? job.input.pages : 1;
      for (let p = 1; p <= count; p++) {
        if (!(await atomic((s, n) => markDispatch(s, n, a)))) return;
        const op =
          job.operation === "note" ? "note" : p === 1 ? "search" : "next";
        let result;
        if (job.mode === "sim") {
          await sleep(this.simDelay);
          result = simulatedResult(op, job.input, p);
        } else
          result = validateResult(
            op,
            job.input,
            await this.call(device, op, job.input),
            p,
          );
        if (!(await atomic((s, n) => checkpoint(s, n, a, result)))) {
          await atomic((s, n) =>
            finish(s, n, a, {
              result: { pages: [...pages, result] },
              error: null,
            }),
          );
          return;
        }
        pages.push(result);
        if (job.operation === "note" || result.hasMore === false) break;
        if (p < count) await sleep(job.mode === "real" ? this.realDelay : 300);
      }
      await atomic((s, n) =>
        finish(s, n, a, {
          result:
            job.operation === "note" ? { detail: pages[0].detail } : { pages },
        }),
      );
    } catch {
      await atomic((s, n) =>
        finish(s, n, a, { error: "接口失败或结果未核验；不自动重试" }),
      );
    }
  }
  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.store.heartbeat(this.workerId, {
        role: "device-worker",
        instanceId: this.instanceId,
        real: true,
        lastError: this.lastError,
      });
      if (this.inflight.size < 4) {
        const device = await this.store.atomic(
          (s, n) => {
            const d = s.devices.find(
              (d) =>
                d.mode === "real" &&
                d.workerId === this.workerId &&
                !this.inflight.has(`probe:${d.id}`) &&
                d.state !== "running" &&
                d.probeRequestedAt > (d.probeTakenAt || 0),
            );
            if (!d) return null;
            // Explicit read-only request; a crashed probe needs another click.
            d.probeTakenAt = d.probeRequestedAt;
            d.revision++;
            return d;
          },
          { mode: "real" },
        );
        if (device) {
          const key = `probe:${device.id}`;
          this.inflight.set(
            key,
            this.probe(device)
              .catch(() => {})
              .finally(() => this.inflight.delete(key)),
          );
        }
      }
      for (const mode of ["sim", "real"]) {
        await this.store.atomic((s, n) => sweep(s, n, mode), { mode });
        while (this.inflight.size < 4 && !this.stopped) {
          const work = await this.store.atomic(
            (s, n) => claim(s, n, mode, this.workerId),
            { mode },
          );
          if (!work) break;
          const task = this.execute(work)
            .catch(() => {
              this.lastError = "执行结果保存失败，等待租约核对";
            })
            .finally(() => this.inflight.delete(work.attempt.id));
          this.inflight.set(work.attempt.id, task);
        }
      }
      this.lastError = null;
    } catch {
      this.lastError = "调度存储不可用，未领取新任务";
    } finally {
      this.ticking = false;
    }
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 500);
    this.timer.unref();
    void this.tick();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.ticking) await sleep(20);
    await Promise.allSettled([...this.inflight.values()]);
  }
}
