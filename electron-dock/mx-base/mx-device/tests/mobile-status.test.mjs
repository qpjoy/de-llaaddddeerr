import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { inspectMobile } from "../server/mobile-status.mjs";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { Engine } from "../server/engine.mjs";
import {
  register,
  configureObserver,
  requestInspection,
  claimInspection,
  completeInspection,
  setPoCChannel,
  control,
  addJob,
  claim,
  recordProbe,
} from "../server/model.mjs";

const blank = () => ({ devices: [], jobs: [], attempts: [], events: [] });
function device(s, n = 1000) {
  const d = register(s, n, "real", {
    name: "legacy",
    workerId: "w",
    origin: "http://127.0.0.1:18081",
    serial: "serial01",
    accountKey: "one",
    approved: true,
  });
  configureObserver(s, n, d.id, {
    revision: d.revision,
    origin: "http://127.0.0.1:8787",
    serial: d.serial,
    approved: true,
  });
  return d;
}
const detail = (more = {}) => ({
  device: {
    serial: "serial01",
    status: "online",
    current_task_id: null,
    model: "Xiaomi",
    current_app: "com.xingin.xhs",
    battery_level: "95%",
    resolution: "1080x2400",
    last_seen_at: "2026-09-20 10:00:00",
    ...more,
  },
});
const runners = (runs = [], legacy = { running: false, meta: {} }) => ({
  runs,
  legacy,
});
const respond = (d, r) => async (url, opts) => {
  assert.equal(opts.method, "GET");
  assert.equal(opts.redirect, "error");
  assert.equal(url.origin, "http://127.0.0.1:8787");
  assert(["/api/devices/serial01", "/api/run"].includes(url.pathname));
  assert.equal(url.search, "");
  return new Response(JSON.stringify(url.pathname === "/api/run" ? r : d), {
    headers: { "content-type": "application/json" },
  });
};
const toggle = (s, n, d, enabled) =>
  setPoCChannel(s, n, d.id, { enabled, revision: d.revision, confirmed: true });

test("Mobile-Agent inspection reads only serial detail/run and strips private configuration, logs and metadata", async () => {
  const d = device(blank());
  const result = await inspectMobile(
    d,
    respond(
      detail({ token: "private", metadata_json: { password: "private" } }),
      runners([
        {
          running: true,
          meta: { device_serial: d.serial, secret: "private" },
          logs: ["private"],
        },
      ]),
    ),
  );
  assert.equal(result.occupancy, "reported-busy");
  assert.equal(result.runningCount, 1);
  assert.equal(result.model, "Xiaomi");
  assert.equal(result.lastSeenRaw, "2026-09-20 10:00:00");
  assert.equal(result.controlAuthority, "unverified");
  assert(!JSON.stringify(result).includes("private"));
  await assert.rejects(inspectMobile({ ...d, mode: "sim" }));
});

test("no reported task is not physical exclusivity; missing/malformed/unassigned runners fail to unknown", async () => {
  const d = device(blank());
  assert.equal(
    (await inspectMobile(d, respond(detail(), runners()))).occupancy,
    "not-reported",
  );
  assert.equal(
    (await inspectMobile(d, respond(detail({ current_task_id: 8 }), runners())))
      .occupancy,
    "reported-busy",
  );
  assert.equal(
    (await inspectMobile(d, respond(detail({ serial: "wrong" }), runners())))
      .deviceRecord,
    "unavailable",
  );
  for (const run of [
    {},
    runners([{ running: "false", meta: {} }]),
    runners([], { running: true, meta: {} }),
  ])
    assert.equal(
      (await inspectMobile(d, respond(detail(), run))).occupancy,
      "unknown",
    );
  assert.equal(
    (
      await inspectMobile(
        d,
        respond(detail({ current_task_id: undefined }), runners()),
      )
    ).occupancy,
    "unknown",
  );
  assert.equal(
    (
      await inspectMobile(
        d,
        respond(
          detail(),
          runners([{ running: true, meta: { device_serial: "other" } }]),
        ),
      )
    ).occupancy,
    "not-reported",
  );
});

test("unreachable, redirect, non-JSON, malformed JSON and oversized status never mean idle", async () => {
  const d = device(blank());
  const factories = [
    () => {
      throw Error("private endpoint details");
    },
    () => new Response("{}", { status: 302 }),
    () => new Response("html"),
    () =>
      new Response("bad", { headers: { "content-type": "application/json" } }),
    () =>
      new Response('"' + "x".repeat(513 * 1024) + '"', {
        headers: { "content-type": "application/json" },
      }),
  ];
  for (const make of factories) {
    const result = await inspectMobile(d, async () => make());
    assert.equal(result.deviceRecord, "unavailable");
    assert.equal(result.occupancy, "unknown");
    assert(!JSON.stringify(result).includes("private"));
  }
});

test("explicit inspection coalesces, uses assigned worker, and never changes PoC busy/enable state", async () => {
  let now = 1000,
    calls = 0;
  const store = new MemoryStore(() => now),
    d = await store.atomic((s, n) => device(s, n));
  const engine = new Engine(store, {
    workerId: "w",
    inspect: async () => {
      calls++;
      return inspectMobile(d, respond(detail(), runners()));
    },
    call: async () => {
      throw Error("No PoC allowed");
    },
  });
  await engine.tick();
  assert.equal(calls, 0);
  const reqs = await Promise.all(
    Array.from({ length: 4 }, () =>
      store.atomic((s, n) => requestInspection(s, n, d.id)),
    ),
  );
  assert.equal(new Set(reqs.map((r) => r.id)).size, 1);
  assert.equal(
    await store.atomic((s, n) => claimInspection(s, n, "wrong")),
    null,
  );
  await engine.tick();
  await Promise.all(engine.inflight.values());
  assert.equal(calls, 1);
  const current = (await store.snapshot("real")).devices[0];
  assert.equal(current.enabled, false);
  assert.equal(current.probe, null);
  assert.equal(current.mobileStatus.receivedAt, now);
  await store.atomic((s, n) => requestInspection(s, n, d.id));
  await engine.tick();
  assert.equal(calls, 1);
  now += 6000;
  await store.atomic((s, n) => requestInspection(s, n, d.id));
  const old = await store.atomic((s, n) => claimInspection(s, n, "w"));
  now += 21000;
  assert.equal(
    await store.atomic((s, n) =>
      completeInspection(s, n, old, { occupancy: "not-reported" }),
    ),
    false,
  );
  await store.atomic((s, n) =>
    configureObserver(s, n, d.id, {
      revision: current.revision,
      origin: d.observer.origin,
      serial: d.serial,
      approved: true,
    }),
  );
  assert.equal(
    await store.atomic((s, n) => completeInspection(s, n, old, {})),
    false,
  );
  await engine.close();
});

test("disabling PoC retains the device/observer/history, prevents all new PoC paths, restores paused with fresh-probe requirement", () => {
  const s = blank(),
    d = device(s);
  d.probe = { at: 1000, idle: true };
  d.projection = { page: 1, isBusy: true };
  d.connected = "online";
  const before = structuredClone(d);
  toggle(s, 1001, d, false);
  assert.equal(d.pocDisabled, true);
  assert.equal(d.origin, before.origin);
  assert.deepEqual(d.observer, before.observer);
  assert.deepEqual(d.projection, before.projection);
  assert.throws(
    () =>
      control(s, 1002, "real", d.id, {
        action: "enable",
        revision: d.revision,
        confirmedExclusive: true,
      }),
    /停用/,
  );
  assert.throws(
    () =>
      addJob(s, 1002, "real", {
        key: "no",
        operation: "search",
        keyword: "x",
        deviceId: d.id,
      }),
    /停用/,
  );
  d.enabled = true;
  assert.equal(claim(s, 1003, "real", "w"), null);
  d.enabled = false;
  toggle(s, 1004, d, true);
  assert.equal(d.enabled, false);
  assert.throws(
    () =>
      control(s, 1005, "real", d.id, {
        action: "enable",
        revision: d.revision,
        confirmedExclusive: true,
      }),
    /空闲/,
  );
  recordProbe(s, 1006, "real", d.id, d.revision, {
    idle: true,
    reachable: true,
  });
  control(s, 1007, "real", d.id, {
    action: "enable",
    revision: d.revision,
    confirmedExclusive: true,
  });
  assert.equal(d.enabled, true);
});

test("PoC channel change rejects queued/running work, uncompleted probe, unknown state and missing confirmation", () => {
  const s = blank(),
    d = device(s);
  assert.throws(
    () =>
      setPoCChannel(s, 1001, d.id, { enabled: false, revision: d.revision }),
    /确认/,
  );
  s.jobs.push({ deviceId: d.id, mode: "real", status: "queued" });
  assert.throws(() => toggle(s, 1001, d, false), /待处理/);
  s.jobs = [];
  s.attempts.push({ deviceId: d.id, status: "running" });
  assert.throws(() => toggle(s, 1001, d, false), /在途/);
  s.attempts = [];
  d.probeRequestedAt = 1000;
  assert.throws(() => toggle(s, 1001, d, false), /检查结束/);
  d.probeRequestedAt = 0;
  d.state = "quarantined";
  assert.throws(() => toggle(s, 1001, d, false), /核验/);
});

test("status and PoC policy routes enforce auth/realm; API reads and disabled stale probes never call upstream", async (t) => {
  const store = new MemoryStore(),
    d = await store.atomic((s, n) => device(s, n));
  const app = createApp({
    store,
    cfg: { adminToken: "a".repeat(64), testToken: "b".repeat(64) },
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise((r) => app.close(r)));
  const request = (path, body, token = "a".repeat(64)) =>
    fetch(`http://127.0.0.1:${app.address().port}/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  for (const path of ["mobile-status", "poc-channel"]) {
    assert.equal(
      (await request(`devices/${d.id}/${path}?mode=sim`, {})).status,
      403,
    );
    assert.equal(
      (await request(`devices/${d.id}/${path}?mode=real`, {}, "b".repeat(64)))
        .status,
      403,
    );
    assert.equal(
      (await request(`devices/${d.id}/${path}?mode=real`, {}, "wrong")).status,
      401,
    );
    assert.equal(
      (await request(`devices/${d.id}/${path}?mode=real`)).status,
      405,
    );
  }
  assert.equal((await request("state?mode=real")).status, 200);
  assert.equal((await store.snapshot("real")).devices[0].inspection, null);
  assert.equal(
    (
      await request(`devices/${d.id}/poc-channel?mode=real`, {
        enabled: false,
        confirmed: true,
        revision: d.revision,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`devices/${d.id}/probe?mode=real`, {
        revision: d.revision + 1,
      })
    ).status,
    403,
  );
  let calls = 0;
  await store.atomic((s) => {
    s.devices[0].probeRequestedAt = Date.now();
  });
  const engine = new Engine(store, {
    workerId: "w",
    call: async () => {
      calls++;
    },
    inspect: async () => ({ occupancy: "unknown" }),
  });
  await engine.tick();
  assert.equal(calls, 0);
  assert.equal(
    (await request(`devices/${d.id}/mobile-status?mode=real`, {})).status,
    202,
  );
  await engine.tick();
  await Promise.all(engine.inflight.values());
  assert.equal(calls, 0);
  await engine.close();
});
