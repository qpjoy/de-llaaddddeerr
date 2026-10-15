import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";

const cfg = { adminToken: "a".repeat(64), testToken: "b".repeat(64) };
const objectSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
const commandBody = (overrides = {}) => ({
  code: "pdd.http_refresh",
  name: "拼多多 · HTTP 测试刷新",
  appId: "pdd",
  action: "refresh",
  effect: "read",
  estimateMs: 1800,
  timeoutMs: 10000,
  inputSchema: objectSchema,
  outputSchema: objectSchema,
  bindings: [
    { kind: "poc", adapterId: "pdd-poc", operation: "pdd.refresh" },
    { kind: "adb", adapterId: "pdd-adb", operation: "pdd.refresh" },
    { kind: "custom", adapterId: "pdd-service", operation: "pdd.refresh" },
  ],
  mapping: "逻辑连接器引用，仅测试目录，不执行手机操作",
  expectedVersion: 0,
  ...overrides,
});
const taskBody = (overrides = {}) => ({
  code: "pdd.http_task",
  name: "拼多多 · HTTP 测试组合",
  appId: "pdd",
  loop: "small",
  resumable: false,
  expectedVersion: 0,
  steps: [
    { code: "pdd.open", repeat: 1 },
    { code: "pdd.refresh", repeat: 1 },
  ],
  ...overrides,
});
const resourcePath = (kind, row, mode = "sim") =>
  `/api/${kind}-definitions/${encodeURIComponent(row.id)}?mode=${mode}`;

async function fixture(t) {
  const store = new MemoryStore(() => 1760000000000);
  const app = createApp({ store, cfg });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  async function request(
    path,
    {
      method = "GET",
      body,
      token = cfg.adminToken,
      headers = {},
      json = true,
      raw,
    } = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined && json
          ? { "content-type": "application/json" }
          : {}),
        ...headers,
      },
      ...(body !== undefined || raw !== undefined
        ? { body: raw ?? JSON.stringify(body) }
        : {}),
    });
    return {
      status: response.status,
      value: await response.json(),
      headers: response.headers,
    };
  }
  const post = (path, body, options = {}) =>
    request(path, { method: "POST", body, ...options });
  const remove = (path, body, options = {}) =>
    request(path, { method: "DELETE", body, ...options });
  return { store, request, post, remove };
}
function readableError(result, status, pattern) {
  assert.equal(result.status, status, JSON.stringify(result.value));
  assert.equal(typeof result.value.error, "string");
  assert(
    result.value.error.trim().length > 3,
    "client should receive a useful validation error",
  );
  assert(
    !result.value.error.includes("\n    at "),
    "internal stack traces must not be exposed",
  );
  if (pattern) assert.match(result.value.error, pattern);
}

test("catalog HTTP command CRUD preserves pinned history, supports encoded IDs and restores archived definitions", async (t) => {
  const { store, request, post, remove } = await fixture(t);
  const created = await post(
    "/api/command-definitions?mode=sim",
    commandBody(),
  );
  assert.equal(created.status, 201, JSON.stringify(created.value));
  const first = created.value;
  assert.equal(first.version, 1);
  assert.equal(first.archived, false);
  assert.deepEqual(first.bindings, commandBody().bindings);
  const beforeUpdate = structuredClone(first);
  const updated = await post(
    "/api/command-definitions?mode=sim",
    commandBody({
      name: "更新后的拼多多刷新",
      estimateMs: 2300,
      expectedVersion: 1,
    }),
  );
  assert.equal(updated.status, 201, JSON.stringify(updated.value));
  assert.equal(updated.value.version, 2);
  assert.notEqual(updated.value.id, first.id);
  const listed = await request("/api/command-definitions?mode=sim");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.value.history.find((row) => row.id === first.id),
    beforeUpdate,
  );
  assert.deepEqual(
    listed.value.commands.filter((row) => row.code === first.code),
    [updated.value],
  );

  const encoded = resourcePath("command", updated.value);
  assert(encoded.includes("%3A"), "exercise URL-encoded colon-separated IDs");
  const archived = await remove(encoded, { expectedVersion: 2 });
  assert.equal(archived.status, 200, JSON.stringify(archived.value));
  assert.equal(archived.value.version, 3);
  assert.equal(archived.value.archived, true);
  const afterArchive = await request("/api/command-definitions?mode=sim");
  assert(!afterArchive.value.commands.some((row) => row.code === first.code));
  assert.deepEqual(
    afterArchive.value.history
      .filter((row) => row.code === first.code)
      .map((row) => row.version),
    [1, 2, 3],
  );
  const restored = await post(
    "/api/command-definitions?mode=sim",
    commandBody({ expectedVersion: 3 }),
  );
  assert.equal(restored.status, 201, JSON.stringify(restored.value));
  assert.equal(restored.value.version, 4);
  assert.equal(restored.value.archived, false);
  assert.equal(store.state.attempts.length, 0);
  assert.equal(store.state.commands.length, 0);
});

test("catalog HTTP task CRUD freezes command versions and preserves old templates through archive and restore", async (t) => {
  const { request, post, remove, store } = await fixture(t);
  const command = (
    await post("/api/command-definitions?mode=sim", commandBody())
  ).value;
  const draft = taskBody({
    steps: [
      { code: "pdd.open", repeat: 1 },
      {
        code: command.code,
        commandVersion: command.version,
        repeat: 1,
        input: {},
      },
    ],
  });
  const created = await post("/api/task-definitions?mode=sim", draft);
  assert.equal(created.status, 201, JSON.stringify(created.value));
  const first = created.value;
  assert.equal(first.version, 1);
  assert.equal(first.steps[1].commandVersion, 1);
  assert.equal(first.steps[1].commandDefinition.estimateMs, 1800);
  await post(
    "/api/command-definitions?mode=sim",
    commandBody({ expectedVersion: 1, estimateMs: 3500 }),
  );
  const updated = await post("/api/task-definitions?mode=sim", {
    ...draft,
    name: "更新后的刷新任务",
    expectedVersion: 1,
  });
  assert.equal(updated.status, 201, JSON.stringify(updated.value));
  assert.equal(updated.value.version, 2);
  assert.equal(
    updated.value.steps[1].commandVersion,
    1,
    "explicit version pin survives command changes",
  );
  const listed = await request("/api/task-definitions?mode=sim");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.value.definitions.find((row) => row.id === first.id),
    first,
  );
  assert.equal(
    listed.value.commands.find((row) => row.code === command.code).version,
    2,
  );
  const archived = await remove(resourcePath("task", updated.value), {
    expectedVersion: 2,
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.value));
  assert.equal(archived.value.version, 3);
  assert.equal(archived.value.archived, true);
  const afterArchive = await request("/api/task-definitions?mode=sim");
  assert.equal(
    afterArchive.value.definitions.find((row) => row.id === archived.value.id)
      .archived,
    true,
  );
  const restored = await post("/api/task-definitions?mode=sim", {
    ...draft,
    expectedVersion: 3,
  });
  assert.equal(restored.status, 201, JSON.stringify(restored.value));
  assert.equal(restored.value.version, 4);
  assert.equal(restored.value.archived, false);
  assert.equal(store.state.jobs.length, 0);
  assert.equal(store.state.attempts.length, 0);
});

test("catalog HTTP enforces authentication, real realm isolation, and DELETE origin and JSON requirements", async (t) => {
  const { store, request, post, remove } = await fixture(t);
  const command = (
    await post("/api/command-definitions?mode=sim", commandBody())
  ).value;
  const task = (await post("/api/task-definitions?mode=sim", taskBody())).value;
  const before = structuredClone(store.state);
  for (const [kind, row, draft] of [
    ["command", command, commandBody()],
    ["task", task, taskBody()],
  ]) {
    const path = `/api/${kind}-definitions`;
    readableError(
      await request(`${path}?mode=sim`, { token: "" }),
      401,
      /登录/,
    );
    readableError(
      await post(`${path}?mode=sim`, draft, { token: "" }),
      401,
      /登录/,
    );
    readableError(
      await remove(
        resourcePath(kind, row),
        { expectedVersion: 1 },
        { token: "" },
      ),
      401,
      /登录/,
    );
    readableError(await post(`${path}?mode=real`, draft), 403, /模拟/);
    readableError(
      await remove(resourcePath(kind, row, "real"), { expectedVersion: 1 }),
      403,
      /模拟/,
    );
    for (const method of ["GET", "POST", "DELETE"]) {
      const realPath =
        method === "DELETE"
          ? resourcePath(kind, row, "real")
          : `${path}?mode=real`;
      readableError(
        await request(realPath, {
          method,
          token: cfg.testToken,
          ...(method === "GET"
            ? {}
            : { body: method === "DELETE" ? { expectedVersion: 1 } : draft }),
        }),
        403,
        /测试凭证仅允许模拟/,
      );
    }
    readableError(
      await remove(
        resourcePath(kind, row),
        { expectedVersion: 1 },
        { headers: { origin: "https://cross-site.invalid" } },
      ),
      403,
      /跨站/,
    );
    readableError(
      await remove(
        resourcePath(kind, row),
        { expectedVersion: 1 },
        { json: false },
      ),
      415,
      /JSON/,
    );
    readableError(
      await remove(
        resourcePath(kind, row),
        { expectedVersion: 1 },
        { raw: "{broken-json" },
      ),
      400,
      /JSON/,
    );
  }
  assert.deepEqual(
    store.state,
    before,
    "rejected writes must leave both catalogs unchanged",
  );
});

test("catalog HTTP returns readable CAS conflicts and validation errors without partial writes", async (t) => {
  const { store, post, remove, request } = await fixture(t);
  const command = (
    await post("/api/command-definitions?mode=sim", commandBody())
  ).value;
  const task = (await post("/api/task-definitions?mode=sim", taskBody())).value;
  const before = structuredClone(store.state);
  readableError(
    await post("/api/command-definitions?mode=sim", commandBody()),
    409,
    /版本.*刷新/,
  );
  readableError(
    await post("/api/task-definitions?mode=sim", taskBody()),
    409,
    /版本.*刷新/,
  );
  for (const [kind, row] of [
    ["command", command],
    ["task", task],
  ]) {
    readableError(
      await remove(resourcePath(kind, row), { expectedVersion: 0 }),
      409,
      /(版本|更新).*刷新/,
    );
    readableError(
      await remove(`/api/${kind}-definitions/%E0%A4%A?mode=sim`, {
        expectedVersion: 1,
      }),
      400,
      /ID/,
    );
  }
  readableError(
    await post(
      "/api/command-definitions?mode=sim",
      commandBody({
        code: "pdd.invalid_schema",
        inputSchema: { type: "object", additionalProperties: true },
      }),
    ),
    400,
    /Schema/,
  );
  readableError(
    await post(
      "/api/command-definitions?mode=sim",
      commandBody({
        code: "pdd.invalid_binding",
        bindings: [
          {
            kind: "custom",
            adapterId: "http://example.invalid",
            operation: "fetch",
          },
        ],
      }),
    ),
    400,
    /绑定/,
  );
  readableError(
    await post(
      "/api/task-definitions?mode=sim",
      taskBody({
        code: "pdd.invalid_task",
        steps: [{ code: "pdd.refresh", repeat: 1 }],
      }),
    ),
    400,
    /第一条.*打开/,
  );
  readableError(
    await post(
      "/api/task-definitions?mode=sim",
      taskBody({
        code: "pdd.foreign_command",
        steps: [
          { code: "pdd.open", repeat: 1 },
          { code: "xhs.search", repeat: 1 },
        ],
      }),
    ),
    400,
    /指令.*App/,
  );
  assert.deepEqual(store.state, before);
  const latestCommand = await post(
    "/api/command-definitions?mode=sim",
    commandBody({ expectedVersion: 1, name: "current command" }),
  );
  const latestTask = await post(
    "/api/task-definitions?mode=sim",
    taskBody({ expectedVersion: 1, name: "current task" }),
  );
  assert.equal(latestCommand.status, 201);
  assert.equal(latestTask.status, 201);
  readableError(
    await remove(resourcePath("command", command), { expectedVersion: 2 }),
    409,
    /更新/,
  );
  readableError(
    await remove(resourcePath("task", task), { expectedVersion: 2 }),
    409,
    /更新/,
  );
  assert.equal(
    (await request("/api/command-definitions?mode=sim")).value.commands.find(
      (row) => row.code === command.code,
    ).version,
    2,
  );
});

test("catalog reads never dispatch queued work or mutate commands, templates, device state or attempts", async (t) => {
  const { store, request, post } = await fixture(t);
  const device = await post("/api/devices?mode=sim", {
    name: "PDD read-only probe",
    simApps: ["pdd"],
  });
  assert.equal(device.status, 201, JSON.stringify(device.value));
  const task = await post("/api/task-definitions?mode=sim", taskBody());
  assert.equal(task.status, 201, JSON.stringify(task.value));
  const job = await post("/api/jobs?mode=sim", {
    key: "catalog-read-no-dispatch",
    definitionId: task.value.id,
    deviceId: device.value.id,
    keyword: "保温杯",
    target: "demo-goods-1",
  });
  assert.equal(job.status, 202, JSON.stringify(job.value));
  assert.equal(job.value.status, "queued");
  const before = structuredClone(store.state);
  for (let i = 0; i < 3; i++) {
    const results = await Promise.all([
      request("/api/command-definitions?mode=sim", { token: cfg.testToken }),
      request("/api/task-definitions?mode=sim", { token: cfg.testToken }),
      request("/api/state?mode=sim", { token: cfg.testToken }),
      request("/api/command-definitions?mode=real"),
      request("/api/task-definitions?mode=real"),
    ]);
    assert(results.every((result) => result.status === 200));
    assert.deepEqual(results[3].value, { commands: [], history: [] });
    assert.deepEqual(results[4].value, { definitions: [], commands: [] });
    assert.deepEqual(store.state, before);
  }
  assert.equal(store.state.jobs[0].status, "queued");
  assert.equal(store.state.commands.length, 0);
  assert.equal(store.state.attempts.length, 0);
});
