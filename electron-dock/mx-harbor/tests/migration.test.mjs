import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import { PostgresSsoStore } from "@qpjoy/mx-common/identity/postgres";
import { migrate } from "../scripts/migrate.mjs";
const connectionString = process.env.MX_SSO_TEST_DATABASE_URL;
test(
  "Harbor own migration is repeatable and preserves encrypted sessions across restart",
  { skip: !connectionString },
  async (t) => {
    const url = new URL(connectionString);
    assert.ok(
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
        url.pathname.includes("sso_test"),
    );
    const root = new pg.Pool({ connectionString }),
      name = `harbor_test_${randomUUID().replaceAll("-", "")}`;
    await root.query(`CREATE DATABASE ${name}`);
    url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.href });
    t.after(async () => {
      await pool.end();
      await root.query(`DROP DATABASE ${name}`);
      await root.end();
    });
    await Promise.all([migrate(pool), migrate(pool)]);
    const key = randomBytes(32).toString("base64url"),
      store = new PostgresSsoStore(pool, key),
      record = {
        subject: "test-user",
        accessToken: "opaque-session-token",
        csrf: "test-csrf",
      };
    await store.put("session", "f".repeat(43), record, 300);
    await migrate(pool);
    const restarted = new PostgresSsoStore(pool, key);
    assert.deepEqual(await restarted.get("session", "f".repeat(43)), record);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM harbor_schema_migrations",
        )
      ).rows[0].count,
      1,
    );
    assert.doesNotMatch(
      (await pool.query("SELECT payload FROM app_auth.browser_sso_records"))
        .rows[0].payload,
      /opaque-session-token/,
    );
  },
);
