import test from "node:test";
import assert from "node:assert/strict";
import {
  register,
  addJob,
  claim,
  finish,
  markDispatch,
} from "../server/model.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { planPool } from "../server/pool-planner.mjs";
import { normalizePoolPolicy } from "../server/pool-policy.mjs";
import { schedulingSnapshot } from "../server/scheduling.mjs";

const NOW = 10000;
function fixture(count = 2, scheduler = {}) {
  const s = {
    devices: [],
    jobs: [],
    attempts: [],
    events: [],
    workers: [{ id: "w", role: "device-worker", at: NOW }],
  };
  for (let i = 0; i < count; i++) {
    const d = register(s, NOW, "sim", {
      name: `slot-${i}`,
      rack: "rack",
      host: "host",
    });
    d.taskIntervalMs = 0;
  }
  configureLoops(s, NOW, "sim", {
    rack: "rack",
    revision: 0,
    smallLimit: 100,
    largeLimit: 100,
    cooldownMinMs: 0,
    cooldownMaxMs: 0,
    // Older cases isolate affinity, budgets and capacity from switch cost;
    // switch cost and plan stability have their own tests below.
    scheduler: { switchCostMs: 0, ...scheduler },
  });
  return s;
}
const put = (s, key, more = {}, now = NOW) =>
  addJob(s, now, "sim", {
    key,
    keyword: key,
    operation: "search",
    rack: "rack",
    estimatedDurationMs: 1000,
    ...more,
  });
const plan = (s, now = NOW) => planPool(s, now, { rack: "rack" });
const xhs = (s, d) =>
  s.apps.find((a) => a.deviceId === d.id && a.appId === "xhs");

test("versioned configuration merges patches and old loop settings preserve scheduler", () => {
  const s = fixture(1, { appPolicies: { xhs: { maxRuns: 8 } } });
  configureLoops(s, NOW, "sim", {
    rack: "rack",
    revision: 1,
    scheduler: {
      appPolicies: { xhs: { cooldownMs: 8000 } },
      maxAffinityDelayMs: 700,
    },
  });
  configureLoops(s, NOW, "sim", {
    rack: "rack",
    revision: 2,
    maxInsertions: 2,
  });
  assert.equal(s.loopPolicies[0].scheduler.appPolicies.xhs.maxRuns, 8);
  assert.equal(s.loopPolicies[0].scheduler.appPolicies.xhs.cooldownMs, 8000);
  assert.equal(s.loopPolicies[0].scheduler.maxAffinityDelayMs, 700);
  for (const invalid of [
    { version: 2 },
    { idleSpreadThresholdPct: 101 },
    { appDefaults: null },
    { appPolicies: [] },
    { unknown: 1 },
    { enabled: "yes" },
  ])
    assert.throws(() => normalizePoolPolicy(invalid), { status: 400 });
  assert.throws(
    () =>
      configureLoops(s, NOW, "sim", {
        rack: "rack",
        revision: 3,
        scheduler: { appPolicies: [] },
      }),
    { status: 400 },
  );
  assert.equal(s.loopPolicies[0].revision, 3);
  assert.throws(
    () =>
      configureLoops(s, NOW, "real", {
        rack: "rack",
        revision: 3,
        scheduler: {},
      }),
    { status: 403 },
  );
});

test("planner is pure, excludes real realm, and running work never becomes a mutable assignment", () => {
  const s = fixture();
  const first = put(s, "running");
  const active = claim(s, NOW, "sim", "w");
  assert.equal(active.job.id, first.id);
  const waiting = put(s, "queued");
  s.devices.push({
    ...s.devices[0],
    id: "real-device",
    mode: "real",
    state: "idle",
  });
  s.jobs.push({ ...waiting, id: "real-job", mode: "real" });
  const before = structuredClone(s);
  const p = plan(s);
  assert.deepEqual(s, before);
  assert.deepEqual(
    p.assignments.map((a) => a.jobId),
    [waiting.id],
  );
  assert.notEqual(p.assignments[0].deviceId, "real-device");
  assert.equal(first.lastDeviceId, active.device.id);
});

test("adaptive idle threshold is task-compatible and recalculates after every soft reservation", () => {
  const s = fixture(4);
  s.devices[2].simApps = ["weibo"];
  s.devices[3].simApps = ["weibo"];
  xhs(s, s.devices[0]).lastClaimedAt = NOW - 100;
  put(s, "a");
  put(s, "b");
  const p = plan(s);
  assert.equal(p.assignments[0].idlePercent, 100);
  assert.equal(p.assignments[0].reasonCode, "idle-spread");
  assert.equal(p.assignments[1].idlePercent, 50);
  assert.equal(p.assignments[1].deviceId, s.devices[0].id);
  assert.equal(p.assignments[1].reasonCode, "bounded-affinity");
  assert.equal(p.assignments[1].startAt, NOW + 1000);
});

test("bounded affinity reserves a busy warm slot and actual claim waits without binding", () => {
  const s = fixture(2, { strategy: "affinity", maxAffinityDelayMs: 3000 });
  const activeJob = put(s, "active", {
    deviceId: s.devices[0].id,
    estimatedDurationMs: 2000,
  });
  const active = claim(s, NOW, "sim", "w");
  const queued = put(s, "next");
  assert.equal(plan(s).assignments[0].deviceId, s.devices[0].id);
  assert.equal(claim(s, NOW, "sim", "w"), null);
  assert.equal(queued.status, "queued");
  assert.equal(queued.lastDeviceId, null);
  s.devices[0].enabled = false;
  assert.equal(plan(s).assignments[0].deviceId, s.devices[1].id);
  const moved = claim(s, NOW, "sim", "w");
  assert.equal(moved.job.id, queued.id);
  assert.equal(moved.device.id, s.devices[1].id);
  assert.equal(activeJob.lastDeviceId, active.device.id);
});

test("warm affinity cannot exceed configured wait advantage", () => {
  const s = fixture(2, { strategy: "affinity", maxAffinityDelayMs: 500 });
  put(s, "active", { deviceId: s.devices[0].id, estimatedDurationMs: 2000 });
  claim(s, NOW, "sim", "w");
  put(s, "next");
  assert.equal(plan(s).assignments[0].deviceId, s.devices[1].id);
});

test("dispatch charges once across replans; completion service enforces rest before next claim", () => {
  const s = fixture(1, {
    appDefaults: { maxRuns: 1, maxServiceMs: 60000, cooldownMs: 5000 },
  });
  put(s, "one");
  put(s, "two");
  const first = claim(s, NOW, "sim", "w");
  markDispatch(s, NOW, first.attempt);
  markDispatch(s, NOW + 100, first.attempt);
  assert.equal(xhs(s, first.device).poolRuns.length, 1);
  for (let n = 0; n < 3; n++) plan(s, NOW + 100);
  assert.equal(xhs(s, first.device).poolRuns.length, 1);
  finish(s, NOW + 2000, first.attempt, { result: {} });
  assert.equal(xhs(s, first.device).poolRuns[0].actualServiceMs, 2000);
  assert.equal(plan(s, NOW + 2000).assignments[0].startAt, NOW + 7000);
  assert.equal(claim(s, NOW + 6999, "sim", "w"), null);
  assert.ok(claim(s, NOW + 7000, "sim", "w"));
});

test("service budget and App cooldown only block that App; estimates larger than a whole budget are rejected", () => {
  const s = fixture(1, { appDefaults: { maxServiceMs: 1500 } });
  put(s, "too-large", { estimatedDurationMs: 2000 });
  const short = put(s, "other", { appId: "weibo" });
  const p = plan(s);
  assert.equal(p.blocked[0].code, "app-service-budget");
  assert.equal(p.assignments[0].jobId, short.id);
  xhs(s, s.devices[0]).cooldownUntil = NOW + 40000;
  put(s, "cooling");
  assert.ok(plan(s).blocked.some((b) => b.code === "queue-wait-budget"));
  assert.equal(claim(s, NOW, "sim", "w").job.id, short.id);
});

test("unfinished budget cannot be forgotten by a zero cooldown or elapsed window", () => {
  const s = fixture(1, {
    appDefaults: { maxRuns: 1, cooldownMs: 0, windowMs: 1000 },
  });
  xhs(s, s.devices[0]).poolRuns = [
    { attemptId: "unknown", at: 1, reservedServiceMs: 1000, finishedAt: null },
  ];
  put(s, "blocked");
  assert.equal(plan(s).blocked[0].code, "app-budget-unresolved");
  assert.equal(claim(s, NOW, "sim", "w"), null);
});

test("whole-session rack capacity, bounded queues, and command capability precede scoring", () => {
  const s = fixture(2, { maxQueuePerDevice: 1 });
  s.resources = [
    {
      mode: "sim",
      rack: "rack",
      scope: "rack",
      resourceKey: JSON.stringify(["rack", "rack"]),
      maxConcurrent: 1,
    },
  ];
  put(s, "a");
  put(s, "b");
  put(s, "c");
  const p = plan(s);
  assert.equal(p.assignments.length, 2);
  assert.ok(p.assignments[1].startAt >= p.assignments[0].finishAt);
  assert.equal(p.blocked[0].code, "queue-limit");
  assert.ok(claim(s, NOW, "sim", "w"));
  assert.equal(claim(s, NOW, "sim", "w"), null);
  const s2 = fixture(2);
  s2.devices[0].simCommandCodes = ["app.open"];
  const j = put(s2, "capability");
  j.workflow = {
    loop: "small",
    definitionId: "test",
    plan: [{ code: "xhs.search" }],
  };
  assert.equal(plan(s2).assignments[0].deviceId, s2.devices[1].id);
});

test("earned cooldown survives disabling, short-window expiry, and a saved policy patch", () => {
  const s = fixture(1, {
    appDefaults: { maxRuns: 1, windowMs: 1000, cooldownMs: 5000 },
  });
  put(s, "first");
  const work = claim(s, NOW, "sim", "w");
  markDispatch(s, NOW, work.attempt);
  finish(s, NOW + 2000, work.attempt, { result: {} });
  const app = xhs(s, s.devices[0]);
  assert.equal(app.poolRestUntil, NOW + 7000);
  const j = put(s, "waiting", {}, NOW + 2000);
  const view = schedulingSnapshot(s, NOW + 2000, "sim");
  assert.equal(view.queue[0].poolAssignment.jobId, j.id);
  assert.equal(view.queue[0].status, "waiting");
  assert.equal(claim(s, NOW + 2000, "sim", "w"), null);
  const ledger = structuredClone(app.poolRuns);
  configureLoops(s, NOW + 2000, "sim", {
    rack: "rack",
    revision: 1,
    scheduler: { enabled: false, appDefaults: { cooldownMs: 0 } },
  });
  assert.deepEqual(app.poolRuns, ledger);
  assert.equal(claim(s, NOW + 6999, "sim", "w"), null);
  assert.ok(claim(s, NOW + 7000, "sim", "w"));
});

test("an unrestricted task stays ready on a legacy rack when another rack's pool cannot admit it", () => {
  const s = fixture(1, { appDefaults: { maxServiceMs: 1000 } });
  const other = register(s, NOW, "sim", { name: "legacy", rack: "legacy" });
  const j = addJob(s, NOW, "sim", {
    key: "unbound",
    operation: "search",
    keyword: "unbound",
    estimatedDurationMs: 2000,
  });
  const view = schedulingSnapshot(s, NOW, "sim").queue.find(
    (x) => x.jobId === j.id,
  );
  assert.equal(view.status, "candidate");
  assert.deepEqual(view.candidateDeviceIds, [other.id]);
  assert.equal(view.poolAssignment, null);
  assert.equal(claim(s, NOW, "sim", "w").device.id, other.id);
});

test("delayed high-priority work does not preoccupy the ready queue and app overrides can be removed", () => {
  const s = fixture(1, { appPolicies: { xhs: { maxRuns: 8 } } });
  const delayed = put(s, "delayed", { priority: 1 });
  delayed.notBefore = NOW + 20000;
  const ready = put(s, "ready");
  assert.equal(plan(s).assignments[0].jobId, ready.id);
  assert.equal(claim(s, NOW, "sim", "w").job.id, ready.id);
  configureLoops(s, NOW, "sim", {
    rack: "rack",
    revision: 1,
    scheduler: { appPolicies: {} },
  });
  assert.deepEqual(s.loopPolicies[0].scheduler.appPolicies, {});
});

test("overdue busy estimates do not indefinitely attract soft queues as if 1ms remained", () => {
  const s = fixture(2, { strategy: "affinity", maxAffinityDelayMs: 500 });
  put(s, "active", { deviceId: s.devices[0].id, estimatedDurationMs: 1000 });
  claim(s, NOW, "sim", "w");
  const queued = put(s, "next", {}, NOW + 2000);
  assert.equal(
    plan(s, NOW + 2000).assignments.find((a) => a.jobId === queued.id).deviceId,
    s.devices[1].id,
  );
});
