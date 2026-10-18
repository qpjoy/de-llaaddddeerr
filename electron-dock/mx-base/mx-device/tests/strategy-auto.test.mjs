// Strategy 2.0: pacing rules, traffic-driven profile switching, shadow evaluation,
// and the account / strategy HTTP surface.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { register, addJob, claim, markDispatch } from "../server/model.mjs";
import { launchWorkstationDemo } from "../server/workstation.mjs";
import {
  saveRule,
  saveStrategy,
  applyStrategy,
  compileStrategyRules,
  resolveStrategy,
  resolveRule,
} from "../server/strategy-registry.mjs";
import { PACING_RULE_DEFAULTS } from "../server/strategy-catalog.mjs";
import {
  configureAutoProfile,
  autoSwitchProfiles,
  rackPressure,
  shadowStrategy,
} from "../server/strategy-auto.mjs";
import { pacingFor } from "../server/ledger.mjs";

const NOW = 2_000_000;
function lab(devices = 2) {
  const s = new MemoryStore().state;
  for (let i = 0; i < devices; i++)
    register(s, NOW, "sim", { name: `d${i}`, rack: "r", host: "h" });
  return s;
}
const queue = (s, count, at = NOW) => {
  for (let i = 0; i < count; i++)
    addJob(s, at, "sim", {
      key: `q${at}-${i}`,
      operation: "search",
      keyword: "k",
      pages: 1,
      rack: "r",
    });
};
const rackRow = (s) => s.loopPolicies.find((p) => p.rack === "r");

test("a pacing rule compiles into the strategy; one per strategy; the paced seed governs bursts", () => {
  const s = lab();
  const rule = saveRule(s, NOW, "sim", {
    code: "pacing.accounts",
    name: "账号预算",
    kind: "pacing",
    expectedVersion: 0,
    config: {
      ...PACING_RULE_DEFAULTS,
      smallLimit: 0, // burst off
      accountMinGapMs: 5000,
      accountDailyCap: 40,
      continuousCapMs: 600000,
      continuousRestMs: 60000,
    },
  });
  assert.equal(rule.kind, "pacing");
  const policy = compileStrategyRules(
    ["placement.adaptive", "queue.bounded", "budget.default", rule.code].map(
      (code) => {
        const definition = resolveRule(s, code);
        return { code, version: definition.version, definition };
      },
    ),
  );
  assert.equal(policy.pacing.burst, null);
  assert.deepEqual(policy.pacing.continuous, { capMs: 600000, restMs: 60000 });
  assert.equal(policy.pacing.account.dailyCap, 40);
  assert.throws(
    () =>
      saveRule(s, NOW, "sim", {
        code: "pacing.bad",
        name: "x",
        kind: "pacing",
        expectedVersion: 0,
        config: {
          ...PACING_RULE_DEFAULTS,
          burstRestMinMs: 9000,
          burstRestMaxMs: 1000,
        },
      }),
    /下限/,
  );
  assert.throws(
    () =>
      saveStrategy(s, NOW, "sim", {
        code: "pool.twice",
        name: "两条节奏",
        expectedVersion: 0,
        rules: [
          { code: "placement.adaptive" },
          { code: "queue.bounded" },
          { code: "budget.default" },
          { code: "pacing.default" },
          { code: rule.code },
        ],
      }),
    /冲突/,
  );
  // The built-in paced strategy moves burst rest from the rack loop to the strategy.
  applyStrategy(s, NOW, "sim", {
    rack: "r",
    revision: 0,
    strategyId: resolveStrategy(s, "pool.paced").id,
  });
  const d = s.devices[0];
  assert.equal(pacingFor(s, d, "xhs").session.burst.source, "strategy");
  assert.equal(pacingFor(s, d, "xhs").session.burst.smallLimit, 3);
});

test("profiles switch by queue pressure with hysteresis, dwell and an hourly cap", () => {
  const s = lab(2);
  const calm = resolveStrategy(s, "pool.balanced").id,
    busy = resolveStrategy(s, "pool.affinity").id;
  applyStrategy(s, NOW, "sim", { rack: "r", revision: 0, strategyId: calm });
  const body = (more = {}) => ({
    rack: "r",
    revision: rackRow(s).revision,
    enabled: true,
    calmStrategyId: calm,
    busyStrategyId: busy,
    enterPressure: 2,
    exitPressure: 0.5,
    minDwellMs: 10000,
    maxSwitchesPerHour: 2,
    ...more,
  });
  assert.throws(
    () => configureAutoProfile(s, NOW, "sim", body({ exitPressure: 3 })),
    /迟滞/,
  );
  assert.throws(
    () => configureAutoProfile(s, NOW, "sim", body({ busyStrategyId: calm })),
    /不能相同/,
  );
  configureAutoProfile(s, NOW, "sim", body());
  assert.equal(rackRow(s).autoProfile.current, "calm");
  queue(s, 5); // pressure 2.5
  assert.equal(rackPressure(s, NOW, "r").pressure, 2.5);
  autoSwitchProfiles(s, NOW + 5000);
  assert.equal(rackRow(s).autoProfile.current, "calm", "dwell not reached");
  autoSwitchProfiles(s, NOW + 10000);
  assert.equal(rackRow(s).autoProfile.current, "busy");
  assert.equal(rackRow(s).strategySnapshot.id, busy);
  assert(s.events.some((e) => e.type === "profile-switch"));
  // Between the thresholds: stay busy (hysteresis).
  for (const j of s.jobs.slice(0, 3)) j.status = "cancelled"; // pressure 1
  autoSwitchProfiles(s, NOW + 30000);
  assert.equal(rackRow(s).autoProfile.current, "busy");
  for (const j of s.jobs) j.status = "cancelled"; // pressure 0
  autoSwitchProfiles(s, NOW + 40000);
  assert.equal(rackRow(s).autoProfile.current, "calm");
  assert.equal(rackRow(s).strategySnapshot.id, calm);
  // Two switches in the last hour: the cap holds the profile.
  queue(s, 6, NOW + 50000);
  autoSwitchProfiles(s, NOW + 60000);
  assert.equal(rackRow(s).autoProfile.current, "calm", "hourly cap");
  autoSwitchProfiles(s, NOW + 3600000 + 20000);
  assert.equal(rackRow(s).autoProfile.current, "busy", "cap window passed");
});

test("shadow evaluation compares current and candidate plans without changing state", () => {
  const s = lab(3);
  applyStrategy(s, NOW, "sim", {
    rack: "r",
    revision: 0,
    strategyId: resolveStrategy(s, "pool.balanced").id,
  });
  queue(s, 8);
  const before = structuredClone(s);
  const result = shadowStrategy(
    s,
    NOW,
    "sim",
    {
      rack: "r",
      strategyId: resolveStrategy(s, "pool.spread").id,
    },
    2,
  );
  assert.deepEqual(s, before);
  assert.equal(result.executorSlots, 2);
  assert.equal(
    result.current.assigned +
      Object.values(result.current.blocked).reduce((a, b) => a + b, 0),
    8,
  );
  assert(result.candidate.waitP95Ms >= 0);
  assert.throws(
    () => shadowStrategy(s, NOW, "real", { rack: "r", strategyId: "x" }),
    { status: 403 },
  );
});

test("sticky plans of the current strategy neither mask shadow results nor outlive a strategy change", () => {
  const s = new MemoryStore().state;
  launchWorkstationDemo(s, NOW, "sim", {
    key: "sticky",
    rack: "r",
    deviceCount: 10,
    scenario: "affinity",
    strategyId: resolveStrategy(s, "pool.paced").id,
  });
  for (let i = 0; i < 4; i++) {
    const work = claim(s, NOW + i, "sim", "w");
    if (work) markDispatch(s, NOW + i, work.attempt);
  }
  const planned = s.jobs.filter((j) => j.status === "queued" && j.poolPlan);
  assert(planned.length, "claims recorded sticky plans");
  const shadow = (code) =>
    shadowStrategy(
      s,
      NOW + 10,
      "sim",
      { rack: "r", strategyId: resolveStrategy(s, code).id },
      10,
    ).candidate;
  const spread = shadow("pool.spread"),
    affinity = shadow("pool.affinity");
  assert.notDeepEqual(
    [spread.startNow, spread.switches],
    [affinity.startNow, affinity.switches],
    "candidates are planned on their own objective",
  );
  applyStrategy(s, NOW + 20, "sim", {
    rack: "r",
    revision: rackRow(s).revision,
    strategyId: resolveStrategy(s, "pool.affinity").id,
  });
  assert.equal(
    s.jobs.filter((j) => j.status === "queued" && j.poolPlan).length,
    0,
    "a new policy replans the rack from scratch",
  );
});

const cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
test("account and strategy 2.0 HTTP: list, restrict, signal, auto profile, shadow", async (t) => {
  const store = new MemoryStore(() => NOW);
  await store.atomic((s, n) => {
    register(s, n, "sim", { name: "d0", rack: "r", host: "h" });
    applyStrategy(s, n, "sim", {
      rack: "r",
      revision: 0,
      strategyId: resolveStrategy(s, "pool.balanced").id,
    });
  });
  const server = createApp({ store, cfg });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, token = cfg.adminToken) => {
    const r = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, value: await r.json() };
  };
  const list = await call("/api/accounts?mode=sim");
  assert.equal(list.status, 200);
  assert.equal(list.value.accounts.length, 2, "xhs and weibo accounts of d0");
  const xhs = list.value.accounts.find((a) => a.appId === "xhs");
  assert.equal(xhs.boundDeviceName, "d0");
  const state = await call("/api/state?mode=sim");
  assert.equal(state.value.accounts, undefined, "not in the polled state");
  assert(state.value.scheduling.devices[0].pacing.apps.length >= 2);
  const limited = await call("/api/account-status?mode=sim", {
    id: xhs.id,
    status: "limited",
    reason: "测试",
    revision: xhs.revision,
  });
  assert.equal(limited.status, 200, JSON.stringify(limited.value));
  assert.equal(limited.value.status, "limited");
  const stale = await call("/api/account-status?mode=sim", {
    id: xhs.id,
    status: "review",
    reason: "测试",
    revision: xhs.revision,
  });
  assert.equal(stale.status, 409);
  const signal = await call("/api/account-signal?mode=sim", {
    id: list.value.accounts.find((a) => a.appId === "weibo").id,
    kind: "captcha",
  });
  assert.equal(signal.value.status, "review");
  const missing = await call("/api/account-status?mode=sim", {
    id: "sim/xhs/none",
    status: "limited",
    reason: "x",
    revision: 1,
  });
  assert.equal(missing.status, 404);
  const loop = (await store.snapshot("sim")).loopPolicies[0];
  const auto = await call("/api/strategy-auto?mode=sim", {
    rack: "r",
    revision: loop.revision,
    enabled: true,
    calmStrategyId: resolveStrategy(store.state, "pool.balanced").id,
    busyStrategyId: resolveStrategy(store.state, "pool.spread").id,
    enterPressure: 1.5,
    exitPressure: 0.5,
    minDwellMs: 30000,
    maxSwitchesPerHour: 4,
  });
  assert.equal(auto.status, 200, JSON.stringify(auto.value));
  assert.equal(auto.value.autoProfile.current, "calm");
  const shadow = await call("/api/strategy-shadow?mode=sim", {
    rack: "r",
    strategyId: resolveStrategy(store.state, "pool.affinity").id,
  });
  assert.equal(shadow.status, 200, JSON.stringify(shadow.value));
  assert(shadow.value.candidate);
  // The simulation-only test token cannot touch the real realm.
  assert.equal(
    (await call("/api/accounts?mode=real", undefined, cfg.testToken)).status,
    403,
  );
  assert.equal(
    (
      await call("/api/strategy-auto?mode=real", {
        rack: "r",
        revision: 1,
        enabled: false,
      })
    ).status,
    403,
  );
});
