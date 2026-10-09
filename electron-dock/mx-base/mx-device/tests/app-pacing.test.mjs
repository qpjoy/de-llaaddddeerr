import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemoryStore } from "../server/store.mjs";
import {
  register,
  addJob,
  claim,
  finish,
  markDispatch,
  control,
  scenario,
} from "../server/model.mjs";
import { configurePacing } from "../server/pacing.mjs";
import { deviceApps } from "../server/apps.mjs";
import { schedulingSnapshot } from "../server/scheduling.mjs";
import { simulatedResult } from "../server/transport.mjs";
import { Engine } from "../server/engine.mjs";

function setup() {
  const s = { devices: [], jobs: [], attempts: [], events: [] };
  const d = register(s, 1000, "sim", { name: "phone" });
  control(s, 1000, "sim", d.id, { revision: d.revision, action: "pause" });
  configurePacing(s, 1000, "sim", d.id, {
    revision: d.revision,
    deviceIntervalMs: 500,
    apps: [
      { appId: "xhs", cooldownMs: 12000 },
      { appId: "weibo", cooldownMs: 6000 },
    ],
  });
  control(s, 1000, "sim", d.id, { revision: d.revision, action: "enable" });
  s.workers = [{ id: "w", role: "device-worker", at: 1000, inflight: 0 }];
  const put = (key, appId = "xhs", priority = 1) =>
    addJob(s, 1000, "sim", {
      key,
      appId,
      operation: "search",
      keyword: key,
      deviceId: d.id,
      priority,
    });
  return { s, d, put };
}

test("one physical slot skips a cooling higher-priority App, and read explanations agree", () => {
  const { s, d, put } = setup();
  const first = put("first"),
    second = put("second"),
    other = put("other", "weibo", 5);
  second.createdAt++;
  const xhs = claim(s, 1001, "sim", "w");
  assert.equal(xhs.job.id, first.id);
  assert.equal(xhs.attempt.appId, "xhs");
  assert.equal(xhs.attempt.accountKey, d.accountKey);
  assert.equal(claim(s, 1002, "sim", "other-worker"), null);
  markDispatch(s, 1003, xhs.attempt);
  finish(s, 2000, xhs.attempt, { result: {} });
  assert.equal(claim(s, 2499, "sim", "w"), null, "global gap blocks both apps");
  const before = structuredClone(s);
  const view = schedulingSnapshot(s, 2500, "sim");
  assert.deepEqual(s, before, "snapshots do not dispatch or mutate cooldowns");
  assert(
    view.queue
      .find((j) => j.jobId === second.id)
      .reasons.some((r) => r.code === "app-cooldown"),
  );
  assert.equal(
    view.queue.find((j) => j.jobId === other.id).status,
    "candidate",
  );
  assert.equal(
    view.devices[0].apps.find((a) => a.appId === "xhs").nextAllowedAt,
    14000,
  );
  const weibo = claim(s, 2500, "sim", "w");
  assert.equal(weibo.job.id, other.id);
  assert.equal(weibo.device.id, xhs.device.id);
  assert.notEqual(weibo.attempt.accountKey, xhs.attempt.accountKey);
  assert.equal(
    schedulingSnapshot(s, 2500, "sim").devices[0].apps.find(
      (a) => a.appId === "weibo",
    ).active,
    true,
  );
  markDispatch(s, 2501, weibo.attempt);
  finish(s, 3000, weibo.attempt, { result: {} });
  assert.equal(claim(s, 13999, "sim", "w"), null);
  assert.equal(claim(s, 14000, "sim", "w").job.id, second.id);
  assert.equal(
    deviceApps(s, d).find((a) => a.appId === "weibo").cooldownUntil,
    9000,
  );
});

test("policy edits preserve deadlines; idle/realm/revision/shape guards and rollback apply", async () => {
  const { s, d, put } = setup();
  put("one");
  const work = claim(s, 1000, "sim", "w");
  const body = () => ({
    revision: d.revision,
    deviceIntervalMs: 0,
    apps: [
      { appId: "xhs", cooldownMs: 0 },
      { appId: "weibo", cooldownMs: 0 },
    ],
  });
  assert.throws(() => configurePacing(s, 1001, "sim", d.id, body()), /暂停/);
  markDispatch(s, 1100, work.attempt);
  finish(s, 2000, work.attempt, { result: {} });
  control(s, 2100, "sim", d.id, { revision: d.revision, action: "pause" });
  configurePacing(s, 2100, "sim", d.id, body());
  assert.equal(d.cooldownUntil, 2500);
  assert.equal(deviceApps(s, d)[0].cooldownUntil, 14000);
  const stricter = body();
  stricter.apps[0].cooldownMs = 20000;
  configurePacing(s, 2200, "sim", d.id, stricter);
  assert.equal(deviceApps(s, d)[0].cooldownUntil, 22000);
  assert.throws(() => configurePacing(s, 2200, "real", d.id, body()), /不存在/);
  assert.throws(
    () => configurePacing(s, 2200, "sim", d.id, { ...body(), revision: 1 }),
    /已更新/,
  );
  const store = new MemoryStore(() => 2300);
  store.state = structuredClone(s);
  delete store.state.workers;
  const before = structuredClone(store.state);
  await assert.rejects(
    store.atomic((s, n) =>
      configurePacing(s, n, "sim", d.id, {
        ...body(),
        apps: [
          { appId: "xhs", cooldownMs: 0 },
          { appId: "xhs", cooldownMs: 1 },
        ],
      }),
    ),
    /全部 App/,
  );
  assert.deepEqual(store.state, before);
});

test("unknown dispatch quarantines the whole phone; late success cannot reset cooldown or slot", () => {
  const { s, d, put } = setup();
  put("one");
  put("other", "weibo", 5);
  const work = claim(s, 1001, "sim", "w");
  markDispatch(s, 1100, work.attempt);
  finish(s, 1200, work.attempt, { error: "lost response" });
  const before = structuredClone(s.apps);
  assert.equal(d.state, "quarantined");
  assert.equal(claim(s, 1300, "sim", "w"), null);
  finish(s, 1400, work.attempt, { result: {} });
  assert.deepEqual(s.apps, before);
  assert.equal(d.state, "quarantined");
  control(s, 200000, "sim", d.id, {
    action: "recover",
    revision: d.revision,
    confirmedStopped: true,
    reason: "simulated stop verified",
  });
  assert.equal(
    s.apps[0].cooldownUntil,
    212000,
    "recovery starts cooldown after verified stop",
  );
  assert.equal(s.apps[0].lastSucceededAt, null);
});

test("app identity preserves legacy idempotency, rejects cross-app dependencies and real Weibo", () => {
  const { s, put } = setup();
  const old = addJob(s, 1000, "sim", {
    key: "old",
    operation: "search",
    keyword: "old",
  });
  assert.equal(
    old.fingerprint,
    createHash("sha256")
      .update(
        JSON.stringify({
          operation: "search",
          input: { keyword: "old", pages: 1 },
          deviceId: null,
          sourceJobId: null,
          priority: 5,
        }),
      )
      .digest("hex"),
  );
  delete old.appId;
  assert.equal(
    addJob(s, 1001, "sim", {
      key: "old",
      appId: "xhs",
      operation: "search",
      keyword: "old",
    }).id,
    old.id,
  );
  assert.throws(
    () =>
      addJob(s, 1001, "sim", {
        key: "old",
        appId: "weibo",
        operation: "search",
        keyword: "old",
      }),
    /幂等/,
  );
  const src = put("source", "weibo");
  assert.throws(
    () =>
      addJob(s, 1001, "sim", {
        key: "bad",
        operation: "note",
        sourceJobId: src.id,
      }),
    /来源 App/,
  );
  assert.throws(
    () =>
      addJob(s, 1001, "real", {
        key: "bad-real",
        appId: "weibo",
        operation: "search",
        keyword: "x",
      }),
    /尚不支持/,
  );
  assert.throws(
    () =>
      addJob(s, 1001, "sim", {
        key: "bad-app",
        appId: ["xhs"],
        operation: "search",
        keyword: "x",
      }),
    /不支持/,
  );
});

test("multiapp demo runs xhs -> weibo -> xhs; cooldown/old attempts survive replay", () => {
  const s = { devices: [], jobs: [], attempts: [], events: [] };
  scenario(s, 1000, "multiapp", "demo");
  const first = claim(s, 1010, "sim", "w");
  finish(s, 2000, first.attempt, { result: {} });
  const other = claim(s, 2300, "sim", "w");
  assert.equal(other.job.appId, "weibo");
  finish(s, 3000, other.attempt, { result: {} });
  assert.equal(claim(s, 13999, "sim", "w"), null);
  const final = claim(s, 14000, "sim", "w");
  assert.equal(final.job.appId, "xhs");
  finish(s, 15000, final.attempt, { result: {} });
  assert.equal(new Set(s.attempts.map((a) => a.deviceId)).size, 1);
  const before = structuredClone(s.apps);
  assert(scenario(s, 16000, "multiapp", "demo").replayed);
  assert.deepEqual(s.apps, before);
  assert.throws(() => scenario(s, 16000, "multiapp", "next"), /仍在冷却/);
});

test("Weibo simulation and dependent detail produce matching evidence without physical I/O", async () => {
  const store = new MemoryStore();
  const src = await store.atomic((s, n) => {
    const d = register(s, n, "sim", { name: "sim" });
    d.taskIntervalMs = 0;
    return addJob(s, n, "sim", {
      key: "search",
      appId: "weibo",
      operation: "search",
      keyword: "demo",
      pages: 2,
    });
  });
  let physicalCalls = 0;
  const physical = async () => {
    physicalCalls++;
    throw Error("physical I/O forbidden");
  };
  const engine = new Engine(store, {
    workerId: "w",
    simDelay: 1,
    call: physical,
    capture: physical,
    inspect: physical,
  });
  const work = await store.atomic((s, n) => claim(s, n, "sim", "w"));
  await engine.execute(work);
  assert.equal(store.state.jobs[0].status, "succeeded");
  assert.equal(store.state.jobs[0].result.pages.length, 2);
  const link = store.state.jobs[0].result.pages[0].items[0].detailInput;
  assert.match(link, /^https:\/\/weibo.com\//);
  await store.atomic((s, n) =>
    addJob(s, n, "sim", {
      key: "detail",
      appId: "weibo",
      operation: "note",
      sourceJobId: src.id,
    }),
  );
  await engine.execute(await store.atomic((s, n) => claim(s, n, "sim", "w")));
  assert.equal(store.state.jobs[1].status, "succeeded");
  assert.equal(store.state.devices[0].projection.appId, "weibo");
  assert.equal(physicalCalls, 0);
  assert.equal(
    simulatedResult("note", { input: link }, 1, "weibo").detail.id,
    "demo11",
  );
});
