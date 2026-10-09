import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { MemoryStore } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import { createApp } from "../server/http.mjs";
import { captureMobile, MAX_FRAME_BYTES } from "../server/mobile-agent.mjs";
import {
  register,
  configureObserver,
  requestCapture,
  claimCapture,
  completeCapture,
  sessionAction,
  publicDevice,
  control,
  addJob,
  claim,
  finish,
  sweep,
  markDispatch,
  mobileOrigin,
} from "../server/model.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9n8AAAAASUVORK5CYII=",
  "base64",
);
const blank = () => ({ devices: [], jobs: [], attempts: [], events: [] });
const mobile = (s, serial = "8ad5ef10") =>
  register(s, 1000, "real", {
    adapter: "mobile-agent",
    name: serial,
    serial,
    workerId: "w",
    accountKey: serial,
    origin: "http://127.0.0.1:8787",
    approved: true,
  });
const acquire = (s, n, d, action = "acquire") =>
  sessionAction(s, n, d.mode, d.id, {
    action,
    revision: d.revision,
    confirmed: true,
  });

test("one Mobile-Agent port serves distinct serials; duplicate physical identities fail across adapters", () => {
  const s = blank(),
    a = mobile(s),
    b = mobile(s, "second");
  assert.equal(a.origin, b.origin);
  assert.notEqual(a.resourceKey, b.resourceKey);
  assert.throws(() => mobile(s), /登记/);
  assert.throws(
    () =>
      register(s, 1000, "real", {
        name: "alias",
        serial: a.serial,
        workerId: "w2",
        accountKey: "new",
        origin: "http://127.0.0.1:18081",
        approved: true,
      }),
    /序列号/,
  );
  assert.throws(
    () =>
      addJob(s, 1000, "real", {
        key: "unsupported",
        operation: "search",
        keyword: "x",
        deviceId: a.id,
      }),
    /仅观察/,
  );
  assert.throws(
    () =>
      control(s, 1000, "real", a.id, {
        action: "enable",
        revision: a.revision,
        confirmedExclusive: true,
      }),
    /不允许/,
  );
  assert.equal(claim(s, 1000, "real", "w"), null);
});
test("existing PoC device can attach an observer without changing origin, busy or enablement", () => {
  const s = blank(),
    d = register(s, 1000, "real", {
      name: "legacy",
      workerId: "w",
      accountKey: "x",
      origin: "http://127.0.0.1:18081",
      approved: true,
    });
  d.probe = { idle: false, projection: { isBusy: true } };
  configureObserver(s, 1001, d.id, {
    revision: d.revision,
    serial: "8ad5ef10",
    origin: "http://127.0.0.1:8787",
    approved: true,
  });
  assert.equal(d.origin, "http://127.0.0.1:18081");
  assert.equal(d.probe.idle, false);
  assert.equal(d.enabled, false);
  assert(requestCapture(s, 1002, d.id));
  assert.throws(
    () =>
      configureObserver(s, 1003, d.id, {
        revision: d.revision,
        serial: "other",
        origin: d.observer.origin,
        approved: true,
      }),
    /不能更换/,
  );
});
test("screen transport is serial-qualified GET only and fails closed for redirects/JSON/oversize/invalid PNG", async () => {
  const d = mobile(blank());
  const f = await captureMobile(d, async (u, opts) => {
    assert.equal(
      u.href,
      "http://127.0.0.1:8787/api/screen.png?device=8ad5ef10",
    );
    assert.equal(opts.method, "GET");
    assert.equal(opts.redirect, "error");
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  assert.equal(f.width, 1);
  assert.equal(f.height, 1);
  for (const r of [
    new Response("{}"),
    new Response(png, {
      status: 302,
      headers: { "content-type": "image/png" },
    }),
    new Response("bad", { headers: { "content-type": "image/png" } }),
    new Response(Buffer.alloc(MAX_FRAME_BYTES + 1), {
      headers: { "content-type": "image/png" },
    }),
  ])
    await assert.rejects(captureMobile(d, async () => r));
  await assert.rejects(captureMobile({ ...d, mode: "sim" }));
  for (const u of [
    "http://169.254.169.254:8787",
    "http://127.0.0.1:5037",
    "http://localhost:8787",
    "http://u:p@127.0.0.1:8787",
    "http://127.0.0.1:8787/api/state",
  ])
    assert.throws(() => mobileOrigin(u));
});
test("viewers and workers coalesce captures, reads cause no I/O, cached frame never leaks into snapshots", async () => {
  const store = new MemoryStore(() => 1000),
    d = await store.atomic((s) => mobile(s));
  let calls = 0;
  const capture = async () => {
    calls++;
    return { png, width: 1, height: 1 };
  };
  const a = new Engine(store, { workerId: "w", capture }),
    b = new Engine(store, { workerId: "w", capture });
  await a.tick();
  assert.equal(calls, 0);
  const requests = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.atomic((s, n) => requestCapture(s, n, d.id)),
    ),
  );
  assert.equal(new Set(requests.map((x) => x.id)).size, 1);
  await Promise.all([a.tick(), b.tick()]);
  await Promise.all([...a.inflight.values(), ...b.inflight.values()]);
  assert.equal(calls, 1);
  assert.deepEqual(await store.frame(d.id, requests[0].id), png);
  assert.equal(
    JSON.stringify(await store.snapshot("real")).includes(
      png.toString("base64"),
    ),
    false,
  );
  await store.atomic((s, n) => requestCapture(s, n, d.id));
  await a.tick();
  assert.equal(calls, 1);
  await Promise.all([a.close(), b.close()]);
});
test("assigned worker, expiry and configuration generations fence old screenshot receipts", () => {
  const s = blank(),
    d = mobile(s);
  requestCapture(s, 1000, d.id);
  assert.equal(claimCapture(s, 1000, "other"), null);
  const work = structuredClone(claimCapture(s, 1000, "w"));
  assert.equal(completeCapture(s, 21000, work, { width: 1, height: 1 }), false);
  requestCapture(s, 21001, d.id);
  assert.equal(completeCapture(s, 21002, work, { width: 1, height: 1 }), false);
  const next = structuredClone(claimCapture(s, 21002, "w"));
  assert.equal(completeCapture(s, 21003, next, null, true), false);
  assert.equal(d.capture.status, "failed");
  assert.equal(d.enabled, false);
});
test("session drains running work, excludes scheduler and other windows; release preserves queued work", () => {
  const s = blank(),
    d = register(s, 1000, "sim", { name: "A" });
  addJob(s, 1000, "sim", { key: "one", operation: "search", keyword: "x" });
  addJob(s, 1001, "sim", { key: "two", operation: "search", keyword: "x" });
  const work = structuredClone(claim(s, 1001, "sim", "w"));
  const session = acquire(s, 1002, d);
  assert.equal(d.session.status, "waiting");
  assert.equal(d.enabled, false);
  assert.throws(() => acquire(s, 1003, d), /其他会话/);
  assert.throws(
    () =>
      sessionAction(s, 1003, "sim", d.id, {
        action: "release",
        token: "wrong",
      }),
    /其他控制端/,
  );
  assert.equal(publicDevice(d).session.tokenHash, undefined);
  finish(s, 1004, work.attempt, { result: {} });
  sweep(s, 1005, "sim");
  assert.equal(d.session.status, "held");
  assert.equal(claim(s, 2000, "sim", "w"), null);
  assert.throws(
    () =>
      control(s, 2000, "sim", d.id, { action: "enable", revision: d.revision }),
    /会话/,
  );
  assert.throws(
    () =>
      control(s, 2000, "sim", d.id, {
        action: "reconnect",
        revision: d.revision,
      }),
    /会话/,
  );
  sessionAction(s, 2000, "sim", d.id, {
    action: "reset",
    token: session.token,
  });
  sessionAction(s, 2001, "sim", d.id, {
    action: "release",
    token: session.token,
  });
  assert.equal(s.jobs[1].status, "queued");
  assert.equal(d.enabled, false);
  assert.equal(d.session.status, "released");
});
test("sim takeover fences previous attempt and token without losing jobs; real force operations always denied", () => {
  const s = blank(),
    d = register(s, 1000, "sim", { name: "A" });
  addJob(s, 1000, "sim", { key: "one", operation: "search", keyword: "x" });
  const w = structuredClone(claim(s, 1000, "sim", "w"));
  const old = acquire(s, 1001, d);
  const next = acquire(s, 1002, d, "takeover");
  assert.notEqual(next.token, old.token);
  assert.equal(s.jobs[0].status, "queued");
  assert.equal(markDispatch(s, 1003, w.attempt), false);
  assert.throws(
    () =>
      sessionAction(s, 1003, "sim", d.id, {
        action: "renew",
        token: old.token,
      }),
    /会话/,
  );
  finish(s, 1004, w.attempt, { result: { stale: true } });
  assert.equal(s.jobs[0].status, "queued");
  assert(s.attempts[0].lateEvidence);
  const real = mobile(s);
  for (const action of ["takeover", "reset"])
    assert.throws(() => acquire(s, 1005, real, action), /真实抢占/);
});
test("expired session never auto-enables device and can be reacquired without a worker", () => {
  const s = blank(),
    d = register(s, 1000, "sim", { name: "A" });
  const first = acquire(s, 1000, d);
  const next = acquire(s, 61001, d);
  assert.notEqual(first.token, next.token);
  assert.equal(d.enabled, false);
  sweep(s, 121002, "sim");
  assert.equal(d.session.status, "expired");
  assert.equal(d.enabled, false);
});
test("HTTP picture and session auth, realm separation, cache-only reads and forced-action denial", async (t) => {
  const store = new MemoryStore(),
    cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
  const d = await store.atomic((s) => mobile(s));
  const sim = await store.atomic((s, n) =>
    register(s, n, "sim", { name: "A" }),
  );
  const app = createApp({ store, cfg });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise((r) => app.close(r)));
  const request = (suffix, b, token = cfg.adminToken) =>
    fetch(`http://127.0.0.1:${app.address().port}/api/${suffix}`, {
      method: b ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: b ? JSON.stringify(b) : undefined,
    });
  assert.equal(
    (await request(`devices/${d.id}/capture?mode=real`, {}, cfg.testToken))
      .status,
    403,
  );
  assert.equal(
    (await request(`devices/${d.id}/capture?mode=sim`, {})).status,
    403,
  );
  assert.equal(
    (
      await request(
        `devices/${d.id}/frame?mode=real&captureId=${d.id}`,
        null,
        "",
      )
    ).status,
    401,
  );
  assert.equal(
    (await request(`devices/${d.id}/frame?mode=real&captureId=${d.id}`)).status,
    404,
  );
  assert.equal(store.state.devices[0].capture, undefined);
  assert.equal(
    (await request(`devices/${d.id}/session?mode=real`, { action: "takeover" }))
      .status,
    403,
  );
  assert.equal(
    (await request(`devices/${d.id}/probe?mode=real`, { revision: d.revision }))
      .status,
    400,
  );
  const lease = await (
    await request(`devices/${sim.id}/session?mode=sim`, {
      action: "acquire",
      revision: sim.revision,
      confirmed: true,
    })
  ).json();
  assert(lease.token);
  const snapshot = await (await request("state?mode=sim")).text();
  assert(!snapshot.includes("tokenHash"));
  assert(!snapshot.includes(lease.token));
  const paused = await (
    await request(`devices/${sim.id}/control?mode=sim`, {
      action: "pause",
      revision: lease.device.revision,
    })
  ).text();
  assert(!paused.includes("tokenHash"));
});
