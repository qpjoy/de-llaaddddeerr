import {
  beginCommand,
  completeCommand,
  simulateCommand,
  cleanWorkflowFaults,
  resumeOwnSession,
} from "./workflows.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  claim,
  sweep,
  markDispatch,
  checkpoint,
  finish,
  recordProbe,
  claimCapture,
  completeCapture,
  claimInspection,
  completeInspection,
} from "./model.mjs";
import { captureMobile } from "./mobile-agent.mjs";
import { eventRetention } from "./retention.mjs";
import { inspectMobile } from "./mobile-status.mjs";
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
      capture = captureMobile,
      inspect = inspectMobile,
      retention = eventRetention(),
      pruneEveryMs = 600000,
      // Optional Leadership: without it this engine is the only scheduler.
      leadership = null,
      maxSimulationInflight = 10,
      maxRealInflight = 4,
    } = {},
  ) {
    this.store = store;
    this.workerId = workerId;
    this.instanceId = instanceId;
    this.call = call;
    this.simDelay = simDelay;
    this.realDelay = realDelay;
    this.capture = capture;
    this.inspect = inspect;
    this.retention = retention;
    this.pruneEveryMs = pruneEveryMs;
    this.lastPruneAt = 0;
    this.lastPrune = null;
    this.pruning = null;
    this.leadership = leadership;
    this.maxSimulationInflight = maxSimulationInflight;
    this.maxRealInflight = maxRealInflight;
    this.epoch = null;
    this.again = null;
    this.pendingModes = new Set();
    this.wakeModes = new Set();
    this.inflight = new Map();
    this.simulationInflight = new Set();
    this.stopped = false;
    this.lastError = null;
  }
  // Per-device execution: row-scoped transactions, no realm lock.
  #attempt(job, a) {
    const options = {
      mode: job.mode,
      jobId: job.id,
      attemptId: a.id,
      deviceId: a.deviceId,
      scope: "attempt",
    };
    return (fn) => this.store.atomic(fn, options);
  }
  async probe(device) {
    if (
      device.mode !== "real" ||
      device.pocDisabled ||
      device.adapter === "mobile-agent"
    )
      return;
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
      { mode: "real", scope: "device", deviceId: device.id },
    );
  }
  async observe(device) {
    try {
      const frame = await this.capture(device);
      await this.store.atomic((s, n) => completeCapture(s, n, device, frame), {
        mode: "real",
        scope: "device",
        deviceId: device.id,
        frame: {
          ...frame,
          deviceId: device.id,
          captureId: device.capture.id,
          version: device.observer.version,
        },
      });
    } catch {
      await this.store.atomic(
        (s, n) => completeCapture(s, n, device, null, true),
        { mode: "real", scope: "device", deviceId: device.id },
      );
    }
  }
  async executeWorkflow({ job, attempt }) {
    let a = attempt;
    const atomic = this.#attempt(job, a);
    try {
      while (true) {
        const command = await atomic((s, n) => beginCommand(s, n, a));
        if (!command) return;
        await sleep(command.simulationDurationMs);
        const ok = await atomic((s, n) =>
          completeCommand(s, n, a, command, simulateCommand(command)),
        );
        if (!ok || command.stepIndex + 1 >= job.workflow.plan.length) return;
        if (job.workflow.loop !== "large") continue;
        // A large session yields at each checkpoint. Continue it here unless a
        // small task could be inserted; then the realm scheduler decides.
        const resumed = await this.#resume(atomic, a);
        if (!resumed) return;
        a = resumed.attempt;
      }
    } catch {
      await atomic((s, n) => {
        finish(s, n, a, { error: "组合指令执行或回执异常，隔离设备" });
        cleanWorkflowFaults(s, n);
      });
    }
  }
  async #resume(atomic, a) {
    for (let waits = 0; waits < 50 && !this.stopped; waits++) {
      const result = await atomic((s, n) =>
        resumeOwnSession(s, n, a, this.workerId),
      );
      if (!result?.waitUntil) return result;
      await sleep(Math.min(5000, Math.max(10, result.waitUntil - Date.now())));
    }
    return null;
  }
  async execute({ device, job, attempt: a }) {
    if (job.workflow) return this.executeWorkflow({ device, job, attempt: a });
    const atomic = this.#attempt(job, a);
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
          result = simulatedResult(op, job.input, p, job.appId);
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
  async inspectDevice(device) {
    let report = null;
    try {
      report = await this.inspect(device);
    } catch {
      /* Keep upstream errors/private config out of state. */
    }
    return this.store.atomic(
      (s, n) => completeInspection(s, n, device, report),
      { mode: "real", scope: "device", deviceId: device.id },
    );
  }
  get realInflight() {
    return this.inflight.size - this.simulationInflight.size;
  }
  /** full: leadership, heartbeat, retention, real observation requests and
   * dispatch (the periodic scan). Otherwise only dispatch for the given realms
   * (an early wake-up after a notification or a finished execution). */
  async tick(full = true, modes = ["sim", "real"]) {
    if (this.stopped) return;
    if (this.ticking) {
      this.again = full || this.again === "full" ? "full" : "dispatch";
      for (const mode of modes) this.pendingModes.add(mode);
      return;
    }
    this.ticking = true;
    try {
      if (full) await this.#scan();
      await this.#dispatch(modes, !this.leadership || this.epoch != null);
      this.lastError = null;
    } catch {
      this.lastError = "调度存储不可用，未领取新任务";
    } finally {
      this.ticking = false;
      const again = this.again;
      this.again = null;
      if (again === "full") void this.tick();
      else if (again) this.wake(...this.pendingModes);
      if (again) this.pendingModes.clear();
    }
  }
  async #scan() {
    this.epoch = this.leadership ? await this.leadership.check() : null;
    const leader = !this.leadership || this.epoch != null;
    await this.store.heartbeat(this.workerId, {
      role: "device-worker",
      instanceId: this.instanceId,
      real: true,
      scheduler: leader ? "leader" : "standby",
      epoch: this.epoch,
      lastError: this.lastError,
      inflight: this.inflight.size,
      maxInflight: this.maxSimulationInflight + this.maxRealInflight,
      // A standby places no simulation work, so it reports no spare capacity.
      simulationInflight: leader
        ? this.simulationInflight.size
        : this.maxSimulationInflight,
      maxSimulationInflight: this.maxSimulationInflight,
      realInflight: this.realInflight,
      maxRealInflight: this.maxRealInflight,
      eventPrune: this.lastPrune,
    });
    this.prune();
    if (this.realInflight < this.maxRealInflight) {
      const device = await this.store.atomic(
        (s, n) => {
          const d = s.devices.find(
            (d) =>
              d.mode === "real" &&
              d.adapter !== "mobile-agent" &&
              d.pocDisabled !== true &&
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
    // At most one observation per worker, leaving capacity for normal tasks.
    if (
      this.realInflight < this.maxRealInflight &&
      !this.inflight.has("observation")
    ) {
      const device = await this.store.atomic(
        (s, n) => claimCapture(s, n, this.workerId),
        { mode: "real" },
      );
      if (device)
        this.inflight.set(
          "observation",
          this.observe(device)
            .catch(() => {})
            .finally(() => this.inflight.delete("observation")),
        );
    }
    if (
      this.realInflight < this.maxRealInflight &&
      !this.inflight.has("inspection")
    ) {
      const device = await this.store.atomic(
        (s, n) => claimInspection(s, n, this.workerId),
        { mode: "real" },
      );
      if (device)
        this.inflight.set(
          "inspection",
          this.inspectDevice(device)
            .catch(() => {})
            .finally(() => this.inflight.delete("inspection")),
        );
    }
  }
  async #dispatch(modes, leader) {
    for (const mode of modes) {
      // Simulation placement belongs to the single active scheduler (epoch
      // fenced). Real devices stay with the worker on their host.
      if (mode === "sim" && !leader) continue;
      const free =
        mode === "sim"
          ? this.maxSimulationInflight - this.simulationInflight.size
          : this.maxRealInflight - this.realInflight;
      let works;
      try {
        // One realm transaction per round: sweep, then claim up to free slots.
        works = await this.store.atomic(
          (s, n) => {
            sweep(s, n, mode);
            const out = [];
            while (out.length < free) {
              const work = claim(s, n, mode, this.workerId);
              if (!work) break;
              out.push(work);
            }
            return out;
          },
          { mode, epoch: mode === "sim" ? this.epoch : null },
        );
      } catch (error) {
        if (error.code !== "MXLEADER") throw error;
        this.leadership?.lost();
        continue;
      }
      if (this.stopped) break;
      for (const work of works) this.#run(work, mode);
    }
  }
  #run(work, mode) {
    const task = this.execute(work)
      .catch(() => {
        this.lastError = "执行结果保存失败，等待租约核对";
      })
      .finally(() => {
        if (this.inflight.get(work.attempt.id) === task) {
          this.inflight.delete(work.attempt.id);
          this.simulationInflight.delete(work.attempt.id);
        }
        // A device just freed up or a session yielded: schedule now, not next scan.
        this.wake(mode);
      });
    this.inflight.set(work.attempt.id, task);
    if (mode === "sim") this.simulationInflight.add(work.attempt.id);
  }
  // Debounced early dispatch (work notification, finished execution).
  wake(...modes) {
    if (this.stopped) return;
    for (const mode of modes.length ? modes : ["sim", "real"])
      if (["sim", "real"].includes(mode)) this.wakeModes.add(mode);
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      const modes = [...this.wakeModes];
      this.wakeModes.clear();
      void this.tick(false, modes);
    }, 50);
    this.wakeTimer.unref?.();
  }
  // Event retention runs beside the scan loop and never delays claims.
  prune() {
    if (
      this.pruning ||
      !this.store.pruneEvents ||
      Date.now() - this.lastPruneAt < this.pruneEveryMs
    )
      return;
    this.lastPruneAt = Date.now();
    this.pruning = this.store
      .pruneEvents(this.retention)
      .then(
        (deleted) => {
          this.lastPrune = { at: Date.now(), deleted };
        },
        () => {
          this.lastPrune = {
            at: Date.now(),
            error: "事件清理失败，下个周期重试",
          };
        },
      )
      .finally(() => {
        this.pruning = null;
      });
  }
  start() {
    this.leadership?.on("work", (mode) => this.wake(mode));
    this.timer = setInterval(() => void this.tick(), 500);
    this.timer.unref();
    void this.tick();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.wakeTimer);
    while (this.ticking) await sleep(20);
    await this.pruning;
    await Promise.allSettled([...this.inflight.values()]);
    await this.leadership?.close();
  }
}
