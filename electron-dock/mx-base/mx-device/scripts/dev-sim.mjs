// npm run dev:sim [-- --port 5180]
// Local UI preview on simulated devices only: a disposable PostgreSQL, the API
// and one simulation engine in this process, and the Vite dev server (with hot
// reload) proxying /api to it. Seeds a 10-device demo rack on the paced
// strategy so pacing, accounts and strategy tools have live data.
// The generated admin token is written to .runtime/dev-sim.json (mode 0600,
// git-ignored) and never printed. No phones, PoC, ADB, Docker or project
// database; everything is deleted on exit, and a run that was killed without
// cleanup is cleared on the next start.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer as createVite } from "vite";
import { startTempPostgres } from "./pg-temp.mjs";
import { PgStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { Engine } from "../server/engine.mjs";
import { register } from "../server/model.mjs";
import { launchWorkstationDemo } from "../server/workstation.mjs";
import { resolveStrategy } from "../server/strategy-registry.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const uiPort = Number(arg("port", "5180"));
const credentials = resolve(".runtime/dev-sim.json");

const previous = await readFile(credentials, "utf8")
  .then(JSON.parse)
  .catch(() => null);
if (previous?.pid) {
  let alive = false;
  try {
    process.kill(previous.pid, 0);
    alive = true;
  } catch {}
  if (alive) throw Error(`模拟预览已在运行（进程 ${previous.pid}）`);
  if (previous.dataDir?.includes("mx-device-pg-"))
    await rm(previous.dataDir, { recursive: true, force: true });
}

const db = await startTempPostgres();
const store = new PgStore(db.url);
let engine, api, vite;
const stop = async () => {
  await vite?.close();
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
  api = createApp({ store, cfg });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${api.address().port}`;
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
      },
    },
  });
  await vite.listen();
  console.log(
    `MX Device 模拟预览：http://127.0.0.1:${uiPort}（PostgreSQL ${db.version}；管理员令牌在 ${credentials}）；Ctrl+C 结束并删除临时数据`,
  );
} catch (error) {
  console.error(error);
  await stop();
}
