import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PgStore } from "../server/store.mjs";
import {
  register,
  addJob,
  claim,
  finish,
  scenario,
  control,
  requestCapture,
  claimCapture,
  completeCapture,
  sessionAction,
  requestInspection,
  claimInspection,
  completeInspection,
  setPoCChannel,
} from "../server/model.mjs";
const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres: concurrent workers, durable restart, idempotency, dependency evidence and simulated failover",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(
      ["127.0.0.1", "localhost"].includes(target.hostname),
      "Integration test must use local disposable Postgres",
    );
    const name = `mx_device_test_${randomBytes(5).toString("hex")}`,
      admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    let a = new PgStore(target.href),
      b = new PgStore(target.href);
    try {
      // Adopt the original pre-ledger schema, then exercise concurrent and repeated deployment.
      await a.pool.query(
        await readFile(
          new URL("../migrations/001_device_center.sql", import.meta.url),
          "utf8",
        ),
      );
      await Promise.all([a.migrate(), b.migrate()]);
      await a.migrate();
      const versions = await a.pool.query(
        "SELECT name,checksum FROM mx_device.schema_migrations ORDER BY name",
      );
      assert.equal(versions.rowCount, 2);
      assert.equal(versions.rows[0].name, "001_device_center.sql");
      assert.match(versions.rows[0].checksum, /^[a-f0-9]{64}$/);
      const camera = await a.atomic(
        (s, n) =>
          register(s, n, "real", {
            name: "disposable observer",
            adapter: "mobile-agent",
            serial: "test-serial",
            workerId: "capture-worker",
            origin: "http://127.0.0.1:8787",
            accountKey: "test-account",
            approved: true,
          }),
        { mode: "real" },
      );
      const captureRequest = await a.atomic(
        (s, n) => requestCapture(s, n, camera.id),
        { mode: "real" },
      );
      const captures = await Promise.all(
        [a, b].map((store) =>
          store.atomic((s, n) => claimCapture(s, n, "capture-worker"), {
            mode: "real",
          }),
        ),
      );
      assert.equal(captures.filter(Boolean).length, 1);
      const captured = captures.find(Boolean),
        png = Buffer.from("test-bounded-bytea");
      await b.atomic(
        (s, n) => completeCapture(s, n, captured, { width: 1, height: 1 }),
        {
          mode: "real",
          frame: {
            deviceId: camera.id,
            captureId: captureRequest.id,
            version: camera.observer.version,
            png,
          },
        },
      );
      assert.deepEqual(await a.frame(camera.id, captureRequest.id), png);
      assert.equal(await a.frame(camera.id, camera.id), null);
      assert.equal(
        JSON.stringify(await a.snapshot("real")).includes("test-bounded-bytea"),
        false,
      );
      const session = await a.atomic(
        (s, n) =>
          sessionAction(s, n, "real", camera.id, {
            action: "acquire",
            revision: camera.revision,
            confirmed: true,
          }),
        { mode: "real" },
      );
      const fresh = (await b.snapshot("real")).devices[0];
      await assert.rejects(
        b.atomic(
          (s, n) =>
            sessionAction(s, n, "real", camera.id, {
              action: "acquire",
              revision: fresh.revision,
              confirmed: true,
            }),
          { mode: "real" },
        ),
        /其他会话/,
      );
      await b.atomic(
        (s, n) =>
          sessionAction(s, n, "real", camera.id, {
            action: "release",
            token: session.token,
          }),
        { mode: "real" },
      );
      const inspection = await a.atomic(
        (s, n) => requestInspection(s, n, camera.id),
        { mode: "real" },
      );
      const inspections = await Promise.all(
        [a, b].map((store) =>
          store.atomic((s, n) => claimInspection(s, n, "capture-worker"), {
            mode: "real",
          }),
        ),
      );
      assert.equal(inspections.filter(Boolean).length, 1);
      await b.atomic(
        (s, n) =>
          completeInspection(s, n, inspections.find(Boolean), {
            occupancy: "unknown",
            controlAuthority: "unverified",
          }),
        { mode: "real" },
      );
      assert.equal(
        (await a.snapshot("real")).devices.find((d) => d.id === camera.id)
          .inspection.id,
        inspection.id,
      );
      const legacy = await a.atomic(
        (s, n) =>
          register(s, n, "real", {
            name: "optional legacy",
            workerId: "capture-worker",
            origin: "http://127.0.0.1:18081",
            accountKey: "optional-legacy",
            approved: true,
          }),
        { mode: "real" },
      );
      await b.atomic(
        (s, n) =>
          setPoCChannel(s, n, legacy.id, {
            revision: legacy.revision,
            enabled: false,
            confirmed: true,
          }),
        { mode: "real" },
      );
      const healthDir = await mkdtemp(
        join(tmpdir(), "mx-device-worker-health-"),
      );
      try {
        const cfgPath = join(healthDir, "config.json"),
          instancePath = join(healthDir, "instance");
        await writeFile(
          cfgPath,
          JSON.stringify({
            databaseUrl: target.href,
            workerId: "health-worker",
          }),
          { mode: 0o600 },
        );
        await writeFile(instancePath, "current-process");
        const checkHealth = () =>
          spawnSync(
            process.execPath,
            [
              fileURLToPath(
                new URL("../server/worker-health.mjs", import.meta.url),
              ),
            ],
            {
              env: {
                ...process.env,
                MX_DEVICE_CONFIG: cfgPath,
                MX_DEVICE_WORKER_HEALTH_FILE: instancePath,
              },
              encoding: "utf8",
              timeout: 8000,
            },
          ).status;
        assert.equal(checkHealth(), 1, "no heartbeat must fail");
        await a.heartbeat("health-worker", {
          instanceId: "old-process",
          lastError: null,
        });
        assert.equal(checkHealth(), 1, "old worker heartbeat must fail");
        await a.heartbeat("health-worker", {
          instanceId: "current-process",
          lastError: null,
        });
        assert.equal(checkHealth(), 0);
        await a.pool.query(
          "UPDATE mx_device.workers SET at=0 WHERE id='health-worker'",
        );
        assert.equal(checkHealth(), 1, "stale heartbeat must fail");
        await a.heartbeat("health-worker", {
          instanceId: "current-process",
          lastError: "storage unavailable",
        });
        assert.equal(checkHealth(), 1, "scheduler error must fail");
      } finally {
        await rm(healthDir, { recursive: true, force: true });
      }
      await a.atomic((s, n) => {
        register(s, n, "sim", { name: "A" });
        addJob(s, n, "sim", {
          key: "one",
          operation: "search",
          keyword: "food",
        });
        addJob(s, n + 1, "sim", {
          key: "two",
          operation: "search",
          keyword: "tea",
        });
      });
      const claims = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          (i % 2 ? a : b).atomic((s, n) => claim(s, n, "sim", `worker-${i}`)),
        ),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      const first = claims.find(Boolean);
      await b.atomic((s, n) => register(s, n, "sim", { name: "B" }));
      const second = await b.atomic((s, n) => claim(s, n, "sim", "second"));
      assert(second);
      assert.notEqual(first.device.id, second.device.id);
      await a.atomic(
        (s, n) =>
          finish(s, n, first.attempt, {
            result: {
              pages: [
                {
                  items: [
                    { detailInput: "https://www.xiaohongshu.com/explore/test" },
                  ],
                },
              ],
            },
          }),
        { mode: "sim", attemptId: first.attempt.id },
      );
      await b.atomic(
        (s, n) => finish(s, n, second.attempt, { result: { pages: [] } }),
        { mode: "sim", attemptId: second.attempt.id },
      );
      await a.close();
      a = new PgStore(target.href);
      const realAfterRestart = (await a.snapshot("real")).devices;
      assert.equal(
        realAfterRestart.find((d) => d.id === camera.id).mobileStatus.occupancy,
        "unknown",
      );
      assert.equal(
        realAfterRestart.find((d) => d.id === legacy.id).pocDisabled,
        true,
      );
      assert.equal(
        (await a.detail("sim", first.job.id)).job.status,
        "succeeded",
      );
      // Large terminal history must not hide an idempotency key or source dependency.
      await a.atomic((s, n) => {
        for (let i = 0; i < 105; i++) {
          const j = addJob(s, n + i, "sim", {
            key: `history-${i}`,
            operation: "search",
            keyword: "x",
          });
          j.status = "cancelled";
          j.completedAt = n;
        }
      });
      const duplicate = await a.atomic(
        (s, n) =>
          addJob(s, n, "sim", {
            key: "one",
            operation: "search",
            keyword: "food",
          }),
        { mode: "sim", key: "one" },
      );
      assert.equal(duplicate.id, first.job.id);
      const dependent = await a.atomic(
        (s, n) =>
          addJob(s, n, "sim", {
            key: "detail",
            operation: "note",
            sourceJobId: first.job.id,
          }),
        { mode: "sim", jobId: first.job.id },
      );
      const dependentWork = await a.atomic((s, n) =>
        claim(s, n + 1000, "sim", "w"),
      );
      assert.equal(dependentWork.job.id, dependent.id);
      assert(dependentWork.job.input.input.endsWith("/test"));
      await a.atomic(
        (s, n) =>
          finish(s, n, dependentWork.attempt, {
            result: { detail: { id: "test" } },
          }),
        { mode: "sim", attemptId: dependentWork.attempt.id },
      );
      await a.atomic((s, n) => scenario(s, n, "failover", "transfer"), {
        mode: "sim",
        key: "transfer:1",
      });
      const w = await a.atomic((s, n) => claim(s, n + 10, "sim", "w"));
      await a.atomic((s, n) => {
        const d = s.devices.find((d) => d.id === w.device.id);
        control(s, n, "sim", d.id, {
          action: "disconnect",
          revision: d.revision,
        });
      });
      const replacement = await a.atomic((s, n) =>
        claim(s, n + 7000, "sim", "w"),
      );
      assert(replacement);
      assert.notEqual(replacement.device.id, w.device.id);
      const [count] = (
        await a.pool.query(
          "SELECT count(*)::int AS n FROM mx_device.attempts WHERE status='running' AND device_id=$1",
          [replacement.device.id],
        )
      ).rows;
      assert.equal(count.n, 1);
      assert.equal(
        (await a.detail("sim", first.job.id)).job.result.pages.length,
        1,
      );
      await a.migrate();
      assert.equal(
        (await a.detail("sim", first.job.id)).job.status,
        "succeeded",
      );
      // A changed historical migration or attempted downgrade must not run new DDL or erase jobs.
      await a.pool.query(
        "UPDATE mx_device.schema_migrations SET checksum='changed'",
      );
      await assert.rejects(a.migrate(), /Applied migration changed/);
      assert.equal(
        (await a.detail("sim", first.job.id)).job.status,
        "succeeded",
      );
      for (const version of versions.rows)
        await a.pool.query(
          "UPDATE mx_device.schema_migrations SET checksum=$1 WHERE name=$2",
          [version.checksum, version.name],
        );
      await a.pool.query(
        "INSERT INTO mx_device.schema_migrations(name,checksum) VALUES('999_future.sql','future')",
      );
      await assert.rejects(a.migrate(), /refusing downgrade/);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  },
);
