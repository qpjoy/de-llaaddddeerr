import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";
import { MemoryStore, PgStore } from "../server/store.mjs";
import {
  BUILTIN_COMMAND_DEFINITIONS,
  BUILTIN_DEFINITIONS,
} from "../server/workflow-catalog.mjs";
import {
  commandDefinitions,
  resolveCommand,
  saveCommand,
  archiveCommand,
  validateSchema,
  validateData,
} from "../server/command-registry.mjs";

function edit(row, overrides = {}) {
  const { id, mode, version, createdAt, archived, internal, ...body } = row;
  return { ...body, expectedVersion: version, ...overrides };
}
test("command catalog CRUD uses immutable versions, CAS, archive tombstones and restoration", () => {
  const s = new MemoryStore().state;
  const first = resolveCommand(s, "pdd.search");
  const original = structuredClone(first);
  const second = saveCommand(
    s,
    1000,
    "sim",
    edit(first, { name: "关键词搜索 v2", estimateMs: 3500 }),
  );
  assert.equal(second.id, "sim:pdd.search:2");
  assert.equal(resolveCommand(s, "pdd.search").version, 2);
  assert.deepEqual(resolveCommand(s, "pdd.search", { version: 1 }), original);
  second.name = "client mutation";
  assert.equal(resolveCommand(s, "pdd.search").name, "关键词搜索 v2");
  assert.throws(() => saveCommand(s, 1001, "sim", edit(first)), {
    status: 409,
  });
  assert.throws(
    () => archiveCommand(s, 1001, "sim", first.id, { expectedVersion: 2 }),
    { status: 409 },
  );
  const archived = archiveCommand(s, 1002, "sim", second.id, {
    expectedVersion: 2,
  });
  assert.equal(archived.version, 3);
  assert.equal(archived.archived, true);
  assert.equal(resolveCommand(s, "pdd.search"), null);
  assert.equal(
    resolveCommand(s, "pdd.search", { allowArchived: true }).version,
    3,
  );
  assert.deepEqual(resolveCommand(s, "pdd.search", { version: 1 }), original);
  assert.equal(
    commandDefinitions(s).filter((c) => c.code === "pdd.search").length,
    0,
  );
  assert.equal(
    commandDefinitions(s, { history: true, includeArchived: true }).filter(
      (c) => c.code === "pdd.search",
    ).length,
    3,
  );
  assert.throws(
    () => archiveCommand(s, 1003, "sim", archived.id, { expectedVersion: 3 }),
    { status: 409 },
  );
  const restored = saveCommand(s, 1003, "sim", edit(archived));
  assert.equal(restored.version, 4);
  assert.equal(restored.archived, false);
  assert.equal(
    commandDefinitions(s).filter((c) => c.code === "pdd.search").length,
    1,
  );
});

test("custom commands create once and fail closed on unknown fields, executable bindings, unsafe schema and real edits", () => {
  const s = new MemoryStore().state;
  const body = edit(resolveCommand(s, "pdd.search"), {
    code: "pdd.partner-search",
    expectedVersion: 0,
  });
  const created = saveCommand(s, 1000, "sim", body);
  assert.equal(created.version, 1);
  assert.throws(() => saveCommand(s, 1000, "sim", body), { status: 409 });
  for (const override of [
    { id: "sim:pdd.inject:1" },
    { internal: true },
    { action: "exec" },
    { effect: "write" },
    { appId: "unknown" },
    { estimateMs: 0 },
    { timeoutMs: 100 },
    {
      bindings: [
        { kind: "adb", adapterId: "device-shell", operation: "input tap 1 1" },
      ],
    },
    {
      bindings: [
        {
          kind: "custom",
          adapterId: "https://example.invalid",
          operation: "search",
        },
      ],
    },
    {
      bindings: [
        {
          kind: "poc",
          adapterId: "pdd-poc.v1",
          operation: "search",
          token: "secret",
        },
      ],
    },
    { bindings: [{ kind: "poc", adapterId: undefined, operation: "search" }] },
    { bindings: [body.bindings[0], body.bindings[0]] },
    { inputSchema: { type: "object", additionalProperties: true } },
    { outputSchema: { $ref: "https://example.invalid/schema" } },
  ])
    assert.throws(
      () =>
        saveCommand(s, 1001, "sim", {
          ...body,
          code: "pdd.invalid",
          ...override,
        }),
      { status: 400 },
    );
  assert.throws(() => saveCommand(s, 1001, "real", body), { status: 403 });
  assert.throws(
    () => archiveCommand(s, 1001, "real", created.id, { expectedVersion: 1 }),
    { status: 403 },
  );
  const internal = resolveCommand(s, "session.restore");
  assert.throws(() => saveCommand(s, 1001, "sim", edit(internal)), {
    status: 403,
  });
  assert.throws(
    () => archiveCommand(s, 1001, "sim", internal.id, { expectedVersion: 1 }),
    { status: 403 },
  );
});

test("bounded schema validation handles required fields, arrays, numbers, enum and nullable page", () => {
  const pdd = resolveCommand(new MemoryStore().state, "pdd.search");
  const schema = validateSchema(pdd.outputSchema);
  const goods = {
    id: "goods-1",
    goodsId: "1001",
    title: "模拟商品",
    priceCents: 1500,
  };
  const result = { keyword: "手机", page: null, items: [goods] };
  assert.equal(validateData(result, schema), true);
  for (const value of [
    { ...result, page: "1" },
    { ...result, page: 0 },
    { ...result, unexpected: true },
    { ...result, items: [{ ...goods, priceCents: -1 }] },
    { ...result, items: [{ title: "没有 ID" }] },
    { ...result, items: Array.from({ length: 101 }, () => goods) },
  ])
    assert.throws(() => validateData(value, schema), { status: 400 });
  assert.throws(() => validateSchema({ type: "string", pattern: "(a+)+$" }), {
    status: 400,
  });
  assert.throws(
    () =>
      validateSchema({
        type: "array",
        maxItems: 201,
        items: { type: "string" },
      }),
    { status: 400 },
  );
  assert.throws(
    () =>
      validateSchema(
        JSON.parse(
          '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
        ),
      ),
    { status: 400 },
  );
  assert.throws(() => validateSchema({ type: "string", enum: [1] }), {
    status: 400,
  });
  const enumSchema = validateSchema({
    type: ["string", "null"],
    enum: ["list", null],
  });
  assert.equal(validateData(null, enumSchema), true);
  assert.throws(() => validateData("detail", enumSchema), { status: 400 });
  const deep = { type: "string" };
  let root = deep;
  for (let i = 0; i < 8; i++) root = { type: "array", items: root };
  assert.throws(() => validateSchema(root), { status: 400 });
});

test("PDD seeds and migration contain the same command and task documents with no real capability", async () => {
  const s = new MemoryStore().state;
  assert.equal(
    commandDefinitions(s).filter((c) => c.appId === "pdd").length,
    9,
  );
  assert.equal(s.definitions.filter((d) => d.appId === "pdd").length, 6);
  for (const c of BUILTIN_COMMAND_DEFINITIONS) {
    validateSchema(c.inputSchema);
    validateSchema(c.outputSchema);
  }
  const sql = await readFile(
    new URL("../migrations/007_command_registry.sql", import.meta.url),
    "utf8",
  );
  const rows = [...sql.matchAll(/'((?:[^']|'')*)'::jsonb/g)].map((match) =>
    JSON.parse(match[1].replaceAll("''", "'")),
  );
  const commands = rows.filter((row) => row.action);
  const tasks = rows.filter((row) => row.steps);
  assert.deepEqual(commands, BUILTIN_COMMAND_DEFINITIONS);
  assert.deepEqual(
    tasks,
    BUILTIN_DEFINITIONS.filter((row) => row.appId === "pdd"),
  );
  assert.equal(
    (await new MemoryStore().snapshot("real")).commandDefinitions.length,
    0,
  );
});

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres command catalog migrates once, serializes concurrent edits and retains archive history across restart",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(["localhost", "127.0.0.1"].includes(target.hostname));
    const name = `mx_commands_${randomBytes(5).toString("hex")}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    let a = new PgStore(target.href),
      b = new PgStore(target.href);
    try {
      // Simulate an installation upgraded from 006, including a user-authored task.
      await a.pool.query("CREATE SCHEMA mx_device");
      await a.pool.query(
        "CREATE TABLE mx_device.schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const migrationDir = new URL("../migrations/", import.meta.url);
      for (const name of (await readdir(migrationDir))
        .filter((name) => /^00[1-6]_.*\.sql$/.test(name))
        .sort()) {
        const sql = await readFile(new URL(name, migrationDir), "utf8");
        await a.pool.query(sql);
        await a.pool.query(
          "INSERT INTO mx_device.schema_migrations(name,checksum) VALUES($1,$2)",
          [name, createHash("sha256").update(sql).digest("hex")],
        );
      }
      const legacyTask = {
        id: "sim:custom.upgrade:1",
        mode: "sim",
        code: "custom.upgrade",
        version: 1,
        name: "保留升级前组合",
        appId: "xhs",
        loop: "small",
        executionModel: "checkpoint-session.v1",
        steps: [
          { code: "app.open", repeat: 1 },
          {
            code: "xhs.note.detail",
            repeat: 1,
            input: { target: "pre-upgrade-id" },
          },
        ],
      };
      await a.pool.query(
        "INSERT INTO mx_device.task_definitions VALUES($1,$2,$3,$4,$5)",
        [
          legacyTask.id,
          legacyTask.mode,
          legacyTask.code,
          legacyTask.version,
          legacyTask,
        ],
      );
      await Promise.all([a.migrate(), b.migrate()]);
      const before = await a.snapshot("sim");
      assert.deepEqual(
        before.commandDefinitions.sort((x, y) => x.id.localeCompare(y.id)),
        structuredClone(BUILTIN_COMMAND_DEFINITIONS).sort((x, y) =>
          x.id.localeCompare(y.id),
        ),
      );
      const migratedLegacy = before.definitions.find(
        (d) => d.id === legacyTask.id,
      );
      assert.equal(migratedLegacy.steps[1].input.target, "pre-upgrade-id");
      assert.equal(migratedLegacy.steps[1].commandVersion, 1);
      assert.equal(
        migratedLegacy.steps[1].commandDefinition.code,
        "xhs.note.detail",
      );
      for (const definition of BUILTIN_DEFINITIONS)
        assert.deepEqual(
          before.definitions.find((d) => d.id === definition.id),
          definition,
        );
      const original = resolveCommand(before, "pdd.search");
      const edits = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 ? a : b).atomic(
            (state, now) =>
              saveCommand(
                state,
                now,
                "sim",
                edit(original, { name: "并发编辑" }),
              ),
            { mode: "sim" },
          ),
        ),
      );
      assert.equal(edits.filter((r) => r.status === "fulfilled").length, 1);
      assert(
        edits
          .filter((r) => r.status === "rejected")
          .every((r) => r.reason.status === 409),
      );
      const current = resolveCommand(await a.snapshot("sim"), "pdd.search");
      await b.atomic(
        (state, now) =>
          archiveCommand(state, now, "sim", current.id, { expectedVersion: 2 }),
        { mode: "sim" },
      );
      await a.close();
      a = new PgStore(target.href);
      await a.migrate();
      const after = await a.snapshot("sim");
      assert.equal(resolveCommand(after, "pdd.search"), null);
      assert.equal(
        resolveCommand(after, "pdd.search", { allowArchived: true }).version,
        3,
      );
      assert.deepEqual(
        resolveCommand(after, "pdd.search", { version: 1 }),
        original,
      );
      assert.equal((await a.snapshot("real")).commandDefinitions.length, 0);
      const appsConstraint = await a.pool.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='mx_device.device_apps'::regclass AND contype='c'",
      );
      assert(
        appsConstraint.rows.some(
          (r) =>
            r.definition.includes("mode = 'sim'") &&
            r.definition.includes("app_id = 'xhs'"),
        ),
      );
    } finally {
      await Promise.all([a.close(), b.close()]);
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);

test("canonical action fields reject incompatible schemas before save while platform record shapes stay extensible", () => {
  const state = new MemoryStore().state;
  const object = (properties) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const string = { type: "string", maxLength: 200 };
  const cases = [
    ["pdd.open", "foregroundAppId", { type: "number" }],
    ["pdd.home", "home", { type: "string" }],
    ["pdd.back", "backed", { type: "integer" }],
    ["weibo.like", "liked", { type: "string" }],
    ["weibo.like", "target", { type: "integer" }],
    ["pdd.detail", "target", { type: "number" }],
    ["pdd.detail", "complete", { type: "string" }],
    ["pdd.ocr", "fullText", { type: ["string", "null"] }],
    ["pdd.search", "keyword", { type: "number" }],
    ["pdd.search", "page", { type: "string" }],
    ["pdd.search", "page", { type: "null" }],
    ["pdd.refresh", "page", { type: "integer" }],
    ["pdd.search", "items", object({ count: { type: "integer" } })],
  ];
  for (const [code, field, schema] of cases) {
    const command = resolveCommand(state, code);
    assert.throws(
      () =>
        saveCommand(
          state,
          1000,
          "sim",
          edit(command, { outputSchema: object({ [field]: schema }) }),
        ),
      { status: 400 },
      `${code}.${field}`,
    );
    assert.equal(resolveCommand(state, code).version, 1);
  }
  const search = resolveCommand(state, "pdd.search");
  for (const [field, schema] of [
    ["keyword", { type: "number" }],
    ["target", { type: "boolean" }],
    ["appId", { type: "integer" }],
    ["page", string],
  ]) {
    assert.throws(
      () =>
        saveCommand(
          state,
          1000,
          "sim",
          edit(search, {
            inputSchema: object({ [field]: schema }),
            outputSchema: object({ arbitraryData: string }),
          }),
        ),
      { status: 400 },
    );
  }
  for (const code of ["pdd.search", "pdd.detail", "pdd.ocr", "weibo.like"]) {
    assert.throws(
      () =>
        saveCommand(
          state,
          1000,
          "sim",
          edit(resolveCommand(state, code), {
            inputSchema: object({ developerQuery: string }),
          }),
        ),
      { status: 400 },
      `${code} compared output requires matching input`,
    );
  }
  const extensible = saveCommand(
    state,
    1000,
    "sim",
    edit(search, {
      outputSchema: object({
        keyword: string,
        page: { type: "integer", minimum: 1 },
        items: {
          type: "array",
          maxItems: 20,
          items: object({
            skuCode: string,
            price: string,
            attributes: object({ size: string }),
          }),
        },
      }),
    }),
  );
  assert.equal(extensible.version, 2);
  assert.deepEqual(
    Object.keys(extensible.outputSchema.properties.items.items.properties),
    ["skuCode", "price", "attributes"],
  );
  const fullyCustom = saveCommand(
    state,
    1001,
    "sim",
    edit(extensible, {
      inputSchema: object({ developerQuery: string }),
      outputSchema: object({
        records: {
          type: "array",
          maxItems: 10,
          items: object({ product: string }),
        },
      }),
    }),
  );
  assert.equal(fullyCustom.version, 3);
  assert(!Object.hasOwn(fullyCustom.outputSchema.properties, "keyword"));
});
