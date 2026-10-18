// Host Agent on PostgreSQL: Agent and attempt scopes, migration 013, and the
// scheduler leader switching while the Agent keeps executing its leases.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PgStore } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import { Leadership } from "../server/leadership.mjs";
import { createApp } from "../server/http.mjs";
import { addWorkflow } from "../server/workflows.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { HostAgent } from "../server/agent/host-agent.mjs";
import { SimDriver } from "../server/agent/sim-driver.mjs";

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
const cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
async function until(fn, ms = 30000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}
test(
  "Postgres: an Agent keeps executing across a scheduler leader switch",
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
    let first, second, host, server;
    try {
      await store.migrate();
      server = createApp({ store, cfg });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${server.address().port}`;
      const api = async (path, body) =>
        (
          await fetch(`${base}/api/${path}?mode=sim`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${cfg.adminToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          })
        ).json();
      const { agent, token } = await api("agents", { name: "PG 宿主机" });
      const stored = (
        await store.pool.query("SELECT status, document FROM mx_device.agents")
      ).rows[0];
      assert.equal(stored.status, "active");
      assert.match(stored.document.tokenHash, /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(stored.document).includes(token), false);
      const serials = ["pg-1", "pg-2", "pg-3"];
      host = new HostAgent({
        center: base,
        token,
        devices: serials.map((serial) => ({ serial, apps: ["xhs", "weibo"] })),
        driver: new SimDriver({ speed: 0.5 }),
        pollWaitMs: 500,
        retryMs: 50,
      });
      await host.start();
      for (const serial of serials)
        await api(`agents/${agent.id}/adopt`, {
          serial,
          rack: "PG Agent",
          simApps: ["xhs", "weibo"],
        });
      const ids = await store.atomic(
        (s, n) => {
          for (const d of s.devices) d.taskIntervalMs = 0;
          configureLoops(s, n, "sim", {
            rack: "PG Agent",
            revision: 0,
            commandDelayMs: 200,
            cooldownMinMs: 0,
            cooldownMaxMs: 0,
          });
          return Array.from(
            { length: 9 },
            (_, i) =>
              addWorkflow(s, n, "sim", {
                key: `pg-agent-${i}`,
                definitionId: i % 2 ? "sim:xhs.detail:1" : "sim:weibo.list:1",
                rack: "PG Agent",
                keyword: `k${i}`,
                target: `t${i}`,
              }).id,
          );
        },
        { mode: "sim" },
      );
      first = new Engine(store, {
        workerId: "sched",
        leadership: new Leadership(target.href, { instanceId: "first" }),
      });
      second = new Engine(store, {
        workerId: "sched",
        leadership: new Leadership(target.href, { instanceId: "second" }),
      });
      first.start();
      await sleep(300);
      second.start();
      const done = async () =>
        (
          await store.pool.query(
            "SELECT count(*)::int AS n FROM mx_device.jobs WHERE id=ANY($1::uuid[]) AND status='succeeded'",
            [ids],
          )
        ).rows[0].n;
      await until(async () => (await done()) >= 2, 30000, "first jobs");
      // The leader goes away while the Agent holds leases; nothing is lost.
      await first.close();
      first = null;
      await until(async () => (await done()) === ids.length, 60000, "all jobs");
      const attempts = (
        await store.pool.query(
          "SELECT status, document FROM mx_device.attempts WHERE job_id=ANY($1::uuid[])",
          [ids],
        )
      ).rows;
      assert(attempts.every((a) => a.document.executor === "agent"));
      assert.equal(
        attempts.filter((a) => a.status === "succeeded").length,
        ids.length,
      );
      const commands = (
        await store.pool.query(
          "SELECT document FROM mx_device.execution_commands WHERE job_id=ANY($1::uuid[])",
          [ids],
        )
      ).rows.map((r) => r.document);
      assert(commands.every((c) => c.status === "succeeded" && c.seq >= 1));
      assert.equal(
        host.stats.commands,
        commands.length,
        "each command ran once",
      );
      assert(second.epoch != null, "the standby took over");
    } finally {
      await first?.close();
      await second?.close();
      await host?.stop();
      if (server) await new Promise((r) => server.close(r));
      await store.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
