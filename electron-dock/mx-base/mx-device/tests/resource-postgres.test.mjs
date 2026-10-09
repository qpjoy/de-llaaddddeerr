import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { PgStore } from "../server/store.mjs";
import { register, addJob, claim, finish, control } from "../server/model.mjs";
import { controlResource } from "../server/resources.mjs";
import { schedulingSnapshot } from "../server/scheduling.mjs";

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres resource policies survive reconnect and serialize quotas, drains and claims",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(["127.0.0.1", "localhost"].includes(target.hostname));
    const name = `mx_device_resource_${randomBytes(5).toString("hex")}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    let a = new PgStore(target.href),
      b = new PgStore(target.href);
    try {
      await a.migrate();
      await a.atomic((s, n) => {
        for (let i = 0; i < 4; i++) {
          register(s, n, "sim", {
            name: `phone-${i}`,
            rack: "rack",
            host: `host-${i % 2}`,
          });
          addJob(s, n, "sim", {
            key: `job-${i}`,
            operation: "search",
            keyword: "quota",
            rack: "rack",
          });
        }
        controlResource(s, n, "sim", {
          scope: "rack",
          rack: "rack",
          action: "limit",
          maxConcurrent: 2,
          revision: 0,
        });
        for (const host of ["host-0", "host-1"])
          controlResource(s, n, "sim", {
            scope: "host",
            rack: "rack",
            host,
            action: "limit",
            maxConcurrent: 1,
            revision: 0,
          });
      });
      const claims = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? a : b).atomic((s, n) => claim(s, n, "sim", `worker-${i}`)),
        ),
      );
      const work = claims.filter(Boolean);
      assert.equal(work.length, 2);
      assert.equal(new Set(work.map((w) => w.device.host)).size, 2);
      const drain = await b.atomic((s, n) =>
        controlResource(s, n, "sim", {
          scope: "rack",
          rack: "rack",
          action: "drain",
          revision: 1,
        }),
      );
      for (const w of work)
        await a.atomic((s, n) => finish(s, n, w.attempt, { result: {} }), {
          attemptId: w.attempt.id,
        });
      await a.close();
      a = new PgStore(target.href);
      let view = await a.snapshot("sim");
      assert.equal(view.resources.length, 3);
      assert(view.devices.every((d) => !d.enabled));
      assert.equal(
        schedulingSnapshot(view, view.now, "sim").groups.find(
          (g) => g.scope === "rack",
        ).draining,
        true,
      );
      assert.equal(await a.atomic((s, n) => claim(s, n, "sim", "w")), null);
      await a.atomic((s, n) =>
        controlResource(s, n, "sim", {
          scope: "rack",
          rack: "rack",
          action: "release",
          revision: drain.revision,
        }),
      );
      assert.equal(await b.atomic((s, n) => claim(s, n, "sim", "w")), null);
      await a.atomic((s, n) => {
        for (const d of s.devices)
          control(s, n, "sim", d.id, {
            action: "enable",
            revision: d.revision,
          });
      });
      const resumed = await b.atomic((s, n) => claim(s, n + 1000, "sim", "w"));
      assert(resumed);
      assert.equal(
        (await a.snapshot("sim")).jobs.filter((j) => j.status === "queued")
          .length,
        1,
      );
      // An old source and an active attempt must remain visible behind a long terminal history.
      await a.atomic(
        (s, n) => {
          addJob(s, n, "sim", {
            key: "dependent",
            operation: "note",
            sourceJobId: work[0].job.id,
          });
          for (let i = 0; i < 105; i++) {
            const j = addJob(s, n + i + 1000, "sim", {
              key: `history-${i}`,
              operation: "search",
              keyword: "history",
            });
            j.status = "cancelled";
            j.completedAt = n;
          }
        },
        { jobId: work[0].job.id },
      );
      view = await b.snapshot("sim");
      assert(view.jobs.some((j) => j.id === work[0].job.id));
      assert(
        view.attempts.some(
          (a) => a.id === resumed.attempt.id && a.status === "running",
        ),
      );
      assert(view.jobs.every((j) => !Object.hasOwn(j, "result")));
      await a.migrate();
      assert.equal((await b.snapshot("sim")).resources.length, 3);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  },
);
