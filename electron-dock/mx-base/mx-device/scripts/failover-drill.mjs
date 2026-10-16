// npm run drill:failover [-- --devices 20] [--serve <port>]
// Local leader-failover drill of the deployable processes: a disposable
// PostgreSQL, the API server and two worker processes sharing one workerId.
// It starts a simulated workstation demo, SIGKILLs the scheduler leader, and
// checks that the standby takes over and the remaining queued work completes.
// Work the killed leader was executing keeps its lease (180 s) and is then
// marked unknown + quarantined: that is the intended conservative semantics,
// so the drill reports it rather than waiting for it.
// --serve keeps everything running afterwards for manual UI inspection; the
// generated credentials stay in the temporary config file, never on stdout.
// Simulation only: no phones, PoC, ADB, Docker or project database.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:net";
import { startTempPostgres } from "./pg-temp.mjs";
import { PgStore } from "../server/store.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const devices = Number(arg("devices", "20"));
const servePort = arg("serve", null);
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const db = await startTempPostgres();
const children = [];
const stopAll = async () => {
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGTERM");
  await sleep(500);
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGKILL");
  await db.stop();
};
process.once("SIGINT", () => void stopAll().then(() => process.exit(130)));
try {
  const store = new PgStore(db.url);
  await store.migrate();
  await store.close();
  const port = Number(servePort || (await freePort()));
  const secret = () => randomBytes(24).toString("hex");
  const config = {
    databaseUrl: db.url,
    adminToken: secret(),
    testToken: secret(),
    host: "127.0.0.1",
    port,
    workerId: "drill-worker",
    maxSimulationInflight: 50,
  };
  const configPath = join(db.dir, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const env = {
    ...process.env,
    MX_DEVICE_CONFIG: configPath,
    MX_DEVICE_SKIP_STARTUP_MIGRATION: "1",
  };
  const start = (file, name) => {
    const health = join(db.dir, `${name}.instance`);
    const child = spawn(process.execPath, [file], {
      env: { ...env, MX_DEVICE_WORKER_HEALTH_FILE: health },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.healthFile = health;
    child.instanceId = () => readFile(health, "utf8").catch(() => null);
    child.name = name;
    child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
    children.push(child);
    return child;
  };
  const base = `http://127.0.0.1:${port}`;
  const api = async (path, body) => {
    const r = await fetch(
      `${base}/api/${path}${path.includes("?") ? "&" : "?"}mode=sim`,
      {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${config.testToken}`,
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    const json = await r.json();
    if (!r.ok) throw Error(`${path}: ${r.status} ${json.error}`);
    return json;
  };
  start("server/index.mjs", "api");
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/health/ready`)).ok) break;
    } catch {}
    if (i > 100) throw Error("API 未就绪");
    await sleep(100);
  }
  const workers = [
    start("server/worker.mjs", "worker-a"),
    start("server/worker.mjs", "worker-b"),
  ];
  const roles = async () => {
    const state = await api("state");
    return state.workers.filter(
      (w) => w.workerId === "drill-worker" && Date.now() - w.at < 5000,
    );
  };
  let live;
  for (let i = 0; ; i++) {
    live = await roles();
    if (live.filter((w) => w.scheduler).length === 2) break;
    if (i > 100) throw Error("两个 worker 未上线");
    await sleep(200);
  }
  const leaders = live.filter((w) => w.scheduler === "leader");
  // The container healthcheck must accept both the leader and the standby.
  for (const w of workers) {
    const status = spawnSync(process.execPath, ["server/worker-health.mjs"], {
      env: { ...env, MX_DEVICE_WORKER_HEALTH_FILE: w.healthFile },
      timeout: 8000,
    }).status;
    if (status !== 0) throw Error(`${w.name} 健康检查失败`);
  }
  console.log(
    `上线：${live.length} 个 worker 实例，领导者 ${leaders.length} 个（epoch ${leaders[0]?.epoch}），备用 ${live.filter((w) => w.scheduler === "standby").length} 个；两者容器健康检查通过`,
  );
  if (leaders.length !== 1) throw Error("领导者数量不是 1");

  await api("workstation-demo", {
    key: "drill",
    rack: "演练机架",
    deviceCount: devices,
    scenario: "mixed",
  });
  const counts = async () => {
    const state = await api("state");
    const jobs = state.jobs.filter((j) => j.runId === "drill");
    const by = (status) => jobs.filter((j) => j.status === status).length;
    return {
      total: jobs.length,
      queued: by("queued"),
      running: by("running"),
      succeeded: by("succeeded"),
      unknown: by("unknown"),
    };
  };
  for (let i = 0; ; i++) {
    const c = await counts();
    if (c.succeeded >= Math.ceil(c.total / 4)) {
      console.log(`故障前：${JSON.stringify(c)}`);
      break;
    }
    if (i > 300) throw Error("任务没有进展");
    await sleep(200);
  }
  // Crash the leader: no graceful shutdown; its session lock dies with the connection.
  const leaderInstance = leaders[0].instanceId;
  let victim = null;
  for (const w of workers)
    if ((await w.instanceId()) === leaderInstance) victim = w;
  if (!victim) throw Error("找不到领导者进程");
  victim.kill("SIGKILL");
  const killedAt = Date.now();
  let takeover;
  for (let i = 0; ; i++) {
    const after = await roles();
    const leader = after.find(
      (w) => w.scheduler === "leader" && w.instanceId !== leaderInstance,
    );
    if (leader) {
      takeover = { ms: Date.now() - killedAt, epoch: leader.epoch };
      break;
    }
    if (i > 150) throw Error("备用未接管");
    await sleep(100);
  }
  console.log(
    `领导者被强杀后 ${takeover.ms} ms 由备用接管（epoch ${takeover.epoch}）`,
  );
  // Work the standby placed finishes; what stays "running" afterwards was in
  // flight in the killed process and keeps its lease (180 s) before becoming
  // unknown + quarantined.
  let last = null,
    stableSince = Date.now();
  for (let i = 0; ; i++) {
    const c = await counts();
    if (JSON.stringify(c) !== JSON.stringify(last)) {
      last = c;
      stableSince = Date.now();
    } else if (!c.queued && Date.now() - stableSince > 5000) {
      console.log(
        `接管后稳定：${JSON.stringify(c)}；${c.running} 个会话是被强杀进程在途的工作，保持占用，租约到期后转为未知并隔离设备，不自动重派`,
      );
      break;
    }
    if (i > 900) throw Error("接管后排队任务没有完成");
    await sleep(200);
  }
  if (servePort) {
    console.log(
      `保持运行供页面检查：${base}（凭证在临时配置文件 ${configPath}）；Ctrl+C 结束`,
    );
    await new Promise(() => {});
  }
} finally {
  await stopAll();
}
