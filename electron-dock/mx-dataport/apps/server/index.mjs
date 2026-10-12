import { createServer } from "node:http";
import pg from "pg";
import { readApplicationSsoProfile } from "@qpjoy/mx-common/identity/profile";
import { readConfig, readDependencies } from "./config.mjs";
import { createHarborApp } from "./app.mjs";
const config = readConfig(process.env),
  pool = config.preview
    ? null
    : new pg.Pool({
        connectionString: config.databaseUrl,
        max: 8,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      });
if (pool)
  await pool.query("SELECT 1 FROM app_auth.browser_sso_records LIMIT 0");
const server = createServer(
  createHarborApp({
    config,
    pool,
    resolveDependencies: () =>
      readDependencies(process.env, readApplicationSsoProfile),
  }),
);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(config.port, config.host, () =>
  console.info(
    JSON.stringify({
      service: "mx-harbor",
      port: config.port,
      preview: config.preview,
    }),
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    server.close(async () => {
      await pool?.end();
      process.exit(0);
    });
    setTimeout(() => {
      server.closeAllConnections();
    }, 10000).unref();
  });
