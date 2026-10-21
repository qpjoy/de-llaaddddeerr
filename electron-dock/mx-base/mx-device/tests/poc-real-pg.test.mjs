// V2-6 P1 on PostgreSQL: migration 016 (real templates only, real commands
// only the PoC ones, one real device per serial) and a real-realm Agent
// through the Agent, device and attempt scopes, granted by the leader. The
// PoC is the simulator with its self-identification removed (see
// poc-real.test.mjs); no phone, PoC, ADB or VPN.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PgStore } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import { Leadership } from "../server/leadership.mjs";
import { createApp } from "../server/http.mjs";
import { REAL_DEFINITIONS } from "../server/workflow-catalog.mjs";
import { HostAgent } from "../server/agent/host-agent.mjs";
import { PocDriver } from "../server/agent/poc-driver.mjs";
import { PocSimulator } from "../server/agent/poc-sim.mjs";

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
const cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
async function until(fn, ms = 30000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}
function realLike(sim) {
  return async (input, init) => {
    const response = await sim.fetch(input, init);
    if (new URL(input).pathname !== "/api/state") return response;
    const { simulator, ...body } = await response.json();
    return new Response(JSON.stringify(body), { status: response.status });
  };
}
const code = (promise) =>
  promise.then(
    () => null,
    (e) => e.code,
  );

test(
  "Postgres: migration 016 seeds only the real PoC templates and a real Agent runs one through the leader",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(["127.0.0.1", "localhost"].includes(target.hostname));
    const name = `mx_device_test_${randomBytes(5).toString("hex")}`,
      admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    const store = new PgStore(target.href, { max: 10 });
    let engine, host, server;
    try {
      await store.migrate();
      // The real catalog is exactly the two seeded templates.
      const seeded = (
        await store.pool.query(
          "SELECT document FROM mx_device.task_definitions WHERE mode='real' ORDER BY id DESC",
        )
      ).rows.map((r) => r.document);
      assert.deepEqual(seeded, REAL_DEFINITIONS);
      assert.equal(
        (await store.snapshot("real")).commandDefinitions.length,
        0,
        "no real command catalog: snapshots live in the templates",
      );
      // The checks keep everything else out of the real realm.
      assert.equal(
        await code(
          store.pool.query(
            "INSERT INTO mx_device.task_definitions VALUES('real:xhs.search10:1','real','xhs.search10',1,'{}')",
          ),
        ),
        "23514",
      );
      assert.equal(
        await code(
          store.pool.query(
            "INSERT INTO mx_device.execution_commands(id,mode,job_id,attempt_id,device_id,status,created_at,document) VALUES($1,'real',$1,$1,$1,'running',0,'{\"code\":\"app.open\"}')",
            [randomUUID()],
          ),
        ),
        "23514",
      );
      const raw = (serial, key) =>
        store.pool.query(
          "INSERT INTO mx_device.devices(id,mode,resource_key,account_key,document) VALUES($1,'real',$2,$2,$3)",
          [randomUUID(), key, { serial }],
        );
      await raw("same-phone", "k1");
      assert.equal(await code(raw("same-phone", "k2")), "23505");
      await store.pool.query("DELETE FROM mx_device.devices");

      server = createApp({ store, cfg });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${server.address().port}`;
      const api = async (path, body) => {
        const r = await fetch(`${base}/api/${path}?mode=real`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${cfg.adminToken}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: r.status, value: await r.json() };
      };
      const created = await api("agents", {
        name: "PG 测试宿主机",
        host: "测试宿主机",
        approved: true,
      });
      assert.equal(created.status, 201);
      assert.equal(await store.agentRealm(created.value.agent.id), "real");
      const sim = new PocSimulator({ delayMs: 30 });
      host = new HostAgent({
        center: base,
        token: created.value.token,
        devices: [{ serial: "pg-phone" }],
        driver: new PocDriver({
          origins: { "pg-phone": "http://127.0.0.1:18081" },
          fetch: realLike(sim),
        }),
        pollWaitMs: 500,
        retryMs: 50,
      });
      await host.start();
      assert.equal(host.driver.realm, "real");
      const adopted = await api(`agents/${created.value.agent.id}/adopt`, {
        serial: "pg-phone",
        rack: "PG 真实机架",
        accountKey: "xhs-pg",
        approved: true,
      });
      assert.equal(adopted.status, 200, JSON.stringify(adopted.value));
      const id = adopted.value.id;
      const row = async () =>
        (
          await store.pool.query(
            "SELECT document FROM mx_device.devices WHERE id=$1",
            [id],
          )
        ).rows[0].document;
      assert.equal((await row()).enabled, false);
      await store.pool.query(
        "UPDATE mx_device.devices SET document=jsonb_set(document,'{taskIntervalMs}','0') WHERE id=$1",
        [id],
      );
      // Probe through the Agent (Agent scope consumes it, device scope records it).
      const asked = await api(`devices/${id}/probe`, {
        revision: (await row()).revision,
      });
      assert.equal(asked.status, 202, JSON.stringify(asked.value));
      await until(
        async () => (await row()).probe?.source === "agent",
        10000,
        "probe",
      );
      assert.equal((await row()).probe.idle, true);
      const on = await api(`devices/${id}/control`, {
        action: "enable",
        revision: (await row()).revision,
        confirmedExclusive: true,
      });
      assert.equal(on.status, 200, JSON.stringify(on.value));
      const queued = await api("jobs", {
        key: "pg-real-1",
        definitionId: "real:xhs.poc.search3:1",
        deviceId: id,
        keyword: "露营装备",
        confirmed: true,
      });
      assert.equal(queued.status, 202, JSON.stringify(queued.value));
      engine = new Engine(store, {
        workerId: "sched",
        leadership: new Leadership(target.href, { instanceId: "leader" }),
      });
      engine.start();
      const status = async () =>
        (
          await store.pool.query(
            "SELECT status FROM mx_device.jobs WHERE id=$1",
            [queued.value.id],
          )
        ).rows[0].status;
      await until(
        async () => !["queued", "running"].includes(await status()),
        30000,
        "real job",
      );
      assert.equal(await status(), "succeeded");
      const commands = (
        await store.pool.query(
          "SELECT mode, document FROM mx_device.execution_commands WHERE job_id=$1 ORDER BY created_at",
          [queued.value.id],
        )
      ).rows;
      assert.deepEqual(
        commands.map((c) => [c.mode, c.document.code, c.document.status]),
        [
          ["real", "xhs.search", "succeeded"],
          ["real", "xhs.search.next", "succeeded"],
          ["real", "xhs.search.next", "succeeded"],
        ],
      );
      assert(commands.every((c) => c.document.receipt.source === "poc"));
      const attempts = (
        await store.pool.query(
          "SELECT document FROM mx_device.attempts WHERE job_id=$1",
          [queued.value.id],
        )
      ).rows.map((r) => r.document);
      assert(
        attempts.every((a) => a.executor === "agent" && a.mode === "real"),
      );
      assert.deepEqual(
        sim.calls.filter((p) => p !== "/api/state"),
        ["/api/search", "/api/next", "/api/next"],
      );
      // Nothing leaked into the simulation realm.
      const simulation = await store.snapshot("sim");
      assert.equal(simulation.agents.length, 0);
      assert.equal(simulation.devices.length, 0);
    } finally {
      await engine?.close();
      await host?.stop();
      if (server) await new Promise((r) => server.close(r));
      await store.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
