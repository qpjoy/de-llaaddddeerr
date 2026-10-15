// The index-backed rewrites in server/store.mjs SQL must return exactly the rows
// the original OR-based statements returned (same documents, same stripped fields).
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { PgStore, SQL } from "../server/store.mjs";
import { register, addJob, claim, finish } from "../server/model.mjs";
import { addWorkflow, beginCommand } from "../server/workflows.mjs";

const LEGACY = {
  atomicJobs: `SELECT CASE WHEN id::text IN
        (SELECT document->>'sourceJobId' FROM mx_device.jobs WHERE mode=$1 AND status IN ('queued','running'))
        THEN document ELSE document - 'result' END AS document FROM mx_device.jobs WHERE mode=$1 AND (
        status IN ('queued','running') OR id=$2 OR request_key=$3 OR
        id IN (SELECT id FROM mx_device.jobs WHERE mode=$1 ORDER BY created_at DESC,id DESC LIMIT 100) OR
        id::text IN (SELECT document->>'sourceJobId' FROM mx_device.jobs WHERE mode=$1 AND status IN ('queued','running')) OR
        id IN (SELECT job_id FROM mx_device.attempts WHERE id=$4))`,
  atomicCommands:
    "SELECT document FROM mx_device.execution_commands WHERE mode=$1 AND (status='running' OR job_id=$2 OR attempt_id=$3 OR job_id IN (SELECT id FROM mx_device.jobs WHERE mode=$1 AND status='running'))",
  snapshotJobs: `SELECT document - 'result' AS document FROM mx_device.jobs WHERE mode=$1 AND (
          status IN ('queued','running') OR
          id IN (SELECT id FROM mx_device.jobs WHERE mode=$1 AND status NOT IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT 100) OR
          id::text IN (SELECT document->>'sourceJobId' FROM mx_device.jobs WHERE mode=$1 AND status='queued'))`,
  snapshotAttempts:
    "SELECT document - 'result' - 'lateEvidence' - 'checkpoints' AS document FROM mx_device.attempts WHERE mode=$1 AND status IN ('running','yielded') UNION ALL (SELECT document - 'result' - 'lateEvidence' - 'checkpoints' FROM mx_device.attempts WHERE mode=$1 AND status NOT IN ('running','yielded') ORDER BY created_at DESC LIMIT 100)",
  snapshotCommands:
    "SELECT document - 'receipt' - 'lateEvidence' AS document FROM mx_device.execution_commands WHERE mode=$1 AND (status='running' OR job_id IN (SELECT id FROM mx_device.jobs WHERE mode=$1 AND status='running')) UNION ALL (SELECT document - 'receipt' - 'lateEvidence' FROM mx_device.execution_commands WHERE mode=$1 AND status<>'running' AND job_id NOT IN (SELECT id FROM mx_device.jobs WHERE mode=$1 AND status='running') ORDER BY created_at DESC LIMIT 400)",
};
const rows = async (pool, sql, params) =>
  (await pool.query(sql, params)).rows
    .map((r) => JSON.stringify(r.document))
    .sort();

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres: index-backed history queries return the same rows as the original statements",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(["127.0.0.1", "localhost"].includes(target.hostname));
    const name = `mx_device_test_${randomBytes(5).toString("hex")}`,
      admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    const store = new PgStore(target.href);
    try {
      await store.migrate();
      const opts = { mode: "sim" };
      // A succeeded search that a queued detail job depends on (its result must load).
      const src = await store.atomic((s, n) => {
        register(s, n, "sim", { name: "A", simApps: ["xhs", "pdd"] });
        register(s, n, "sim", { name: "B", simApps: ["xhs", "pdd"] });
        return addJob(s, n, "sim", {
          key: "src",
          operation: "search",
          keyword: "源",
          pages: 1,
        });
      }, opts);
      const work = await store.atomic((s, n) => claim(s, n, "sim", "w"), opts);
      await store.atomic(
        (s, n) =>
          finish(s, n, work.attempt, {
            result: {
              pages: [
                {
                  items: [
                    {
                      id: "x",
                      detailInput: "https://www.xiaohongshu.com/explore/abc",
                    },
                  ],
                },
              ],
            },
          }),
        { ...opts, jobId: src.id, attemptId: work.attempt.id },
      );
      // A running workflow with a running command.
      const running = await store.atomic(
        (s, n) =>
          addWorkflow(s, n, "sim", {
            key: "wf",
            definitionId: "sim:pdd.search5:1",
            keyword: "k",
            target: "t",
          }),
        opts,
      );
      const live = await store.atomic((s, n) => claim(s, n, "sim", "w"), opts);
      assert.equal(live.job.id, running.id);
      await store.atomic((s, n) => beginCommand(s, n, live.attempt), {
        ...opts,
        jobId: live.job.id,
        attemptId: live.attempt.id,
      });
      // History newer than the source pushes it out of the latest 100.
      const tpl = (
        await store.pool.query("SELECT * FROM mx_device.jobs WHERE id=$1", [
          src.id,
        ])
      ).rows[0];
      const atpl = (
        await store.pool.query(
          "SELECT * FROM mx_device.attempts WHERE job_id=$1",
          [src.id],
        )
      ).rows[0];
      const ctpl = (
        await store.pool.query(
          "SELECT * FROM mx_device.execution_commands WHERE job_id=$1 LIMIT 1",
          [live.job.id],
        )
      ).rows[0];
      const base = Number(tpl.created_at) + 1000;
      await store.pool.query(
        `INSERT INTO mx_device.jobs SELECT md5('j'||g)::uuid,'sim','h:'||g,'succeeded',$1::bigint+g,
           $2::jsonb || jsonb_build_object('id',md5('j'||g)::uuid,'key','h:'||g,'status','succeeded') FROM generate_series(1,150) g`,
        [base, tpl.document],
      );
      await store.pool.query(
        `INSERT INTO mx_device.attempts SELECT md5('a'||g)::uuid,'sim',md5('j'||g)::uuid,$3::uuid,'succeeded',$1::bigint+g,
           $2::jsonb || jsonb_build_object('id',md5('a'||g)::uuid,'jobId',md5('j'||g)::uuid) FROM generate_series(1,150) g`,
        [base, atpl.document, atpl.device_id],
      );
      await store.pool.query(
        `INSERT INTO mx_device.execution_commands SELECT md5('c'||g||k)::uuid,'sim',md5('j'||g)::uuid,md5('a'||g)::uuid,$3::uuid,'succeeded',$1::bigint+g*10+k,
           $2::jsonb || jsonb_build_object('id',md5('c'||g||k)::uuid,'jobId',md5('j'||g)::uuid,'status','succeeded')
         FROM generate_series(1,150) g, generate_series(1,3) k`,
        [base, ctpl.document, ctpl.device_id],
      );
      const detail = await store.atomic(
        (s, n) =>
          addJob(s, n, "sim", {
            key: "detail",
            operation: "note",
            sourceJobId: src.id,
            priority: 9,
          }),
        { ...opts, key: "detail", jobId: src.id },
      );
      await store.pool.query("ANALYZE");

      const historyJob = (
        await store.pool.query("SELECT md5('j'||7)::uuid AS id")
      ).rows[0].id;
      const historyAttempt = (
        await store.pool.query("SELECT md5('a'||7)::uuid AS id")
      ).rows[0].id;
      const jobParams = [
        ["sim", null, null, null],
        ["sim", src.id, null, null],
        ["sim", null, "src", null],
        ["sim", null, "h:3", null],
        ["sim", null, null, work.attempt.id],
        ["sim", live.job.id, null, live.attempt.id],
        ["sim", historyJob, "detail", historyAttempt],
        ["real", src.id, "src", null],
      ];
      for (const params of jobParams)
        assert.deepEqual(
          await rows(store.pool, SQL.atomicJobs, params),
          await rows(store.pool, LEGACY.atomicJobs, params),
          `atomicJobs ${JSON.stringify(params)}`,
        );
      const sourceRow = (
        await store.pool.query(SQL.atomicJobs, ["sim", null, null, null])
      ).rows
        .map((r) => r.document)
        .find((d) => d.id === src.id);
      assert(sourceRow?.result, "source of a live dependent keeps its result");
      assert(detail.sourceJobId === src.id);
      for (const params of [
        ["sim", null, null],
        ["sim", live.job.id, live.attempt.id],
        ["sim", historyJob, historyAttempt],
        ["real", null, null],
      ])
        assert.deepEqual(
          await rows(store.pool, SQL.atomicCommands, params),
          await rows(store.pool, LEGACY.atomicCommands, params),
          `atomicCommands ${JSON.stringify(params)}`,
        );
      for (const key of [
        "snapshotJobs",
        "snapshotAttempts",
        "snapshotCommands",
      ])
        for (const mode of ["sim", "real"])
          assert.deepEqual(
            await rows(store.pool, SQL[key], [mode]),
            await rows(store.pool, LEGACY[key], [mode]),
            `${key} ${mode}`,
          );
      // Spot-check sizes so the comparison exercised the limits.
      assert.equal(
        (await rows(store.pool, SQL.snapshotAttempts, ["sim"])).length,
        101,
      );
      assert.equal(
        (await rows(store.pool, SQL.snapshotCommands, ["sim"])).length,
        401,
      );
    } finally {
      await store.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
