import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../server/store.mjs";
import {
  register,
  addJob,
  claim,
  control,
  sessionAction,
  sweep,
} from "../server/model.mjs";
import {
  rackScenario,
  saveDefinition,
  beginCommand,
  completeCommand,
  simulateCommand,
} from "../server/workflows.mjs";
import { configureLoops, DEFAULT_LOOP_POLICY } from "../server/loop-policy.mjs";
import { BUILTIN_DEFINITIONS } from "../server/workflow-catalog.mjs";
const empty = () => ({
  devices: [],
  jobs: [],
  attempts: [],
  events: [],
  apps: [],
  commands: [],
  definitions: structuredClone(BUILTIN_DEFINITIONS),
});
const submit = (s, n, key, code, extra = {}) =>
  addJob(s, n, "sim", { key, definitionId: `sim:${code}:1`, ...extra });
const doStep = (s, n, w, receipt) => {
  const c = beginCommand(s, n, w.attempt);
  assert(c);
  assert(
    completeCommand(
      s,
      n + 100,
      w.attempt,
      c,
      receipt ? receipt(c) : simulateCommand(c),
    ),
  );
  return c;
};

test("ten slots / twenty heterogeneous jobs finish with bounded insertion, restored pages and no overlapping command", () => {
  const s = empty();
  rackScenario(s, 1000, "rack-run");
  assert.equal(s.devices.length, 10);
  assert.equal(s.jobs.length, 20);
  let now = 1001,
    cycles = 0;
  const active = new Map();
  let peak = 0;
  while (
    s.jobs.some((j) => ["queued", "running"].includes(j.status)) &&
    cycles++ < 2000
  ) {
    let w;
    while ((w = claim(s, now, "sim", "worker"))) {
      assert(!active.has(w.device.id));
      const c = beginCommand(s, now, w.attempt);
      active.set(w.device.id, { w, c, end: now + c.simulationDurationMs });
    }
    peak = Math.max(peak, active.size);
    assert.equal(
      new Set(
        s.commands.filter((c) => c.status === "running").map((c) => c.deviceId),
      ).size,
      active.size,
    );
    now += 200;
    for (const [id, a] of active) {
      if (a.end > now) continue;
      assert(completeCommand(s, now, a.w.attempt, a.c, simulateCommand(a.c)));
      active.delete(id);
      if (a.w.job.workflow.loop === "small" && a.w.job.status === "running") {
        const c = beginCommand(s, now, a.w.attempt);
        active.set(id, { w: a.w, c, end: now + c.simulationDurationMs });
      }
    }
  }
  assert(cycles < 2000);
  assert.equal(peak, 10);
  assert(s.jobs.every((j) => j.status === "succeeded"));
  const big = s.jobs.find((j) => j.key === "rack-run:1");
  assert.equal(big.workflow.insertions, 3);
  assert.equal(big.workflow.nextStep, 12);
  assert.deepEqual(
    big.workflow.receipts.filter((r) => r.page).map((r) => r.page),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert(
    s.commands.some((c) => c.jobId === big.id && c.code === "session.restore"),
  );
  const inserted = new Set(
    s.attempts
      .filter(
        (a) =>
          a.parentAttemptId === s.attempts.find((a) => a.jobId === big.id).id,
      )
      .map((a) => a.jobId),
  );
  const remaining = s.jobs.filter(
    (j) =>
      j.deviceId === big.deviceId &&
      j.workflow.loop === "small" &&
      !inserted.has(j.id),
  );
  assert.equal(remaining.length, 1);
  assert(remaining[0].startedAt >= big.completedAt);
  for (const d of s.devices) {
    const rows = s.commands
      .filter((c) => c.deviceId === d.id)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 1; i < rows.length; i++)
      assert(rows[i].createdAt >= rows[i - 1].completedAt);
  }
  assert(
    s.apps.some(
      (a) => a.rest && a.rest.durationMs >= 4000 && a.rest.durationMs <= 8000,
    ),
  );
  const before = structuredClone(s);
  assert(rackScenario(s, now, "rack-run").replayed);
  assert.deepEqual(s, before);
});

test("immutable definitions bind versions, whitelist commands and reject all real composite submission", () => {
  const s = empty();
  const d = register(s, 1000, "sim", { name: "A" });
  const body = {
    code: "custom.search_ocr",
    name: "搜索和 OCR",
    appId: "xhs",
    loop: "large",
    resumable: true,
    expectedVersion: 0,
    steps: [
      { code: "app.open", repeat: 1 },
      { code: "xhs.search", repeat: 1 },
      { code: "xhs.get_note_detail.ocr", repeat: 1 },
    ],
  };
  const v1 = saveDefinition(s, 1000, "sim", body);
  const j = addJob(s, 1000, "sim", {
    key: "one",
    definitionId: v1.id,
    deviceId: d.id,
  });
  const v2 = saveDefinition(s, 1001, "sim", {
    ...body,
    expectedVersion: 1,
    steps: [...body.steps, { code: "session.home", repeat: 1 }],
  });
  assert.equal(v2.version, 2);
  assert.equal(j.workflow.plan.length, 3);
  assert.equal(
    addJob(s, 1002, "sim", { key: "one", definitionId: v1.id, deviceId: d.id })
      .id,
    j.id,
  );
  assert.throws(
    () =>
      addJob(s, 1002, "sim", {
        key: "one",
        definitionId: v2.id,
        deviceId: d.id,
      }),
    /幂等/,
  );
  assert.throws(
    () =>
      saveDefinition(s, 1000, "sim", {
        ...body,
        code: "unsafe",
        steps: [{ code: "shell.exec", repeat: 1 }],
      }),
    /指令/,
  );
  assert.throws(
    () =>
      saveDefinition(s, 1000, "sim", {
        ...body,
        code: "badnext",
        steps: [
          { code: "app.open", repeat: 1 },
          { code: "xhs.search.next", repeat: 1 },
        ],
      }),
    /搜索/,
  );
  assert.throws(
    () => addJob(s, 1000, "real", { key: "real", definitionId: v1.id }),
    /仅模拟/,
  );
  assert.throws(() => saveDefinition(s, 1000, "real", body), /仅允许模拟/);
});

test("yielded parent survives store replacement; malformed child receipt quarantines parent and cannot resume", async () => {
  let now = 1000;
  let store = new MemoryStore(() => now);
  let d, parent;
  await store.atomic((s, n) => {
    d = register(s, n, "sim", { name: "A", rack: "R" });
    d.taskIntervalMs = 0;
    configureLoops(s, n, "sim", {
      rack: "R",
      revision: 0,
      ...DEFAULT_LOOP_POLICY,
    });
    parent = submit(s, n, "parent", "xhs.search10", {
      deviceId: d.id,
      priority: 1,
    });
    submit(s, n, "child", "weibo.like", { deviceId: d.id });
  });
  for (let i = 0; i < 2; i++) {
    await store.atomic((s, n) => doStep(s, n, claim(s, n, "sim", "w")));
    now += 200;
  }
  const saved = structuredClone(store.state);
  store = new MemoryStore(() => now);
  store.state = saved;
  assert.equal(store.state.attempts[0].status, "yielded");
  const work = await store.atomic((s, n) => claim(s, n, "sim", "replacement"));
  assert.equal(work.job.key, "child");
  await store.atomic((s, n) => {
    const c = beginCommand(s, n, work.attempt);
    const wrong = { ...simulateCommand(c), deviceId: crypto.randomUUID() };
    assert.equal(completeCommand(s, n + 100, work.attempt, c, wrong), false);
  });
  assert.equal(store.state.devices[0].state, "quarantined");
  assert.equal(
    store.state.jobs.find((j) => j.id === parent.id).status,
    "unknown",
  );
  assert(store.state.attempts.every((a) => a.status === "unknown"));
  assert.equal(
    await store.atomic((s, n) => claim(s, n + 100000, "sim", "w")),
    null,
  );
});

test("detour budget prevents insertion; pause drains a checkpointed parent without handing it to a session", () => {
  const s = empty(),
    d = register(s, 1000, "sim", { name: "A", rack: "R" });
  d.taskIntervalMs = 0;
  configureLoops(s, 1000, "sim", {
    rack: "R",
    revision: 0,
    ...DEFAULT_LOOP_POLICY,
    maxDetourMs: 1000,
  });
  const parent = submit(s, 1000, "parent", "xhs.search10", {
    deviceId: d.id,
    priority: 1,
  });
  submit(s, 1000, "child", "weibo.like", { deviceId: d.id });
  doStep(s, 1000, claim(s, 1000, "sim", "w"));
  doStep(s, 1200, claim(s, 1200, "sim", "w"));
  const session = sessionAction(s, 1400, "sim", d.id, {
    action: "acquire",
    revision: d.revision,
    confirmed: true,
  });
  assert.equal(session.device.session.status, "waiting");
  assert.throws(
    () =>
      control(s, 1400, "sim", d.id, {
        action: "disconnect",
        revision: d.revision,
      }),
    /组合/,
  );
  const w = claim(s, 1400, "sim", "w");
  assert.equal(w.job.id, parent.id);
  assert.equal(parent.workflow.insertions, 0);
  for (let i = 0; i < 10; i++) {
    doStep(
      s,
      1600 + i * 200,
      i === 0 ? w : claim(s, 1600 + i * 200, "sim", "w"),
    );
  }
  sweep(s, 4000, "sim");
  assert.equal(d.session.status, "held");
  assert.equal(parent.status, "succeeded");
});

test("unbound small jobs prefer an idle compatible slot; slow simulation cannot underprice insertion", () => {
  const s = empty();
  const a = register(s, 1000, "sim", { name: "A", rack: "R" });
  a.taskIntervalMs = 0;
  const b = register(s, 1000, "sim", { name: "B", rack: "R" });
  b.taskIntervalMs = 0;
  configureLoops(s, 1000, "sim", {
    ...DEFAULT_LOOP_POLICY,
    rack: "R",
    revision: 0,
    maxDetourMs: 6000,
    commandDelayMs: 200,
  });
  const parent = submit(s, 1000, "large", "xhs.search10", {
    deviceId: a.id,
    priority: 1,
  });
  let w = claim(s, 1000, "sim", "w");
  doStep(s, 1000, w);
  w = claim(s, 1100, "sim", "w");
  doStep(s, 1100, w);
  const small = submit(s, 1200, "small", "weibo.list");
  // The parent continues; the unbound request uses the idle device.
  assert.equal(claim(s, 1200, "sim", "w").job.id, parent.id);
  const free = claim(s, 1200, "sim", "w");
  assert.equal(free.job.id, small.id);
  assert.equal(free.device.id, b.id);
  assert.equal(parent.workflow.insertions, 0);
  // A two-command child would take 10s at the selected speed, exceeding 6s.
  doStep(s, 1300, w);
  configureLoops(s, 1400, "sim", {
    ...DEFAULT_LOOP_POLICY,
    rack: "R",
    revision: 1,
    maxDetourMs: 6000,
    commandDelayMs: 5000,
  });
  submit(s, 1400, "bound", "weibo.list", { deviceId: a.id });
  assert.equal(claim(s, 1400, "sim", "w").job.id, parent.id);
  assert.equal(parent.workflow.insertions, 0);
});
