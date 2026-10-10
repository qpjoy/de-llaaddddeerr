import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
export async function migrate(pool) {
  const sql = await readFile(
      new URL("../migrations/001_sso.sql", import.meta.url),
      "utf8",
    ),
    checksum = createHash("sha256").update(sql).digest("hex"),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('mx-harbor:migrations'))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS harbor_schema_migrations (name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const old = (
      await client.query(
        "SELECT checksum FROM harbor_schema_migrations WHERE name='001_sso' ",
      )
    ).rows[0];
    if (old && old.checksum !== checksum)
      throw Error("Applied Harbor migration checksum changed");
    if (!old) {
      await client.query(sql);
      await client.query(
        "INSERT INTO harbor_schema_migrations(name,checksum) VALUES('001_sso',$1)",
        [checksum],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const url = new URL(process.env.MX_HARBOR_DATABASE_URL);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !/^\/mx_harbor(?:_test)?$/.test(url.pathname)
  )
    throw Error("Migration requires the Harbor database");
  const pool = new pg.Pool({ connectionString: url.href });
  try {
    await migrate(pool);
    console.info("Harbor migrations complete");
  } finally {
    await pool.end();
  }
}
