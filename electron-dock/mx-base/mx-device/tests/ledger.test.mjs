// Pacing ledger: one module decides and records device, session (device × App)
// and account pacing, with the scope, primitive and source of every deadline.
import test from "node:test";
import assert from "node:assert/strict";
import {
  register,
  addJob,
  claim,
  markDispatch,
  finish,
  control,
} from "../server/model.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { deviceBlockers, schedulingSnapshot } from "../server/scheduling.mjs";
import { appBlockers } from "../server/apps.mjs";
import { pacingFor } from "../server/ledger.mjs";
import { planPool } from "../server/pool-planner.mjs";
import {
  accountId,
  findAccount,
  setAccountStatus,
  recordAccountSignal,
} from "../server/accounts.mjs";

const NOW = 1_000_000;
const state = () => ({
  devices: [],
  jobs: [],
  attempts: [],
  events: [],
  apps: [],
  commands: [],
  loopPolicies: [],
});
function rack(loop = {}, scheduler) {
  const s = state();
  const d = register(s, NOW, "sim", { name: "A", rack: "r", host: "h" });
  d.taskIntervalMs = 0;
  configureLoops(s, NOW, "sim", {
    rack: "r",
    revision: 0,
    smallLimit: 100,
    largeLimit: 100,
    cooldownMinMs: 0,
    cooldownMaxMs: 0,
    ...loop,
    ...(scheduler
      ? { scheduler: { enabled: true, switchCostMs: 0, ...scheduler } }
      : {}),
  });
  return { s, d };
}
let n = 0;
// One whole session of a short search at time `at`, `ms` long; returns its job.
function session(s, at, ms = 1000) {
  const job = addJob(s, at, "sim", {
    key: `k${n++}`,
    operation: "search",
    keyword: "k",
    pages: 1,
    rack: "r",
    estimatedDurationMs: 1000,
  });
  const work = claim(s, at, "sim", "w");
  assert(work, "claimed");
  assert(markDispatch(s, at, work.attempt));
  finish(s, at + ms, work.attempt, { result: { pages: [] } });
  return job;
}
const app = (s, d, id = "xhs") =>
  s.apps.find((a) => a.deviceId === d.id && a.appId === id);

test("device scope: minimum gap and verified stop are reported with their primitive", () => {
  const { s, d } = rack();
  d.taskIntervalMs = 2000;
  session(s, NOW);
  const [gap] = deviceBlockers(s, NOW + 1500, d);
  assert.equal(gap.scope, "device");
  assert.equal(gap.primitive, "minGap");
  assert.equal(gap.until, NOW + 1000 + 2000);
  assert.equal(pacingFor(s, d, "xhs").device.source, "device");
  // Quarantine, then verified recovery protects the device and its used App.
  d.state = "quarantined";
  d.enabled = false;
  app(s, d).cooldownMs = 5000;
  control(s, NOW + 10000, "sim", d.id, {
    action: "recover",
    revision: d.revision,
    confirmedStopped: true,
    reason: "已核验停止",
  });
  assert.equal(
    deviceBlockers(s, NOW + 10001, d).find((b) => b.code === "cooldown")
      .primitive,
    "verifiedStop",
  );
  const [blocked] = appBlockers(s, NOW + 10001, d, { appId: "xhs" });
  assert.equal(blocked.primitive, "verifiedStop");
  assert.equal(blocked.until, NOW + 10000 + 5000);
});

test("session scope: minimum gap, legacy burst rest, strategy burst and window rest", () => {
  // Minimum gap configured on the device App.
  let { s, d } = rack();
  app(s, d).cooldownMs = 4000;
  session(s, NOW);
  let [b] = appBlockers(s, NOW + 2000, d, { appId: "xhs" });
  assert.deepEqual(
    [b.scope, b.primitive, b.until],
    ["session", "minGap", NOW + 5000],
  );

  // Legacy rack loop: one small session earns a fixed 3 s rest.
  ({ s, d } = rack({
    smallLimit: 1,
    cooldownMinMs: 3000,
    cooldownMaxMs: 3000,
  }));
  assert.equal(pacingFor(s, d, "xhs").session.burst.source, "rack-loop");
  session(s, NOW);
  [b] = appBlockers(s, NOW + 1500, d, { appId: "xhs" });
  assert.equal(b.primitive, "burstRest");
  assert.equal(b.until, NOW + 1000 + 3000);

  // A strategy pacing rule supersedes the loop settings (loop allows 100).
  ({ s, d } = rack(
    {},
    {
      pacing: {
        burst: {
          windowMs: 60000,
          smallLimit: 1,
          largeLimit: 1,
          restMinMs: 2000,
          restMaxMs: 2000,
        },
      },
    },
  ));
  assert.equal(pacingFor(s, d, "xhs").session.burst.source, "strategy");
  session(s, NOW);
  assert.equal(app(s, d).rest.source, "strategy");
  [b] = appBlockers(s, NOW + 1500, d, { appId: "xhs" });
  assert.equal(b.primitive, "burstRest");

  // Strategy window budget: one run per window earns a 9 s rest.
  ({ s, d } = rack(
    {},
    {
      appDefaults: {
        windowMs: 60000,
        maxRuns: 1,
        maxServiceMs: 60000,
        cooldownMs: 9000,
      },
    },
  ));
  session(s, NOW);
  [b] = appBlockers(s, NOW + 1500, d, { appId: "xhs" });
  assert.equal(b.primitive, "windowRest");
  assert.equal(b.until, NOW + 1000 + 9000);
});

test("device scope: a continuous-service cap rests the device", () => {
  const { s, d } = rack(
    {},
    { pacing: { continuous: { capMs: 5000, restMs: 7000 } } },
  );
  session(s, NOW, 3000);
  assert.equal(deviceBlockers(s, NOW + 3001, d).length, 0);
  session(s, NOW + 3300, 3000);
  const [rest] = deviceBlockers(s, NOW + 6400, d);
  assert.equal(rest.primitive, "continuousRest");
  assert.equal(rest.until, NOW + 6300 + 7000);
  assert(s.events.some((e) => e.type === "device-rest"));
  // After the rest the streak starts over.
  session(s, NOW + 20000, 1000);
  assert.equal(deviceBlockers(s, NOW + 21001, d).length, 0);
});

test("accounts: charged once per attempt, budgets follow the account, status is hard", () => {
  const { s, d } = rack(
    {},
    {
      pacing: {
        account: {
          minGapMs: 30000,
          windowMs: 60000,
          maxRuns: 0,
          maxServiceMs: 0,
          restMs: 0,
          dailyCap: 2,
        },
      },
    },
  );
  const id = accountId("sim", "xhs", app(s, d).accountKey);
  assert(findAccount(s, d, "xhs"), "account created with the App row");
  session(s, NOW);
  let account = findAccount(s, d, "xhs");
  assert.equal(account.id, id);
  assert.equal(account.totals.sessions, 1);
  assert.equal(account.totals.serviceMs, 1000);
  // The account gap holds the next session though device and App are free.
  const blocked = appBlockers(s, NOW + 5000, d, { appId: "xhs" });
  assert.deepEqual(
    blocked.map((b) => [b.scope, b.code, b.primitive]),
    [["account", "account-cooldown", "minGap"]],
  );
  addJob(s, NOW + 5000, "sim", {
    key: "held",
    operation: "search",
    keyword: "k",
    pages: 1,
    rack: "r",
    estimatedDurationMs: 1000,
  });
  assert.equal(claim(s, NOW + 5000, "sim", "w"), null);
  const planned = planPool(s, NOW + 5000, { rack: "r" }).assignments[0];
  assert.equal(
    planned.startAt,
    NOW + 1000 + 30000,
    "plan waits for the account",
  );
  // Second session after the gap; then the rolling 24 h cap is reached.
  const work = claim(s, NOW + 31000, "sim", "w");
  markDispatch(s, NOW + 31000, work.attempt);
  finish(s, NOW + 32000, work.attempt, { result: { pages: [] } });
  assert(
    appBlockers(s, NOW + 70000, d, { appId: "xhs" }).some(
      (b) => b.code === "account-daily-cap",
    ),
  );
  put(s);
  assert.equal(
    planPool(s, NOW + 70000, { rack: "r" }).blocked[0].code,
    "account-budget",
  );
  // Restricting is immediate; restoring needs a confirmation and keeps backoffs.
  account = findAccount(s, d, "xhs");
  setAccountStatus(s, NOW + 70000, "sim", id, {
    status: "limited",
    reason: "运营手工标记",
    revision: account.revision,
  });
  assert(
    appBlockers(s, NOW + 70000, d, { appId: "xhs" }).some(
      (b) => b.code === "account-limited",
    ),
  );
  assert.throws(
    () =>
      setAccountStatus(s, NOW + 70001, "sim", id, {
        status: "active",
        reason: "x",
        revision: account.revision,
      }),
    /确认/,
  );
  assert.throws(
    () =>
      setAccountStatus(s, NOW + 70001, "sim", id, {
        status: "active",
        reason: "x",
        revision: account.revision - 1,
        confirmed: true,
      }),
    { status: 409 },
  );
});
function put(s) {
  return addJob(s, NOW, "sim", {
    key: `p${n++}`,
    operation: "search",
    keyword: "k",
    pages: 1,
    rack: "r",
    estimatedDurationMs: 1000,
  });
}

test("platform signals put the account under review with exponential backoff that survives restore", () => {
  const { s, d } = rack();
  const id = findAccount(s, d, "xhs").id;
  recordAccountSignal(s, NOW, "sim", id, { kind: "captcha", detail: "滑块" });
  let account = findAccount(s, d, "xhs");
  assert.equal(account.status, "review");
  assert.equal(account.cooldownUntil, NOW + 10 * 60000);
  recordAccountSignal(s, NOW + 1000, "sim", id, { kind: "rate-limited" });
  account = findAccount(s, d, "xhs");
  assert.equal(account.cooldownUntil, NOW + 1000 + 20 * 60000, "doubles");
  assert.equal(account.signals.length, 2);
  assert.throws(
    () => recordAccountSignal(s, NOW, "sim", id, { kind: "rumor" }),
    /未知/,
  );
  setAccountStatus(s, NOW + 2000, "sim", id, {
    status: "active",
    reason: "平台侧已核实",
    revision: account.revision,
    confirmed: true,
  });
  const [backoff] = appBlockers(s, NOW + 3000, d, { appId: "xhs" });
  assert.equal(backoff.code, "account-cooldown");
  assert.equal(backoff.primitive, "signalBackoff");
  // Retired accounts are never restored.
  account = findAccount(s, d, "xhs");
  setAccountStatus(s, NOW + 4000, "sim", id, {
    status: "retired",
    reason: "停用",
    revision: account.revision,
  });
  assert.throws(
    () =>
      setAccountStatus(s, NOW + 5000, "sim", id, {
        status: "active",
        reason: "x",
        revision: findAccount(s, d, "xhs").revision,
        confirmed: true,
      }),
    { status: 409 },
  );
});

test("the read model explains pacing per scope and never creates ledger rows", () => {
  const { s, d } = rack({
    smallLimit: 1,
    cooldownMinMs: 3000,
    cooldownMaxMs: 3000,
  });
  d.taskIntervalMs = 500;
  session(s, NOW);
  s.workers = [{ id: "w", role: "device-worker", at: NOW + 1200 }];
  const before = structuredClone(s);
  const view = schedulingSnapshot(s, NOW + 1200, "sim");
  assert.deepEqual(s, before, "read-only");
  const pacing = view.devices[0].pacing;
  assert.equal(pacing.device.primitive, "minGap");
  assert.equal(pacing.device.until, NOW + 1000 + 500);
  const xhs = pacing.apps.find((a) => a.appId === "xhs");
  assert.equal(xhs.primitive, "burstRest");
  assert.equal(xhs.burst.source, "rack-loop");
  assert.equal(xhs.account.status, "active");
});
