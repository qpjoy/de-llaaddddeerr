import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import pg from "pg";
import { PgStore, MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { register, addJob, claim, sweep } from "../server/model.mjs";
import {
  beginCommand,
  completeCommand,
  simulateCommand,
  rackScenario,
} from "../server/workflows.mjs";
import { configureLoops, DEFAULT_LOOP_POLICY } from "../server/loop-policy.mjs";
import { schedulingSnapshot } from "../server/scheduling.mjs";

test("workflow API: immutable versions, request replay, realm guards and reads never dispatch", async (t) => {
  const store = new MemoryStore(),
    cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
  const app = createApp({ store, cfg });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise((r) => app.close(r)));
  const req = (path, body, token = cfg.testToken) =>
    fetch(`http://127.0.0.1:${app.address().port}/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await req("task-definitions?mode=sim")).status, 200);
  assert.equal(
    (await req("scenarios?mode=sim", { kind: "rack20", key: "lab" })).status,
    202,
  );
  assert.equal(
    (await req("scenarios?mode=sim", { kind: "rack20", key: "lab" })).status,
    202,
  );
  assert.equal(store.state.jobs.length, 20);
  const before = structuredClone(store.state);
  for (let i = 0; i < 3; i++)
    assert.equal((await req("state?mode=sim")).status, 200);
  assert.deepEqual(store.state, before);
  const body = {
    code: "custom.ocr",
    name: "自定义 OCR",
    appId: "xhs",
    loop: "small",
    expectedVersion: 0,
    steps: [
      { code: "app.open", repeat: 1 },
      { code: "xhs.get_note_detail.ocr", repeat: 1 },
    ],
  };
  const response = await req("task-definitions?mode=sim", body);
  assert.equal(response.status, 201);
  const def = await response.json();
  assert.equal((await req("task-definitions?mode=sim", body)).status, 409);
  const job = {
    definitionId: def.id,
    key: "custom-one",
    target: "note-a",
    confirmed: true,
  };
  const j1 = await (await req("jobs?mode=sim", job)).json();
  const j2 = await (await req("jobs?mode=sim", job)).json();
  assert.equal(j1.id, j2.id);
  assert.equal(
    (await req("jobs?mode=sim", { ...job, target: "changed" })).status,
    409,
  );
  for (const [path, b] of [
    ["jobs", job],
    ["task-definitions", body],
    ["loop-policy", DEFAULT_LOOP_POLICY],
  ])
    assert.equal(
      (await req(`${path}?mode=real`, b, cfg.adminToken)).status,
      403,
    );
  assert.equal(store.state.attempts.length, 0);
});

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres workflow: checkpoint restart, concurrent child claim, immutable commands, durable cooldown and late evidence",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(["localhost", "127.0.0.1"].includes(target.hostname));
    const name = `mx_workflow_${randomBytes(5).toString("hex")}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    let a = new PgStore(target.href),
      b = new PgStore(target.href);
    const options = { mode: "sim" };
    try {
      await Promise.all([a.migrate(), b.migrate()]);
      assert.equal((await a.snapshot("sim")).definitions.length, 8);
      const { d, parent, child } = await a.atomic((s, n) => {
        const d = register(s, n, "sim", {
          name: "persisted slot",
          rack: "test",
        });
        d.taskIntervalMs = 0;
        configureLoops(s, n, "sim", {
          ...DEFAULT_LOOP_POLICY,
          rack: "test",
          revision: 0,
          cooldownMinMs: 100,
          cooldownMaxMs: 100,
          smallLimit: 1,
          maxDetourMs: 60000,
        });
        const parent = addJob(s, n, "sim", {
          key: "parent",
          definitionId: "sim:xhs.search10:1",
          deviceId: d.id,
          priority: 1,
        });
        const child = addJob(s, n, "sim", {
          key: "child",
          definitionId: "sim:weibo.search:1",
          deviceId: d.id,
        });
        return { d, parent, child };
      }, options);
      async function step(store, work) {
        const o = {
          mode: "sim",
          jobId: work.job.id,
          attemptId: work.attempt.id,
        };
        const c = await store.atomic(
          (s, n) => beginCommand(s, n, work.attempt),
          o,
        );
        assert(c);
        assert(
          await store.atomic(
            (s, n) =>
              completeCommand(s, n, work.attempt, c, simulateCommand(c)),
            o,
          ),
        );
        return c;
      }
      let w = await a.atomic((s, n) => claim(s, n, "sim", "worker-a"), options);
      const previousExecution = structuredClone(w.attempt);
      await step(a, w); // app.open, not a safe insertion checkpoint
      w = await b.atomic((s, n) => claim(s, n, "sim", "worker-b"), options);
      assert.equal(
        await a.atomic((s, n) => beginCommand(s, n, previousExecution), {
          mode: "sim",
          jobId: w.job.id,
          attemptId: w.attempt.id,
        }),
        null,
      );
      await step(b, w); // page 1
      await a.close();
      a = new PgStore(target.href);
      const snap = await a.snapshot("sim");
      assert.equal(
        snap.attempts.find((x) => x.jobId === parent.id).status,
        "yielded",
      );
      await a.heartbeat("worker-c", {
        role: "device-worker",
        inflight: 0,
        maxInflight: 10,
      });
      const ready = await a.snapshot("sim");
      assert.equal(
        schedulingSnapshot(ready, ready.now, "sim").queue.find(
          (x) => x.jobId === child.id,
        ).status,
        "candidate",
      );
      const claims = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? a : b).atomic(
            (s, n) => claim(s, n, "sim", `worker-${i}`),
            options,
          ),
        ),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      w = claims.find(Boolean);
      assert.equal(w.job.id, child.id);
      assert(w.attempt.parentAttemptId);
      for (let i = 0; i < child.workflow.plan.length; i++)
        await step(i % 2 ? a : b, w);
      const rest = (await a.snapshot("sim")).apps.find(
        (x) => x.deviceId === d.id && x.appId === "weibo",
      ).rest;
      assert.equal(rest.durationMs, 100);
      await b.close();
      b = new PgStore(target.href);
      assert.deepEqual(
        (await b.snapshot("sim")).apps.find(
          (x) => x.deviceId === d.id && x.appId === "weibo",
        ).rest,
        rest,
      );
      w = await b.atomic((s, n) => claim(s, n, "sim", "resumer"), options);
      assert.equal(w.job.id, parent.id);
      const restore = await step(b, w);
      assert.equal(restore.code, "session.restore");
      let loops = 0;
      while (
        (await a.detail("sim", parent.id)).job.status !== "succeeded" &&
        loops++ < 20
      ) {
        w = await a.atomic((s, n) => claim(s, n, "sim", "resumer"), options);
        assert(w);
        await step(a, w);
      }
      const detail = await a.detail("sim", parent.id);
      assert.equal(detail.job.status, "succeeded");
      assert.deepEqual(
        detail.commands
          .filter((c) => c.page)
          .sort((a, b) => a.stepIndex - b.stepIndex)
          .map((c) => c.page),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      );
      const last = detail.commands.find((c) => c.code === "session.home");
      const before = await a.snapshot("sim");
      assert(
        await a.atomic(
          (s, n) =>
            completeCommand(s, n, w.attempt, last, simulateCommand(last)),
          { ...options, jobId: parent.id, attemptId: w.attempt.id },
        ),
      );
      assert.deepEqual((await a.snapshot("sim")).apps, before.apps); // duplicate receipt never increments cooldown counters
      await a.atomic(
        (s, n) =>
          addJob(s, n, "sim", {
            key: "crash",
            definitionId: "sim:weibo.search:1",
            deviceId: d.id,
          }),
        options,
      );
      await new Promise((r) => setTimeout(r, 120));
      const crashed = await a.atomic(
        (s, n) => claim(s, n, "sim", "crash-worker"),
        options,
      );
      const o = {
        ...options,
        jobId: crashed.job.id,
        attemptId: crashed.attempt.id,
      };
      const cmd = await a.atomic(
        (s, n) => beginCommand(s, n, crashed.attempt),
        o,
      );
      await a.atomic((s, n) => {
        s.attempts.find((x) => x.id === crashed.attempt.id).leaseUntil = n - 1;
        sweep(s, n, "sim");
      }, o);
      assert.equal(
        await b.atomic(
          (s, n) =>
            completeCommand(s, n, crashed.attempt, cmd, simulateCommand(cmd)),
          o,
        ),
        false,
      );
      const failed = await b.detail("sim", crashed.job.id);
      assert.equal(failed.job.status, "unknown");
      assert(failed.commands[0].lateEvidence);
      assert.equal((await b.snapshot("sim")).devices[0].state, "quarantined");
    } finally {
      await Promise.all([a.close(), b.close()]);
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
