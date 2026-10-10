import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { MemoryStore, PgStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { register, claim, control } from "../server/model.mjs";
import { adapterTestDefinition } from "../server/workflow-catalog.mjs";
import {
  testAdapterCommand,
  beginCommand,
  completeCommand,
  simulateCommand,
  validReceipt,
  saveDefinition,
} from "../server/workflows.mjs";

const body = (key, code = "xhs.search.next", appId = "xhs") => ({
  key,
  code,
  appId,
  keyword: "杭州",
  target: "note-a",
});
const blank = () => new MemoryStore().state;
function finishTest(s, now, work) {
  for (let i = 0; i < work.job.workflow.plan.length; i++) {
    const c = beginCommand(s, now + i * 100, work.attempt);
    assert(c);
    assert(
      completeCommand(
        s,
        now + i * 100 + 50,
        work.attempt,
        c,
        simulateCommand(c),
      ),
    );
  }
}

test("adapter tests prepare only whitelisted commands; next-page needs search and real/internal/cross-app commands are rejected", () => {
  const s = blank(),
    d = register(s, 1000, "sim", { name: "bench" });
  for (const [code, app] of [
    ["shell.exec", "xhs"],
    ["session.restore", "xhs"],
    ["weibo.like", "xhs"],
    ["app.open", "unknown"],
  ]) {
    assert.equal(adapterTestDefinition(code, app), null);
    assert.throws(
      () => testAdapterCommand(s, 1000, "sim", d.id, body("bad", code, app)),
      { status: 400 },
    );
  }
  assert.throws(() => testAdapterCommand(s, 1000, "real", d.id, body("real")), {
    status: 403,
  });
  const j = testAdapterCommand(s, 1000, "sim", d.id, {
    ...body("next"),
    priority: 1,
    plan: [{ code: "shell.exec" }],
  });
  assert.deepEqual(
    j.workflow.plan.map((c) => c.code),
    ["app.open", "xhs.search", "xhs.search.next"],
  );
  assert.equal(j.priority, 5);
  assert.equal(s.definitions.length, 8);
  const work = claim(s, 1000, "sim", "worker");
  finishTest(s, 1001, work);
  assert.equal(j.status, "succeeded");
  assert.equal(d.projection.page, 2);
  assert.equal(d.projection.commandCode, "xhs.search.next");
  assert.equal(d.projection.jobId, j.id);
  assert.equal(d.projection.commandId, s.commands.at(-1).id);
});

test("adapter jobs replay after pause, reject changed keys and honor App cooldown plus physical exclusivity", () => {
  const s = blank(),
    d = register(s, 1000, "sim", { name: "bench" });
  d.taskIntervalMs = 0;
  s.apps.find((a) => a.deviceId === d.id && a.appId === "xhs").cooldownUntil =
    5000;
  const j = testAdapterCommand(s, 1000, "sim", d.id, body("xhs"));
  assert.equal(claim(s, 1001, "sim", "w1"), null);
  const wb = testAdapterCommand(
    s,
    1001,
    "sim",
    d.id,
    body("weibo", "weibo.list", "weibo"),
  );
  const work = claim(s, 1002, "sim", "w1");
  assert.equal(work.job.id, wb.id);
  assert.equal(claim(s, 5001, "sim", "w2"), null);
  finishTest(s, 1003, work);
  control(s, 1300, "sim", d.id, { action: "pause", revision: d.revision });
  assert.equal(testAdapterCommand(s, 1301, "sim", d.id, body("xhs")).id, j.id);
  assert.throws(
    () => testAdapterCommand(s, 1301, "sim", d.id, body("xhs", "session.home")),
    /幂等/,
  );
  assert.throws(
    () => testAdapterCommand(s, 1301, "sim", d.id, body("new")),
    /尚未启用/,
  );
  assert.equal(claim(s, 5001, "sim", "w2"), null);
  control(s, 5002, "sim", d.id, { action: "enable", revision: d.revision });
  assert.equal(claim(s, 5003, "sim", "w2").job.id, j.id);
});

test("navigation and OCR tests require confirmed receipts and preserve meaningful projection evidence", () => {
  for (const code of [
    "session.back",
    "session.home",
    "xhs.get_note_detail.ocr",
  ]) {
    const s = blank(),
      d = register(s, 1000, "sim", { name: "bench" });
    const j = testAdapterCommand(s, 1000, "sim", d.id, body(code, code));
    const work = claim(s, 1000, "sim", "worker");
    finishTest(s, 1001, work);
    const command = s.commands.at(-1);
    assert.equal(
      validReceipt(command, { ...command.receipt, result: {} }),
      false,
    );
    assert.equal(j.status, "succeeded");
    assert.equal(d.projection.commandCode, code);
    assert(
      s.events
        .filter((e) => e.type === "checkpoint")
        .every((e) => !e.message.includes("undefined")),
    );
    if (code.endsWith("ocr")) {
      assert.equal(d.projection.detail.id, "note-a");
      assert.equal(
        d.projection.detail.content,
        command.receipt.result.fullText,
      );
    }
  }
});

test("bench API enforces auth/CSRF/real boundary; reads do not dispatch and templates save only explicitly", async (t) => {
  const store = new MemoryStore(),
    cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
  const d = await store.atomic((s, n) =>
    register(s, n, "sim", { name: "bench" }),
  );
  const app = createApp({ store, cfg });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise((r) => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}/api/`;
  const request = (path, data, token = cfg.testToken, extra = {}) =>
    fetch(base + path, {
      method: data ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...extra,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
  const path = `devices/${d.id}/adapter-test`,
    data = body("http");
  assert.equal((await request(path + "?mode=sim", data, "")).status, 401);
  assert.equal(
    (
      await request(path + "?mode=sim", data, cfg.testToken, {
        origin: "https://evil.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(path + "?mode=real", data, cfg.adminToken)).status,
    403,
  );
  assert.equal(
    (await request(path + "?mode=sim", { ...data, code: "session.restore" }))
      .status,
    400,
  );
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => request(path + "?mode=sim", data)),
  );
  assert(responses.every((r) => r.status === 202));
  const jobs = await Promise.all(responses.map((r) => r.json()));
  assert.equal(new Set(jobs.map((j) => j.id)).size, 1);
  const padded = await request(path + "?mode=sim", {
    ...data,
    key: ` ${data.key} `,
  });
  assert.equal((await padded.json()).id, jobs[0].id);
  const before = structuredClone(store.state);
  await request("state?mode=sim");
  await request(`jobs/${jobs[0].id}?mode=sim`);
  assert.deepEqual(store.state, before);
  assert.equal(store.state.commands.length, 0);
  assert.equal(store.state.attempts.length, 0);
  assert.equal(store.state.definitions.length, 8);
  const seed = adapterTestDefinition(data.code, data.appId);
  const saved = await request("task-definitions?mode=sim", {
    ...seed,
    code: "custom.bench",
    name: "调试组合",
    expectedVersion: 0,
  });
  assert.equal(saved.status, 201);
  assert.equal(store.state.definitions.length, 9);
  assert.deepEqual((await saved.json()).steps, seed.steps);
});

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres persists virtual test plan, command evidence and replay across reconnect without definition pollution",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(["127.0.0.1", "localhost"].includes(target.hostname));
    const admin = new pg.Client({ connectionString: url }),
      name = `mx_bench_${randomBytes(5).toString("hex")}`;
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    let store = new PgStore(target.href);
    try {
      await store.migrate();
      const { d, j } = await store.atomic(
        (s, n) => {
          const d = register(s, n, "sim", { name: "bench" });
          return {
            d,
            j: testAdapterCommand(
              s,
              n,
              "sim",
              d.id,
              body("persist", "xhs.get_note_detail.ocr"),
            ),
          };
        },
        { mode: "sim" },
      );
      const work = await store.atomic((s, n) => claim(s, n, "sim", "worker"), {
        mode: "sim",
      });
      const o = { mode: "sim", jobId: j.id, attemptId: work.attempt.id };
      for (let i = 0; i < j.workflow.plan.length; i++) {
        const c = await store.atomic(
          (s, n) => beginCommand(s, n, work.attempt),
          o,
        );
        await store.atomic(
          (s, n) => completeCommand(s, n, work.attempt, c, simulateCommand(c)),
          o,
        );
      }
      await store.close();
      store = new PgStore(target.href);
      const replay = await store.atomic(
        (s, n) =>
          testAdapterCommand(
            s,
            n,
            "sim",
            d.id,
            body("persist", "xhs.get_note_detail.ocr"),
          ),
        { mode: "sim", key: "persist" },
      );
      assert.equal(replay.id, j.id);
      assert.equal(replay.status, "succeeded");
      assert.equal(replay.adapterTest.code, "xhs.get_note_detail.ocr");
      const detail = await store.detail("sim", j.id),
        snap = await store.snapshot("sim");
      assert.equal(detail.commands.length, 2);
      assert.equal(snap.definitions.length, 8);
      assert.equal(
        snap.devices[0].projection.detail.content,
        detail.commands.find((c) => c.code.endsWith("ocr")).receipt.result
          .fullText,
      );
      await store.atomic(
        (s, n) =>
          saveDefinition(s, n, "sim", {
            ...adapterTestDefinition("session.back", "xhs"),
            code: "custom.back",
            name: "返回",
            expectedVersion: 0,
          }),
        { mode: "sim" },
      );
      assert.equal((await store.snapshot("sim")).definitions.length, 9);
    } finally {
      await store.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
