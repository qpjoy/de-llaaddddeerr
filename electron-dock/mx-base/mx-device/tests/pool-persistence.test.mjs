import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PgStore } from "../server/store.mjs";
import { register, addJob, claim } from "../server/model.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import {
  saveDefinition,
  beginCommand,
  completeCommand,
  simulateCommand,
} from "../server/workflows.mjs";

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres pool: concurrent admission, budget rest, policy patch and calibrated receipts survive restart",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(["localhost", "127.0.0.1"].includes(target.hostname));
    const name = `mx_pool_${randomBytes(5).toString("hex")}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    let a = new PgStore(target.href),
      b = new PgStore(target.href);
    const options = { mode: "sim" };
    try {
      await Promise.all([a.migrate(), b.migrate()]);
      assert(
        (await a.snapshot("sim")).definitions.some(
          (d) => d.id === "sim:xianyu.refresh:1",
        ),
      );
      const { device, first } = await a.atomic((s, n) => {
        const device = register(s, n, "sim", {
          name: "pool persisted slot",
          rack: "pool-test",
          simApps: ["xhs", "xianyu"],
          simCommandCodes: ["app.open", "xhs.list", "xianyu.refresh"],
        });
        device.taskIntervalMs = 0;
        configureLoops(s, n, "sim", {
          rack: "pool-test",
          revision: 0,
          smallLimit: 100,
          largeLimit: 100,
          cooldownMinMs: 0,
          cooldownMaxMs: 0,
          scheduler: {
            appDefaults: { maxRuns: 1, windowMs: 1000, cooldownMs: 5000 },
          },
        });
        const def = saveDefinition(s, n, "sim", {
          code: "pool.receipts",
          name: "pool timing receipts",
          appId: "xhs",
          loop: "small",
          expectedVersion: 0,
          steps: [
            { code: "app.open", repeat: 1 },
            { code: "xhs.list", repeat: 3 },
          ],
        });
        const first = addJob(s, n, "sim", {
          key: "first",
          definitionId: def.id,
          rack: "pool-test",
        });
        addJob(s, n, "sim", {
          key: "second",
          definitionId: def.id,
          rack: "pool-test",
        });
        return { device, first };
      }, options);
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? a : b).atomic(
            (s, n) => claim(s, n, "sim", `worker-${i}`),
            options,
          ),
        ),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      const work = claims.find(Boolean);
      // Either equal-priority job may win the UUID FIFO tie; only one can own it.
      const o = { ...options, jobId: work.job.id, attemptId: work.attempt.id };
      for (let n = 0; n < 4; n++) {
        const c = await a.atomic(
          (s, now) => beginCommand(s, now, work.attempt),
          o,
        );
        assert(c);
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert(
          await b.atomic(
            (s, now) =>
              completeCommand(s, now, work.attempt, c, simulateCommand(c)),
            o,
          ),
        );
      }
      const before = await a.snapshot("sim");
      const app = before.apps.find(
        (x) => x.deviceId === device.id && x.appId === "xhs",
      );
      assert.equal(app.poolRuns.length, 1);
      assert.equal(app.poolRuns[0].attemptId, work.attempt.id);
      assert(app.poolRuns[0].actualServiceMs > 0);
      assert(app.poolRestUntil > before.now);
      const timingKey = `${first.workflow.definitionId}/xhs.list`;
      assert.equal(before.devices[0].commandTimings[timingKey].count, 3);
      assert(before.devices[0].commandTimings[timingKey].p90Ms > 0);
      await a.atomic(
        (s, n) =>
          configureLoops(s, n, "sim", {
            rack: "pool-test",
            revision: 1,
            scheduler: { enabled: false, maxAffinityDelayMs: 700 },
          }),
        options,
      );
      await Promise.all([a.close(), b.close()]);
      a = new PgStore(target.href);
      b = new PgStore(target.href);
      const after = await a.snapshot("sim");
      assert.equal(after.loopPolicies[0].revision, 2);
      assert.equal(after.loopPolicies[0].scheduler.maxAffinityDelayMs, 700);
      assert.equal(after.loopPolicies[0].scheduler.appDefaults.maxRuns, 1);
      assert.equal(
        after.apps.find((x) => x.id === app.id).poolRestUntil,
        app.poolRestUntil,
      );
      assert.deepEqual(
        after.devices[0].commandTimings,
        before.devices[0].commandTimings,
      );
      assert.deepEqual(after.devices[0].simApps, ["xhs", "xianyu"]);
      assert.deepEqual(after.devices[0].simCommandCodes, [
        "app.open",
        "xhs.list",
        "xianyu.refresh",
      ]);
      const blocked = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? a : b).atomic(
            (s, n) => claim(s, n, "sim", `retry-${i}`),
            options,
          ),
        ),
      );
      assert(blocked.every((x) => x === null));
      assert.equal((await a.snapshot("real")).devices.length, 0);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
