import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../server/store.mjs";
import { register, addJob, claim, control } from "../server/model.mjs";
import { schedulingSnapshot } from "../server/scheduling.mjs";
import { applyStrategy } from "../server/strategy-registry.mjs";
import { configureSimDevice } from "../server/workstation.mjs";
import {
  beginCommand,
  completeCommand,
  simulateCommand,
} from "../server/workflows.mjs";
import { latestCatalog, workstationView } from "../src/workstation-view.mjs";

const now = 1000;
const fixture = () => new MemoryStore(() => now).state;
const device = (s, name, extra = {}) =>
  register(s, now, "sim", { name, rack: "A", ...extra });
const job = (s, key, extra = {}) =>
  addJob(s, now, "sim", { key, definitionId: "sim:xhs.list:1", ...extra });
const snapshot = (s, at = now) => ({
  ...s,
  now: at,
  scheduling: schedulingSnapshot(s, at, "sim"),
});

test("workstation separates planned queues and explicit assignments from claimed execution", () => {
  const s = fixture(),
    a = device(s, "A1"),
    b = device(s, "A2");
  applyStrategy(s, now, "sim", {
    rack: "A",
    revision: 0,
    strategyId: "sim:pool.balanced:1",
  });
  const first = job(s, "soft-first", { rack: "A" });
  const second = job(s, "fixed-second", { deviceId: b.id, rack: "A" });
  const input = snapshot(s);
  const before = structuredClone(input);
  const initial = workstationView(input, "A");
  const soft = initial.queue.find((q) => q.job.id === first.id);
  const fixed = initial.queue.find((q) => q.job.id === second.id);
  assert.equal(soft.binding, "预计分配");
  assert.equal(soft.deviceId, soft.assignment.deviceId);
  assert.equal(
    first.deviceId,
    null,
    "read-only planning must not bind the job",
  );
  assert.equal(fixed.binding, "指定设备");
  assert.equal(fixed.deviceId, b.id);
  assert.equal(initial.metrics.running, 0);
  assert(initial.devices.every((d) => !d.job && !d.attempt));
  assert.deepEqual(input, before, "deriving the UI never mutates source state");
  const execution = claim(s, now, "sim", "view-test-worker");
  assert(execution);
  const next = workstationView(snapshot(s), "A");
  assert.equal(next.metrics.running, 1);
  assert.equal(next.queue.length, 1);
  assert(!next.queue.some((q) => q.job.id === execution.job.id));
  const row = next.devices.find((d) => d.device.id === execution.device.id);
  assert.equal(row.attempt.id, execution.attempt.id);
  assert.equal(row.job.id, execution.job.id);
  assert.equal(row.status, "running");
  assert.equal(next.devicesById.get(a.id).rack, "A");
});

test("pausing new claims keeps the in-flight command and current task visible", () => {
  const s = fixture(),
    d = device(s, "Paused in flight");
  const j = job(s, "active");
  const execution = claim(s, now, "sim", "view-test-worker");
  const command = beginCommand(s, now, execution.attempt);
  control(s, now + 1, "sim", d.id, { action: "pause", revision: d.revision });
  const row = workstationView(snapshot(s, now + 1)).devices[0];
  assert.equal(row.device.enabled, false);
  assert.equal(row.status, "running");
  assert.equal(row.job.id, j.id);
  assert.equal(row.command.id, command.id);
  assert.equal(row.attempt.status, "running");
  assert.equal(row.queue.length, 0);
});

test("yielded checkpoints remain claimed sessions rather than re-entering the central queue", () => {
  const s = fixture();
  device(s, "Checkpoint phone");
  const j = job(s, "long", { definitionId: "sim:xhs.search10:1" });
  const execution = claim(s, now, "sim", "view-test-worker");
  const command = beginCommand(s, now, execution.attempt);
  completeCommand(
    s,
    now + 500,
    execution.attempt,
    command,
    simulateCommand(command),
  );
  const row = workstationView(snapshot(s, now + 500)).devices[0];
  assert.equal(row.attempt.status, "yielded");
  assert.equal(row.status, "running");
  assert.equal(row.job.id, j.id);
  assert.equal(
    row.command,
    undefined,
    "completed commands are historical evidence",
  );
  assert.equal(row.queue.length, 0);
  assert.equal(j.workflow.nextStep, 1);
});

test("one cooling App leaves other apps available; whole-device intervals do not inflate app cooldown counts", () => {
  const s = fixture(),
    d = device(s, "Multi-app");
  const xhs = s.apps.find((a) => a.deviceId === d.id && a.appId === "xhs");
  const weibo = s.apps.find((a) => a.deviceId === d.id && a.appId === "weibo");
  xhs.cooldownUntil = now + 5000;
  let view = workstationView(snapshot(s));
  assert.equal(view.devices[0].status, "idle");
  assert.deepEqual(
    view.devices[0].coolingApps.map((a) => a.appId),
    ["xhs"],
  );
  assert.equal(view.metrics.cooling, 1);
  weibo.cooldownUntil = now + 8000;
  view = workstationView(snapshot(s));
  assert.equal(view.devices[0].status, "cooling");
  assert.equal(view.metrics.cooling, 2);
  xhs.cooldownUntil = 0;
  weibo.cooldownUntil = 0;
  d.cooldownUntil = now + 300;
  view = workstationView(snapshot(s));
  assert.equal(view.devices[0].status, "cooling");
  assert(view.devices[0].apps.every((a) => a.nextAllowedAt === now + 300));
  assert.equal(
    view.metrics.cooling,
    0,
    "device cooldown is distinct from App cooldown",
  );
  assert.equal(
    workstationView(snapshot(s, now + 300)).devices[0].status,
    "idle",
  );
});

test("removed app history is preserved in storage but excluded from current capability and cooling views", () => {
  const s = fixture(),
    d = device(s, "Changing inventory", { simApps: ["xhs", "pdd"] });
  const pdd = s.apps.find((a) => a.deviceId === d.id && a.appId === "pdd");
  pdd.cooldownUntil = now + 50000;
  control(s, now, "sim", d.id, { action: "pause", revision: d.revision });
  configureSimDevice(s, now, "sim", d.id, {
    revision: d.revision,
    simApps: ["xhs", "weibo"],
  });
  assert.equal(s.apps.find((a) => a.id === pdd.id).cooldownUntil, now + 50000);
  const view = workstationView(snapshot(s));
  assert.deepEqual(
    view.devices[0].apps.map((a) => a.appId),
    ["xhs", "weibo"],
  );
  assert.equal(view.metrics.cooling, 0);
  const fallback = workstationView({ ...s, now });
  assert.deepEqual(
    fallback.devices[0].apps.map((a) => a.appId),
    ["xhs", "weibo"],
  );
  assert.equal(fallback.metrics.cooling, 0);
});

test("missing app rows use current inventory instead of treating the only persisted cooling app as the whole phone", () => {
  const s = fixture(),
    d = device(s, "Partial persisted inventory");
  s.apps = s.apps.filter((a) => a.appId !== "weibo");
  s.apps[0].cooldownUntil = now + 5000;
  for (const input of [snapshot(s), { ...s, now }]) {
    const row = workstationView(input).devices[0];
    assert.equal(row.status, "idle");
    assert.deepEqual(
      row.apps.map((a) => a.appId),
      ["xhs", "weibo"],
    );
    assert.equal(row.apps.find((a) => a.appId === "weibo").cooldownUntil, 0);
  }
  assert.equal(s.apps.length, 1, "view fallbacks do not create database rows");
  assert.equal(d.state, "idle");
});

test("rack views include their scoped and fixed tasks plus unassigned global tasks, without stealing another rack's plan", () => {
  const s = fixture(),
    a = device(s, "A phone"),
    b = device(s, "B phone", { rack: "B" });
  const global = job(s, "global");
  const rackA = job(s, "rack-a", { rack: "A" });
  const rackB = job(s, "rack-b", { rack: "B" });
  const fixedA = job(s, "fixed-a", { deviceId: a.id });
  const fixedB = job(s, "fixed-b", { deviceId: b.id });
  const input = snapshot(s);
  const ids = (view) => view.queue.map((q) => q.job.id).sort();
  assert.deepEqual(
    ids(workstationView(input, "A")),
    [global.id, rackA.id, fixedA.id].sort(),
  );
  assert.deepEqual(
    ids(workstationView(input, "B")),
    [global.id, rackB.id, fixedB.id].sort(),
  );
  assert.equal(workstationView(input).queue.length, 5);
  assert.deepEqual(
    workstationView(input, "A").devices.map((r) => r.device.id),
    [a.id],
  );
  input.scheduling.queue.find((q) => q.jobId === global.id).poolAssignment = {
    deviceId: b.id,
    queuePosition: 1,
    startAt: now,
    finishAt: now + 1000,
    reason: "测试预计分配",
  };
  assert.deepEqual(
    ids(workstationView(input, "A")),
    [rackA.id, fixedA.id].sort(),
  );
  assert.equal(
    workstationView(input, "B").queue.find((q) => q.job.id === global.id)
      .binding,
    "预计分配",
  );
  assert.equal(global.deviceId, null);
});

test("held control sessions take precedence over paused claims and keep quarantine and offline states explicit", () => {
  const s = fixture(),
    d = device(s, "Reserved phone");
  d.enabled = false;
  for (const status of ["waiting", "held"]) {
    d.session = { status };
    assert.equal(workstationView(snapshot(s)).devices[0].status, "reserved");
  }
  d.session.status = "released";
  assert.equal(workstationView(snapshot(s)).devices[0].status, "paused");
  d.connected = "offline";
  assert.equal(workstationView(snapshot(s)).devices[0].status, "offline");
  d.state = "quarantined";
  assert.equal(workstationView(snapshot(s)).devices[0].status, "quarantined");
});

test("snapshot time zero and archive tombstones remain authoritative", () => {
  const s = fixture();
  assert.equal(
    workstationView({ ...s, now: 0, scheduling: { at: 1000 } }).now,
    0,
  );
  assert.equal(workstationView({ ...s, scheduling: { at: 0 } }).now, 0);
  const v1 = { code: "pool.example", version: 1, archived: false };
  const tombstone = { code: "pool.example", version: 2, archived: true };
  const restored = { code: "pool.example", version: 3, archived: false };
  assert.deepEqual(latestCatalog([v1, tombstone]), []);
  assert.deepEqual(latestCatalog([restored, v1, tombstone]), [restored]);
});
