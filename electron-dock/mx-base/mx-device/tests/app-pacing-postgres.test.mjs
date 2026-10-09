import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PgStore } from "../server/store.mjs";
import {
  register,
  addJob,
  claim,
  markDispatch,
  finish,
  control,
} from "../server/model.mjs";
import { configurePacing } from "../server/pacing.mjs";
import { schedulingSnapshot } from "../server/scheduling.mjs";

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "PG upgrade, concurrent claims, durable App cooldown and account uniqueness",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(["127.0.0.1", "localhost"].includes(target.hostname));
    const name = `mx_device_apps_${randomBytes(5).toString("hex")}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    let a = new PgStore(target.href),
      b = new PgStore(target.href);
    try {
      // Upgrade an existing pre-ledger device, retaining its global deadline.
      await a.pool.query(
        await readFile(
          new URL("../migrations/001_device_center.sql", import.meta.url),
          "utf8",
        ),
      );
      const old = register(
        { devices: [], jobs: [], attempts: [], events: [] },
        1000,
        "sim",
        { name: "upgraded phone" },
      );
      old.cooldownUntil = 1234;
      await a.pool.query(
        "INSERT INTO mx_device.devices VALUES($1,$2,$3,$4,$5)",
        [old.id, old.mode, old.resourceKey, old.accountKey, old],
      );
      await Promise.all([a.migrate(), b.migrate()]);
      let snap = await a.snapshot("sim");
      assert.equal(snap.apps.length, 2);
      assert.equal(snap.devices[0].cooldownUntil, 1234);
      await a.atomic((s, n) => {
        const d = s.devices[0];
        control(s, n, "sim", d.id, { action: "pause", revision: d.revision });
        configurePacing(s, n, "sim", d.id, {
          revision: d.revision,
          deviceIntervalMs: 0,
          apps: [
            { appId: "xhs", cooldownMs: 60000 },
            { appId: "weibo", cooldownMs: 30000 },
          ],
        });
        control(s, n, "sim", d.id, { action: "enable", revision: d.revision });
        for (const [i, appId] of ["xhs", "xhs", "weibo"].entries())
          addJob(s, n + i, "sim", {
            key: `job-${i}`,
            appId,
            operation: "search",
            keyword: "race",
            priority: appId === "xhs" ? 1 : 5,
          });
      });
      const race = () =>
        Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            (i % 2 ? a : b).atomic((s, n) => claim(s, n, "sim", `worker-${i}`)),
          ),
        );
      const first = (await race()).filter(Boolean);
      assert.equal(first.length, 1);
      assert.equal(first[0].job.appId, "xhs");
      await a.atomic(
        (s, n) => {
          markDispatch(s, n, first[0].attempt);
          finish(s, n, first[0].attempt, { result: {} });
        },
        { attemptId: first[0].attempt.id },
      );
      const prior = (await a.snapshot("sim")).apps.find(
        (x) => x.appId === "xhs",
      );
      await a.close();
      a = new PgStore(target.href);
      await a.migrate();
      assert.deepEqual(
        (await a.snapshot("sim")).apps.find((x) => x.appId === "xhs"),
        prior,
      );
      const next = (await race()).filter(Boolean);
      assert.equal(next.length, 1);
      assert.equal(next[0].job.appId, "weibo");
      assert.equal(next[0].device.id, first[0].device.id);
      await b.atomic(
        (s, n) => {
          markDispatch(s, n, next[0].attempt);
          finish(s, n, next[0].attempt, { result: {} });
        },
        { attemptId: next[0].attempt.id },
      );
      assert((await race()).every((x) => x === null));
      snap = await a.snapshot("sim");
      assert.equal(snap.jobs.filter((j) => j.status === "queued").length, 1);
      const view = schedulingSnapshot(snap, snap.now, "sim");
      assert(view.queue[0].reasons.some((r) => r.code === "app-cooldown"));
      assert.equal((await b.snapshot("sim")).attempts.length, 2);
      // A lower policy cannot release a deadline persisted before process replacement.
      await a.atomic((s, n) => {
        const d = s.devices[0];
        control(s, n, "sim", d.id, { action: "pause", revision: d.revision });
        configurePacing(s, n, "sim", d.id, {
          revision: d.revision,
          deviceIntervalMs: 0,
          apps: [
            { appId: "xhs", cooldownMs: 0 },
            { appId: "weibo", cooldownMs: 0 },
          ],
        });
      });
      assert.equal(
        (await b.snapshot("sim")).apps.find((x) => x.appId === "xhs")
          .cooldownUntil,
        prior.cooldownUntil,
      );
      const second = await a.atomic((s, n) =>
        register(s, n, "sim", { name: "second phone" }),
      );
      await assert.rejects(
        a.pool.query(
          "UPDATE mx_device.device_apps SET account_key=$1 WHERE device_id=$2 AND app_id='xhs'",
          [old.accountKey, second.id],
        ),
        { code: "23505" },
      );
      assert.equal(
        (await b.snapshot("sim")).apps.filter((x) => x.appId === "xhs").length,
        2,
      );
    } finally {
      await Promise.all([a.close(), b.close()]);
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  },
);
