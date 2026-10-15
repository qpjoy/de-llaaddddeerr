// Switch cost, executor capacity, sticky plans and one plan per claim round.
import test from "node:test";
import assert from "node:assert/strict";
import { register, addJob, claim, finish } from "../server/model.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { planPool, recordPlans } from "../server/pool-planner.mjs";
import { placingSlots } from "../server/scheduling.mjs";
import {
  addWorkflow,
  beginCommand,
  completeCommand,
  simulateCommand,
} from "../server/workflows.mjs";

const NOW = 10000;
function rack(count, scheduler = {}) {
  const s = {
    devices: [],
    jobs: [],
    attempts: [],
    events: [],
    apps: [],
    commands: [],
  };
  for (let i = 0; i < count; i++)
    register(s, NOW, "sim", { name: `d${i}`, rack: "r", host: "h" });
  for (const d of s.devices) d.taskIntervalMs = 0;
  configureLoops(s, NOW, "sim", {
    rack: "r",
    revision: 0,
    smallLimit: 100,
    largeLimit: 100,
    cooldownMinMs: 0,
    cooldownMaxMs: 0,
    scheduler,
  });
  return s;
}
const put = (s, key, more = {}, now = NOW) =>
  addJob(s, now, "sim", {
    key,
    keyword: key,
    operation: "search",
    rack: "r",
    estimatedDurationMs: 4000,
    ...more,
  });
const plan = (s, now = NOW, options = {}) =>
  planPool(s, now, { rack: "r", ...options });
const of = (p, job) => p.assignments.find((a) => a.jobId === job.id);
const busy = (s, device, ms) => {
  put(s, `busy-${device.id}`, { deviceId: device.id, estimatedDurationMs: ms });
  return claim(s, NOW, "sim", "w");
};

test("switch cost: a warm busy device wins when it finishes earlier; spreading starts a free one", () => {
  for (const strategy of ["affinity", "spread"]) {
    const s = rack(2, { strategy, switchCostMs: 3000 });
    const [warm, cold] = s.devices;
    busy(s, warm, 2000); // xhs is now warm on d0, busy for 2 s
    const job = put(s, "next");
    const a = of(plan(s), job);
    if (strategy === "affinity") {
      // warm: start +2000, no switch, finish +6000; cold: start 0 + 3000 + 4000 = +7000
      assert.equal(a.deviceId, warm.id);
      assert.equal(a.switchMs, 0);
      assert.equal(a.finishAt, NOW + 6000);
    } else {
      assert.equal(a.deviceId, cold.id, "spread starts now on the free device");
      assert.equal(a.switchMs, 3000);
      assert.equal(a.finishAt, NOW + 7000);
      assert.equal(a.reasonCode, "idle-spread");
    }
  }
  // Without a switch cost the free device finishes first even with affinity rules.
  const s = rack(2, {
    strategy: "affinity",
    switchCostMs: 0,
    maxAffinityDelayMs: 0,
  });
  busy(s, s.devices[0], 2000);
  const next = put(s, "next");
  assert.equal(of(plan(s), next).deviceId, s.devices[1].id);
});

test("executor capacity: plans wait for a free slot across racks and report capacity blocks", () => {
  const s = rack(4, { strategy: "spread", switchCostMs: 0 });
  register(s, NOW, "sim", { name: "other", rack: "other", host: "h" });
  const other = s.devices.at(-1);
  other.taskIntervalMs = 0;
  busy(s, s.devices[0], 5000);
  // A session on another rack holds the second slot until +3000.
  addJob(s, NOW, "sim", {
    key: "elsewhere",
    keyword: "x",
    operation: "search",
    deviceId: other.id,
    estimatedDurationMs: 3000,
  });
  claim(s, NOW, "sim", "w");
  const job = put(s, "next");
  assert.equal(of(plan(s), job).startAt, NOW, "unbounded without slots");
  const limited = of(plan(s, NOW, { executorSlots: 2 }), job);
  assert.equal(limited.startAt, NOW + 3000, "first slot frees at +3000");
  // Slots at least the device count never constrain.
  assert.equal(of(plan(s, NOW, { executorSlots: 5 }), job).startAt, NOW);
  // A slot wait beyond the queue budget keeps the job in the central queue.
  const tight = planPool(s, NOW, {
    rack: "r",
    executorSlots: 2,
    policy: { strategy: "spread", switchCostMs: 0, maxQueueWaitMs: 1000 },
  });
  assert.equal(
    tight.blocked.find((b) => b.jobId === job.id).code,
    "queue-wait-budget",
  );
});

test("placing slots come from the fresh leader heartbeat, or legacy workers", () => {
  const now = 50000;
  const w = (more) => ({ role: "device-worker", at: now, ...more });
  assert.equal(placingSlots({ workers: [] }, now), null);
  assert.equal(
    placingSlots(
      {
        workers: [
          w({ scheduler: "leader", maxSimulationInflight: 7 }),
          w({ scheduler: "standby", maxSimulationInflight: 7 }),
          w({ scheduler: "leader", maxSimulationInflight: 9, at: now - 60000 }),
        ],
      },
      now,
    ),
    7,
  );
  assert.equal(
    placingSlots({ workers: [w({ maxSimulationInflight: 4 })] }, now),
    4,
  );
});

test("sticky plans keep a device unless moving gains enough, freeze before start, and cap moves", () => {
  const s = rack(3, {
    strategy: "spread",
    switchCostMs: 0,
    stickyGainMs: 2000,
    stickyGainPct: 20,
    maxPlanMoves: 1,
    planFreezeMs: 1000,
  });
  const [a, b, c] = s.devices;
  busy(s, a, 20000);
  busy(s, b, 9000);
  busy(s, c, 10000);
  const job = put(s, "j");
  let p = plan(s);
  assert.equal(of(p, job).deviceId, b.id);
  recordPlans(s, NOW, [p]);
  assert.deepEqual(job.poolPlan, { deviceId: b.id, moves: 0, since: NOW });
  // c frees 1.5 s before b: below max(2 s, 20% of 13 s) — stay on b.
  s.attempts.find((x) => x.deviceId === c.id).createdAt -= 2500;
  p = plan(s);
  assert.equal(of(p, job).deviceId, b.id);
  assert.equal(of(p, job).reasonCode, "sticky-gain");
  assert.equal(of(p, job).moved, false);
  // c now frees 6 s earlier: move, counted once.
  s.attempts.find((x) => x.deviceId === c.id).createdAt -= 4500;
  p = plan(s);
  assert.equal(of(p, job).deviceId, c.id);
  assert.equal(of(p, job).moved, true);
  assert.equal(of(p, job).moves, 1);
  recordPlans(s, NOW + 1, [p]);
  assert.equal(job.poolPlan.moves, 1);
  // The move limit is reached: a better device no longer attracts it.
  s.attempts.find((x) => x.deviceId === a.id).createdAt -= 19000;
  p = plan(s);
  assert.equal(of(p, job).deviceId, c.id);
  assert.equal(of(p, job).reasonCode, "sticky-limit");
  // Unchanged plans are not rewritten.
  recordPlans(s, NOW + 2, [p]);
  assert.equal(job.poolPlan.since, NOW + 1);
});

test("a plan about to start is frozen; a device free now or an ineligible plan moves it uncounted", () => {
  const s = rack(3, {
    strategy: "spread",
    switchCostMs: 0,
    planFreezeMs: 1000,
  });
  const [a, b, c] = s.devices;
  busy(s, a, 4500);
  busy(s, b, 4500);
  busy(s, c, 4500);
  const job = put(s, "j");
  job.poolPlan = { deviceId: a.id, moves: 0, since: NOW };
  const age = (device, ms) =>
    (s.attempts.find((x) => x.deviceId === device.id).createdAt -= ms);
  // a frees at +500 (inside the 1 s freeze); b at +200: both are future
  // slots, so the plan stays frozen on a.
  age(a, 4000);
  age(b, 4300);
  let p = plan(s);
  assert.equal(of(p, job).deviceId, a.id);
  assert.equal(of(p, job).reasonCode, "sticky-frozen");
  // c finishes and can start now while a cannot: a soft plan never holds a job back.
  finish(
    s,
    NOW,
    s.attempts.find((x) => x.deviceId === c.id),
    {
      result: { pages: [] },
    },
  );
  p = plan(s);
  assert.equal(of(p, job).deviceId, c.id);
  assert.equal(of(p, job).moved, true);
  assert.equal(of(p, job).forced, true);
  assert.equal(of(p, job).moves, 0, "immediate starts are not counted");
  // a is paused: the plan must move, and the forced move is not counted.
  job.poolPlan = { deviceId: a.id, moves: 0, since: NOW };
  a.enabled = false;
  p = plan(s);
  assert.notEqual(of(p, job).deviceId, a.id);
  assert.equal(of(p, job).forced, true);
  assert.equal(of(p, job).moves, 0);
});

test("claims in one round reuse one plan and still never double-book a device", () => {
  const s = rack(3, { strategy: "spread", switchCostMs: 0 });
  for (let i = 0; i < 5; i++) put(s, `r${i}`);
  const round = {};
  const first = claim(s, NOW, "sim", "w", { round });
  const plans = round.plans;
  assert(plans instanceof Map && plans.size === 1);
  const claimed = [first];
  let work;
  while ((work = claim(s, NOW, "sim", "w", { round }))) claimed.push(work);
  assert.equal(round.plans, plans, "plan computed once per round");
  assert.equal(claimed.length, 3);
  assert.equal(new Set(claimed.map((w) => w.device.id)).size, 3);
  // Queued jobs carry the persisted plan for the next round.
  assert(s.jobs.filter((j) => j.status === "queued").every((j) => j.poolPlan));
});

test("live simulation pays the switch on open and trains timing without it", () => {
  const s = rack(1, { switchCostMs: 2500 });
  const d = s.devices[0];
  let at = NOW;
  // Runs one whole session; returns its first (open) command.
  const session = (key, definitionId) => {
    addWorkflow(s, at, "sim", {
      key,
      definitionId,
      rack: "r",
      keyword: "k",
      target: "t",
    });
    at += 100000;
    const work = claim(s, at, "sim", "w");
    assert(work, `claimed ${key}`);
    let open;
    for (let c; (c = beginCommand(s, at, work.attempt)); ) {
      open ??= c;
      at += 3000;
      assert(completeCommand(s, at, work.attempt, c, simulateCommand(c)));
    }
    assert.equal(s.jobs.find((j) => j.key === key).status, "succeeded");
    return open;
  };
  const first = session("w1", "sim:weibo.list:1");
  assert.equal(first.switchMs, 2500, "nothing in front yet");
  assert.equal(first.simulationDurationMs, 1400 + 2500);
  assert.equal(d.foregroundAppId, "weibo");
  // The trained sample excludes the switch: 3000 elapsed − 2500 switch.
  const key = Object.keys(d.commandTimings).find((k) =>
    k.endsWith("/app.open"),
  );
  assert.equal(d.commandTimings[key].samples[0], 500);
  const warm = session("w2", "sim:weibo.list:1");
  assert.equal(warm.switchMs, undefined, "warm App: no switch");
  assert.equal(warm.simulationDurationMs, 1400);
  const other = session("x1", "sim:xhs.detail:1");
  assert.equal(other.switchMs, 2500, "switching to another App pays again");
  assert.equal(d.foregroundAppId, "xhs");
});
