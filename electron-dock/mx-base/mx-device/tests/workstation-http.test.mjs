import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { claim } from "../server/model.mjs";

const cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
async function fixture(t) {
  const store = new MemoryStore(() => 1770000000000);
  const server = createApp({ store, cfg });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, options = {}) => {
    const r = await fetch(base + path, {
      method: options.method || (body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${options.token ?? cfg.adminToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, value: await r.json() };
  };
  return { store, request };
}
const ruleBody = {
  code: "placement.http",
  name: "API 分配规则",
  kind: "placement",
  expectedVersion: 0,
  config: {
    strategy: "adaptive",
    idleSpreadThresholdPct: 65,
    maxAffinityDelayMs: 2000,
  },
};
const strategyBody = {
  code: "pool.http",
  name: "API 策略",
  expectedVersion: 0,
  rules: [
    { code: ruleBody.code },
    { code: "queue.bounded" },
    { code: "budget.default" },
  ],
};

test("strategy and rule HTTP CRUD freeze rule versions, retain history and apply explicit rack defaults", async (t) => {
  const { store, request } = await fixture(t);
  const created = await request("/api/rule-definitions", ruleBody);
  assert.equal(created.status, 201, JSON.stringify(created.value));
  const strategy = await request("/api/strategy-definitions", strategyBody);
  assert.equal(strategy.status, 201, JSON.stringify(strategy.value));
  const changed = await request("/api/rule-definitions", {
    ...ruleBody,
    expectedVersion: 1,
    config: { ...ruleBody.config, idleSpreadThresholdPct: 80 },
  });
  assert.equal(changed.status, 201);
  assert.equal((await request("/api/rule-definitions", ruleBody)).status, 409);
  const d = await request("/api/devices", {
    name: "A",
    rack: "new",
    defaultStrategyId: strategy.value.id,
  });
  assert.equal(d.status, 201, JSON.stringify(d.value));
  assert.equal(
    store.state.loopPolicies[0].strategySnapshot.id,
    strategy.value.id,
  );
  assert.equal(
    store.state.loopPolicies[0].scheduler.idleSpreadThresholdPct,
    65,
  );
  assert.equal(
    (
      await request("/api/devices", {
        name: "B",
        rack: "new",
        defaultStrategyId: "sim:pool.spread:1",
      })
    ).status,
    201,
  );
  assert.equal(
    store.state.loopPolicies[0].strategySnapshot.id,
    strategy.value.id,
  );
  const applied = await request("/api/strategy-apply", {
    rack: "new",
    revision: 1,
    strategyId: "sim:pool.spread:1",
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal(applied.value.strategySnapshot.code, "pool.spread");
  assert.equal(
    (
      await request("/api/strategy-apply", {
        rack: "new",
        revision: 1,
        strategyId: "sim:pool.balanced:1",
      })
    ).status,
    409,
  );
  const ruleArchive = await request(
    `/api/rule-definitions/${encodeURIComponent(changed.value.id)}`,
    { expectedVersion: 2 },
    { method: "DELETE" },
  );
  assert.equal(ruleArchive.status, 200);
  const archive = await request(
    `/api/strategy-definitions/${encodeURIComponent(strategy.value.id)}`,
    { expectedVersion: 1 },
    { method: "DELETE" },
  );
  assert.equal(archive.status, 200);
  const rows = (await request("/api/strategy-definitions")).value;
  assert(!rows.strategies.some((r) => r.code === strategyBody.code));
  assert.equal(
    rows.history.filter((r) => r.code === strategyBody.code).length,
    2,
  );
  assert.equal(
    rows.ruleHistory.filter((r) => r.code === ruleBody.code).length,
    3,
  );
  assert.equal(
    (
      await request("/api/rule-definitions", {
        ...ruleBody,
        expectedVersion: 3,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await request("/api/strategy-definitions", {
        ...strategyBody,
        expectedVersion: 2,
      })
    ).status,
    201,
  );
  assert.equal(
    store.state.loopPolicies[0].strategySnapshot.code,
    "pool.spread",
  );
});

test("workstation HTTP assignment, cancellation and paused device capability edits use revisions", async (t) => {
  const { store, request } = await fixture(t);
  const run = await request("/api/workstation-demo", {
    key: "http-demo",
    rack: "API 机架",
    deviceCount: 2,
    scenario: "mixed",
  });
  assert.equal(run.status, 202, JSON.stringify(run.value));
  assert.equal(
    (
      await request("/api/workstation-demo", {
        key: "http-demo",
        rack: "API 机架",
        deviceCount: 2,
        scenario: "mixed",
      })
    ).value.replayed,
    true,
  );
  const [a, b] = store.state.devices,
    [first, second] = store.state.jobs;
  assert.equal(
    (
      await request(`/api/jobs/${first.id}/assignment`, {
        revision: 0,
        deviceId: b.id,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/jobs/${first.id}/assignment`, {
        revision: 0,
        deviceId: a.id,
      })
    ).status,
    409,
  );
  assert.equal(
    (await request(`/api/jobs/${second.id}/queue-cancel`, { revision: 0 }))
      .status,
    200,
  );
  assert.equal(
    store.state.jobs.find((j) => j.id === second.id).status,
    "cancelled",
  );
  const work = await store.atomic((s, now) => claim(s, now, "sim", "worker"));
  assert(work);
  assert.equal(
    (
      await request(`/api/jobs/${work.job.id}/assignment`, {
        revision: work.job.revision || 0,
        deviceId: null,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/api/jobs/${work.job.id}/queue-cancel`, {
        revision: work.job.revision || 0,
      })
    ).status,
    409,
  );
  const d = await request("/api/devices", {
    name: "编辑能力",
    rack: "独立编辑",
  });
  assert.equal(
    (
      await request(`/api/devices/${d.value.id}/sim-capabilities`, {
        revision: d.value.revision,
        simApps: ["pdd"],
      })
    ).status,
    409,
  );
  const paused = await request(`/api/devices/${d.value.id}/control`, {
    revision: d.value.revision,
    action: "pause",
  });
  const changed = await request(`/api/devices/${d.value.id}/sim-capabilities`, {
    revision: paused.value.revision,
    simApps: ["pdd"],
    simCommandCodes: ["pdd.open", "pdd.search"],
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.value));
  assert.deepEqual(changed.value.simApps, ["pdd"]);
  assert.equal(changed.value.enabled, false);
});

test("workstation APIs enforce authentication, same-origin JSON, simulation realm and read-only GET", async (t) => {
  const { store, request } = await fixture(t);
  const paths = [
    "/api/strategy-definitions",
    "/api/rule-definitions",
    "/api/strategy-apply",
    "/api/workstation-demo",
  ];
  for (const path of paths) {
    assert.equal((await request(path, {}, { token: "" })).status, 401);
    assert.equal((await request(path + "?mode=real", {})).status, 403);
    assert.equal(
      (
        await request(
          path,
          {},
          { headers: { origin: "https://invalid.example" } },
        )
      ).status,
      403,
    );
    assert.equal(
      (await request(path, {}, { headers: { "content-type": "text/plain" } }))
        .status,
      415,
    );
  }
  assert.equal(
    (
      await request(
        "/api/rule-definitions/sim%3Aplacement.adaptive%3A1",
        { expectedVersion: 1 },
        { method: "DELETE", headers: { origin: "https://invalid.example" } },
      )
    ).status,
    403,
  );
  for (const path of ["/api/strategy-definitions", "/api/rule-definitions"]) {
    const real = await request(path + "?mode=real");
    assert.equal(real.status, 200);
    assert(Object.values(real.value).every((rows) => rows.length === 0));
    assert.equal(
      (await request(path + "?mode=real", undefined, { token: cfg.testToken }))
        .status,
      403,
    );
  }
  const spec = {
    key: "readonly",
    rack: "只读演示",
    deviceCount: 2,
    scenario: "cooldown",
  };
  assert.equal(
    (await request("/api/workstation-demo", spec, { token: cfg.testToken }))
      .status,
    202,
  );
  const before = structuredClone(store.state);
  for (const path of [
    "/api/state",
    "/api/strategy-definitions",
    "/api/rule-definitions",
  ])
    assert.equal((await request(path)).status, 200);
  assert.deepEqual(store.state, before);
  assert.equal(store.state.attempts.length, 0);
  const d = store.state.devices[0],
    j = store.state.jobs[0];
  for (const path of [
    `/api/jobs/${j.id}/assignment`,
    `/api/jobs/${j.id}/queue-cancel`,
    `/api/devices/${d.id}/sim-capabilities`,
  ])
    assert.equal((await request(path + "?mode=real", {})).status, 403);
  assert.equal(
    (
      await request("/api/devices?mode=real", {
        name: "No",
        defaultStrategyId: "sim:pool.balanced:1",
      })
    ).status,
    403,
  );
});
