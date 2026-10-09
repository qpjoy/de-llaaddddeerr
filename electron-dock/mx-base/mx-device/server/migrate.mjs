import { config } from "./config.mjs";
import { PgStore } from "./store.mjs";

const cfg = await config(false);
const store = new PgStore(cfg.databaseUrl);
try {
  await store.migrate();
  await store.ready();
  console.log("MX Device migrations complete; no device calls");
} catch {
  // Do not emit connection strings, passwords or arbitrary server error details.
  console.error(
    "MX Device migration failed; transaction rolled back. Check database access, migration history and locks.",
  );
  process.exitCode = 1;
} finally {
  await store.close();
}
