// Row-level execution, optimistic writes and the single active scheduler on PostgreSQL.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PgStore } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import { Leadership } from "../server/leadership.mjs";
import { register, control } from "../server/model.mjs";
import { addWorkflow } from "../server/workflows.mjs";
import { configureLoops } from "../server/loop-policy.mjs";

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
async function database() {
  const target = new URL(url);
  assert(["127.0.0.1", "localhost"].includes(target.hostname));
  const name = `mx_device_test_${randomBytes(5).toString("hex")}`,
    admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  target.pathname = `/${name}`;
  return {
    url: target.href,
    async drop() {
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
// A fast simulated rack: 200 ms commands, no rests.
async function rack(store, devices, jobs) {
  return store.atomic(
    (s, n) => {
      for (let i = 0; i < devices; i++)
        register(s, n, "sim", {
          name: `R${i}`,
          rack: "行级",
          host: "H",
          simApps: ["xhs", "weibo"],
        });
      configureLoops(s, n, "sim", {
        rack: "行级",
        revision: 0,
        commandDelayMs: 200,
        cooldownMinMs: 0,
        cooldownMaxMs: 0,
      });
      for (const d of s.devices) d.taskIntervalMs = 0;
      return Array.from({ length: jobs }, (_, i) =>
        addWorkflow(s, n, "sim", {
          key: `row-${i}`,
          definitionId: i % 2 ? "sim:xhs.detail:1" : "sim:weibo.list:1",
          rack: "行级",
          keyword: `k${i}`,
          target: `t${i}`,
        }),
      ).map((j) => j.id);
    },
    { mode: "sim" },
  );
}
async function until(check, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error("等待超时");
    await sleep(100);
  }
}
const realmLock = async (connectionString) => {
  const c = new pg.Client({ connectionString });
  await c.connect();
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(1297634386,0)");
  return {
    async release() {
      await c.query("COMMIT");
      await c.end();
    },
  };
};

test(
  "Postgres: engine executes per-device work in row-scoped transactions; commands never overlap",
  { skip: !url },
  async () => {
    const db = await database();
    const store = new PgStore(db.url, { max: 10 });
    const engine = new Engine(store, {
      workerId: "row-worker",
      leadership: new Leadership(db.url, { instanceId: "row-1" }),
      maxSimulationInflight: 6,
    });
    try {
      await store.migrate();
      const ids = await rack(store, 6, 18);
      engine.start();
      const done = await until(async () => {
        const s = await store.snapshot("sim");
        const jobs = s.jobs.filter((j) => ids.includes(j.id));
        return jobs.every((j) => j.status === "succeeded") && s;
      });
      const worker = done.workers.find((w) => w.workerId === "row-worker");
      assert.match(
        worker.id,
        /^row-worker\//,
        "one heartbeat row per instance",
      );
      assert.equal(worker.scheduler, "leader");
      assert(worker.epoch >= 1);
      // The unique index makes overlap impossible; check the recorded intervals too.
      const { rows } = await store.pool.query(
        "SELECT device_id, (document->>'createdAt')::bigint AS s, (document->>'completedAt')::bigint AS e FROM mx_device.execution_commands ORDER BY device_id, s",
      );
      assert.equal(rows.length, 36);
      for (let i = 1; i < rows.length; i++)
        if (rows[i].device_id === rows[i - 1].device_id)
          assert(Number(rows[i].s) >= Number(rows[i - 1].e), "no overlap");
      const devices = new Set(rows.map((r) => r.device_id));
      assert(devices.size >= 4, "work spread across devices");
    } finally {
      await engine.close();
      await store.close();
      await db.drop();
    }
  },
);

test(
  "Postgres: scoped execution proceeds while the realm lock is held; realm work waits",
  { skip: !url },
  async () => {
    const db = await database();
    const store = new PgStore(db.url, { max: 6 });
    try {
      await store.migrate();
      const device = await store.atomic(
        (s, n) => register(s, n, "sim", { name: "锁", rack: "R", host: "H" }),
        { mode: "sim" },
      );
      const lock = await realmLock(db.url);
      let realmDone = false;
      const realm = store
        .atomic(
          (s) => {
            s.devices[0].note = "realm";
          },
          { mode: "sim" },
        )
        .then(() => (realmDone = true));
      // A device-scoped transaction does not queue behind the realm lock.
      const started = Date.now();
      await store.atomic(
        (s) => {
          s.devices[0].note = "scoped";
        },
        { mode: "sim", scope: "device", deviceId: device.id },
      );
      assert(Date.now() - started < 1000);
      await sleep(300);
      assert.equal(realmDone, false, "realm transaction waits for the lock");
      await lock.release();
      await realm;
      const row = (
        await store.pool.query(
          "SELECT document->>'note' AS note, version FROM mx_device.devices WHERE id=$1",
          [device.id],
        )
      ).rows[0];
      assert.equal(row.note, "realm");
      assert.equal(Number(row.version), 3, "insert, scoped write, realm write");
      // Scoped transactions refuse to touch collections they did not load.
      await assert.rejects(
        store.atomic((s) => s.jobs.length, {
          mode: "sim",
          scope: "device",
          deviceId: device.id,
        }),
        /未加载的集合：jobs/,
      );
    } finally {
      await store.close();
      await db.drop();
    }
  },
);

test(
  "Postgres: a realm write over a concurrently changed row retries instead of overwriting",
  { skip: !url },
  async () => {
    const db = await database();
    const store = new PgStore(db.url, { max: 6 });
    try {
      await store.migrate();
      const device = await store.atomic(
        (s, n) => register(s, n, "sim", { name: "并发", rack: "R", host: "H" }),
        { mode: "sim" },
      );
      // Another writer changes the row and holds it until after the realm
      // transaction has loaded the old version and tries to write.
      const other = new pg.Client({ connectionString: db.url });
      await other.connect();
      await other.query("BEGIN");
      await other.query(
        "UPDATE mx_device.devices SET document=jsonb_set(document,'{name}','\"已改名\"'),version=version+1 WHERE id=$1",
        [device.id],
      );
      let runs = 0;
      const paused = store.atomic(
        (s, n) => {
          runs++;
          const d = s.devices.find((x) => x.id === device.id);
          return control(s, n, "sim", d.id, {
            action: "pause",
            revision: d.revision,
          });
        },
        { mode: "sim" },
      );
      await sleep(300);
      await other.query("COMMIT");
      await other.end();
      const result = await paused;
      assert.equal(runs, 2, "first run conflicted, second run saw the new row");
      assert.equal(store.conflicts, 1);
      assert.equal(result.enabled, false);
      const doc = (
        await store.pool.query(
          "SELECT document FROM mx_device.devices WHERE id=$1",
          [device.id],
        )
      ).rows[0].document;
      assert.equal(doc.name, "已改名", "concurrent write preserved");
      assert.equal(doc.enabled, false, "realm write applied on top");
    } finally {
      await store.close();
      await db.drop();
    }
  },
);

test(
  "Postgres: one active scheduler; a stale epoch cannot commit; a standby takes over",
  { skip: !url },
  async () => {
    const db = await database();
    const store = new PgStore(db.url, { max: 8 });
    const a = new Leadership(db.url, { instanceId: "A" }),
      b = new Leadership(db.url, { instanceId: "B" });
    let first, second;
    try {
      await store.migrate();
      const epochA = await a.check();
      assert(epochA >= 1);
      assert.equal(await b.check(), null, "only one leader");
      assert.equal(await a.check(), epochA, "leadership is sticky");
      await store.atomic(() => null, { mode: "sim", epoch: epochA });
      await a.close();
      const epochB = await b.check();
      assert.equal(epochB, epochA + 1);
      await assert.rejects(
        store.atomic(
          (s, n) => register(s, n, "sim", { name: "旧领导", rack: "R" }),
          { mode: "sim", epoch: epochA },
        ),
        (error) => error.code === "MXLEADER",
      );
      assert.equal(
        (
          await store.pool.query(
            "SELECT count(*)::int AS n FROM mx_device.devices",
          )
        ).rows[0].n,
        0,
        "stale leader's placement was not committed",
      );
      // The epoch bump waits for an in-flight scheduling transaction of the old leader.
      await b.close();
      const holder = new pg.Client({ connectionString: db.url });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query(
        "SELECT epoch FROM mx_device.scheduler_leader WHERE id=1 FOR SHARE",
      );
      let acquired = null;
      const pending = a.check().then((e) => (acquired = e));
      await sleep(300);
      assert.equal(
        acquired,
        null,
        "new leader waits for the fenced transaction",
      );
      await holder.query("COMMIT");
      await holder.end();
      assert.equal(await pending, epochB + 1);
      await a.close();

      // Two engines: only the leader places simulation work.
      const ids = await rack(store, 4, 8);
      first = new Engine(store, {
        workerId: "first",
        leadership: new Leadership(db.url, { instanceId: "first" }),
        maxSimulationInflight: 2,
      });
      second = new Engine(store, {
        workerId: "second",
        leadership: new Leadership(db.url, { instanceId: "second" }),
        maxSimulationInflight: 2,
      });
      await first.tick();
      await second.tick();
      assert.notEqual(first.epoch, null);
      assert.equal(second.epoch, null);
      const owners = async () =>
        (
          await store.pool.query(
            "SELECT DISTINCT document->>'workerId' AS w FROM mx_device.attempts",
          )
        ).rows.map((r) => r.w);
      assert.deepEqual(await owners(), ["first"]);
      // The leader stops; the standby becomes leader and finishes the rest.
      await first.close();
      first = null;
      second.start();
      await until(async () => {
        const s = await store.snapshot("sim");
        return s.jobs
          .filter((j) => ids.includes(j.id))
          .every((j) => j.status === "succeeded");
      });
      assert.deepEqual((await owners()).sort(), ["first", "second"]);
      assert(second.epoch > epochB + 1);
    } finally {
      await first?.close();
      await second?.close();
      await a.close();
      await b.close();
      await store.close();
      await db.drop();
    }
  },
);
