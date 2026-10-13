import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";

test("isolated virtual pool HTTP: auth, realm, bounded input, normalized report and unchanged live state", async (t) => {
  const store = new MemoryStore();
  const cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
  const app = createApp({ store, cfg });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const call = (path, body, token = cfg.testToken) =>
    fetch(`http://127.0.0.1:${app.address().port}/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await call("pool-scenarios?mode=sim", null, "")).status, 401);
  assert.equal(
    (await call("pool-simulate?mode=real", { deviceCount: 2 }, cfg.adminToken))
      .status,
    403,
  );
  assert.equal(
    (await call("pool-simulate?mode=sim", { deviceCount: 101 })).status,
    400,
  );
  assert.equal(
    (await call("pool-simulate?mode=sim", { policy: { arbitrary: true } }))
      .status,
    400,
  );
  const catalog = await (await call("pool-scenarios?mode=sim")).json();
  assert.equal(catalog.scenarios.length, 8);
  const before = structuredClone(store.state);
  const response = await call("pool-simulate?mode=sim", {
    scenario: "failure",
    deviceCount: 2,
    seed: 42,
  });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.simulated, true);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.realTransportCalls, 0);
  assert.equal(report.summary.invariantViolations, 0);
  assert.equal(report.policy.version, 1);
  assert.equal(
    report.summary.completed + report.summary.failed,
    report.summary.submitted,
  );
  assert.deepEqual(
    store.state,
    before,
    "benchmark must not mutate persisted/living device state",
  );
});
