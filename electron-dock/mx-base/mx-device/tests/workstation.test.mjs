import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { MemoryStore, PgStore } from "../server/store.mjs";
import { register, addJob, claim, control } from "../server/model.mjs";
import {
  beginCommand,
  completeCommand,
  simulateCommand,
} from "../server/workflows.mjs";
import {
  assignQueuedJob,
  cancelQueuedJob,
  configureSimDevice,
  launchWorkstationDemo,
} from "../server/workstation.mjs";

const empty = () => new MemoryStore().state;
const device = (s, name, extra = {}) =>
  register(s, 1000, "sim", { name, rack: "A", ...extra });
const job = (s, key, extra = {}) =>
  addJob(s, 1000, "sim", {
    key,
    definitionId: "sim:xhs.list:1",
    rack: "A",
    ...extra,
  });
const code = (status) => (error) => error.status === status;

test("queued assignments enforce CAS, placement and capability but preserve future cooldown waits", () => {
  const s = empty(),
    a = device(s, "A"),
    b = device(s, "B"),
    c = device(s, "C", { rack: "other" });
  const j = job(s, "assign");
  b.cooldownUntil = 10000;
  s.apps.find(
    (app) => app.deviceId === b.id && app.appId === "xhs",
  ).cooldownUntil = 20000;
  assignQueuedJob(s, 1001, "sim", j.id, { revision: 0, deviceId: b.id });
  assert.equal(j.deviceId, b.id);
  assert.equal(j.revision, 1);
  assert.equal(claim(s, 1001, "sim", "worker"), null);
  assert.throws(
    () =>
      assignQueuedJob(s, 1001, "sim", j.id, { revision: 0, deviceId: a.id }),
    code(409),
  );
  assert.throws(
    () =>
      assignQueuedJob(s, 1001, "sim", j.id, { revision: 1, deviceId: c.id }),
    /范围/,
  );
  assignQueuedJob(s, 1002, "sim", j.id, { revision: 1, deviceId: null });
  assert.deepEqual(j.placement, { rack: "A", host: null });
  assert.equal(j.deviceId, null);
  assignQueuedJob(s, 1002, "sim", j.id, {
    revision: 2,
    deviceId: null,
    clearPlacement: true,
  });
  assert.equal(j.placement, undefined);
  b.enabled = false;
  assert.throws(
    () =>
      assignQueuedJob(s, 1003, "sim", j.id, { revision: 3, deviceId: b.id }),
    /暂停/,
  );
  b.enabled = true;
  b.state = "quarantined";
  assert.throws(
    () =>
      assignQueuedJob(s, 1003, "sim", j.id, { revision: 3, deviceId: b.id }),
    /隔离/,
  );
  b.state = "idle";
  b.simApps = ["pdd"];
  assert.throws(
    () =>
      assignQueuedJob(s, 1003, "sim", j.id, { revision: 3, deviceId: b.id }),
    /不支持/,
  );
  b.simApps = ["xhs"];
  b.simCommandCodes = ["app.open"];
  assert.throws(
    () =>
      assignQueuedJob(s, 1003, "sim", j.id, { revision: 3, deviceId: b.id }),
    /全部指令/,
  );
  assert.throws(
    () =>
      assignQueuedJob(s, 1003, "real", j.id, { revision: 3, deviceId: b.id }),
    code(403),
  );
});

test("claim and assignment serialize in either order; claimed and yielded sessions cannot migrate", async () => {
  for (const assignmentFirst of [true, false]) {
    const store = new MemoryStore(() => 1000);
    const data = await store.atomic((s) => {
      const a = device(s, "A"),
        b = device(s, "B"),
        j = job(s, "race");
      return { a, b, j };
    });
    const assign = () =>
      store.atomic((s, now) =>
        assignQueuedJob(s, now, "sim", data.j.id, {
          revision: 0,
          deviceId: data.b.id,
        }),
      );
    const take = () => store.atomic((s, now) => claim(s, now, "sim", "worker"));
    const results = await Promise.allSettled(
      assignmentFirst ? [assign(), take()] : [take(), assign()],
    );
    const work = results[assignmentFirst ? 1 : 0].value;
    assert.equal(work.device.id, assignmentFirst ? data.b.id : data.a.id);
    assert.equal(
      results[assignmentFirst ? 0 : 1].status,
      assignmentFirst ? "fulfilled" : "rejected",
    );
    assert.equal(store.state.attempts.length, 1);
    await assert.rejects(
      store.atomic((s, now) =>
        cancelQueuedJob(s, now, "sim", data.j.id, {
          revision: assignmentFirst ? 1 : 0,
        }),
      ),
      code(409),
    );
  }
  const s = empty(),
    a = device(s, "A"),
    j = job(s, "long", { definitionId: "sim:xhs.search10:1", deviceId: a.id });
  const work = claim(s, 1001, "sim", "worker"),
    command = beginCommand(s, 1001, work.attempt);
  completeCommand(s, 1002, work.attempt, command, simulateCommand(command));
  assert.equal(work.attempt.status, "yielded");
  assert.throws(
    () =>
      assignQueuedJob(s, 1003, "sim", j.id, { revision: 0, deviceId: null }),
    code(409),
  );
});

test("queued cancellation keeps job, identity and audit; stale and terminal updates fail", () => {
  const s = empty();
  device(s, "A");
  const j = job(s, "cancel");
  const fingerprint = j.fingerprint;
  cancelQueuedJob(s, 1001, "sim", j.id, { revision: 0 });
  assert.equal(s.jobs.length, 1);
  assert.equal(j.status, "cancelled");
  assert.equal(j.fingerprint, fingerprint);
  assert.equal(j.revision, 1);
  assert(
    s.events.some(
      (event) => event.type === "cancelled" && event.jobId === j.id,
    ),
  );
  assert.equal(claim(s, 1002, "sim", "worker"), null);
  assert.throws(
    () => cancelQueuedJob(s, 1002, "sim", j.id, { revision: 1 }),
    code(409),
  );
  assert.throws(
    () =>
      assignQueuedJob(s, 1002, "sim", j.id, { revision: 1, deviceId: null }),
    code(409),
  );
});

test("device capability edits require paused idle state and never strand bound queued tasks or erase app history", () => {
  const s = empty(),
    a = device(s, "A"),
    j = job(s, "bound", { deviceId: a.id });
  assert.throws(
    () =>
      configureSimDevice(s, 1001, "sim", a.id, {
        revision: a.revision,
        simApps: ["pdd"],
      }),
    /暂停/,
  );
  control(s, 1001, "sim", a.id, { revision: a.revision, action: "pause" });
  assert.throws(
    () =>
      configureSimDevice(s, 1002, "sim", a.id, {
        revision: a.revision,
        simApps: ["pdd"],
      }),
    /绑定的排队/,
  );
  assert.throws(
    () =>
      configureSimDevice(s, 1002, "sim", a.id, {
        revision: a.revision,
        simCommandCodes: ["app.open"],
      }),
    /绑定的排队/,
  );
  assignQueuedJob(s, 1002, "sim", j.id, { revision: 0, deviceId: null });
  const oldApp = s.apps.find(
    (app) => app.deviceId === a.id && app.appId === "xhs",
  );
  oldApp.cooldownUntil = 45000;
  oldApp.restHistory = [{ until: 45000 }];
  configureSimDevice(s, 1003, "sim", a.id, {
    revision: a.revision,
    simApps: ["pdd"],
    simCommandCodes: ["pdd.open", "pdd.search"],
  });
  assert.deepEqual(a.simApps, ["pdd"]);
  assert.equal(a.enabled, false);
  assert.equal(oldApp.cooldownUntil, 45000);
  configureSimDevice(s, 1004, "sim", a.id, {
    revision: a.revision,
    simApps: ["xhs", "pdd"],
    simCommandCodes: null,
  });
  assert.equal(a.simCommandCodes, undefined);
  assert.equal(s.apps.find((app) => app.id === oldApp.id).cooldownUntil, 45000);
  a.workflowAttemptId = "reserved";
  assert.throws(
    () =>
      configureSimDevice(s, 1005, "sim", a.id, {
        revision: a.revision,
        simApps: ["pdd"],
      }),
    /保留会话/,
  );
});

test("workstation demo is isolated, replayable after job history pruning, bounded and all-or-nothing", () => {
  const s = empty(),
    existing = device(s, "old");
  job(s, "old-job");
  const before = structuredClone({ device: existing, jobs: s.jobs });
  const spec = {
    key: "new-demo",
    rack: "新演示架",
    deviceCount: 10,
    scenario: "mixed",
  };
  const run = launchWorkstationDemo(s, 2000, "sim", spec);
  assert.equal(run.jobCount, 20);
  assert.equal(run.strategyId, "sim:pool.balanced:1");
  assert.deepEqual(
    s.devices.find((d) => d.id === existing.id),
    before.device,
  );
  assert.deepEqual(
    s.jobs.find((j) => j.key === "old-job"),
    before.jobs[0],
  );
  assert(
    s.jobs
      .filter((j) => j.runId === run.runId)
      .every((j) => j.placement.rack === spec.rack && j.deviceId === null),
  );
  s.devices.reverse();
  s.jobs = s.jobs.filter((j) => j.runId !== run.runId);
  const replayBefore = structuredClone(s);
  assert.equal(launchWorkstationDemo(s, 5000, "sim", spec).replayed, true);
  assert.deepEqual(s, replayBefore);
  assert.throws(
    () => launchWorkstationDemo(s, 5000, "sim", { ...spec, scenario: "burst" }),
    /幂等/,
  );
  assert.throws(
    () => launchWorkstationDemo(s, 5000, "sim", { ...spec, key: "different" }),
    /独立机架/,
  );
  assert.throws(() => launchWorkstationDemo(s, 5000, "real", spec), code(403));
  assert.throws(
    () =>
      launchWorkstationDemo(s, 5000, "sim", {
        ...spec,
        key: "new",
        rack: "overflow",
        deviceCount: 100,
      }),
    code(429),
  );
  const broken = empty();
  broken.definitions.find((d) => d.code === "xhs.search10").archived = true;
  const failedBefore = structuredClone(broken);
  assert.throws(
    () => launchWorkstationDemo(broken, 1000, "sim", spec),
    /已归档/,
  );
  assert.deepEqual(broken, failedBefore);
});

test("supported live scenarios use actual workflow queue, App cooldowns, delayed arrivals and bounded sizes", () => {
  for (const scenario of ["mixed", "affinity", "cooldown", "burst"]) {
    const s = empty();
    const run = launchWorkstationDemo(s, 1000, "sim", {
      key: scenario,
      rack: scenario,
      deviceCount: 2,
      scenario,
    });
    assert.equal(run.jobCount, scenario === "burst" ? 12 : 4);
    assert.equal(s.loopPolicies[0].strategySnapshot.id, "sim:pool.balanced:1");
    if (scenario === "affinity")
      assert.equal(s.jobs.filter((j) => j.notBefore === 2500).length, 2);
    if (scenario === "cooldown") {
      assert(s.apps.every((app) => app.cooldownMs === 3000));
      assert.equal(
        s.apps.filter((app) => app.cooldownUntil === 6000).length,
        1,
      );
    }
  }
  for (const count of [20, 50, 100]) {
    const s = empty();
    const run = launchWorkstationDemo(s, 1000, "sim", {
      key: `size-${count}`,
      rack: `size-${count}`,
      deviceCount: count,
      scenario: "burst",
    });
    assert.equal(s.devices.length, count);
    assert.equal(run.jobCount, Math.min(count * 6, 200));
  }
});

test("an App cooldown leaves other Apps eligible while manual binding cannot bypass cooling", () => {
  const s = empty(),
    a = device(s, "A"),
    xhs = job(s, "cool-xhs"),
    weibo = job(s, "warm-weibo", { definitionId: "sim:weibo.list:1" });
  s.apps.find(
    (app) => app.deviceId === a.id && app.appId === "xhs",
  ).cooldownUntil = 30000;
  assignQueuedJob(s, 1001, "sim", xhs.id, { revision: 0, deviceId: a.id });
  const work = claim(s, 1001, "sim", "worker");
  assert.equal(work.job.id, weibo.id);
  assert.equal(xhs.status, "queued");
  const next = job(s, "behind-running");
  assignQueuedJob(s, 1002, "sim", next.id, { revision: 0, deviceId: a.id });
  assert.equal(claim(s, 1002, "sim", "worker"), null);
  assert.equal(s.attempts.length, 1);
});

test("global unrelated tasks do not consume independent demo devices or appear in their plan", async () => {
  const { planPool } = await import("../server/pool-planner.mjs");
  const s = empty(),
    old = device(s, "old");
  old.enabled = false;
  const unrelated = job(s, "global-old", { rack: undefined });
  const run = launchWorkstationDemo(s, 2000, "sim", {
    key: "separate",
    rack: "separate",
    deviceCount: 2,
    scenario: "mixed",
  });
  const plan = planPool(s, 2000, { rack: run.rack });
  assert(!plan.assignments.some((a) => a.jobId === unrelated.id));
  const work = claim(s, 2000, "sim", "worker");
  assert.equal(work.job.runId, run.runId);
  assert.equal(unrelated.status, "queued");
});

test("live demo finishes with exclusive per-device command streams and real receipt-driven projections", () => {
  const s = empty();
  launchWorkstationDemo(s, 1000, "sim", {
    key: "execute",
    rack: "execute",
    deviceCount: 10,
    scenario: "mixed",
  });
  let now = 1000,
    cycles = 0,
    peak = 0;
  const commands = new Map();
  while (
    s.jobs.some((j) => ["queued", "running"].includes(j.status)) &&
    cycles++ < 3000
  ) {
    let work;
    while ((work = claim(s, now, "sim", "worker"))) {
      assert(
        !commands.has(work.device.id),
        "a device cannot run concurrent command streams",
      );
      const c = beginCommand(s, now, work.attempt);
      commands.set(work.device.id, {
        work,
        c,
        end: now + c.simulationDurationMs,
      });
    }
    peak = Math.max(peak, commands.size);
    now += 200;
    for (const [id, active] of commands) {
      if (now < active.end) continue;
      assert(
        completeCommand(
          s,
          now,
          active.work.attempt,
          active.c,
          simulateCommand(active.c),
        ),
      );
      commands.delete(id);
      if (
        active.work.job.status === "running" &&
        active.work.job.workflow.loop === "small"
      ) {
        const c = beginCommand(s, now, active.work.attempt);
        commands.set(id, {
          work: active.work,
          c,
          end: now + c.simulationDurationMs,
        });
      }
    }
  }
  assert(cycles < 3000);
  assert(peak > 1);
  assert(s.jobs.every((j) => j.status === "succeeded"));
  assert(s.devices.some((d) => d.projection));
  for (const d of s.devices) {
    const rows = s.commands
      .filter((c) => c.deviceId === d.id)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 1; i < rows.length; i++)
      assert(rows[i].createdAt >= rows[i - 1].completedAt);
  }
});

const databaseUrl = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres workstation claim races, capability history and demo replay survive restart",
  { skip: !databaseUrl },
  async () => {
    const target = new URL(databaseUrl);
    assert(["127.0.0.1", "localhost"].includes(target.hostname));
    const database = `mx_workstation_${randomBytes(5).toString("hex")}`;
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    target.pathname = `/${database}`;
    let a = new PgStore(target.href),
      b = new PgStore(target.href);
    try {
      await a.migrate();
      const spec = {
        key: "durable-demo",
        rack: "持久机架",
        deviceCount: 2,
        scenario: "mixed",
      };
      const run = await a.atomic((s, now) =>
        launchWorkstationDemo(s, now, "sim", spec),
      );
      const snapshot = await a.snapshot("sim");
      const first = snapshot.jobs[0],
        targetDevice = snapshot.devices[0];
      const results = await Promise.allSettled([
        a.atomic(
          (s, now) =>
            assignQueuedJob(s, now, "sim", first.id, {
              revision: 0,
              deviceId: targetDevice.id,
            }),
          { jobId: first.id },
        ),
        b.atomic((s, now) => claim(s, now, "sim", "worker")),
      ]);
      assert(results.some((r) => r.status === "fulfilled"));
      if (results[0].status === "rejected")
        assert.equal(results[0].reason.status, 409);
      const after = await a.snapshot("sim");
      assert.equal(
        new Set(
          after.attempts
            .filter((row) => row.status === "running")
            .map((row) => row.deviceId),
        ).size,
        after.attempts.filter((row) => row.status === "running").length,
      );
      const edited = await a.atomic((s, now) => {
        const d = register(s, now, "sim", {
          name: "能力持久化",
          rack: "能力编辑架",
        });
        control(s, now, "sim", d.id, { revision: d.revision, action: "pause" });
        const app = s.apps.find(
          (app) => app.deviceId === d.id && app.appId === "xhs",
        );
        app.cooldownUntil = now + 45000;
        configureSimDevice(s, now, "sim", d.id, {
          revision: d.revision,
          simApps: ["pdd"],
        });
        return {
          deviceId: d.id,
          appId: app.id,
          cooldownUntil: app.cooldownUntil,
        };
      });
      await a.close();
      a = new PgStore(target.href);
      const replay = await a.atomic((s, now) =>
        launchWorkstationDemo(s, now, "sim", spec),
      );
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.jobIds, run.jobIds);
      const restarted = await a.snapshot("sim");
      assert.equal(restarted.devices.length, 3);
      assert.deepEqual(
        restarted.devices.find((d) => d.id === edited.deviceId).simApps,
        ["pdd"],
      );
      assert.equal(
        restarted.apps.find((app) => app.id === edited.appId).cooldownUntil,
        edited.cooldownUntil,
      );
    } finally {
      await a.close();
      await b.close();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    }
  },
);
