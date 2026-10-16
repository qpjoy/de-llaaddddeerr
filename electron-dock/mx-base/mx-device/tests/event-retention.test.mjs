import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { MemoryStore, PgStore } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import {
  DEFAULT_EVENT_RETENTION,
  eventRetention,
} from "../server/retention.mjs";

const DAY = 86400000;
const pushEvents = (store, rows) =>
  store.atomic((s) => {
    for (const [mode, at, n] of rows)
      s.events.push({ id: `${mode}-${n}`, mode, at, type: "test", message: n });
  });

test("retention settings default, validate bounds and reject unknown keys", () => {
  const r = eventRetention();
  assert.deepEqual(
    { simDays: r.simDays, realDays: r.realDays, keepLatest: r.keepLatest },
    DEFAULT_EVENT_RETENTION,
  );
  assert.deepEqual(r.retentionMs, { sim: 7 * DAY, real: 90 * DAY });
  assert.equal(eventRetention({ simDays: 1 }).retentionMs.sim, DAY);
  assert.throws(() => eventRetention({ simDays: 0 }), /simDays/);
  assert.throws(() => eventRetention({ keepLatest: 10 }), /keepLatest/);
  assert.throws(() => eventRetention({ realDays: 1.5 }), /realDays/);
  assert.throws(() => eventRetention({ jobsDays: 3 }), /未知/);
  assert.throws(() => eventRetention([]), /对象/);
});

test("memory store prunes old events per realm but always keeps the newest", async () => {
  let clock = 100 * DAY;
  const store = new MemoryStore(() => clock);
  await pushEvents(store, [
    ["sim", clock - 10 * DAY, 1],
    ["sim", clock - 9 * DAY, 2],
    ["sim", clock - 8 * DAY, 3],
    ["sim", clock - DAY, 4],
    ["real", clock - 10 * DAY, 5],
    ["real", clock - 9 * DAY, 6],
  ]);
  const deleted = await store.pruneEvents({
    retentionMs: { sim: 7 * DAY, real: 30 * DAY },
    keepLatest: 2,
  });
  assert.deepEqual(deleted, { sim: 2, real: 0 });
  assert.deepEqual(
    store.state.events.map((e) => e.message),
    [3, 4, 5, 6],
    "sim keeps the newest two even though #3 is past retention; real is within 30 days",
  );
  assert.deepEqual(
    await store.pruneEvents({
      retentionMs: { sim: 7 * DAY, real: 30 * DAY },
      keepLatest: 2,
    }),
    { sim: 0, real: 0 },
  );
});

test("engine prunes once per period beside the scan loop and reports in heartbeat", async () => {
  const store = new MemoryStore();
  let calls = 0,
    fail = false;
  const original = store.pruneEvents.bind(store);
  store.pruneEvents = async (options) => {
    calls++;
    if (fail) throw Error("boom");
    return original(options);
  };
  const engine = new Engine(store, { pruneEveryMs: 60000 });
  await engine.tick();
  await engine.pruning;
  await engine.tick();
  assert.equal(calls, 1, "second tick within the period does not prune again");
  assert.deepEqual(engine.lastPrune.deleted, { sim: 0, real: 0 });
  assert.deepEqual(
    store.workers.find((w) => w.id === "local-worker").eventPrune,
    engine.lastPrune,
  );
  fail = true;
  engine.lastPruneAt = 0;
  await engine.tick();
  await engine.pruning;
  assert.equal(calls, 2);
  assert.match(engine.lastPrune.error, /事件清理失败/);
  assert.equal(
    engine.lastError,
    null,
    "prune failure does not stop scheduling",
  );
  await engine.close();
});

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres: event pruning deletes in batches by age, keeps newest per realm and snapshots",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(["127.0.0.1", "localhost"].includes(target.hostname));
    const name = `mx_device_test_${randomBytes(5).toString("hex")}`,
      admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    const store = new PgStore(target.href);
    try {
      await store.migrate();
      const versions = await store.pool.query(
        "SELECT name FROM mx_device.schema_migrations ORDER BY name",
      );
      assert.equal(versions.rows.at(-1).name, "012_pacing_rules.sql");
      const now = Number(
        (
          await store.pool.query(
            "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
          )
        ).rows[0].now,
      );
      // 25 old + 5 recent sim events, 12 old real events.
      await store.pool.query(
        `INSERT INTO mx_device.events(mode,at,document)
         SELECT 'sim', $1::bigint - (40-g)*86400000::bigint, jsonb_build_object('n',g) FROM generate_series(1,25) g
         UNION ALL SELECT 'sim', $1::bigint - g*1000::bigint, jsonb_build_object('n',100+g) FROM generate_series(1,5) g
         UNION ALL SELECT 'real', $1::bigint - (200-g)*86400000::bigint, jsonb_build_object('n',g) FROM generate_series(1,12) g`,
        [now],
      );
      const options = {
        retentionMs: { sim: 7 * DAY, real: 90 * DAY },
        keepLatest: 8,
        batchSize: 4,
        maxBatches: 3,
      };
      // Batches are bounded: 3 × 4 = 12 sim rows per run at most.
      assert.deepEqual(await store.pruneEvents(options), { sim: 12, real: 4 });
      assert.deepEqual(await store.pruneEvents(options), { sim: 10, real: 0 });
      assert.deepEqual(await store.pruneEvents(options), { sim: 0, real: 0 });
      const left = await store.pool.query(
        "SELECT mode,count(*)::int AS n FROM mx_device.events GROUP BY mode ORDER BY mode",
      );
      assert.deepEqual(left.rows, [
        { mode: "real", n: 8 },
        { mode: "sim", n: 8 },
      ]);
      const snapshot = await store.snapshot("sim");
      assert.equal(snapshot.events.length, 8);
      assert.equal(snapshot.events.at(-1).n, 105, "latest event retained");
    } finally {
      await store.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
