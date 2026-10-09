import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const clone = (value) => structuredClone(value);
export class MemoryStore {
  constructor(clock = Date.now) {
    this.clock = clock;
    this.state = { devices: [], jobs: [], attempts: [], events: [] };
    this.tail = Promise.resolve();
    this.workers = [];
  }
  async atomic(fn) {
    const prev = this.tail;
    let release;
    this.tail = new Promise((r) => {
      release = r;
    });
    await prev;
    try {
      const state = clone(this.state);
      const result = fn(state, this.clock());
      this.state = state;
      return clone(result);
    } finally {
      release();
    }
  }
  async snapshot(mode) {
    return {
      ...Object.fromEntries(
        Object.entries(clone(this.state)).map(([k, rows]) => [
          k,
          rows.filter((r) => r.mode === mode),
        ]),
      ),
      workers: clone(this.workers),
    };
  }
  async detail(mode, id) {
    const job = this.state.jobs.find((j) => j.id === id && j.mode === mode);
    return (
      job &&
      clone({
        job,
        attempts: this.state.attempts.filter((a) => a.jobId === id),
      })
    );
  }
  async heartbeat(id, doc) {
    this.workers = this.workers.filter((w) => w.id !== id);
    this.workers.push({ id, at: this.clock(), ...doc });
  }
  async ready() {
    return true;
  }
  async close() {}
}

export class PgStore {
  constructor(url) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 2000,
      query_timeout: 5000,
      idleTimeoutMillis: 10000,
      application_name: "mx-device",
    });
    this.pool.on("error", () => {});
  }
  async migrate() {
    const dir = new URL("../migrations/", import.meta.url);
    // File I/O precedes the transaction; migrations contain only bounded DB work.
    const files = await Promise.all(
      (await readdir(dir))
        .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
        .sort()
        .map(async (name) => {
          const sql = await readFile(new URL(name, dir), "utf8");
          return {
            name,
            sql,
            checksum: createHash("sha256").update(sql).digest("hex"),
          };
        }),
    );
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='2s'");
      await c.query("SET LOCAL statement_timeout='4s'");
      await c.query("SELECT pg_advisory_xact_lock(1297634386,2)");
      await c.query("CREATE SCHEMA IF NOT EXISTS mx_device");
      await c.query(
        "CREATE TABLE IF NOT EXISTS mx_device.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const applied = (
        await c.query("SELECT name,checksum FROM mx_device.schema_migrations")
      ).rows;
      for (const old of applied) {
        if (
          !files.some((f) => f.name === old.name && f.checksum === old.checksum)
        )
          throw new Error(
            "Applied migration changed or is missing; refusing downgrade",
          );
      }
      for (const f of files) {
        if (applied.some((old) => old.name === f.name)) continue;
        // 001 is idempotent, allowing pre-ledger installations to be adopted in place.
        await c.query(f.sql);
        await c.query(
          "INSERT INTO mx_device.schema_migrations(name,checksum) VALUES($1,$2)",
          [f.name, f.checksum],
        );
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async ready() {
    await this.pool.query("SELECT 1 FROM mx_device.devices LIMIT 1");
    return true;
  }
  async close() {
    await this.pool.end();
  }
  async heartbeat(id, doc) {
    await this.pool.query(
      "INSERT INTO mx_device.workers VALUES($1,(extract(epoch FROM clock_timestamp())*1000)::bigint,$2) ON CONFLICT(id) DO UPDATE SET at=excluded.at,document=excluded.document",
      [id, doc],
    );
  }
  async atomic(
    fn,
    { mode = "sim", jobId = null, attemptId = null, key = null } = {},
  ) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='2s'");
      await c.query("SET LOCAL statement_timeout='5s'");
      // Bounded experimental control plane: serialize short scheduling decisions per realm,
      // NEVER physical execution. Independent devices still execute concurrently.
      await c.query("SELECT pg_advisory_xact_lock(1297634386,$1)", [
        mode === "real" ? 1 : 0,
      ]);
      const now = Number(
        (
          await c.query(
            "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
          )
        ).rows[0].now,
      );
      const devices = (
        await c.query("SELECT document FROM mx_device.devices WHERE mode=$1", [
          mode,
        ])
      ).rows.map((r) => r.document);
      const jobs = (
        await c.query(
          `SELECT CASE WHEN id::text IN
        (SELECT document->>'sourceJobId' FROM mx_device.jobs WHERE mode=$1 AND status IN ('queued','running'))
        THEN document ELSE document - 'result' END AS document FROM mx_device.jobs WHERE mode=$1 AND (
        status IN ('queued','running') OR id=$2 OR request_key=$3 OR
        id IN (SELECT id FROM mx_device.jobs WHERE mode=$1 ORDER BY created_at DESC,id DESC LIMIT 100) OR
        id::text IN (SELECT document->>'sourceJobId' FROM mx_device.jobs WHERE mode=$1 AND status IN ('queued','running')) OR
        id IN (SELECT job_id FROM mx_device.attempts WHERE id=$4))`,
          [mode, jobId, key, attemptId],
        )
      ).rows.map((r) => r.document);
      const attempts = (
        await c.query(
          "SELECT document FROM mx_device.attempts WHERE mode=$1 AND (status='running' OR id=$2)",
          [mode, attemptId],
        )
      ).rows.map((r) => r.document);
      const state = { devices, jobs, attempts, events: [] },
        before = new Map(
          [...devices, ...jobs, ...attempts].map((r) => [
            r.id,
            JSON.stringify(r),
          ]),
        );
      const result = fn(state, now);
      if (result?.then)
        throw new Error("Async work inside transaction is forbidden");
      for (const d of state.devices)
        if (before.get(d.id) !== JSON.stringify(d))
          await c.query(
            "INSERT INTO mx_device.devices VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET document=excluded.document,resource_key=excluded.resource_key,account_key=excluded.account_key",
            [d.id, d.mode, d.resourceKey, d.accountKey, d],
          );
      for (const j of state.jobs)
        if (before.get(j.id) !== JSON.stringify(j))
          await c.query(
            "INSERT INTO mx_device.jobs VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET status=excluded.status,document=excluded.document",
            [j.id, j.mode, j.key, j.status, j.createdAt, j],
          );
      for (const a of state.attempts)
        if (before.get(a.id) !== JSON.stringify(a))
          await c.query(
            "INSERT INTO mx_device.attempts VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET status=excluded.status,document=excluded.document",
            [a.id, a.mode, a.jobId, a.deviceId, a.status, a.createdAt, a],
          );
      for (const e of state.events)
        await c.query(
          "INSERT INTO mx_device.events(mode,at,document) VALUES($1,$2,$3)",
          [mode, e.at, e],
        );
      await c.query("COMMIT");
      return clone(result);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async snapshot(mode) {
    const [d, j, e, w, a] = await Promise.all([
      this.pool.query(
        "SELECT document FROM mx_device.devices WHERE mode=$1 ORDER BY id",
        [mode],
      ),
      this.pool.query(
        "SELECT document - 'result' AS document FROM mx_device.jobs WHERE mode=$1 AND status IN ('queued','running') UNION ALL (SELECT document - 'result' FROM mx_device.jobs WHERE mode=$1 AND status NOT IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT 100)",
        [mode],
      ),
      this.pool.query(
        "SELECT seq,document FROM mx_device.events WHERE mode=$1 ORDER BY seq DESC LIMIT 100",
        [mode],
      ),
      this.pool.query(
        "SELECT id,at,document FROM mx_device.workers ORDER BY id",
      ),
      this.pool.query(
        "SELECT document - 'result' - 'lateEvidence' - 'checkpoints' AS document FROM mx_device.attempts WHERE mode=$1 ORDER BY created_at DESC LIMIT 100",
        [mode],
      ),
    ]);
    return {
      devices: d.rows.map((r) => r.document),
      jobs: j.rows.map((r) => r.document),
      attempts: a.rows.map((r) => r.document),
      events: e.rows.reverse().map((r) => ({ ...r.document, seq: r.seq })),
      workers: w.rows.map((r) => ({
        ...r.document,
        id: r.id,
        at: Number(r.at),
      })),
    };
  }
  async detail(mode, id) {
    const j = await this.pool.query(
      "SELECT document FROM mx_device.jobs WHERE id=$1 AND mode=$2",
      [id, mode],
    );
    if (!j.rowCount) return null;
    return {
      job: j.rows[0].document,
      attempts: (
        await this.pool.query(
          "SELECT document FROM mx_device.attempts WHERE job_id=$1 ORDER BY created_at",
          [id],
        )
      ).rows.map((r) => r.document),
    };
  }
}
