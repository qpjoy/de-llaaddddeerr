import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import { register, claim } from "../server/model.mjs";
import {
  addWorkflow,
  beginCommand,
  completeCommand,
  simulateCommand,
  resumeOwnSession,
  rackScenario,
} from "../server/workflows.mjs";
import { configureLoops } from "../server/loop-policy.mjs";

const poolRack = (s, n) => {
  register(s, n, "sim", { name: "池", rack: "池", host: "H" });
  configureLoops(s, n, "sim", {
    rack: "池",
    revision: 0,
    commandDelayMs: 200,
    cooldownMinMs: 0,
    cooldownMaxMs: 0,
    scheduler: { enabled: true, switchCostMs: 0 },
  });
  return addWorkflow(s, n, "sim", {
    key: "big",
    definitionId: "sim:weibo.search_batch:1",
    rack: "池",
    keyword: "k",
    target: "t",
  });
};
const step = (s, n, work) => {
  const c = beginCommand(s, n, work.attempt);
  assert(completeCommand(s, n + 50, work.attempt, c, simulateCommand(c)));
};

test("a yielded session resumes on its own device when no insertion is possible", () => {
  const s = {
    devices: [],
    jobs: [],
    attempts: [],
    events: [],
    apps: [],
    commands: [],
    loopPolicies: [],
  };
  const job = poolRack(s, 1000);
  const work = structuredClone(claim(s, 1000, "sim", "w"));
  step(s, 1100, work);
  const yielded = s.attempts.find((a) => a.id === work.attempt.id);
  assert.equal(yielded.status, "yielded");
  // The device interval set at dispatch blocks the next step briefly.
  const wait = resumeOwnSession(s, 1200, work.attempt, "w");
  assert(wait.waitUntil > 1200);
  const resumed = resumeOwnSession(s, wait.waitUntil, work.attempt, "w");
  assert.equal(resumed.job.id, job.id);
  assert.equal(resumed.attempt.status, "running");
  assert.equal(
    resumed.attempt.executionGeneration,
    work.attempt.executionGeneration + 1,
  );
  // A stale holder (older generation) cannot resume it again.
  step(s, wait.waitUntil + 10, resumed);
  assert.equal(
    resumeOwnSession(s, wait.waitUntil + 5000, work.attempt, "w"),
    null,
  );
});

test("a session that could host an inserted task is left to the realm scheduler", () => {
  const s = {
    devices: [],
    jobs: [],
    attempts: [],
    events: [],
    apps: [],
    commands: [],
  };
  rackScenario(s, 1000, "lab");
  let now = 1001;
  // Find a resumable large session at a safe checkpoint.
  for (let i = 0; i < 400; i++) {
    now += 400;
    const work = claim(s, now, "sim", "w");
    if (!work) continue;
    step(s, now, work);
    const d = s.devices.find((x) => x.id === work.device.id);
    const a = s.attempts.find((x) => x.id === work.attempt.id);
    const j = s.jobs.find((x) => x.id === work.job.id);
    if (
      a.status === "yielded" &&
      j.workflow.resumable &&
      j.workflow.safePoint &&
      d.enabled
    ) {
      assert.equal(
        resumeOwnSession(s, now + 60000, a, "w"),
        null,
        "insertion is possible, so the realm scheduler decides",
      );
      return;
    }
  }
  assert.fail("no resumable checkpoint reached");
});

test("the engine runs a whole large session in one execution on a pool rack", async () => {
  const store = new MemoryStore();
  const job = await store.atomic((s, n) => poolRack(s, n));
  const work = await store.atomic((s, n) => claim(s, n, "sim", "w"));
  const engine = new Engine(store, { workerId: "w" });
  await engine.execute(work);
  const done = store.state.jobs.find((j) => j.id === job.id);
  assert.equal(done.status, "succeeded");
  assert.equal(done.workflow.nextStep, done.workflow.plan.length);
  assert.equal(
    store.state.commands.filter((c) => c.jobId === job.id).length,
    done.workflow.plan.length,
  );
});
