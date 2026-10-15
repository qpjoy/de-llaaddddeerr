import { config } from "./config.mjs";
import { PgStore } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { Leadership } from "./leadership.mjs";
import { eventRetention } from "./retention.mjs";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

// Capacity knobs from the worker config; invalid values stop startup.
const bounded = (value, fallback, min, max, name) => {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max)
    throw Error(`${name} 须为 ${min}–${max} 的整数`);
  return n;
};
const cfg = await config(false);
const maxSimulationInflight = bounded(
  cfg.maxSimulationInflight,
  10,
  1,
  200,
  "maxSimulationInflight",
);
const maxRealInflight = bounded(
  cfg.maxRealInflight,
  4,
  1,
  64,
  "maxRealInflight",
);
// Execution transactions are short and row-scoped; size the pool for them.
const store = new PgStore(cfg.databaseUrl, {
  max: bounded(cfg.poolSize, 10, 2, 64, "poolSize"),
});
await store.ready();
const instanceId = randomUUID();
if (process.env.MX_DEVICE_WORKER_HEALTH_FILE)
  await writeFile(process.env.MX_DEVICE_WORKER_HEALTH_FILE, instanceId, {
    mode: 0o600,
  });
// Invalid retention settings stop startup instead of silently keeping or deleting history.
const engine = new Engine(store, {
  workerId: cfg.workerId,
  instanceId,
  retention: eventRetention(cfg.eventRetention),
  leadership: new Leadership(cfg.databaseUrl, { instanceId }),
  maxSimulationInflight,
  maxRealInflight,
});
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
