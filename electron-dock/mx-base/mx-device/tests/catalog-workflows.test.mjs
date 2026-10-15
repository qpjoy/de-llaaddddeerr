import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { MemoryStore, PgStore } from "../server/store.mjs";
import { register, addJob, claim } from "../server/model.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { BUILTIN_DEFINITIONS } from "../server/workflow-catalog.mjs";
import {
  resolveCommand,
  saveCommand,
  archiveCommand,
  validateData,
} from "../server/command-registry.mjs";
import {
  saveDefinition,
  archiveDefinition,
  beginCommand,
  completeCommand,
  simulateCommand,
  validReceipt,
} from "../server/workflows.mjs";

const writableCommand = (row, changes = {}) => {
  const { id, mode, version, createdAt, archived, internal, ...editable } = row;
  return { ...editable, expectedVersion: version, ...changes };
};
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = (maxLength = 200) => ({ type: "string", maxLength });
function rack() {
  const state = new MemoryStore().state;
  const device = register(state, 1000, "sim", {
    name: "拼多多模拟手机",
    rack: "catalog",
    simApps: ["pdd"],
  });
  device.taskIntervalMs = 0;
  configureLoops(state, 1000, "sim", {
    rack: "catalog",
    revision: 0,
    maxInsertions: 0,
    smallLimit: 100,
    largeLimit: 100,
    cooldownMinMs: 0,
    cooldownMaxMs: 0,
  });
  return { state, device };
}
function drain(state, now = 1001) {
  const executed = [];
  let work = null;
  for (
    let turn = 0;
    turn < 300 &&
    state.jobs.some((job) => ["queued", "running"].includes(job.status));
    turn++
  ) {
    work ||= claim(state, now, "sim", "catalog-worker");
    assert(
      work,
      `eligible work missing: ${state.jobs.map((job) => `${job.key}:${job.reason}`).join(", ")}`,
    );
    const command = beginCommand(state, now, work.attempt);
    assert(command);
    assert.equal(
      state.commands.filter((command) => command.status === "running").length,
      1,
    );
    assert.equal(
      claim(state, now, "sim", "competing-worker"),
      null,
      "one phone cannot execute overlapping command sessions",
    );
    const receipt = simulateCommand(command);
    assert.equal(validReceipt(command, receipt), true);
    assert.equal(
      completeCommand(state, now + 50, work.attempt, command, receipt),
      true,
    );
    executed.push(command);
    now += 100;
    if (work.job.status !== "running" || work.attempt.status === "yielded")
      work = null;
  }
  assert(state.jobs.every((job) => job.status === "succeeded"));
  return executed;
}
function searchTask(state, commandCode, code = "pdd.catalog-test") {
  return saveDefinition(state, 1000, "sim", {
    code,
    name: "可编辑目录组合",
    appId: "pdd",
    loop: "small",
    expectedVersion: 0,
    steps: [
      { code: "pdd.open", repeat: 1 },
      { code: commandCode, repeat: 1 },
    ],
  });
}

test("dynamic command -> frozen task -> enqueue keeps version-one execution after command edit and archive", () => {
  const { state } = rack();
  const command = saveCommand(
    state,
    1000,
    "sim",
    writableCommand(resolveCommand(state, "pdd.search"), {
      code: "pdd.partner-search",
      name: "开发者搜索",
      expectedVersion: 0,
    }),
  );
  const task = searchTask(state, command.code);
  const snapshot = structuredClone(task.steps[1].commandDefinition);
  assert.equal(task.steps[1].commandVersion, 1);
  const edited = saveCommand(
    state,
    1001,
    "sim",
    writableCommand(command, {
      name: "新搜索",
      estimateMs: 4900,
      outputSchema: object({ changedShape: string() }),
    }),
  );
  archiveCommand(state, 1002, "sim", edited.id, { expectedVersion: 2 });
  assert.equal(resolveCommand(state, command.code), null);
  assert.deepEqual(task.steps[1].commandDefinition, snapshot);
  const job = addJob(state, 1003, "sim", {
    key: "frozen-before-enqueue",
    definitionId: task.id,
    keyword: "手机",
  });
  assert.equal(job.workflow.plan[1].commandVersion, 1);
  assert.equal(job.estimatedDurationMs, 1500 + command.estimateMs);
  assert.throws(() => searchTask(state, command.code, "pdd.archived-command"), {
    status: 400,
  });
  const commands = drain(state, 1004);
  const result = commands.find((row) => row.code === command.code);
  assert.equal(result.commandVersion, 1);
  assert.equal(result.estimatedDurationMs, command.estimateMs);
  assert.deepEqual(result.definition, snapshot);
  assert(result.receipt.result.items[0].goodsId);
  assert.equal(job.result.steps[1].commandVersion, 1);
  assert.equal(job.result.steps[1].result.keyword, "手机");
});

test("task archive blocks every new submission while idempotent replay and already queued execution remain valid", () => {
  const { state } = rack();
  const task = searchTask(state, "pdd.search");
  const request = {
    key: "before-task-archive",
    definitionId: task.id,
    keyword: "鞋子",
  };
  const queued = addJob(state, 1001, "sim", request);
  const archived = archiveDefinition(state, 1002, "sim", task.id, {
    expectedVersion: 1,
  });
  assert.equal(archived.version, 2);
  assert.equal(archived.archived, true);
  assert.equal(addJob(state, 1003, "sim", request).id, queued.id);
  assert.throws(
    () => addJob(state, 1003, "sim", { ...request, keyword: "其他关键词" }),
    { status: 409 },
  );
  assert.throws(
    () => addJob(state, 1003, "sim", { ...request, key: "new-old-version" }),
    { status: 409 },
  );
  assert.throws(
    () =>
      addJob(state, 1003, "sim", {
        ...request,
        key: "new-archived-version",
        definitionId: archived.id,
      }),
    { status: 409 },
  );
  drain(state, 1004);
  assert.equal(addJob(state, 2000, "sim", request).id, queued.id);
  assert.equal(state.jobs.length, 1);
});

test("all six migrated PDD tasks execute serially and forward search goodsId into detail and OCR", () => {
  const { state, device } = rack();
  const templates = BUILTIN_DEFINITIONS.filter(
    (definition) => definition.appId === "pdd",
  );
  assert.equal(templates.length, 6);
  for (const definition of templates)
    addJob(state, 1000, "sim", {
      key: definition.code,
      definitionId: definition.id,
      deviceId: device.id,
      keyword: "合成商品",
      target: "must-be-replaced-by-search",
    });
  const commands = drain(state);
  assert.equal(
    commands.length,
    templates.reduce(
      (sum, definition) =>
        sum + definition.steps.reduce((sum, step) => sum + step.repeat, 0),
      0,
    ),
  );
  assert(
    commands.every(
      (command) =>
        command.deviceId === device.id &&
        command.commandVersion === 1 &&
        command.receipt.source === "simulator",
    ),
  );
  for (const code of ["pdd.detail", "pdd.search_detail_ocr"]) {
    const job = state.jobs.find((job) => job.key === code);
    const search = commands.find(
      (command) => command.jobId === job.id && command.code === "pdd.search",
    );
    const goodsId = search.receipt.result.items[0].goodsId;
    assert.notEqual(goodsId, job.input.target);
    for (const command of commands.filter(
      (command) =>
        command.jobId === job.id &&
        ["pdd.detail", "pdd.ocr"].includes(command.code),
    )) {
      assert.equal(command.params.target, goodsId);
      assert.equal(command.receipt.result.target, goodsId);
      if (command.code === "pdd.detail")
        assert.equal(command.receipt.result.goodsId, goodsId);
      if (command.code === "pdd.ocr")
        assert.equal(command.receipt.result.blocks[0].confidence, 0.98);
    }
  }
  const paginated = state.jobs.find((job) => job.key === "pdd.search5");
  assert.deepEqual(
    commands
      .filter((command) => command.jobId === paginated.id && command.page)
      .map((command) => command.page),
    [1, 2, 3, 4, 5],
  );
});

test("developer custom input/output schemas remain usable without hardcoded command code or result shape", () => {
  const { state } = rack();
  const command = saveCommand(
    state,
    1000,
    "sim",
    writableCommand(resolveCommand(state, "pdd.search"), {
      code: "pdd.external-catalog",
      expectedVersion: 0,
      inputSchema: object({
        query: { ...string(20), minLength: 2 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      }),
      outputSchema: object({
        records: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: object({
            sku: { ...string(20), minLength: 2 },
            amount: { type: "integer", minimum: 100 },
          }),
        },
        total: { type: "integer", minimum: 2 },
        status: { type: "string", enum: ["ok"] },
      }),
      bindings: [
        {
          kind: "custom",
          adapterId: "company-catalog.v1",
          operation: "search",
        },
      ],
    }),
  );
  const task = searchTask(state, command.code, "pdd.custom-schema");
  assert.throws(
    () =>
      addJob(state, 1000, "sim", {
        key: "bad-query",
        definitionId: task.id,
        input: { query: "x", limit: 3 },
      }),
    { status: 400 },
  );
  assert.throws(
    () =>
      addJob(state, 1000, "sim", {
        key: "bad-limit",
        definitionId: task.id,
        input: { query: "合成商品", limit: 11 },
      }),
    { status: 400 },
  );
  assert.equal(state.jobs.length, 0);
  addJob(state, 1000, "sim", {
    key: "custom-schema",
    definitionId: task.id,
    input: { query: "合成商品", limit: 3 },
  });
  const executed = drain(state).find((row) => row.code === command.code);
  assert.deepEqual(executed.params, { query: "合成商品", limit: 3 });
  assert.equal(
    validateData(executed.receipt.result, command.outputSchema),
    true,
  );
  assert.equal(executed.receipt.result.records.length, 2);
  assert.equal(executed.receipt.result.records[0].amount, 100);
  assert.equal(executed.receipt.result.status, "ok");
});

test("step authoring rejects future/self references, unknown fields, prototype paths and schema type mismatches", () => {
  const { state } = rack();
  const make = (input) =>
    saveDefinition(state, 1000, "sim", {
      code: "pdd.invalid-input",
      name: "非法引用",
      appId: "pdd",
      loop: "small",
      expectedVersion: 0,
      steps: [
        { code: "pdd.open", repeat: 1 },
        { code: "pdd.search", repeat: 1 },
        { code: "pdd.detail", repeat: 1, input },
      ],
    });
  for (const input of [
    { target: { fromStep: 2, path: ["target"] } },
    { target: { fromStep: 3, path: ["target"] } },
    { target: { fromStep: -1, path: ["items", 0, "goodsId"] } },
    { target: { fromStep: 1, path: ["items", 0, "missing"] } },
    { target: { fromStep: 1, path: ["items", 0, "priceCents"] } },
    { target: { fromStep: 1, path: ["constructor"] } },
    {
      target: {
        fromStep: 1,
        path: ["items", 0, "goodsId"],
        shell: "forbidden",
      },
    },
    { target: 123 },
    { undeclared: "value" },
  ])
    assert.throws(() => make(input), { status: 400 });
  assert(
    !state.definitions.some(
      (definition) => definition.code === "pdd.invalid-input",
    ),
  );
});

test("missing upstream data is rejected before another command is dispatched", () => {
  const { state } = rack();
  addJob(state, 1000, "sim", {
    key: "empty-search",
    definitionId: "sim:pdd.detail:1",
  });
  const work = claim(state, 1001, "sim", "worker");
  let command = beginCommand(state, 1001, work.attempt);
  assert(
    completeCommand(
      state,
      1050,
      work.attempt,
      command,
      simulateCommand(command),
    ),
  );
  command = beginCommand(state, 1100, work.attempt);
  const receipt = simulateCommand(command);
  receipt.result.items = [];
  assert(completeCommand(state, 1150, work.attempt, command, receipt));
  assert.equal(beginCommand(state, 1200, work.attempt), null);
  assert.equal(work.job.status, "failed");
  assert.equal(work.device.state, "idle");
  assert.equal(state.commands.length, 2);
  assert.equal(
    state.commands.some((command) => command.status === "running"),
    false,
  );
});

test("receipt command version, schema, identity and canonical semantic mismatches quarantine the session", () => {
  const changes = [
    (receipt) => ({ ...receipt, commandVersion: 99 }),
    (receipt) => ({ ...receipt, result: { foregroundAppId: 123 } }),
    (receipt) => ({ ...receipt, result: { foregroundAppId: "xhs" } }),
    (receipt) => ({ ...receipt, attemptId: "other-attempt" }),
  ];
  for (const mutate of changes) {
    const { state, device } = rack();
    const job = addJob(state, 1000, "sim", {
      key: "bad-receipt",
      definitionId: "sim:pdd.search:1",
    });
    const work = claim(state, 1001, "sim", "worker");
    const command = beginCommand(state, 1001, work.attempt);
    const receipt = mutate(simulateCommand(command));
    assert.equal(validReceipt(command, receipt), false);
    assert.equal(
      completeCommand(state, 1050, work.attempt, command, receipt),
      false,
    );
    assert.equal(command.status, "unknown");
    assert.equal(job.status, "unknown");
    assert.equal(device.state, "quarantined");
    assert.equal(claim(state, 2000, "sim", "retry-worker"), null);
  }
});

const databaseUrl = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres PDD reference inputs and final step results survive store restart between every atomic command",
  { skip: !databaseUrl },
  async () => {
    const target = new URL(databaseUrl);
    assert(["localhost", "127.0.0.1"].includes(target.hostname));
    const name = `mx_catalog_workflows_${randomBytes(5).toString("hex")}`;
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    let store = new PgStore(target.href);
    const options = { mode: "sim" };
    try {
      await store.migrate();
      const { job, device } = await store.atomic((state, now) => {
        const device = register(state, now, "sim", {
          name: "持久化拼多多模拟手机",
          rack: "persisted-catalog",
          simApps: ["pdd"],
        });
        device.taskIntervalMs = 0;
        configureLoops(state, now, "sim", {
          rack: "persisted-catalog",
          revision: 0,
          maxInsertions: 0,
          smallLimit: 100,
          largeLimit: 100,
          cooldownMinMs: 0,
          cooldownMaxMs: 0,
        });
        const job = addJob(state, now, "sim", {
          key: "pdd-search-detail-ocr-restarts",
          definitionId: "sim:pdd.search_detail_ocr:1",
          deviceId: device.id,
          keyword: "持久化合成商品",
          target: "replace-from-search",
        });
        return { job, device };
      }, options);
      let expectedGoodsId;
      for (
        let stepIndex = 0;
        stepIndex < job.workflow.plan.length;
        stepIndex++
      ) {
        const work = await store.atomic(
          (state, now) =>
            claim(state, now, "sim", `catalog-worker-${stepIndex}`),
          options,
        );
        assert(work);
        assert.equal(work.job.id, job.id);
        const commandOptions = {
          ...options,
          jobId: job.id,
          attemptId: work.attempt.id,
        };
        const command = await store.atomic(
          (state, now) => beginCommand(state, now, work.attempt),
          commandOptions,
        );
        assert(command);
        assert.equal(command.stepIndex, stepIndex);
        if (["pdd.detail", "pdd.ocr"].includes(command.code))
          assert.equal(command.params.target, expectedGoodsId);
        const receipt = simulateCommand(command);
        if (command.code === "pdd.search")
          expectedGoodsId = receipt.result.items[0].goodsId;
        // Completion uses a new connection and reloads the authoritative persisted command.
        await store.close();
        store = new PgStore(target.href);
        assert.equal(
          await store.atomic(
            (state, now) =>
              completeCommand(state, now, work.attempt, command, receipt),
            commandOptions,
          ),
          true,
        );
        const persisted = await store.detail("sim", job.id);
        assert.equal(
          persisted.commands.filter((command) => command.status === "succeeded")
            .length,
          stepIndex + 1,
        );
        // The next step must resolve upstream data from the DB, not retained JS state.
        await store.close();
        store = new PgStore(target.href);
      }
      const detail = await store.detail("sim", job.id);
      assert.equal(detail.job.status, "succeeded");
      assert.equal(detail.job.result.steps.length, 5);
      assert.deepEqual(
        detail.job.result.steps.map((step) => step.code),
        ["pdd.open", "pdd.search", "pdd.detail", "pdd.ocr", "pdd.back"],
      );
      assert.equal(
        detail.job.result.steps[1].result.items[0].goodsId,
        expectedGoodsId,
      );
      assert.equal(detail.job.result.steps[2].result.target, expectedGoodsId);
      assert.equal(detail.job.result.steps[2].result.goodsId, expectedGoodsId);
      assert.equal(detail.job.result.steps[3].result.target, expectedGoodsId);
      assert.equal(
        detail.job.result.steps[3].result.blocks[0].confidence,
        0.98,
      );
      assert(
        detail.commands.every(
          (command) =>
            command.commandVersion === 1 && command.definition.version === 1,
        ),
      );
      assert.equal(
        (await store.snapshot("sim")).devices.find(
          (row) => row.id === device.id,
        ).state,
        "idle",
      );
      assert.equal((await store.snapshot("real")).devices.length, 0);
    } finally {
      await store.close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);

test("custom nullable or nested records stay intact without breaking phone projection", () => {
  const { state } = rack();
  const command = saveCommand(
    state,
    1000,
    "sim",
    writableCommand(resolveCommand(state, "pdd.search"), {
      code: "pdd.records",
      expectedVersion: 0,
      outputSchema: object({
        items: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: ["object", "null"],
            properties: { title: object({ text: string() }) },
            required: ["title"],
            additionalProperties: false,
          },
        },
      }),
    }),
  );
  const definition = searchTask(state, command.code);
  addJob(state, 1001, "sim", { key: "records", definitionId: definition.id });
  let work = claim(state, 1002, "sim", "w");
  let c = beginCommand(state, 1002, work.attempt);
  completeCommand(state, 1003, work.attempt, c, simulateCommand(c));
  c = beginCommand(state, 1004, work.attempt);
  const receipt = simulateCommand(c);
  receipt.result.items = [null, { title: { text: "原始结构" } }];
  assert.equal(completeCommand(state, 1005, work.attempt, c, receipt), true);
  assert.equal(state.jobs[0].status, "succeeded");
  assert.deepEqual(
    state.jobs[0].result.steps[1].result.items,
    receipt.result.items,
  );
  assert.equal(
    state.devices[0].projection.items[0].title,
    "结构化记录（详见回执）",
  );
});
