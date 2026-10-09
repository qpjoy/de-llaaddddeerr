import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { MemoryStore } from "../server/store.mjs";
import {
  register,
  addJob,
  claim,
  control,
  finish,
  scenario,
  recordProbe,
} from "../server/model.mjs";
import { controlResource, updatePlacement } from "../server/resources.mjs";
import {
  deviceBlockers,
  schedulingSnapshot,
  resourcePolicy,
} from "../server/scheduling.mjs";
import { createApp } from "../server/http.mjs";

const state = () => ({
  devices: [],
  jobs: [],
  attempts: [],
  events: [],
  resources: [],
  workers: [{ id: "w", role: "device-worker", at: 1000 }],
});
const phone = (s, name, rack = "R1", host = "H1") =>
  register(s, 1000, "sim", { name, rack, host });
const job = (s, key, extra = {}) =>
  addJob(s, 1000 + s.jobs.length, "sim", {
    key,
    operation: "search",
    keyword: key,
    ...extra,
  });
const policy = (s, action, extra = {}) =>
  controlResource(s, 1000, "sim", {
    scope: "rack",
    rack: "R1",
    revision: 0,
    action,
    ...extra,
  });

test("rack and host limits compose across workers without preempting running work", () => {
  const s = state();
  phone(s, "A");
  phone(s, "B");
  phone(s, "C", "R1", "H2");
  phone(s, "D", "R2", "H3");
  const cap = policy(s, "limit", { maxConcurrent: 2 });
  policy(s, "limit", { scope: "host", host: "H1", maxConcurrent: 1 });
  for (let i = 0; i < 4; i++) job(s, `j${i}`);
  const first = structuredClone(claim(s, 1000, "sim", "w1"));
  const second = structuredClone(claim(s, 1001, "sim", "w2"));
  assert.deepEqual([first.device.name, second.device.name], ["A", "C"]);
  assert(
    deviceBlockers(s, 1002, s.devices[1]).some(
      (r) => r.code === "host-capacity",
    ),
  );
  assert.equal(claim(s, 1002, "sim", "w3").device.name, "D");
  policy(s, "limit", { revision: cap.revision, maxConcurrent: 1 });
  assert.equal(s.attempts.filter((a) => a.status === "running").length, 3);
  finish(s, 1100, first.attempt, { result: {} });
  assert.equal(claim(s, 2000, "sim", "w1"), null);
  finish(s, 2100, second.attempt, { result: {} });
  assert.equal(claim(s, 3000, "sim", "w1").device.name, "A");
});

test("drain preserves attempts and queued jobs, fences new members and does not enable on release", () => {
  const s = state(),
    d = phone(s, "A");
  job(s, "one");
  job(s, "two");
  const work = structuredClone(claim(s, 1000, "sim", "w"));
  const p = policy(s, "drain");
  assert.equal(s.jobs[0].status, "running");
  assert.equal(s.jobs[1].status, "queued");
  assert.equal(phone(s, "B").enabled, false);
  assert.throws(
    () =>
      control(s, 1100, "sim", s.devices[1].id, {
        action: "enable",
        revision: 1,
      }),
    /排空/,
  );
  finish(s, 1200, work.attempt, { result: {} });
  assert.equal(claim(s, 2000, "sim", "w"), null);
  policy(s, "release", { revision: p.revision });
  assert(s.devices.every((d) => !d.enabled));
  assert.equal(claim(s, 2000, "sim", "w"), null);
  control(s, 2100, "sim", d.id, { action: "enable", revision: d.revision });
  assert.equal(claim(s, 2200, "sim", "w").job.key, "two");
});

test("realm, optimistic revisions, input bounds and demo setup cannot bypass draining", () => {
  const s = state();
  phone(s, "A");
  const p = policy(s, "drain");
  assert.throws(() => policy(s, "release"), /已更新/);
  assert.throws(
    () => policy(s, "limit", { revision: p.revision, maxConcurrent: 0 }),
    /上限/,
  );
  assert.throws(
    () => policy(s, "limit", { revision: p.revision, maxConcurrent: 1.5 }),
    /上限/,
  );
  assert.throws(
    () => policy(s, "limit", { revision: p.revision, maxConcurrent: "2" }),
    /上限/,
  );
  assert.throws(() => scenario(s, 1100, "five", "scene"), /排空/);
  const real = register(s, 1000, "real", {
    name: "real",
    rack: "R1",
    host: "H1",
    origin: "http://127.0.0.1:18081",
    workerId: "w",
    accountKey: "a",
    approved: true,
  });
  recordProbe(s, 1000, "real", real.id, real.revision, {
    reachable: true,
    idle: true,
  });
  control(s, 1100, "real", real.id, {
    action: "enable",
    revision: real.revision,
    confirmedExclusive: true,
  });
  addJob(s, 1100, "real", {
    key: "real",
    operation: "search",
    keyword: "x",
    deviceId: real.id,
  });
  assert.equal(claim(s, 1200, "real", "w").device.id, real.id);
  assert.equal(schedulingSnapshot(s, 1200, "sim").counts.total, 2);
  assert.equal(schedulingSnapshot(s, 1200, "real").groups[0].draining, false);
});

test("simulation placement filters, idempotency and diagnostics agree with actual claim", () => {
  const s = state();
  phone(s, "A");
  const b = phone(s, "B", "R2", "H2");
  const placed = job(s, "placed", { rack: "R2", host: "H2" });
  assert.equal(job(s, "placed", { rack: "R2", host: "H2" }).id, placed.id);
  assert.throws(() => job(s, "placed", { rack: "R1" }), /幂等键/);
  assert.throws(
    () => job(s, "bad", { rack: "R1", deviceId: b.id }),
    /调度范围/,
  );
  const before = structuredClone(s);
  const view = schedulingSnapshot(s, 31000, "sim");
  assert.deepEqual(s, before, "read-only diagnostics must not change state");
  // The worker heartbeat is stale, so the read model must not claim readiness.
  assert(view.queue[0].reasons.some((r) => r.code === "worker-unavailable"));
  s.workers[0].at = 31000;
  const fresh = schedulingSnapshot(s, 31000, "sim");
  assert.deepEqual(fresh.queue[0].candidateDeviceIds, [b.id]);
  assert.equal(fresh.queue[0].effectivePriority, 4);
  assert.equal(claim(s, 31000, "sim", "w").device.id, b.id);
});

test("queue explanations distinguish dependency, deferred work, reserved, disabled and observer-only", () => {
  const s = state(),
    d = phone(s, "A");
  const source = job(s, "source"),
    dependent = job(s, "dependent", {
      operation: "note",
      sourceJobId: source.id,
      priority: 1,
    });
  dependent.notBefore = 8000;
  d.session = { status: "held" };
  d.enabled = false;
  let q = schedulingSnapshot(s, 2000, "sim").queue.find(
    (q) => q.jobId === dependent.id,
  );
  assert.deepEqual(
    q.reasons.map((r) => r.code),
    ["not-before", "dependency", "reserved", "paused"],
  );
  source.status = "unknown";
  q = schedulingSnapshot(s, 9000, "sim").queue[0];
  assert(q.reasons.some((r) => r.code === "dependency-failed"));
  const observer = register(s, 1000, "real", {
    name: "observe",
    rack: "R1",
    host: "H1",
    adapter: "mobile-agent",
    serial: "phone",
    origin: "http://127.0.0.1:8787",
    workerId: "w",
    accountKey: "a",
    approved: true,
  });
  const reasons = schedulingSnapshot(s, 2000, "real").devices[0].blockers;
  assert(reasons.some((r) => r.code === "observer-only"));
  assert.equal(schedulingSnapshot(s, 2000, "real").counts.candidates, 0);
  assert.equal(observer.enabled, false);
});

test("placement requires paused idle device and preserves identities, endpoint, policies and pending work", () => {
  const s = state(),
    d = phone(s, "A");
  const j = job(s, "bound", { deviceId: d.id });
  const body = {
    name: "renamed",
    rack: "R2",
    host: "H2",
    revision: d.revision,
  };
  assert.throws(() => updatePlacement(s, 2000, "sim", d.id, body), /先暂停/);
  control(s, 2000, "sim", d.id, { action: "pause", revision: d.revision });
  const identity = {
    id: d.id,
    workerId: d.workerId,
    origin: d.origin,
    resourceKey: d.resourceKey,
    accountKey: d.accountKey,
  };
  const p = policy(s, "drain");
  updatePlacement(s, 2100, "sim", d.id, { ...body, revision: d.revision });
  for (const [key, value] of Object.entries(identity))
    assert.equal(d[key], value);
  assert.equal(j.deviceId, d.id);
  assert.equal(j.status, "queued");
  assert.equal(d.enabled, false);
  assert.equal(resourcePolicy(s, "sim", "rack", "R1").id, p.id);
  assert.equal(phone(s, "replacement", "R1").enabled, false);
});

test("HTTP resources and placement enforce authentication, realm separation, revisions, and pure reads", async (t) => {
  const store = new MemoryStore(),
    cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
  const d = await store.atomic((s, n) =>
    register(s, n, "sim", { name: "A", rack: "R1", host: "H1" }),
  );
  const app = createApp({ store, cfg });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise((r) => app.close(r)));
  const url = `http://127.0.0.1:${app.address().port}`;
  const req = (path, body, token = cfg.adminToken) =>
    fetch(url + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const command = { scope: "rack", rack: "R1", action: "drain", revision: 0 };
  assert.equal((await req("/api/resources/control", command, "")).status, 401);
  assert.equal(
    (await req("/api/resources/control?mode=real", command, cfg.testToken))
      .status,
    403,
  );
  assert.equal((await req("/api/resources/control", command)).status, 200);
  assert.equal((await req("/api/resources/control", command)).status, 409);
  const before = structuredClone(store.state);
  const view = await (await req("/api/state?mode=sim")).json();
  assert.equal(view.scheduling.groups[0].draining, true);
  assert.deepEqual(store.state, before);
  assert.equal(
    (
      await req(
        `/api/devices/${d.id}/placement?mode=real`,
        { revision: 2, name: "B", rack: "R2", host: "H2" },
        cfg.testToken,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await req(`/api/devices/${d.id}/placement`, {
        revision: 1,
        name: "B",
        rack: "R2",
        host: "H2",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await req(`/api/devices/${d.id}/placement`, {
        revision: 2,
        name: "B",
        rack: "R2",
        host: "H2",
      })
    ).status,
    200,
  );
});
