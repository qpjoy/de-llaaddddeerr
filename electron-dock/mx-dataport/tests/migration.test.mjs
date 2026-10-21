import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import pg from "pg";
import { PostgresSsoStore } from "@qpjoy/mx-common/identity/postgres";
import { migrate } from "../scripts/migrate.mjs";
const connectionString = process.env.MX_SSO_TEST_DATABASE_URL;
const sql = readFileSync(new URL("../migrations/001_sso.sql", import.meta.url), "utf8"),
  checksum = createHash("sha256").update(sql).digest("hex");
function fixture({ old, fail, connectionError } = {}) {
  const queries = [], releases = [], events = [];
  const client = Object.assign(new EventEmitter(), {
    async query(text, values) {
      queries.push({ text, values });
      if (fail) fail(text);
      return { rows: text.startsWith("SELECT checksum") && old ? [old] : [] };
    },
    release(destroy) { releases.push(destroy); },
  });
  const pool = {
    async connect() {
      if (connectionError) throw connectionError;
      return client;
    },
  };
  return { pool, client, queries, releases, events, onProgress: entry => events.push(entry) };
}
test("migration preserves SQL/checksum and transaction order while reporting fixed stages", async () => {
  const f = fixture();
  await migrate(f.pool, f);
  assert.deepEqual(f.queries.map(q => q.text), [
    "BEGIN",
    "SELECT pg_advisory_xact_lock(hashtext('mx-harbor:migrations'))",
    "CREATE TABLE IF NOT EXISTS harbor_schema_migrations (name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    "SELECT checksum FROM harbor_schema_migrations WHERE name='001_sso' ",
    sql,
    "INSERT INTO harbor_schema_migrations(name,checksum) VALUES('001_sso',$1)",
    "COMMIT",
  ]);
  assert.deepEqual(f.queries.at(-2).values, [checksum]);
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.client.listenerCount("error"), 0);
  assert.deepEqual(f.events, ["load", "connect", "begin", "lock", "history", "checksum", "apply", "commit"].flatMap(stage =>
    ["started", "complete"].map(status => ({ event: "dataport_migration", stage, status })),
  ));
});
test("already-applied migration only verifies checksum and never rewrites session tables", async () => {
  const f = fixture({ old: { checksum } });
  await migrate(f.pool, f);
  assert.equal(f.queries.length, 5);
  assert.equal(f.queries.at(-1).text, "COMMIT");
  assert.ok(f.events.every(e => e.stage !== "apply"));
  assert.deepEqual(f.releases, [false]);
});
test("checksum mismatch destroys the transaction without changing applied history", async () => {
  const f = fixture({ old: { checksum: "existing-checksum" } });
  await assert.rejects(migrate(f.pool, f), { stage: "checksum", code: "CHECKSUM_MISMATCH" });
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.queries.length, 4);
  assert.deepEqual(f.events.at(-1), {
    event: "dataport_migration", stage: "checksum", status: "failed", code: "CHECKSUM_MISMATCH",
  });
});
test("connection and query failures expose only safe stage/code and never queue rollback on stuck work", async () => {
  for (const [error, expected, connect] of [
    [Object.assign(Error("postgres://private-user:private-password@private-host/mx_harbor"), { code: "ECONNREFUSED" }), "ECONNREFUSED", true],
    [Error("Connection terminated due to connection timeout"), "CONNECTION_TIMEOUT", true],
    [Error("timeout exceeded when trying to connect"), "CONNECTION_TIMEOUT", true],
    [Object.assign(Error("relation private-sensitive-relation"), { code: "55P03" }), "55P03", false],
    [Object.assign(Error("query includes private-password"), { code: "57014" }), "57014", false],
    [Error("Query read timeout"), "QUERY_TIMEOUT", false],
    [Error("private-password"), "UNKNOWN", false],
  ]) {
    const f = fixture({
      connectionError: connect ? error : undefined,
      fail: text => { if (text.includes("pg_advisory_xact_lock")) throw error; },
    });
    await assert.rejects(migrate(f.pool, f), failure => {
      assert.equal(failure.code, expected);
      assert.equal(failure.stage, connect ? "connect" : "lock");
      assert.doesNotMatch(failure.stack, /private-/);
      return true;
    });
    assert.deepEqual(f.releases, connect ? [] : [true]);
    assert.ok(f.queries.every(q => !["COMMIT", "ROLLBACK"].includes(q.text)));
    assert.doesNotMatch(JSON.stringify(f.events), /private-/);
  }
});
test("checked-out client error events are safely reported at their original stage and listener ownership is preserved", async () => {
  for (const duringQuery of [true, false]) {
    const f = fixture(),
      error = Object.assign(Error("private-password backend terminated"), { code: "ECONNRESET" });
    // Keep a caller-owned listener to verify that cleanup only removes ours.
    const observer = () => {};
    f.client.on("error", observer);
    if (duringQuery) {
      const query = f.client.query;
      f.client.query = (text, values) => text.includes("pg_advisory_xact_lock")
        ? new Promise((resolve, reject) => setImmediate(() => {
          assert.equal(f.client.listenerCount("error"), 2);
          f.client.emit("error", error);
          reject(error);
        }))
        : query(text, values);
    } else {
      const report = f.onProgress;
      f.onProgress = entry => {
        report(entry);
        if (entry.stage === "connect" && entry.status === "complete") {
          assert.equal(f.client.listenerCount("error"), 2);
          f.client.emit("error", error);
        }
      };
    }
    await assert.rejects(migrate(f.pool, f), failure => {
      assert.equal(failure.stage, duringQuery ? "lock" : "connect");
      assert.equal(failure.code, "ECONNRESET");
      assert.doesNotMatch(failure.stack, /private-/);
      return true;
    });
    assert.deepEqual(f.releases, [true]);
    assert.deepEqual(f.client.listeners("error"), [observer]);
    assert.doesNotMatch(JSON.stringify(f.events), /private-/);
    assert.equal(f.events.at(-1).status, "failed");
    if (!duringQuery) assert.equal(f.queries.length, 0);
  }
});
test("migration CLI bounds driver waits and emits only safe JSON for invalid credentials or database errors", t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dataport-migration-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ["scripts", "migrations", "node_modules/pg"]) mkdirSync(join(dir, folder), { recursive: true });
  copyFileSync(new URL("../scripts/migrate.mjs", import.meta.url), join(dir, "scripts/migrate.mjs"));
  copyFileSync(new URL("../migrations/001_sso.sql", import.meta.url), join(dir, "migrations/001_sso.sql"));
  writeFileSync(join(dir, "node_modules/pg/package.json"), JSON.stringify({ name: "pg", type: "module", exports: "./index.mjs" }));
  writeFileSync(join(dir, "node_modules/pg/index.mjs"), `
    import {writeFileSync} from 'node:fs';
    import {EventEmitter} from 'node:events';
    export default { Pool: class {
      constructor(options) { writeFileSync(process.env.TEST_DIR + '/options.json', JSON.stringify(options)); }
      async connect() {
        if (process.env.TEST_FAILURE === 'yes') throw Object.assign(Error('private-password and private-host'), {code: '28P01'});
        const client = Object.assign(new EventEmitter(), {
          query: text => process.env.TEST_FAILURE === 'socket' && text.includes('pg_advisory_xact_lock')
            ? new Promise((resolve, reject) => setImmediate(() => {
                const error = Object.assign(Error('private-password backend failure'), {code: '57P01'});
                client.emit('error', error); reject(error);
              }))
            : Promise.resolve({rows: []}),
          release() {},
        });
        return client;
      }
      async end() { writeFileSync(process.env.TEST_DIR + '/ended', 'yes'); }
    }};
  `);
  const run = (url, failure = "") => spawnSync(process.execPath, [join(dir, "scripts/migrate.mjs")], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, TEST_DIR: dir, TEST_FAILURE: failure, MX_HARBOR_DATABASE_URL: url },
  });
  let result = run("postgres://private-user:private-password@private-host/mx_launcher");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), {
    event: "dataport_migration", stage: "validate", status: "failed", code: "DATABASE_URL_INVALID",
  });
  result = run("postgres://private-user:private-password@private-host/mx_harbor?query_timeout=0&statement_timeout=0&lock_timeout=0&connectionTimeoutMillis=0", "yes");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), {
    event: "dataport_migration", stage: "connect", status: "failed", code: "28P01",
  });
  assert.doesNotMatch(result.stdout, /private-/);
  const options = JSON.parse(readFileSync(join(dir, "options.json"), "utf8"));
  assert.equal(options.max, 1);
  assert.equal(options.connectionTimeoutMillis, 10000);
  assert.equal(options.statement_timeout, 30000);
  assert.equal(options.lock_timeout, 10000);
  assert.equal(options.query_timeout, 35000);
  assert.equal(new URL(options.connectionString).search, "");
  assert.equal(readFileSync(join(dir, "ended"), "utf8"), "yes");
  result = run("postgres://private-user:private-password@private-host/mx_harbor", "socket");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /private-/);
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), {
    event: "dataport_migration", stage: "lock", status: "failed", code: "57P01",
  });
  result = run("postgres://private-user:private-password@private-host/mx_harbor");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), {
    event: "dataport_migration", stage: "commit", status: "complete",
  });
});
test(
  "DataPort own migration is repeatable and preserves encrypted sessions across restart",
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
