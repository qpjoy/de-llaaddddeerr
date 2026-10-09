import { readFile } from "node:fs/promises";
import { config } from "./config.mjs";
import { PgStore } from "./store.mjs";

let store;
try {
  const cfg = await config(false);
  const instanceId = await readFile(
    process.env.MX_DEVICE_WORKER_HEALTH_FILE,
    "utf8",
  );
  store = new PgStore(cfg.databaseUrl);
  const result = await store.pool.query(
    `SELECT 1 FROM mx_device.workers WHERE id=$1 AND document->>'instanceId'=$2
     AND at > (extract(epoch FROM clock_timestamp())*1000)-10000
     AND document->>'lastError' IS NULL`,
    [cfg.workerId, instanceId],
  );
  if (!result.rowCount) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  if (store) await store.close();
}
