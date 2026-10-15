import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import {
  PgStore,
  snapshotCatalog,
  storedJob,
  storedCommand,
  restoreJob,
  restoreCommand,
} from "../server/store.mjs";
import { BUILTIN_COMMAND_DEFINITIONS } from "../server/workflow-catalog.mjs";
import { register, claim } from "../server/model.mjs";
import { addWorkflow, beginCommand } from "../server/workflows.mjs";

const catalogRows = BUILTIN_COMMAND_DEFINITIONS.map((row) =>
  JSON.parse(JSON.stringify(row)),
);
const open = catalogRows.find((row) => row.code === "app.open");

test("identical snapshots are stored by reference and restored as frozen catalog rows", () => {
  const catalog = snapshotCatalog(catalogRows);
  const job = {
    id: "j",
    workflow: {
      plan: [
        { code: "app.open", definition: structuredClone(open), ordinal: 1 },
        // A snapshot that differs from the catalog row must stay embedded.
        {
          code: "app.open",
          definition: { ...structuredClone(open), estimateMs: 1 },
          ordinal: 2,
        },
        // Unknown ids stay embedded too.
        { code: "x", definition: { id: "sim:unknown:1" }, ordinal: 3 },
      ],
    },
  };
  const stored = storedJob(job, catalog);
  assert.deepEqual(stored.workflow.plan[0], {
    code: "app.open",
    ordinal: 1,
    definitionRef: open.id,
  });
  assert.equal(stored.workflow.plan[1].definition.estimateMs, 1);
  assert(!("definitionRef" in stored.workflow.plan[1]));
  assert.equal(stored.workflow.plan[2].definition.id, "sim:unknown:1");
  assert(job.workflow.plan[0].definition, "storing never mutates the live row");

  const restored = restoreJob(JSON.parse(JSON.stringify(stored)), catalog);
  assert.deepEqual(restored.workflow.plan[0].definition, open);
  assert(Object.isFrozen(restored.workflow.plan[0].definition.inputSchema));
  assert.throws(() => {
    "use strict";
    restored.workflow.plan[0].definition.name = "changed";
  }, TypeError);
  // Restored rows round-trip to the same stored JSON, so unchanged rows are not rewritten.
  assert.equal(
    JSON.stringify(storedJob(restored, catalog)),
    JSON.stringify(stored),
  );
  // A replaced definition never keeps a stale reference.
  restored.workflow.plan[0].definition = { id: "sim:unknown:1" };
  assert.deepEqual(storedJob(restored, catalog).workflow.plan[0], {
    code: "app.open",
    ordinal: 1,
    definition: { id: "sim:unknown:1" },
  });

  const command = {
    id: "c",
    code: "app.open",
    definition: structuredClone(open),
  };
  assert.equal(storedCommand(command, catalog).definitionRef, open.id);
  assert.throws(
    () => restoreCommand({ id: "c", definitionRef: "sim:gone:9" }, catalog),
    /指令版本缺失/,
  );
});

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres: workflow jobs and commands persist snapshots by reference; legacy embedded rows still load",
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
      const job = await store.atomic((s, n) => {
        register(s, n, "sim", { name: "A", simApps: ["pdd"] });
        return addWorkflow(s, n, "sim", {
          key: "ref",
          definitionId: "sim:pdd.search_detail_ocr:1",
          keyword: "k",
          target: "t",
        });
      }, opts);
      const work = await store.atomic((s, n) => claim(s, n, "sim", "w"), opts);
      const command = await store.atomic(
        (s, n) => beginCommand(s, n, work.attempt),
        { ...opts, jobId: job.id, attemptId: work.attempt.id },
      );
      const raw = (
        await store.pool.query(
          "SELECT document FROM mx_device.jobs WHERE id=$1",
          [job.id],
        )
      ).rows[0].document;
      assert(raw.workflow.plan.every((s) => s.definitionRef && !s.definition));
      const rawCommand = (
        await store.pool.query(
          "SELECT document FROM mx_device.execution_commands WHERE id=$1",
          [command.id],
        )
      ).rows[0].document;
      assert.equal(rawCommand.definitionRef, command.definition.id);
      assert(!rawCommand.definition);

      // Every read path restores the full definition.
      const catalog = (
        await store.pool.query(
          "SELECT document FROM mx_device.command_definitions WHERE mode='sim'",
        )
      ).rows.map((r) => r.document);
      const byId = new Map(catalog.map((row) => [row.id, row]));
      const full = (plan) =>
        plan.every(
          (step) =>
            JSON.stringify(step.definition) ===
            JSON.stringify(byId.get(step.definitionRef || step.definition.id)),
        );
      const snap = await store.snapshot("sim");
      assert(full(snap.jobs.find((j) => j.id === job.id).workflow.plan));
      assert.equal(
        snap.commands.find((c) => c.id === command.id).definition.code,
        command.code,
      );
      const detail = await store.detail("sim", job.id);
      assert(full(detail.job.workflow.plan));
      assert(detail.commands[0].definition.outputSchema);
      const inTx = await store.atomic(
        (s) => s.jobs.find((j) => j.id === job.id),
        opts,
      );
      assert(full(inTx.workflow.plan));

      // A legacy row with embedded snapshots loads and is not rewritten by a no-op.
      const legacy = structuredClone(snap.jobs.find((j) => j.id === job.id));
      legacy.id = "11111111-1111-4111-8111-111111111111";
      legacy.key = "legacy";
      legacy.status = "succeeded";
      for (const step of legacy.workflow.plan) delete step.definitionRef;
      await store.pool.query(
        "INSERT INTO mx_device.jobs VALUES($1,'sim','legacy','succeeded',$2,$3)",
        [legacy.id, legacy.createdAt + 1, legacy],
      );
      const xminBefore = (
        await store.pool.query(
          "SELECT xmin::text FROM mx_device.jobs WHERE id=$1",
          [legacy.id],
        )
      ).rows[0].xmin;
      const loaded = await store.atomic(
        (s) => s.jobs.find((j) => j.id === legacy.id),
        { ...opts, jobId: legacy.id },
      );
      assert(full(loaded.workflow.plan));
      const xminAfter = (
        await store.pool.query(
          "SELECT xmin::text FROM mx_device.jobs WHERE id=$1",
          [legacy.id],
        )
      ).rows[0].xmin;
      assert.equal(xminAfter, xminBefore, "unchanged legacy row not rewritten");
      // Once modified, it is stored compactly.
      await store.atomic(
        (s) => {
          s.jobs.find((j) => j.id === legacy.id).reason = "touched";
        },
        { ...opts, jobId: legacy.id },
      );
      const compacted = (
        await store.pool.query(
          "SELECT document FROM mx_device.jobs WHERE id=$1",
          [legacy.id],
        )
      ).rows[0].document;
      assert(
        compacted.workflow.plan.every((s) => s.definitionRef && !s.definition),
      );

      // A reference to a missing catalog version fails closed.
      await store.pool.query(
        "UPDATE mx_device.jobs SET document=jsonb_set(document,'{workflow,plan,0,definitionRef}','\"sim:missing:9\"') WHERE id=$1",
        [legacy.id],
      );
      await assert.rejects(
        store.atomic(() => null, { ...opts, jobId: legacy.id }),
        /指令版本缺失/,
      );
    } finally {
      await store.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
