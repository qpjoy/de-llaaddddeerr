// Job API v1 on PostgreSQL: migration 014, client rows (hash only), usage
// rows appended by execution transactions and folded by the realm, outbox rows
// written with the job's end and delivered once each, and SKIP LOCKED claims.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { PgStore } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import { createApp } from "../server/http.mjs";
import { register } from "../server/model.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { OutboxDeliverer, verifySignature } from "../server/outbox.mjs";

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
const cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };

test(
  "Postgres: two callers through the Job API v1 with callbacks",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(["127.0.0.1", "localhost"].includes(target.hostname));
    const name = `mx_device_test_${randomBytes(5).toString("hex")}`,
      admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    const store = new PgStore(target.href, { max: 8 });
    const received = [];
    const receiver = createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      received.push({ headers: req.headers, body });
      res.writeHead(200).end();
    });
    let server, engine, deliverer;
    try {
      await store.migrate();
      receiver.listen(0, "127.0.0.1");
      await once(receiver, "listening");
      const hook = `http://127.0.0.1:${receiver.address().port}`;
      deliverer = new OutboxDeliverer(store, { intervalMs: 100 }).start();
      server = createApp({ store, cfg, deliverer });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${server.address().port}`;
      const call = async (path, key, body) => {
        const res = await fetch(`${base}${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${key}`,
            ...(body && { "content-type": "application/json" }),
          },
          body: body && JSON.stringify(body),
        });
        return { status: res.status, value: await res.json() };
      };
      await store.atomic(
        (s, n) => {
          for (let i = 0; i < 3; i++)
            register(s, n, "sim", {
              name: `PG-C${i}`,
              rack: "PG 调用方",
              host: "h",
              simApps: ["xhs", "weibo"],
            });
          for (const d of s.devices) d.taskIntervalMs = 0;
          configureLoops(s, n, "sim", {
            rack: "PG 调用方",
            revision: 0,
            commandDelayMs: 200,
            cooldownMinMs: 0,
            cooldownMaxMs: 0,
          });
        },
        { mode: "sim" },
      );
      const clients = [];
      for (const [label, weight] of [
        ["甲", 1],
        ["乙", 3],
      ]) {
        const created = await call("/api/clients?mode=sim", cfg.adminToken, {
          name: `PG ${label}`,
          weight,
          callbackHosts: [hook],
        });
        assert.equal(created.status, 201, JSON.stringify(created.value));
        clients.push(created.value);
      }
      const stored = (
        await store.pool.query("SELECT status, document FROM mx_device.clients")
      ).rows;
      assert.equal(stored.length, 2);
      for (const row of stored) {
        assert.match(row.document.keyHash, /^[0-9a-f]{64}$/);
        for (const c of clients)
          assert.equal(JSON.stringify(row.document).includes(c.key), false);
      }
      // Six jobs each; every other one asks for a callback.
      const jobs = [];
      for (const [i, c] of clients.entries())
        for (let k = 0; k < 6; k++) {
          const r = await call("/v1/jobs", c.key, {
            clientRequestId: `pg-${i}-${k}`,
            template: k % 2 ? "xhs.detail" : "weibo.list",
            params: { keyword: `k${k}`, target: `t${k}` },
            ...(k % 2 === 0 && { callback: { url: `${hook}/cb` } }),
          });
          assert.equal(r.status, 202, JSON.stringify(r.value));
          jobs.push({ key: c.key, id: r.value.jobId, callback: k % 2 === 0 });
        }
      engine = new Engine(store, { workerId: "pg-clients" });
      engine.start();
      for (const j of jobs) {
        let v;
        for (let n = 0; n < 6; n++) {
          v = (await call(`/v1/jobs/${j.id}/wait?timeout=20`, j.key)).value;
          if (v.final) break;
        }
        assert.equal(v.status, "succeeded", JSON.stringify(v));
        assert.equal(v.result.schema, "mx-device.result.v1");
      }
      // Each callback delivered once, signed with its client's secret.
      const wanted = jobs.filter((j) => j.callback).length;
      for (let n = 0; n < 100 && received.length < wanted; n++)
        await new Promise((r) => setTimeout(r, 100));
      assert.equal(received.length, wanted);
      const ids = new Set(received.map((r) => r.headers["x-mx-delivery-id"]));
      assert.equal(ids.size, wanted);
      for (const r of received) {
        const payload = JSON.parse(r.body);
        const owner = clients.find((c) =>
          jobs.some((j) => j.id === payload.job.jobId && j.key === c.key),
        );
        assert(verifySignature(owner.callbackSecret, r.headers, r.body));
      }
      const outbox = (
        await store.pool.query(
          "SELECT status, attempts FROM mx_device.outbox ORDER BY created_at",
        )
      ).rows;
      for (
        let n = 0;
        n < 50 && outbox.some((o) => o.status !== "delivered");
        n++
      ) {
        await new Promise((r) => setTimeout(r, 100));
        outbox.splice(
          0,
          outbox.length,
          ...(
            await store.pool.query(
              "SELECT status, attempts FROM mx_device.outbox",
            )
          ).rows,
        );
      }
      assert.equal(outbox.length, wanted);
      assert(outbox.every((o) => o.status === "delivered" && o.attempts === 1));
      // Usage rows were appended by execution and are folded by the realm.
      await engine.close();
      engine = null;
      await store.atomic(() => null, { mode: "sim" });
      assert.equal(
        (
          await store.pool.query(
            "SELECT count(*)::int AS n FROM mx_device.client_usage",
          )
        ).rows[0].n,
        0,
      );
      const after = (await store.snapshot("sim")).clients;
      for (const c of after) {
        assert.equal(c.usage.succeeded, 6);
        assert.equal(c.usage.claimed, 6);
        assert(c.usage.servedMs > 0);
        assert(c.fair.vruntime > 0);
      }
      // Own jobs only, newest first, through the client index.
      const listed = await call("/v1/jobs?limit=10", clients[0].key);
      assert.equal(listed.value.jobs.length, 6);
      assert(
        listed.value.jobs.every((j) => j.clientRequestId.startsWith("pg-0-")),
      );
      // Two replicas claiming the same due delivery: only one gets it.
      await store.pool.query(
        "UPDATE mx_device.outbox SET status='pending', next_at=0, locked_until=0 WHERE id=(SELECT id FROM mx_device.outbox LIMIT 1)",
      );
      await deliverer.stop();
      deliverer = null;
      const [x, y] = await Promise.all([
        store.claimDeliveries({ limit: 5 }),
        store.claimDeliveries({ limit: 5 }),
      ]);
      assert.equal(x.length + y.length, 1);
      assert.equal(
        (await store.claimDeliveries({ limit: 5 })).length,
        0,
        "locked",
      );
      assert.equal(
        (await store.jobStatuses("sim", [jobs[0].id, randomUUID()])).size,
        1,
      );
    } finally {
      await engine?.close();
      await deliverer?.stop();
      if (server) await new Promise((r) => server.close(r));
      await new Promise((r) => receiver.close(r));
      await store.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
