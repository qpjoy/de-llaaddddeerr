import { config } from "./config.mjs";
import { PgStore } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const cfg = await config(false),
  store = new PgStore(cfg.databaseUrl);
await store.ready();
const instanceId = randomUUID();
if (process.env.MX_DEVICE_WORKER_HEALTH_FILE)
  await writeFile(process.env.MX_DEVICE_WORKER_HEALTH_FILE, instanceId, {
    mode: 0o600,
  });
const engine = new Engine(store, { workerId: cfg.workerId, instanceId });
engine.start();
console.log(
  `MX Device worker ${cfg.workerId}; no ADB, Docker or restart control`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await engine.close();
    await store.close();
    process.exit(0);
  });
// Keep the worker alive; the engine's scan timer itself is intentionally unref'ed.
setInterval(() => {}, 60000);
