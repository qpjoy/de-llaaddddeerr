import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { PgStore } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import { register } from "../server/model.mjs";
import { addWorkflow } from "../server/workflows.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { initialAccount, recordAccountSignal } from "../server/accounts.mjs";

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres: account seeds match code, executions charge accounts in row-scoped transactions",
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
    let engine;
    try {
      await store.migrate();
      const ids = await store.atomic(
        (s, n) => {
          for (let i = 0; i < 3; i++)
            register(s, n, "sim", { name: `A${i}`, rack: "acct", host: "h" });
          for (const d of s.devices) d.taskIntervalMs = 0;
          configureLoops(s, n, "sim", {
            rack: "acct",
            revision: 0,
            commandDelayMs: 200,
            cooldownMinMs: 0,
            cooldownMaxMs: 0,
          });
          return Array.from(
            { length: 6 },
            (_, i) =>
              addWorkflow(s, n, "sim", {
                key: `acct-${i}`,
                definitionId: "sim:weibo.list:1",
                rack: "acct",
                keyword: "k",
                target: "t",
              }).id,
          );
        },
        { mode: "sim" },
      );
      // The 011 seed SQL builds the same document code builds for a new row.
      const sql = await readFile(
        new URL("../migrations/011_accounts.sql", import.meta.url),
        "utf8",
      );
      const insert = sql.slice(sql.indexOf("INSERT INTO mx_device.accounts"));
      const created = (
        await store.pool.query(
          "SELECT document FROM mx_device.accounts ORDER BY id",
        )
      ).rows.map((r) => r.document);
      assert.equal(created.length, 6, "3 devices × 2 Apps");
      await store.pool.query("DELETE FROM mx_device.accounts");
      await store.pool.query(insert);
      const seeded = (
        await store.pool.query(
          "SELECT document FROM mx_device.accounts ORDER BY id",
        )
      ).rows.map((r) => r.document);
      assert.deepEqual(
        seeded,
        created.map((a) => ({
          ...initialAccount(a.mode, a.appId, a.accountKey, 0),
        })),
      );

      engine = new Engine(store, {
        workerId: "acct",
        maxSimulationInflight: 3,
      });
      engine.start();
      for (let i = 0; ; i++) {
        const s = await store.snapshot("sim");
        if (
          s.jobs
            .filter((j) => ids.includes(j.id))
            .every((j) => j.status === "succeeded")
        )
          break;
        if (i > 200) throw Error("jobs did not finish");
        await sleep(100);
      }
      await engine.close();
      engine = null;
      const rows = (
        await store.pool.query(
          "SELECT status, document FROM mx_device.accounts WHERE app_id='weibo'",
        )
      ).rows;
      assert.equal(
        rows.reduce((n, r) => n + r.document.totals.sessions, 0),
        6,
        "every session charged its account exactly once",
      );
      for (const r of rows) {
        assert.equal(r.status, r.document.status);
        assert(r.document.totals.serviceMs >= r.document.totals.sessions * 300);
        assert.deepEqual(r.document.runs, [], "no stale reservations");
      }
      // Concurrent signal and status writes keep both changes (row versions).
      const id = rows[0].document.id;
      await Promise.all([
        store.atomic(
          (s, n) => recordAccountSignal(s, n, "sim", id, { kind: "captcha" }),
          { mode: "sim" },
        ),
        store.atomic(
          (s, n) =>
            recordAccountSignal(s, n, "sim", id, { kind: "rate-limited" }),
          { mode: "sim" },
        ),
      ]);
      const after = (
        await store.pool.query(
          "SELECT status, document FROM mx_device.accounts WHERE id=$1",
          [id],
        )
      ).rows[0];
      assert.equal(after.status, "review");
      assert.equal(after.document.signals.length, 2);
    } finally {
      await engine?.close();
      await store.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
