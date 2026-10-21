import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
const timeouts = {
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
  lock_timeout: 10000,
  query_timeout: 35000,
};
function errorCode(error) {
  if (
    (typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)) ||
    [
      "DATABASE_URL_INVALID", "CHECKSUM_MISMATCH", "ETIMEDOUT",
      "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET",
    ].includes(error?.code)
  ) return error.code;
  if (error?.message === "Query read timeout") return "QUERY_TIMEOUT";
  if ([
    "Connection terminated due to connection timeout",
    "timeout exceeded when trying to connect",
    "timeout expired",
  ].includes(error?.message)) return "CONNECTION_TIMEOUT";
  return "UNKNOWN";
}
export async function migrate(pool, { onProgress = () => {} } = {}) {
  let stage = "load", client, clientFailure, failed = false;
  const onClientError = error => { clientFailure ||= { error, stage }; };
  const checkClient = () => {
    if (clientFailure) {
      stage = clientFailure.stage;
      throw clientFailure.error;
    }
  };
  const run = async (next, work) => {
    checkClient();
    stage = next;
    onProgress({ event: "dataport_migration", stage, status: "started" });
    checkClient();
    const result = await work();
    checkClient();
    onProgress({ event: "dataport_migration", stage, status: "complete" });
    checkClient();
    return result;
  };
  try {
    const sql = await run("load", () => readFile(
        new URL("../migrations/001_sso.sql", import.meta.url), "utf8",
      )),
      checksum = createHash("sha256").update(sql).digest("hex");
    client = await run("connect", async () => {
      client = await pool.connect();
      // Pool removes its idle error listener while a client is checked out.
      // Socket/backend termination also emits here, apart from rejecting queries.
      client.on("error", onClientError);
      return client;
    });
    await run("begin", () => client.query("BEGIN"));
    await run("lock", () => client.query(
      "SELECT pg_advisory_xact_lock(hashtext('mx-harbor:migrations'))",
    ));
    const old = await run("history", async () => {
      await client.query(
        "CREATE TABLE IF NOT EXISTS harbor_schema_migrations (name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
      );
      return (await client.query(
        "SELECT checksum FROM harbor_schema_migrations WHERE name='001_sso' ",
      )).rows[0];
    });
    await run("checksum", () => {
      if (old && old.checksum !== checksum)
        throw Object.assign(Error("Applied DataPort migration checksum changed"), {
          code: "CHECKSUM_MISMATCH",
        });
    });
    if (!old) await run("apply", async () => {
      await client.query(sql);
      await client.query(
        "INSERT INTO harbor_schema_migrations(name,checksum) VALUES('001_sso',$1)",
        [checksum],
      );
    });
    await run("commit", () => client.query("COMMIT"));
  } catch (error) {
    failed = true;
    const code = errorCode(error);
    onProgress({ event: "dataport_migration", stage, status: "failed", code });
    throw Object.assign(Error(`DataPort migration failed: ${stage} (${code})`), {
      stage, code,
    });
  } finally {
    // A query read timeout may leave server work active. Destroy the connection
    // so PostgreSQL rolls back, rather than queueing ROLLBACK behind stuck work.
    if (client) {
      try { client.release(failed); }
      finally { client.removeListener("error", onClientError); }
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const report = (entry) => console.info(JSON.stringify(entry));
  let pool;
  try {
    report({ event: "dataport_migration", stage: "validate", status: "started" });
    let url;
    try {
      url = new URL(process.env.MX_HARBOR_DATABASE_URL);
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !/^\/mx_harbor(?:_test)?$/.test(url.pathname)
      ) throw Error();
    } catch {
      throw Object.assign(Error(), { stage: "validate", code: "DATABASE_URL_INVALID" });
    }
    report({ event: "dataport_migration", stage: "validate", status: "complete" });
    // pg lets URL parameters override pool options; retained URLs must not
    // silently disable these migration-only limits.
    for (const key of Object.keys(timeouts)) url.searchParams.delete(key);
    pool = new pg.Pool({ connectionString: url.href, max: 1, ...timeouts });
    await migrate(pool, { onProgress: report });
  } catch (error) {
    if (!pool) report({
      event: "dataport_migration", stage: "validate", status: "failed", code: errorCode(error),
    });
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
