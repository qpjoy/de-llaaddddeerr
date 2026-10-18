// npm run dev:sim [-- --port 5180] [--load] [--hub [--hub-port 5190]]
// Local UI preview on simulated devices only: a disposable PostgreSQL, the API
// and one simulation engine in this process, and the Vite dev server (with hot
// reload) proxying /api to it. Seeds a 10-device demo rack on the paced
// strategy so pacing, accounts and strategy tools have live data, and a
// simulated host Agent (over the real Agent protocol) hosting a 6-device rack.
// Two Job API v1 callers are seeded; --hub also builds the UI and starts a
// simulated Hub (scripts/hub-sim.mjs) that embeds the workbench through its
// reverse proxy and submits jobs with callbacks and long-polls.
// The generated admin token is written to .runtime/dev-sim.json (mode 0600,
// git-ignored) and never printed. No phones, PoC, ADB, Docker or project
// database; everything is deleted on exit, and a run that was killed without
// cleanup is cleared on the next start.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer as createVite, build as viteBuild } from "vite";
import { startTempPostgres } from "./pg-temp.mjs";
import { PgStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { Engine } from "../server/engine.mjs";
import { register } from "../server/model.mjs";
import { launchWorkstationDemo } from "../server/workstation.mjs";
import {
  resolveStrategy,
  applyStrategy,
} from "../server/strategy-registry.mjs";
import { createAgent, adoptDevice } from "../server/agents.mjs";
import { addWorkflow } from "../server/workflows.mjs";
import { HostAgent } from "../server/agent/host-agent.mjs";
import { SimDriver } from "../server/agent/sim-driver.mjs";
import { createClient } from "../server/clients.mjs";
import { OutboxDeliverer } from "../server/outbox.mjs";
import { startHubSim } from "./hub-sim.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const uiPort = Number(arg("port", "5180"));
// --load: fill the simulation pool to 100 devices and ~2000 active tasks.
const load = process.argv.includes("--load");
// --hub: a simulated Hub embedding the workbench (needs a UI build).
const hub = process.argv.includes("--hub");
const hubPort = Number(arg("hub-port", String(uiPort + 10)));
const credentials = resolve(".runtime/dev-sim.json");

const previous = await readFile(credentials, "utf8")
  .then(JSON.parse)
  .catch(() => null);
if (previous?.pid) {
  // A preview that was just stopped may still be exiting: wait up to 5 s.
  const alive = () => {
    try {
      process.kill(previous.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 25 && alive(); i++)
    await new Promise((r) => setTimeout(r, 200));
  if (alive()) throw Error(`模拟预览已在运行（进程 ${previous.pid}）`);
  if (previous.dataDir?.includes("mx-device-pg-"))
    await rm(previous.dataDir, { recursive: true, force: true });
}

const db = await startTempPostgres();
const store = new PgStore(db.url);
let engine, api, vite, hostAgent, deliverer, hubSim;
const stop = async () => {
  await hubSim?.close();
  await vite?.close();
  await deliverer?.stop();
  await hostAgent?.stop();
  await engine?.close();
  await new Promise((r) => (api ? api.close(r) : r()));
  await store.close();
  await db.stop();
  await rm(credentials, { force: true });
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);

try {
  await store.migrate();
  await store.atomic(
    (s, n) => {
      for (const letter of ["A", "B"])
        register(s, n, "sim", {
          name: `模拟手机 ${letter}`,
          rack: "演示机架",
          host: "模拟宿主机",
        });
      launchWorkstationDemo(s, n, "sim", {
        key: "dev-sim",
        rack: "节奏预览机架",
        deviceCount: 10,
        scenario: "mixed",
        strategyId: resolveStrategy(s, "pool.paced").id,
      });
    },
    { mode: "sim" },
  );
  const cfg = {
    databaseUrl: db.url,
    adminToken: randomBytes(32).toString("hex"),
    testToken: randomBytes(32).toString("hex"),
    host: "127.0.0.1",
    port: 0,
    workerId: "dev-sim",
  };
  await mkdir(resolve(".runtime"), { recursive: true });
  await writeFile(
    credentials,
    JSON.stringify(
      { adminToken: cfg.adminToken, pid: process.pid, dataDir: db.dir },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  // Job API v1 callers: Hub's operations embed and one external customer.
  const callers = await store.atomic(
    (s, n) => ({
      ops: createClient(s, n, "sim", {
        name: "Hub 运维",
        embed: "ops",
        classes: ["interactive", "standard", "batch"],
        weight: 1,
      }),
      customer: createClient(s, n, "sim", {
        name: "外部客户 A",
        embed: "client",
        classes: ["interactive", "standard", "batch"],
        weight: 2,
        quotas: { maxQueued: 40, maxInflight: 6, ratePerMinute: 60, burst: 10 },
        callbackHosts: [`http://127.0.0.1:${hubPort}`],
      }),
    }),
    { mode: "sim" },
  );
  deliverer = new OutboxDeliverer(store).start();
  api = createApp({ store, cfg, deliverer });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${api.address().port}`;
  // A simulated host Agent over the real protocol, hosting its own rack.
  const { agent, token } = await store.atomic(
    (s, n) =>
      createAgent(s, n, "sim", {
        name: "模拟宿主机 Agent",
        host: "Agent 宿主机 1",
      }),
    { mode: "sim" },
  );
  const serials = Array.from(
    { length: 6 },
    (_, i) => `agent-sim-${String(i + 1).padStart(2, "0")}`,
  );
  hostAgent = new HostAgent({
    center: target,
    token,
    devices: serials.map((serial) => ({ serial })),
    driver: new SimDriver(),
  });
  await hostAgent.start();
  await store.atomic(
    (s, n) => {
      for (const serial of serials)
        adoptDevice(s, n, "sim", agent.id, {
          serial,
          name: `Agent ${serial.slice(-2)}`,
          rack: "Agent 机架",
          simApps: ["xhs", "weibo", "xianyu", "pdd"],
        });
      applyStrategy(s, n, "sim", {
        rack: "Agent 机架",
        revision: 0,
        strategyId: resolveStrategy(s, "pool.paced").id,
      });
      for (let i = 0; i < 18; i++)
        addWorkflow(s, n, "sim", {
          key: `dev-sim-agent-${i}`,
          definitionId: i % 2 ? "sim:xhs.detail:1" : "sim:weibo.list:1",
          rack: "Agent 机架",
          keyword: `Agent 主题 ${i + 1}`,
          target: `t${i}`,
        });
    },
    { mode: "sim" },
  );
  if (load)
    await store.atomic(
      (s, n) => {
        const free = 100 - s.devices.length;
        for (let i = 0; i < free; i++)
          register(s, n, "sim", {
            name: `压测 ${String(i + 1).padStart(3, "0")}`,
            rack: `压测机架 ${Math.floor(i / 25) + 1}`,
            host: `压测宿主机 ${Math.floor(i / 10) + 1}`,
            simApps: ["xhs", "weibo", "xianyu", "pdd"],
          });
        const racks = [
          ...new Set(
            s.devices
              .filter((d) => d.rack.startsWith("压测"))
              .map((d) => d.rack),
          ),
        ];
        for (const rack of racks)
          applyStrategy(s, n, "sim", {
            rack,
            revision: 0,
            strategyId: resolveStrategy(s, "pool.balanced").id,
          });
        const active = s.jobs.filter((j) =>
          ["queued", "running"].includes(j.status),
        ).length;
        for (let i = 0; i < 1990 - active; i++)
          addWorkflow(s, n, "sim", {
            key: `dev-sim-load-${i}`,
            definitionId: i % 2 ? "sim:xhs.detail:1" : "sim:weibo.list:1",
            rack: racks[i % racks.length],
            keyword: `压测 ${i + 1}`,
            target: `t${i}`,
          });
      },
      { mode: "sim" },
    );
  engine = new Engine(store, { workerId: cfg.workerId });
  engine.start();
  vite = await createVite({
    configFile: resolve("vite.config.mjs"),
    server: {
      host: "127.0.0.1",
      port: uiPort,
      strictPort: true,
      // Keep the browser's Host so the API's same-origin write check passes.
      proxy: {
        "/api": { target, changeOrigin: false },
        "/health": { target, changeOrigin: false },
        // Lets a CLI Agent (npm run agent:sim) connect through this port.
        "/agent": { target, changeOrigin: false },
        "/v1": { target, changeOrigin: false },
      },
    },
  });
  await vite.listen();
  if (hub) {
    // The embed routes serve the built UI (relative asset URLs).
    await viteBuild({
      configFile: resolve("vite.config.mjs"),
      logLevel: "warn",
    });
    hubSim = await startHubSim({
      center: target,
      port: hubPort,
      ops: { key: callers.ops.key },
      customer: {
        key: callers.customer.key,
        callbackSecret: callers.customer.callbackSecret,
        name: callers.customer.client.name,
      },
    });
    console.log(
      `模拟 Hub：${hubSim.url}（反向代理嵌入工作台、回调接收、自动提交演示任务）`,
    );
  }
  console.log(
    `MX Device 模拟预览：http://127.0.0.1:${uiPort}（PostgreSQL ${db.version}；管理员令牌在 ${credentials}）；Ctrl+C 结束并删除临时数据`,
  );
} catch (error) {
  console.error(error);
  await stop();
}
