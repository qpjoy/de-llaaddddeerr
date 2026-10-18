// Workbench 2.0 view models: lane timeline, flow stages, plan explanations,
// and replay lanes from the virtual-clock comparison.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../server/store.mjs";
import { register, claim, markDispatch, finish } from "../server/model.mjs";
import { addWorkflow } from "../server/workflows.mjs";
import {
  applyStrategy,
  resolveStrategy,
} from "../server/strategy-registry.mjs";
import { schedulingSnapshot } from "../server/scheduling.mjs";
import { planPool, recordPlans } from "../server/pool-planner.mjs";
import { runPoolSimulation } from "../server/pool-simulator.mjs";
import { DEFAULT_POOL_POLICY } from "../server/pool-policy.mjs";
import {
  liveLanes,
  liveTicks,
  lanesAt,
  PAST_MS,
  FUTURE_MS,
} from "../src/timeline-model.mjs";
import { flowModel } from "../src/flow-model.mjs";

const NOW = 5_000_000;
async function rack(devices = 3, jobs = 8) {
  // Jobs arrive two minutes before NOW; snapshots are taken at NOW.
  let clock = NOW - 120000;
  const store = new MemoryStore(() => clock);
  await store.atomic((s, n) => {
    for (let i = 0; i < devices; i++)
      register(s, n, "sim", {
        name: `L${i}`,
        rack: "lanes",
        host: "h",
        simApps: ["xhs", "weibo"],
      });
    applyStrategy(s, n, "sim", {
      rack: "lanes",
      revision: 0,
      strategyId: resolveStrategy(s, "pool.balanced").id,
    });
    for (let i = 0; i < jobs; i++)
      addWorkflow(s, n, "sim", {
        key: `lane-${i}`,
        definitionId: i % 2 ? "sim:xhs.detail:1" : "sim:weibo.list:1",
        rack: "lanes",
        keyword: `k${i}`,
        target: `t${i}`,
      });
  });
  clock = NOW;
  return store;
}
const payload = async (store) => {
  const s = await store.snapshot("sim");
  return { ...s, scheduling: schedulingSnapshot(s, s.now, "sim") };
};

test("lanes show runs, remaining estimates, soft plans, cooldowns and quarantine", async () => {
  const store = await rack();
  // Two sessions start; one earlier session finished; one device is quarantined.
  await store.atomic((s, n) => {
    const first = claim(s, n - 60000, "sim", "w");
    markDispatch(s, n - 60000, first.attempt);
    finish(s, n - 30000, first.attempt, { result: { done: true } });
    const app = s.apps.find(
      (a) => a.deviceId === first.device.id && a.appId === first.job.appId,
    );
    app.cooldownUntil = n + 20000;
    const second = claim(s, n - 500, "sim", "w");
    markDispatch(s, n - 500, second.attempt);
    s.devices[2].state = "quarantined";
    s.devices[2].enabled = false;
  });
  const state = await payload(store);
  const model = liveLanes(state, { now: NOW });
  assert.equal(model.start, NOW - PAST_MS);
  assert.equal(model.end, NOW + FUTURE_MS);
  assert.equal(model.lanes.length, 3);
  const blocks = model.lanes.flatMap((l) => l.blocks);
  const done = blocks.find((b) => b.kind === "run" && b.status === "succeeded");
  assert.equal(done.end, NOW - 30000);
  assert(done.label.includes("·"), "labelled with the task title");
  const running = blocks.find(
    (b) => b.kind === "run" && b.status === "running",
  );
  assert.equal(running.end, NOW);
  assert(blocks.some((b) => b.kind === "remaining" && b.start === NOW));
  const cooling = blocks.find((b) => b.kind === "cooldown");
  assert.equal(
    cooling.start,
    NOW - 30000,
    "from the end of that App's last session",
  );
  assert.equal(cooling.end, NOW + 20000);
  assert(
    blocks.some((b) => b.kind === "plan" && b.start >= NOW),
    "soft plans ahead",
  );
  const quarantined = model.lanes[2].blocks.find(
    (b) => b.kind === "quarantine",
  );
  assert.equal(quarantined.end, model.end);
  // Every block lies inside the window and has positive width.
  for (const b of blocks) {
    assert(b.end > b.start, b.id);
    assert(b.start >= model.start && b.end <= model.end, b.id);
  }
  const ticks = liveTicks(NOW);
  assert.equal(ticks.find((t) => t.at === NOW).label, "现在");
  assert.equal(ticks[0].label, "−2:00");
});

test("flow stages account for every queued job and live session", async () => {
  const store = await rack(3, 8);
  await store.atomic((s, n) => {
    const work = claim(s, n, "sim", "w");
    markDispatch(s, n, work.attempt);
    claim(s, n, "sim", "w"); // claimed, nothing dispatched yet: leased
  });
  const state = await payload(store);
  const flow = flowModel(state, { now: NOW });
  const count = (id) => flow.stages.find((s) => s.id === id).count;
  const queued = state.jobs.filter((j) => j.status === "queued").length;
  assert.equal(count("queued") + count("planned"), queued);
  assert.equal(count("leased"), 1);
  assert.equal(count("running"), 1);
  assert.equal(count("accepted"), 8);
  assert(flow.waitP95Ms >= 0);
});

test("plans explain themselves: alternatives, candidates and a bounded history", async () => {
  const store = await rack(3, 4);
  const s = store.state;
  const plan = planPool(s, NOW, { rack: "lanes" });
  const first = plan.assignments[0];
  assert(first.candidates >= 1);
  assert(first.alternatives.length <= 3);
  for (const alt of first.alternatives) {
    assert.notEqual(alt.deviceId, first.deviceId);
    assert(
      alt.finishAt >= first.finishAt || first.reasonCode !== "earliest-finish",
    );
  }
  recordPlans(s, NOW, [plan]);
  const job = s.jobs.find((j) => j.id === first.jobId);
  assert.equal(job.planHistory.length, 1);
  assert.equal(job.planHistory[0].to, first.deviceId);
  // A different device later appends; history keeps the last six.
  for (let i = 0; i < 8; i++)
    recordPlans(s, NOW + i, [
      {
        assignments: [
          {
            ...first,
            deviceId: s.devices[i % 2 ? 1 : 2].id,
            reason: `r${i}`,
          },
        ],
      },
    ]);
  assert.equal(job.planHistory.length, 6);
});

test("the comparison report carries replay lanes for both strategies", () => {
  const report = runPoolSimulation({
    scenario: "affinity",
    deviceCount: 10,
    seed: 3,
    policy: { ...DEFAULT_POOL_POLICY, enabled: true },
  });
  const sessions = (lanes) => lanes.reduce((n, l) => n + l.blocks.length, 0);
  assert.equal(report.lanes.length, 10);
  assert.equal(sessions(report.lanes), report.summary.completed);
  assert.equal(sessions(report.baselineLanes), report.baseline.completed);
  // As of time t: later sessions hidden, sessions in progress end at t.
  const t = report.summary.makespanMs / 2;
  const at = lanesAt(report.lanes, t).flatMap((l) => l.blocks);
  assert(at.every((b) => b.start <= t && b.end <= t));
  assert(
    at.some((b) => b.status === "running") ||
      at.every((b) => b.status !== "running"),
  );
  assert(
    sessions(report.lanes) >= at.length,
    "never more sessions than the full run",
  );
});
