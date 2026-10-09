import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";

test("App pacing API requires auth/realm and serves read-only eligibility; concurrent submission is idempotent", async (t) => {
  const store = new MemoryStore(),
    cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
  const app = createApp({ store, cfg });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise((r) => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const req = (path, body, token = cfg.testToken) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const d = await (await req("/api/devices", { name: "one phone" })).json();
  const path = `/api/devices/${d.id}/pacing`;
  const policy = {
    revision: d.revision,
    deviceIntervalMs: 500,
    apps: [
      { appId: "xhs", cooldownMs: 12000 },
      { appId: "weibo", cooldownMs: 6000 },
    ],
  };
  assert.equal((await req(path, policy, "")).status, 401);
  assert.equal((await req(`${path}?mode=real`, policy)).status, 403);
  assert.equal((await req(path, policy)).status, 409);
  const paused = await (
    await req(`/api/devices/${d.id}/control`, {
      action: "pause",
      revision: d.revision,
    })
  ).json();
  policy.revision = paused.revision;
  assert.equal((await req(path, policy)).status, 200);
  assert.equal((await req(path, policy)).status, 409);
  const current = store.state.devices[0];
  assert.equal(
    (
      await req(`/api/devices/${d.id}/control`, {
        action: "enable",
        revision: current.revision,
      })
    ).status,
    200,
  );
  const body = {
    key: "client-stable-key",
    appId: "weibo",
    operation: "search",
    keyword: "same",
    deviceId: d.id,
  };
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => req("/api/jobs", body)),
  );
  assert(responses.every((r) => r.status === 202));
  const jobs = await Promise.all(responses.map((r) => r.json()));
  assert.equal(new Set(jobs.map((j) => j.id)).size, 1);
  assert.equal((await req("/api/jobs", { ...body, appId: "xhs" })).status, 409);
  assert.equal(
    (
      await req(
        "/api/jobs?mode=real",
        { ...body, confirmed: true },
        cfg.adminToken,
      )
    ).status,
    400,
  );
  const before = structuredClone(store.state);
  const state = await (await req("/api/state")).json();
  assert.equal(state.scheduling.devices[0].apps.length, 2);
  assert.equal(state.jobs[0].appId, "weibo");
  assert.deepEqual(store.state, before);
  assert.equal(store.state.attempts.length, 0);
});
