import test from "node:test";
import assert from "node:assert/strict";
import { register, addJob, claim, finish } from "../server/model.mjs";
import { schedulingSnapshot, compareJobs } from "../server/scheduling.mjs";
import { estimatedDuration, taskLane } from "../server/task-contract.mjs";
const state = () => ({
  devices: [],
  jobs: [],
  attempts: [],
  events: [],
  workers: [{ id: "w", role: "device-worker", at: 1000 }],
});
const put = (s, key, extra = {}) =>
  addJob(s, 1000, "sim", { key, operation: "search", keyword: key, ...extra });

test("default cost is stable and compatible with historical idempotency; overrides are validated", () => {
  const s = state();
  register(s, 1000, "sim", { name: "A" });
  const first = put(s, "one");
  assert.equal(first.estimatedDurationMs, 15000);
  assert.equal(first.executionModel, "exclusive-session.v1");
  assert.equal(put(s, "one", { estimatedDurationMs: 15000 }).id, first.id);
  assert.equal(put(s, "two", { pages: 3 }).estimatedDurationMs, 35000);
  assert.equal(
    put(s, "detail", {
      operation: "note",
      input: "https://www.xiaohongshu.com/explore/demo1",
    }).estimatedDurationMs,
    20000,
  );
  const custom = put(s, "custom", { estimatedDurationMs: 5000 });
  assert.equal(taskLane(custom), "short");
  assert.throws(() => put(s, "custom", { estimatedDurationMs: 6000 }), /幂等/);
  for (const estimatedDurationMs of [0, -1, 999, 180001, NaN, "15000"])
    assert.throws(
      () => put(s, `invalid-${estimatedDurationMs}`, { estimatedDurationMs }),
      /预计执行耗时/,
    );
  assert.equal(
    estimatedDuration({ operation: "search", input: { pages: 2 } }),
    25000,
  );
});

test("priority precedes estimated cost, fresh equal-priority short tasks precede long tasks", () => {
  const s = state();
  register(s, 1000, "sim", { name: "A" });
  const long = put(s, "long", { estimatedDurationMs: 90000 });
  const short = put(s, "short", { estimatedDurationMs: 5000 });
  short.createdAt++;
  const high = put(s, "high", { priority: 1, estimatedDurationMs: 120000 });
  high.createdAt += 2;
  const view = schedulingSnapshot(s, 1010, "sim");
  assert.deepEqual(
    view.queue.map((j) => j.jobId),
    [high.id, short.id, long.id],
  );
  assert.deepEqual(
    view.queue.map((j) => j.lane),
    ["long", "short", "long"],
  );
  const first = claim(s, 1010, "sim", "w");
  assert.equal(first.job.id, high.id);
  assert.equal(first.attempt.estimatedDurationMs, 120000);
  assert.equal(
    claim(s, 1011, "sim", "other"),
    null,
    "short work never preempts an owned session",
  );
  finish(s, 1100, first.attempt, { result: {} });
  assert.equal(claim(s, 1400, "sim", "w").job.id, short.id);
});

test("aging puts waiting long work ahead of fresh short work, including top-priority arrivals", () => {
  const s = state();
  register(s, 1000, "sim", { name: "A" });
  const long = put(s, "old-long", { priority: 2, estimatedDurationMs: 90000 });
  const short = put(s, "new-short", { priority: 1, estimatedDurationMs: 1000 });
  short.createdAt = 31000;
  assert.equal(claim(s, 31000, "sim", "w").job.id, long.id);
  // At equal effective priority all aged jobs remain FIFO, not duration-ranked.
  const rows = [
    { id: "a", priority: 1, createdAt: 1000, estimatedDurationMs: 90000 },
    { id: "b", priority: 1, createdAt: 2000, estimatedDurationMs: 1000 },
    { id: "c", priority: 1, createdAt: 41000, estimatedDurationMs: 500 },
  ];
  assert.deepEqual(
    rows
      .reverse()
      .sort(compareJobs(42000))
      .map((j) => j.id),
    ["a", "b", "c"],
  );
});
