// The read-only scheduling index must never change a decision or an explanation:
// every snapshot and every claim equals the unindexed reference computation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  register,
  addJob,
  claim,
  control,
  recordProbe,
  finish,
} from "../server/model.mjs";
import {
  rackScenario,
  addWorkflow,
  beginCommand,
  completeCommand,
  simulateCommand,
} from "../server/workflows.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { configurePacing } from "../server/pacing.mjs";
import { schedulingSnapshot } from "../server/scheduling.mjs";
import { controlResource } from "../server/resources.mjs";
import { BUILTIN_DEFINITIONS } from "../server/workflow-catalog.mjs";

const empty = () => ({
  devices: [],
  jobs: [],
  attempts: [],
  events: [],
  apps: [],
  commands: [],
  resources: [],
  loopPolicies: [],
  definitions: structuredClone(BUILTIN_DEFINITIONS),
  workers: [],
});
const sameSnapshot = (s, now, mode) => {
  s.workers = [
    {
      id: "w",
      role: "device-worker",
      at: now,
      simulationInflight: 3,
      maxSimulationInflight: 10,
      realInflight: 0,
      maxRealInflight: 4,
    },
  ];
  assert.deepEqual(
    schedulingSnapshot(s, now, mode),
    schedulingSnapshot(s, now, mode, { reference: true }),
    `snapshot ${mode} @${now}`,
  );
};

// Loop-policy rests are drawn with randomInt; pin them so both copies stay identical.
const pinRests = (s) => {
  for (const p of s.loopPolicies) p.cooldownMinMs = p.cooldownMaxMs = 6000;
};
// Drives two identical copies: A claims with the index, B with the reference path.
function lockstep(seed, { steps = 400, mode = "sim", check = 7 } = {}) {
  const a = structuredClone(seed),
    b = structuredClone(seed);
  let now = 10000,
    claims = 0;
  const active = [];
  for (let i = 0; i < steps; i++) {
    now += 350;
    if (i % check === 0) sameSnapshot(a, now, mode);
    const wa = claim(a, now, mode, "w"),
      wb = claim(b, now, mode, "w", { reference: true });
    assert.equal(wa?.job.id, wb?.job.id, `claimed job @${now}`);
    assert.equal(wa?.device.id, wb?.device.id, `claimed device @${now}`);
    if (wa) {
      claims++;
      active.push([wa, wb]);
    }
    // Advance one command for the oldest active session on both copies.
    const next = active.shift();
    if (!next) continue;
    const [xa, xb] = next;
    if (!xa.job.workflow) {
      finish(a, now, xa.attempt, { result: { pages: [] } });
      finish(b, now, xb.attempt, { result: { pages: [] } });
      continue;
    }
    const ca = beginCommand(a, now, xa.attempt),
      cb = beginCommand(b, now, xb.attempt);
    assert.equal(!!ca, !!cb);
    if (!ca) continue;
    const ok = completeCommand(
      a,
      now + 100,
      xa.attempt,
      ca,
      simulateCommand(ca),
    );
    assert.equal(
      completeCommand(b, now + 100, xb.attempt, cb, simulateCommand(cb)),
      ok,
    );
    const ja = a.jobs.find((j) => j.id === xa.job.id);
    if (ok && ja.status === "running" && ja.workflow?.loop !== "large")
      active.push(next);
  }
  return { a, b, claims };
}

test("rack lab: insertion checks with the index match the reference at every step", () => {
  const s = empty();
  rackScenario(s, 1000, "idx-lab");
  pinRests(s);
  const { a, b, claims } = lockstep(s, { steps: 600 });
  assert(claims >= 20, `exercised ${claims} claims`);
  assert.deepEqual(
    a.jobs.map((j) => [j.id, j.status]),
    b.jobs.map((j) => [j.id, j.status]),
  );
});

test("pool rack with capacity limits, draining host, cooldowns and capabilities matches the reference", () => {
  const s = empty();
  const now = 1000;
  for (let i = 0; i < 40; i++)
    register(s, now, "sim", {
      name: `P${i}`,
      rack: "池",
      host: `H${i % 4}`,
      simApps: i % 5 ? ["xhs", "weibo", "xianyu", "pdd"] : ["xhs", "weibo"],
      ...(i % 7 === 0
        ? { simCommandCodes: ["app.open", "xhs.note.detail", "weibo.list"] }
        : {}),
    });
  configureLoops(s, now, "sim", {
    rack: "池",
    revision: 0,
    scheduler: { enabled: true },
  });
  pinRests(s);
  controlResource(s, now, "sim", {
    scope: "host",
    rack: "池",
    host: "H1",
    action: "limit",
    revision: 0,
    maxConcurrent: 3,
  });
  controlResource(s, now, "sim", {
    scope: "rack",
    rack: "池",
    action: "limit",
    revision: 0,
    maxConcurrent: 25,
  });
  // A paused device with a longer App cooldown.
  const d = s.devices[3];
  control(s, now, "sim", d.id, { action: "pause", revision: d.revision });
  configurePacing(s, now, "sim", d.id, {
    revision: d.revision,
    deviceIntervalMs: 500,
    apps: ["xhs", "weibo", "xianyu", "pdd"].map((appId) => ({
      appId,
      cooldownMs: appId === "xhs" ? 4000 : 0,
    })),
  });
  control(s, now, "sim", d.id, { action: "enable", revision: d.revision });
  const defs = [
    "sim:xhs.detail:1",
    "sim:weibo.list:1",
    "sim:xianyu.refresh:1",
    "sim:pdd.search_detail_ocr:1",
    "sim:xhs.search10:1",
  ];
  for (let i = 0; i < 120; i++)
    addWorkflow(s, now, "sim", {
      key: `p${i}`,
      definitionId: defs[i % defs.length],
      rack: "池",
      priority: 1 + (i % 9),
      keyword: `k${i}`,
      target: `t${i}`,
    });
  const { claims } = lockstep(s, { steps: 500, check: 5 });
  assert(claims >= 60, `exercised ${claims} claims`);
});

test("draining resources and real devices explain identically", () => {
  const s = empty();
  const now = 1000;
  for (let i = 0; i < 6; i++)
    register(s, now, "sim", { name: `S${i}`, rack: "R", host: `H${i % 2}` });
  controlResource(s, now, "sim", {
    scope: "host",
    rack: "R",
    host: "H0",
    action: "drain",
    revision: 0,
  });
  for (let i = 0; i < 10; i++)
    addJob(s, now, "sim", {
      key: `j${i}`,
      operation: "search",
      keyword: `k${i}`,
      pages: 1 + (i % 3),
      rack: i % 2 ? "R" : undefined,
    });
  const real = register(s, now, "real", {
    name: "真机",
    origin: "http://127.0.0.1:18081",
    workerId: "w",
    accountKey: "acct",
    approved: true,
  });
  recordProbe(s, now, "real", real.id, real.revision, {
    reachable: true,
    idle: true,
  });
  control(s, now, "real", real.id, {
    action: "enable",
    revision: real.revision,
    confirmedExclusive: true,
  });
  addJob(s, now, "real", {
    key: "r1",
    operation: "search",
    keyword: "真",
    pages: 1,
    deviceId: real.id,
  });
  for (const at of [now, now + 31000, now + 400000]) {
    sameSnapshot(s, at, "sim");
    sameSnapshot(s, at, "real");
  }
  lockstep(s, { steps: 60, check: 3 });
});
