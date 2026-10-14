// npm run bench:pg -- [--jobs 0,10000,50000,100000] [--iterations 30] [--out file.json] [--plans]
// Measures how store transactions scale with history on a disposable local
// PostgreSQL. Live state: 100 sim devices, 100 running sessions, 100 queued
// jobs with the pool scheduler enabled. History is bulk-copied from documents
// produced by the real model, so row shapes and sizes are realistic.
// Never connects to the project database, phones, PoC, or any remote service.
import pg from "pg";
import { randomBytes } from "node:crypto";
import { statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { PgStore, MemoryStore, SQL } from "../server/store.mjs";
import { register, claim } from "../server/model.mjs";
import {
  addWorkflow,
  beginCommand,
  completeCommand,
  simulateCommand,
} from "../server/workflows.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { schedulingSnapshot } from "../server/scheduling.mjs";
import { planPool } from "../server/pool-planner.mjs";
import { startTempPostgres } from "./pg-temp.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const steps = arg("jobs", "0,10000,50000,100000")
  .split(",")
  .map(Number)
  .sort((a, b) => a - b);
const iterations = Number(arg("iterations", "30"));
const out = arg("out", null);
const printPlans = process.argv.includes("--plans");
if (steps.some((n) => !Number.isInteger(n) || n < 0) || !(iterations >= 3))
  throw Error("--jobs 须为非负整数列表，--iterations ≥ 3");

const RACK = "压测机架";
const DEFS = [
  "sim:xhs.detail:1",
  "sim:weibo.search:1",
  "sim:xianyu.refresh:1",
  "sim:pdd.search_detail_ocr:1",
  "sim:xhs.search10:1",
];
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
};
const ms = (n) => Math.round(n * 10) / 10;
async function time(fn) {
  const samples = [];
  let errors = 0;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    try {
      await fn();
      samples.push(performance.now() - start);
    } catch {
      errors++;
    }
  }
  return samples.length
    ? {
        p50: ms(percentile(samples, 0.5)),
        p95: ms(percentile(samples, 0.95)),
        max: ms(Math.max(...samples)),
        errors,
      }
    : { p50: null, p95: null, max: null, errors };
}

// One completed large session from the real model provides history templates.
async function templates() {
  let clock = 1_000_000;
  const m = new MemoryStore(() => clock);
  await m.atomic((s, n) => {
    register(s, n, "sim", {
      name: "模板",
      rack: "模板",
      host: "模板",
      simApps: ["pdd"],
    });
    addWorkflow(s, n, "sim", {
      key: "template",
      definitionId: "sim:pdd.search_detail_ocr:1",
      keyword: "模板关键词",
      target: "template-goods",
    });
  });
  for (let guard = 0; guard < 100; guard++) {
    clock += 2000;
    const work = await m.atomic((s, n) => claim(s, n, "sim", "template"));
    if (!work) break;
    const command = await m.atomic((s, n) => beginCommand(s, n, work.attempt));
    if (!command) continue;
    clock += 1400;
    await m.atomic((s, n) =>
      completeCommand(s, n, work.attempt, command, simulateCommand(command)),
    );
  }
  const { jobs, attempts, commands, events } = m.state;
  if (jobs[0]?.status !== "succeeded")
    throw Error("模板任务未完成，无法生成历史数据");
  return { job: jobs[0], attempt: attempts[0], commands, events };
}

function planSummary(plan) {
  const seq = new Set();
  const walk = (node) => {
    if (node["Node Type"] === "Seq Scan") seq.add(node["Relation Name"]);
    for (const child of node.Plans || []) walk(child);
  };
  walk(plan.Plan);
  return {
    executionMs: ms(plan["Execution Time"]),
    seqScans: [...seq].sort(),
    sharedBlocks:
      (plan.Plan["Shared Hit Blocks"] || 0) +
      (plan.Plan["Shared Read Blocks"] || 0),
  };
}

let temp = null;
let url = process.env.MX_DEVICE_TEST_DATABASE_URL;
if (url) {
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname))
    throw Error("压测只允许本机一次性 PostgreSQL");
} else {
  temp = await startTempPostgres();
  url = temp.url;
}
const admin = new pg.Client({ connectionString: url });
await admin.connect();
const version = (await admin.query("SHOW server_version")).rows[0]
  .server_version;
const dbName = `mx_device_bench_${randomBytes(4).toString("hex")}`;
await admin.query(`CREATE DATABASE ${dbName}`);
const target = new URL(url);
target.pathname = `/${dbName}`;
const store = new PgStore(target.href);
const bulk = new pg.Client({ connectionString: target.href });
const report = {
  at: new Date().toISOString(),
  postgres: version,
  iterations,
  live: {},
  steps: [],
};
try {
  await store.migrate();
  await bulk.connect();
  // ---- live state ----
  await store.atomic(
    (s, n) => {
      for (let i = 0; i < 100; i++)
        register(s, n, "sim", {
          name: `压测 ${String(i + 1).padStart(3, "0")}`,
          rack: RACK,
          host: `压测宿主机 ${(i % 5) + 1}`,
          simApps: ["xhs", "weibo", "xianyu", "pdd"],
        });
      configureLoops(s, n, "sim", {
        rack: RACK,
        revision: 0,
        scheduler: { enabled: true },
      });
    },
    { mode: "sim" },
  );
  await store.atomic(
    (s, n) => {
      for (let i = 0; i < 200; i++)
        addWorkflow(s, n, "sim", {
          key: `live:${i}`,
          definitionId: DEFS[i % DEFS.length],
          rack: RACK,
          keyword: `压测 ${i}`,
          target: `goods-${i}`,
        });
    },
    { mode: "sim" },
  );
  const running = [];
  while (running.length < 100) {
    const work = await store.atomic((s, n) => claim(s, n, "sim", "bench"), {
      mode: "sim",
    });
    if (!work) break;
    await store.atomic((s, n) => beginCommand(s, n, work.attempt), {
      mode: "sim",
      jobId: work.job.id,
      attemptId: work.attempt.id,
    });
    running.push(work);
  }
  const probe = running[0];
  const deviceIds = (
    await bulk.query("SELECT id FROM mx_device.devices WHERE mode='sim'")
  ).rows.map((r) => r.id);
  report.live = {
    devices: deviceIds.length,
    running: running.length,
    queued: 200 - running.length,
  };

  // ---- history templates ----
  const tpl = await templates();
  const strip = (doc) => {
    const { id, jobId, attemptId, deviceId, ...rest } = doc;
    return rest;
  };
  const jobTpl = strip(tpl.job),
    attemptTpl = strip(tpl.attempt),
    commandTpls = tpl.commands.map(strip),
    eventTpls = tpl.events.map(strip);
  const perJobBytes =
    JSON.stringify(jobTpl).length +
    JSON.stringify(attemptTpl).length +
    commandTpls.reduce((n, c) => n + JSON.stringify(c).length, 0) +
    eventTpls.reduce((n, e) => n + JSON.stringify(e).length, 0);
  report.history = {
    commandsPerJob: commandTpls.length,
    eventsPerJob: eventTpls.length,
    approxDocumentBytesPerJob: perJobBytes,
  };
  const need = steps.at(-1) * perJobBytes * 3 + 2 * 1024 ** 3;
  const fs = await statfs(temp?.dir || tmpdir());
  if (fs.bavail * fs.bsize < need)
    throw Error(
      `磁盘剩余 ${((fs.bavail * fs.bsize) / 1024 ** 3).toFixed(1)} GiB，不足以安全生成 ${steps.at(-1)} 个历史任务（约需 ${(need / 1024 ** 3).toFixed(1)} GiB）；请减小 --jobs`,
    );

  const base =
    Number(
      (await bulk.query("SELECT min(created_at) AS m FROM mx_device.jobs"))
        .rows[0].m,
    ) - 86400000;
  let have = 0;
  async function grow(to) {
    for (let from = have + 1; from <= to; from += 10000) {
      const end = Math.min(to, from + 9999);
      await bulk.query("BEGIN");
      await bulk.query(
        `INSERT INTO mx_device.jobs(id,mode,request_key,status,created_at,document)
         SELECT md5('j'||g)::uuid,'sim','bench:'||g,'succeeded',$3::bigint-g*10,
           $4::jsonb || jsonb_build_object('id',md5('j'||g)::uuid,'key','bench:'||g,'createdAt',$3::bigint-g*10)
         FROM generate_series($1::int,$2::int) g`,
        [from, end, base, jobTpl],
      );
      await bulk.query(
        `INSERT INTO mx_device.attempts(id,mode,job_id,device_id,status,created_at,document)
         SELECT md5('a'||g)::uuid,'sim',md5('j'||g)::uuid,($5::uuid[])[1+g%100],'succeeded',$3::bigint-g*10,
           $4::jsonb || jsonb_build_object('id',md5('a'||g)::uuid,'jobId',md5('j'||g)::uuid,'deviceId',($5::uuid[])[1+g%100])
         FROM generate_series($1::int,$2::int) g`,
        [from, end, base, attemptTpl, deviceIds],
      );
      await bulk.query(
        `INSERT INTO mx_device.execution_commands(id,mode,job_id,attempt_id,device_id,status,created_at,document)
         SELECT md5('c'||g||':'||k)::uuid,'sim',md5('j'||g)::uuid,md5('a'||g)::uuid,($5::uuid[])[1+g%100],'succeeded',$3::bigint-g*10+k,
           ($4::jsonb->(k-1)) || jsonb_build_object('id',md5('c'||g||':'||k)::uuid,'jobId',md5('j'||g)::uuid,'attemptId',md5('a'||g)::uuid,'deviceId',($5::uuid[])[1+g%100])
         FROM generate_series($1::int,$2::int) g, generate_series(1,$6::int) k`,
        [
          from,
          end,
          base,
          JSON.stringify(commandTpls),
          deviceIds,
          commandTpls.length,
        ],
      );
      await bulk.query(
        `INSERT INTO mx_device.events(mode,at,document)
         SELECT 'sim',$3::bigint-g*10+k,($4::jsonb->(k-1)) || jsonb_build_object('jobId',md5('j'||g)::uuid)
         FROM generate_series($1::int,$2::int) g, generate_series(1,$5::int) k`,
        [from, end, base, JSON.stringify(eventTpls), eventTpls.length],
      );
      await bulk.query("COMMIT");
    }
    have = to;
    await bulk.query("ANALYZE");
  }

  const explain = async (sql, params) =>
    planSummary(
      (
        await bulk.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
          params,
        )
      ).rows[0]["QUERY PLAN"][0],
    );
  const commandPath = {
    mode: "sim",
    jobId: probe.job.id,
    attemptId: probe.attempt.id,
  };
  for (const n of steps) {
    const t0 = performance.now();
    await grow(n);
    const seedMs = Math.round(performance.now() - t0);
    const counts = (
      await bulk.query(
        `SELECT (SELECT count(*) FROM mx_device.jobs) AS jobs,
          (SELECT count(*) FROM mx_device.attempts) AS attempts,
          (SELECT count(*) FROM mx_device.execution_commands) AS commands,
          (SELECT count(*) FROM mx_device.events) AS events,
          pg_database_size(current_database()) AS bytes`,
      )
    ).rows[0];
    const plans = {
      atomicJobs: await explain(SQL.atomicJobs, [
        "sim",
        probe.job.id,
        null,
        probe.attempt.id,
      ]),
      atomicAttempts: await explain(SQL.atomicAttempts, [
        "sim",
        probe.attempt.id,
      ]),
      atomicCommands: await explain(SQL.atomicCommands, [
        "sim",
        probe.job.id,
        probe.attempt.id,
      ]),
      snapshotJobs: await explain(SQL.snapshotJobs, ["sim"]),
      snapshotAttempts: await explain(SQL.snapshotAttempts, ["sim"]),
      snapshotCommands: await explain(SQL.snapshotCommands, ["sim"]),
    };
    if (printPlans && n === steps.at(-1))
      for (const [key, params] of [
        ["atomicJobs", ["sim", probe.job.id, null, probe.attempt.id]],
        ["snapshotJobs", ["sim"]],
      ])
        console.log(
          `--- ${key}\n` +
            (
              await bulk.query(`EXPLAIN (ANALYZE, BUFFERS) ${SQL[key]}`, params)
            ).rows
              .map((r) => r["QUERY PLAN"])
              .join("\n"),
        );
    const device = deviceIds[0];
    const timings = {
      atomicNoop: await time(() => store.atomic(() => null, commandPath)),
      atomicTouchDevice: await time(() =>
        store.atomic((s) => {
          const d = s.devices.find((x) => x.id === device);
          d.benchTouch = (d.benchTouch || 0) + 1;
        }, commandPath),
      ),
      snapshot: await time(() => store.snapshot("sim")),
      apiState: await time(async () => {
        const state = await store.snapshot("sim");
        schedulingSnapshot(state, state.now, "sim");
      }),
    };
    const state = await store.snapshot("sim");
    const planSamples = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      planPool(state, state.now, { rack: RACK });
      planSamples.push(performance.now() - start);
    }
    const row = {
      historyJobs: n,
      seedMs,
      rows: {
        jobs: Number(counts.jobs),
        attempts: Number(counts.attempts),
        commands: Number(counts.commands),
        events: Number(counts.events),
      },
      databaseMiB: Math.round(Number(counts.bytes) / 1024 ** 2),
      plans,
      timings,
      planPoolMs: {
        p50: ms(percentile(planSamples, 0.5)),
        max: ms(Math.max(...planSamples)),
      },
    };
    report.steps.push(row);
    const seq = [
      ...new Set(Object.values(plans).flatMap((p) => p.seqScans)),
    ].join(",");
    console.log(
      `history=${n} jobs=${row.rows.jobs} commands=${row.rows.commands} events=${row.rows.events} db=${row.databaseMiB}MiB | ` +
        `atomic noop p50/p95=${timings.atomicNoop.p50}/${timings.atomicNoop.p95}ms ` +
        `touch=${timings.atomicTouchDevice.p50}/${timings.atomicTouchDevice.p95}ms ` +
        `snapshot=${timings.snapshot.p50}/${timings.snapshot.p95}ms ` +
        `api/state=${timings.apiState.p50}/${timings.apiState.p95}ms ` +
        `planPool=${row.planPoolMs.p50}ms | seq scans: ${seq || "none"}`,
    );
  }
  // Where one store transaction's time goes at the largest step: every load
  // query (client round-trip, including row transfer and JSON parsing) versus
  // the in-process clone/serialize/diff work in PgStore.atomic.
  const loads = [
    [
      "devices",
      "SELECT document FROM mx_device.devices WHERE mode=$1",
      ["sim"],
    ],
    ["jobs", SQL.atomicJobs, ["sim", probe.job.id, null, probe.attempt.id]],
    ["attempts", SQL.atomicAttempts, ["sim", probe.attempt.id]],
    [
      "resource_policies",
      "SELECT document FROM mx_device.resource_policies WHERE mode=$1",
      ["sim"],
    ],
    [
      "device_apps",
      "SELECT document FROM mx_device.device_apps WHERE mode=$1",
      ["sim"],
    ],
    [
      "task_definitions",
      "SELECT document FROM mx_device.task_definitions WHERE mode=$1",
      ["sim"],
    ],
    [
      "command_definitions",
      "SELECT document FROM mx_device.command_definitions WHERE mode=$1",
      ["sim"],
    ],
    [
      "loop_policies",
      "SELECT document FROM mx_device.loop_policies WHERE mode=$1",
      ["sim"],
    ],
    [
      "rule_definitions",
      "SELECT document FROM mx_device.rule_definitions WHERE mode=$1",
      ["sim"],
    ],
    [
      "strategy_definitions",
      "SELECT document FROM mx_device.strategy_definitions WHERE mode=$1",
      ["sim"],
    ],
    [
      "execution_commands",
      SQL.atomicCommands,
      ["sim", probe.job.id, probe.attempt.id],
    ],
  ];
  const breakdown = [];
  for (const [name, sql, params] of loads) {
    const samples = [];
    let rows = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      rows = (await bulk.query(sql, params)).rows;
      samples.push(performance.now() - start);
    }
    breakdown.push({
      load: name,
      rows: rows.length,
      kib: Math.round(JSON.stringify(rows).length / 1024),
      p50Ms: ms(percentile(samples, 0.5)),
    });
  }
  const queryMs = breakdown.reduce((n, b) => n + b.p50Ms, 0);
  report.atomicBreakdown = {
    loads: breakdown,
    queriesP50SumMs: ms(queryMs),
    atomicNoopP50Ms: report.steps.at(-1).timings.atomicNoop.p50,
    inProcessAndTxMs: ms(report.steps.at(-1).timings.atomicNoop.p50 - queryMs),
  };
  console.log(
    "atomic breakdown: " +
      breakdown
        .map((b) => `${b.load} ${b.rows}行/${b.kib}KiB/${b.p50Ms}ms`)
        .join("; ") +
      ` | 查询合计 ${ms(queryMs)}ms，事务内其余（克隆/序列化/对比/BEGIN/锁/COMMIT）${report.atomicBreakdown.inProcessAndTxMs}ms`,
  );
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report, null, 2));
} finally {
  await bulk.end().catch(() => {});
  await store.close().catch(() => {});
  await admin
    .query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    .catch(() => {});
  await admin.end().catch(() => {});
  if (temp) await temp.stop();
}
