import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
const cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
test("API authentication, realm boundary, CSRF, idempotency, read-only snapshots and independent readiness", async (t) => {
  const store = new MemoryStore(),
    app = createApp({ store, cfg });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise((r) => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const req = (path, body, token = cfg.adminToken, extra = {}) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await req("/api/state", null, "")).status, 401);
  assert.equal(
    (await req("/api/state?mode=real", null, cfg.testToken)).status,
    403,
  );
  assert.equal(
    (await req("/api/scenarios?mode=real", { kind: "five", key: "bad" }))
      .status,
    403,
  );
  assert.equal(
    (
      await req(
        "/api/scenarios",
        { kind: "five", key: "xsrf" },
        cfg.adminToken,
        { origin: "https://evil.invalid" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await req("/api/login", { token: cfg.adminToken }, "")).status,
    200,
  );
  const cookie = (
    await req("/api/login", { token: cfg.adminToken }, "")
  ).headers.get("set-cookie");
  assert(cookie.includes("HttpOnly"));
  assert(cookie.includes("SameSite=Strict"));
  assert.equal(
    (await fetch(base + "/api/session", { headers: { cookie } })).status,
    200,
  );
  const first = await req("/api/scenarios?mode=sim", {
    kind: "five",
    key: "scene",
  });
  assert.equal(first.status, 202);
  const replay = await (
    await req("/api/scenarios?mode=sim", { kind: "five", key: "scene" })
  ).json();
  assert(replay.replayed);
  assert.equal(store.state.jobs.length, 5);
  assert.equal(store.state.attempts.length, 0);
  for (let i = 0; i < 3; i++)
    assert.equal((await req("/api/state?mode=sim")).status, 200);
  assert.equal(store.state.attempts.length, 0);
  const d = await (
    await req("/api/devices?mode=real", {
      name: "real paused",
      origin: "http://127.0.0.1:18081",
      workerId: "test-worker",
      accountKey: "test",
      approved: true,
    })
  ).json();
  assert.equal(d.enabled, false);
  assert.equal(d.serial, null);
  assert.equal(
    (
      await req(`/api/devices/${d.id}/probe?mode=real`, {
        revision: d.revision,
      })
    ).status,
    202,
  );
  assert.equal(store.state.attempts.length, 0);
  assert.equal((await req("/health/ready")).status, 200);
  assert.equal(
    (
      await req("/api/jobs?mode=real", {
        key: "no-confirm",
        deviceId: d.id,
        operation: "search",
        keyword: "x",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await req("/api/devices?mode=real", {
        name: "ssrf",
        origin: "http://169.254.169.254",
        workerId: "w",
        accountKey: "x",
        approved: true,
      })
    ).status,
    400,
  );
});
