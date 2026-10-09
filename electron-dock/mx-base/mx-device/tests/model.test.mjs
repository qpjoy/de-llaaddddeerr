import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../server/store.mjs";
import {
  register,
  addJob,
  claim,
  control,
  finish,
  sweep,
  markDispatch,
  checkpoint,
  scenario,
  recordProbe,
  origin,
} from "../server/model.mjs";
import { simulatedResult } from "../server/transport.mjs";
const state = () => ({ devices: [], jobs: [], attempts: [], events: [] });
const sim = (s, name = "A") => register(s, 1000, "sim", { name });
const job = (s, key, extra = {}) =>
  addJob(s, 1000, "sim", {
    key,
    operation: "search",
    keyword: key,
    pages: 1,
    ...extra,
  });
test("single device cannot execute concurrent attempts; different devices can", () => {
  const s = state();
  sim(s);
  job(s, "one");
  job(s, "two");
  const a = claim(s, 1000, "sim", "w");
  assert(a);
  assert.equal(claim(s, 1000, "sim", "w"), null);
  sim(s, "B");
  const b = claim(s, 1001, "sim", "w");
  assert(b);
  assert.notEqual(a.device.id, b.device.id);
});
test("priority is non-preemptive, FIFO tie break, aging prevents low-priority starvation", () => {
  const s = state();
  sim(s);
  const a = job(s, "active", { priority: 1 });
  const first = structuredClone(claim(s, 1000, "sim", "w"));
  const b = job(s, "background", { priority: 8 });
  const c = job(s, "short", {
    priority: 1,
    operation: "note",
    input: "https://www.xiaohongshu.com/explore/test1",
  });
  assert.equal(claim(s, 1200, "sim", "w"), null);
  finish(s, 1500, first.attempt, { result: { pages: [] } });
  assert.equal(claim(s, 1900, "sim", "w").job.id, c.id);
  assert.equal(a.status, "succeeded");
  const last = structuredClone(s.attempts.at(-1));
  finish(s, 2000, last, { result: {} });
  job(s, "later-high", { priority: 1 });
  s.jobs.at(-1).createdAt = 211000;
  assert.equal(claim(s, 212000, "sim", "w").job.id, b.id);
});
test("idempotency accepts exact replay and rejects altered arguments", () => {
  const s = state();
  sim(s);
  const a = job(s, "same");
  assert.equal(job(s, "same").id, a.id);
  assert.throws(() => job(s, "same", { pages: 2 }), /幂等键/);
});
test("sim disconnect keeps job, waits six seconds, migrates and fences late evidence", () => {
  const s = state(),
    a = sim(s),
    b = sim(s, "B");
  const j = job(s, "one");
  const work = structuredClone(claim(s, 1000, "sim", "w"));
  control(s, 1100, "sim", a.id, { action: "disconnect", revision: a.revision });
  assert.equal(j.status, "queued");
  assert.equal(claim(s, 7099, "sim", "w"), null);
  const next = structuredClone(claim(s, 7100, "sim", "w"));
  assert.equal(next.device.id, b.id);
  assert.equal(
    checkpoint(s, 7200, work.attempt, simulatedResult("search", j.input)),
    false,
  );
  finish(s, 7200, work.attempt, { result: { old: true } });
  assert.equal(j.status, "running");
  assert(s.attempts[0].lateEvidence);
  finish(s, 7300, next.attempt, { result: { new: true } });
  assert.deepEqual(j.result, { new: true });
  assert.equal(s.attempts.length, 2);
});
test("expired real execution is unknown, quarantines device and preserves queued jobs", () => {
  const s = state();
  const d = register(s, 1000, "real", {
    name: "phone",
    origin: "http://127.0.0.1:18081",
    workerId: "w",
    accountKey: "account",
    approved: true,
  });
  assert(!d.enabled);
  assert.throws(
    () =>
      control(s, 1000, "real", d.id, {
        action: "enable",
        revision: d.revision,
        confirmedExclusive: true,
      }),
    /空闲/,
  );
  recordProbe(s, 1000, "real", d.id, d.revision, {
    idle: true,
    reachable: true,
  });
  control(s, 1000, "real", d.id, {
    action: "enable",
    revision: d.revision,
    confirmedExclusive: true,
  });
  const args = { operation: "search", keyword: "x", deviceId: d.id };
  addJob(s, 1000, "real", { ...args, key: "1" });
  addJob(s, 1001, "real", { ...args, key: "2" });
  const work = structuredClone(claim(s, 1001, "real", "w"));
  markDispatch(s, 1002, work.attempt);
  sweep(s, 181001, "real");
  assert.equal(s.jobs[0].status, "unknown");
  assert.equal(s.jobs[1].status, "queued");
  assert.equal(d.state, "quarantined");
  assert(!d.enabled);
  assert.equal(claim(s, 200000, "real", "w"), null);
  assert.throws(
    () =>
      control(s, 200000, "real", d.id, {
        action: "disconnect",
        revision: d.revision,
      }),
    /模拟/,
  );
});
test("detail dependency waits for complete search, malformed link cannot poison queue", () => {
  const s = state();
  sim(s);
  const a = job(s, "source");
  const b = job(s, "dependent", {
    operation: "note",
    sourceJobId: a.id,
    priority: 1,
  });
  const w = structuredClone(claim(s, 1000, "sim", "w"));
  assert.equal(w.job.id, a.id);
  finish(s, 1100, w.attempt, {
    result: { pages: [{ items: [{ detailInput: "http://evil.invalid" }] }] },
  });
  assert.equal(claim(s, 1500, "sim", "w"), null);
  assert.equal(b.status, "blocked");
});
test("pause drains without terminating work; scenes and real realms are isolated", () => {
  const s = state(),
    d = sim(s);
  job(s, "one");
  const work = structuredClone(claim(s, 1000, "sim", "w"));
  control(s, 1100, "sim", d.id, { action: "pause", revision: d.revision });
  assert.equal(s.jobs[0].status, "running");
  finish(s, 1200, work.attempt, { result: {} });
  job(s, "two");
  assert.equal(claim(s, 1500, "sim", "w"), null);
  assert.throws(() => scenario(s, 1600, "five", "s1"), /当前演示/);
});
test("memory test store rolls back mutations on error and serializes claims", async () => {
  const store = new MemoryStore(() => 1000);
  await store.atomic((s) => {
    sim(s);
    job(s, "a");
    job(s, "b");
  });
  const result = await Promise.all(
    Array.from({ length: 20 }, () =>
      store.atomic((s, n) => claim(s, n, "sim", "w")),
    ),
  );
  assert.equal(result.filter(Boolean).length, 1);
  await assert.rejects(
    store.atomic((s) => {
      s.jobs = [];
      throw Error("fail");
    }),
  );
  assert.equal(store.state.jobs.length, 2);
});
test("endpoint validation excludes arbitrary targets and aliases", () => {
  for (const value of [
    "http://169.254.169.254",
    "http://localhost:18081",
    "http://127.0.0.1:22",
    "http://127.0.0.1:18081/api",
    "http://user:pass@127.0.0.1:18081",
    "http://127.0.0.1:18081/?url=x",
  ])
    assert.throws(() => origin(value));
  assert.equal(origin("http://127.0.0.1:18081/"), "http://127.0.0.1:18081");
});

test("demo selection is stable and a non-idle explicit probe pauses real dispatch", () => {
  const s = state();
  sim(s, "模拟手机 B");
  sim(s, "模拟手机 A");
  scenario(s, 2000, "five", "ordered");
  assert.equal(claim(s, 2010, "sim", "w").device.name, "模拟手机 A");
  const d = register(s, 2100, "real", {
    name: "phone",
    origin: "http://127.0.0.1:18081",
    workerId: "w",
    accountKey: "a",
    serial: "serial-1",
    approved: true,
  });
  assert.throws(
    () =>
      register(s, 2100, "real", {
        name: "alias",
        origin: "http://127.0.0.1:18082",
        workerId: "w",
        accountKey: "b",
        serial: "serial-1",
        approved: true,
      }),
    /序列号/,
  );
  d.enabled = true;
  recordProbe(s, 2200, "real", d.id, d.revision, {
    reachable: true,
    idle: false,
  });
  assert.equal(d.enabled, false);
});
