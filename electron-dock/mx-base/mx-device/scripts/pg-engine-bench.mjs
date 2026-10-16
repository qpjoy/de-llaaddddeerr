// npm run bench:engine -- [--devices 100] [--jobs 200] [--inflight 100] [--pool] [--switch-cost 0] [--out file.json]
// Runs the real Engine + Leadership + PgStore on a disposable local PostgreSQL
// until every simulated job finishes, twice: per-device execution in row-scoped
// transactions (current) and the same work forced through realm transactions
// (the pre-V2-1 path). Simulation only; never touches phones or other services.
import pg from "pg";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { PgStore } from "../server/store.mjs";
import { Engine } from "../server/engine.mjs";
import { Leadership } from "../server/leadership.mjs";
import { register } from "../server/model.mjs";
import { addWorkflow } from "../server/workflows.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { startTempPostgres } from "./pg-temp.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const devices = Number(arg("devices", "100"));
const jobs = Number(arg("jobs", "200"));
const inflight = Number(arg("inflight", String(devices)));
const pool = process.argv.includes("--pool");
// Simulated App switch with --pool (0 keeps runs comparable across versions).
const switchCostMs = Number(arg("switch-cost", "0"));
const out = arg("out", null);
if (!(devices >= 1 && devices <= 100) || !(jobs >= 1 && jobs <= 200))
  throw Error("--devices 1–100，--jobs 1–200");

const DEFS = [
  "sim:xhs.detail:1",
  "sim:weibo.list:1",
  "sim:weibo.search_batch:1",
  "sim:xianyu.refresh:1",
  "sim:pdd.search_detail_ocr:1",
];
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] * 10) /
        10
    : null;
};

async function run(url, label, forceRealm) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const name = `mx_device_engine_${randomBytes(4).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const store = new PgStore(target.href, { max: 24 });
  const timings = { scoped: [], realm: [] };
  // Times every transaction; the baseline drops scope to force the realm path.
  const measured = Object.create(store);
  measured.atomic = async (fn, options = {}) => {
    const { scope, deviceId, ...rest } = options;
    const opts = forceRealm ? rest : options;
    const start = performance.now();
    try {
      return await store.atomic(fn, opts);
    } finally {
      timings[opts.scope ? "scoped" : "realm"].push(performance.now() - start);
    }
  };
  let engine;
  try {
    await store.migrate();
    const ids = await store.atomic(
      (s, n) => {
        for (let i = 0; i < devices; i++)
          register(s, n, "sim", {
            name: `E${String(i).padStart(3, "0")}`,
            rack: "吞吐",
            host: `H${i % 5}`,
            simApps: ["xhs", "weibo", "xianyu", "pdd"],
          });
        configureLoops(s, n, "sim", {
          rack: "吞吐",
          revision: 0,
          commandDelayMs: 200,
          cooldownMinMs: 0,
          cooldownMaxMs: 0,
          ...(pool ? { scheduler: { enabled: true, switchCostMs } } : {}),
        });
        return Array.from(
          { length: jobs },
          (_, i) =>
            addWorkflow(s, n, "sim", {
              key: `e${i}`,
              definitionId: DEFS[i % DEFS.length],
              rack: "吞吐",
              keyword: `k${i}`,
              target: `t${i}`,
            }).id,
        );
      },
      { mode: "sim" },
    );
    const commandsTotal = (
      await store.pool.query(
        "SELECT sum(jsonb_array_length(document->'workflow'->'plan'))::int AS n FROM mx_device.jobs",
      )
    ).rows[0].n;
    engine = new Engine(measured, {
      workerId: "bench",
      leadership: new Leadership(target.href, { instanceId: label }),
      maxSimulationInflight: inflight,
    });
    const started = performance.now();
    let peak = 0;
    engine.start();
    for (;;) {
      await sleep(250);
      peak = Math.max(peak, engine.simulationInflight.size);
      const { rows } = await store.pool.query(
        "SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS active, count(*) FILTER (WHERE status='succeeded')::int AS ok FROM mx_device.jobs WHERE id = ANY($1::uuid[])",
        [ids],
      );
      if (!rows[0].active) {
        const seconds = (performance.now() - started) / 1000;
        await engine.close();
        engine = null;
        const result = {
          label,
          succeeded: rows[0].ok,
          jobs,
          commands: commandsTotal,
          seconds: Math.round(seconds * 10) / 10,
          commandsPerSecond: Math.round((commandsTotal / seconds) * 10) / 10,
          peakConcurrentSessions: peak,
          conflictsRetried: store.conflicts,
          scopedTx: {
            count: timings.scoped.length,
            p50: percentile(timings.scoped, 0.5),
            p95: percentile(timings.scoped, 0.95),
          },
          realmTx: {
            count: timings.realm.length,
            p50: percentile(timings.realm, 0.5),
            p95: percentile(timings.realm, 0.95),
          },
        };
        console.log(
          `${label}: ${result.succeeded}/${jobs} 成功，${commandsTotal} 条指令，${result.seconds}s，${result.commandsPerSecond} 条/s，峰值并发 ${peak}，冲突重试 ${store.conflicts}；行级事务 ${result.scopedTx.count} 次 P50/P95 ${result.scopedTx.p50}/${result.scopedTx.p95}ms；域事务 ${result.realmTx.count} 次 P50/P95 ${result.realmTx.p50}/${result.realmTx.p95}ms`,
        );
        return result;
      }
      if (performance.now() - started > 600000) throw Error("超时 10 分钟");
    }
  } finally {
    await engine?.close();
    await store.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

let temp = null,
  url = process.env.MX_DEVICE_TEST_DATABASE_URL;
if (url) {
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname))
    throw Error("压测只允许本机一次性 PostgreSQL");
} else {
  temp = await startTempPostgres();
  url = temp.url;
}
try {
  const report = {
    at: new Date().toISOString(),
    devices,
    jobs,
    inflight,
    poolScheduler: pool,
    switchCostMs: pool ? switchCostMs : null,
    commandDelayMs: 200,
    runs: [
      await run(url, "行级事务（当前）", false),
      await run(url, "全部走域事务（V2-1 前）", true),
    ],
  };
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
} finally {
  if (temp) await temp.stop();
}
