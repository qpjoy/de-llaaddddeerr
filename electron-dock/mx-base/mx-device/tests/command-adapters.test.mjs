import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  createCommandAdapterRegistry,
  executeBoundCommand,
  validateAdapterReceipt,
  CommandAdapterError,
} from "../server/command-adapters.mjs";

const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string", maxLength: 200 };
const command = (kind = "poc") => ({
  id: "command-1",
  jobId: "job-1",
  attemptId: "attempt-1",
  deviceId: "device-1",
  appId: "pdd",
  code: "pdd.search",
  mode: "real",
  status: "running",
  stepIndex: 1,
  page: 1,
  params: { keyword: "鞋子" },
  definition: {
    code: "pdd.search",
    appId: "pdd",
    version: 2,
    action: "search",
    timeoutMs: 1000,
    inputSchema: object({ keyword: string }),
    outputSchema: object({
      keyword: string,
      page: { type: "integer", minimum: 1 },
      items: { type: "array", maxItems: 100, items: object({ id: string }) },
    }),
    bindings: [{ kind, adapterId: `pdd-${kind}.v1`, operation: "search" }],
  },
});
const receipt = (request, binding) => ({
  ...request,
  source: "adapter",
  transport: binding.kind,
  bindingId: binding.adapterId,
  stopped: true,
  result: {
    keyword: request.input.keyword,
    page: 1,
    items: [{ id: "goods-1" }],
  },
});
const install = (registry, kind, execute, operations = ["search"]) =>
  registry.register({ kind, id: `pdd-${kind}.v1`, operations, execute });
const error =
  (code, ambiguous = false) =>
  (failure) => {
    assert.ok(failure instanceof CommandAdapterError);
    assert.equal(failure.code, code);
    assert.equal(failure.ambiguous, ambiguous);
    assert.equal(failure.retryable, false);
    return true;
  };

for (const kind of ["poc", "adb", "custom"]) {
  test(`${kind} handler executes one immutable canonical request and returns a validated receipt`, async () => {
    const registry = createCommandAdapterRegistry();
    const c = command(kind);
    let calls = 0;
    install(registry, kind, async (request, { signal, binding }) => {
      calls++;
      assert.equal(request.commandVersion, 2);
      assert.equal(request.idempotencyKey, "command-1:attempt-1");
      assert.equal(request.operation, "search");
      assert.equal(signal.aborted, false);
      assert.throws(() => {
        request.input.keyword = "changed";
      }, TypeError);
      assert.throws(() => {
        binding.operation = "detail";
      }, TypeError);
      return receipt(request, binding);
    });
    const result = await executeBoundCommand(c, { registry });
    assert.equal(calls, 1);
    assert.equal(validateAdapterReceipt(c, result), true);
    assert.equal(
      validateAdapterReceipt({ ...c, status: "succeeded" }, result),
      true,
    );
    assert.equal(result.input, undefined);
    assert.equal(result.timeoutMs, undefined);
    assert.equal(Object.isFrozen(result.result), true);
    assert.equal(registry.getDispatch(c.id).status, "succeeded");
  });
}

test("bindings and operation allowlists fail closed before dispatch", () => {
  const registry = createCommandAdapterRegistry();
  const c = command();
  assert.throws(
    () => executeBoundCommand(c, { registry }),
    error("binding_unavailable"),
  );
  let calls = 0;
  install(registry, "poc", () => calls++, ["detail"]);
  assert.throws(
    () =>
      executeBoundCommand(c, { registry, binding: c.definition.bindings[0] }),
    error("operation_unavailable"),
  );
  assert.throws(
    () =>
      executeBoundCommand(c, {
        registry,
        binding: { ...c.definition.bindings[0], operation: "detail" },
      }),
    error("binding_unavailable"),
  );
  assert.equal(calls, 0);
  assert.equal(registry.getDispatch(c.id), null);
});

test("multiple installed bindings require explicit selection, without changing frozen metadata", async () => {
  const registry = createCommandAdapterRegistry();
  const c = command();
  c.definition.bindings.push({
    kind: "adb",
    adapterId: "pdd-adb.v1",
    operation: "search",
  });
  let pocCalls = 0;
  install(registry, "poc", () => pocCalls++);
  install(registry, "adb", (request, { binding }) => receipt(request, binding));
  assert.throws(
    () => executeBoundCommand(c, { registry }),
    error("binding_required"),
  );
  const result = await executeBoundCommand(c, {
    registry,
    binding: "pdd-adb.v1",
  });
  assert.equal(result.transport, "adb");
  assert.equal(pocCalls, 0);
});

test("simulation, unclaimed commands, invalid input, versions and timeouts cannot reach adapters", () => {
  const registry = createCommandAdapterRegistry();
  let calls = 0;
  install(registry, "poc", () => calls++);
  const cases = [
    [{ ...command(), mode: "sim" }, "realm_or_state"],
    [{ ...command(), status: "queued" }, "realm_or_state"],
    [{ ...command(), params: { keyword: 123 } }, "invalid_input"],
    [{ ...command(), code: "pdd.detail" }, "invalid_command"],
    [
      { ...command(), definition: { ...command().definition, version: 0 } },
      "invalid_command",
    ],
    [
      {
        ...command(),
        definition: { ...command().definition, timeoutMs: Infinity },
      },
      "invalid_timeout",
    ],
    [
      { ...command(), definition: { ...command().definition, timeoutMs: 0 } },
      "invalid_timeout",
    ],
  ];
  for (const [c, code] of cases)
    assert.throws(() => executeBoundCommand(c, { registry }), error(code));
  assert.equal(calls, 0);
});

test("duplicate command identities never call the handler again, including cloned commands", async () => {
  const registry = createCommandAdapterRegistry();
  const c = command();
  let release,
    calls = 0;
  install(registry, "poc", (request, { binding }) => {
    calls++;
    return new Promise((resolve) => {
      release = () => resolve(receipt(request, binding));
    });
  });
  const first = executeBoundCommand(c, { registry });
  assert.throws(
    () => executeBoundCommand(structuredClone(c), { registry }),
    error("duplicate_dispatch", true),
  );
  await nextTurn();
  release();
  await first;
  assert.throws(
    () => executeBoundCommand(c, { registry }),
    error("duplicate_dispatch", true),
  );
  assert.equal(calls, 1);
});

test("timeout aborts the handler, preserves unknown, records late evidence and never retries", async () => {
  const registry = createCommandAdapterRegistry();
  const c = command();
  c.definition.timeoutMs = 10;
  let release,
    adapterSignal,
    calls = 0;
  install(registry, "poc", (request, { signal, binding }) => {
    calls++;
    adapterSignal = signal;
    return new Promise((resolve) => {
      release = () => resolve(receipt(request, binding));
    });
  });
  await assert.rejects(
    executeBoundCommand(c, { registry }),
    error("timeout", true),
  );
  assert.equal(adapterSignal.aborted, true);
  assert.equal(registry.getDispatch(c.id).status, "unknown");
  release();
  await nextTurn();
  const record = registry.getDispatch(c.id);
  assert.equal(record.status, "unknown");
  assert.equal(record.lateEvidence.receipt.commandId, c.id);
  assert.throws(
    () => executeBoundCommand(c, { registry }),
    error("duplicate_dispatch", true),
  );
  assert.equal(calls, 1);
});

test("cancellation before dispatch is safe; cancellation after dispatch remains ambiguous", async () => {
  const registry = createCommandAdapterRegistry();
  let calls = 0,
    adapterSignal;
  install(registry, "poc", (_request, { signal }) => {
    calls++;
    adapterSignal = signal;
    return new Promise(() => {});
  });
  const before = new AbortController();
  before.abort();
  assert.throws(
    () => executeBoundCommand(command(), { registry, signal: before.signal }),
    error("aborted_before_dispatch"),
  );
  assert.equal(calls, 0);
  const after = new AbortController();
  const pending = executeBoundCommand(command(), {
    registry,
    signal: after.signal,
  });
  await nextTurn();
  after.abort();
  await assert.rejects(pending, error("aborted_after_dispatch", true));
  assert.equal(adapterSignal.aborted, true);
  assert.equal(calls, 1);
});

test("immediate cancellation cannot schedule a handler after abort", async () => {
  const registry = createCommandAdapterRegistry();
  let calls = 0;
  install(registry, "poc", () => calls++);
  assert.throws(
    () => executeBoundCommand(command(), { registry, signal: {} }),
    error("invalid_signal"),
  );
  const controller = new AbortController();
  const pending = executeBoundCommand(command(), {
    registry,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, error("aborted_after_dispatch", true));
  await nextTurn();
  assert.equal(calls, 0);
});

test("throwing adapters expose a safe ambiguous error and no automatic retry", async () => {
  const registry = createCommandAdapterRegistry();
  let calls = 0;
  install(registry, "poc", () => {
    calls++;
    throw new Error("private endpoint credentials");
  });
  await assert.rejects(
    executeBoundCommand(command(), { registry }),
    (failure) => {
      error("handler_failed", true)(failure);
      assert.equal(failure.message.includes("credentials"), false);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(registry.getDispatch("command-1").status, "unknown");
});

test("wrong identities, transports, unproven stop, result types and stale result context are rejected", async () => {
  const changes = [
    { commandId: "another-command" },
    { attemptId: "another-attempt" },
    { deviceId: "another-phone" },
    { commandVersion: 1 },
    { jobId: "another-job" },
    { idempotencyKey: "another-key" },
    { source: "simulator" },
    { transport: "adb" },
    { bindingId: "unregistered" },
    { stopped: false },
    { result: { keyword: "鞋子", page: 1, items: [{ id: 42 }] } },
    { result: { keyword: "old-keyword", page: 1, items: [] } },
    { result: { keyword: "鞋子", page: 2, items: [] } },
  ];
  for (const change of changes) {
    const registry = createCommandAdapterRegistry();
    install(registry, "poc", (request, { binding }) => ({
      ...receipt(request, binding),
      ...change,
    }));
    await assert.rejects(
      executeBoundCommand(command(), { registry }),
      error("invalid_receipt", true),
    );
    assert.equal(registry.getDispatch("command-1").status, "unknown");
  }
});

test("empty structured search results are valid; screenshot-only OCR and incomplete details are not", async () => {
  const registry = createCommandAdapterRegistry();
  install(registry, "poc", (request, { binding }) => ({
    ...receipt(request, binding),
    result: { keyword: "鞋子", page: 1, items: [] },
  }));
  const c = command();
  assert.equal(
    validateAdapterReceipt(c, await executeBoundCommand(c, { registry })),
    true,
  );
  for (const action of ["detail", "ocr"]) {
    const d = command();
    d.code = d.definition.code = `pdd.${action}`;
    d.params = { target: "goods-1" };
    d.definition.action = action;
    d.definition.inputSchema = object({ target: string });
    d.definition.outputSchema = object({
      target: string,
      fullText: string,
      complete: { type: "boolean" },
    });
    d.definition.bindings[0].operation = action;
    const r = {
      commandId: d.id,
      jobId: d.jobId,
      attemptId: d.attemptId,
      deviceId: d.deviceId,
      appId: d.appId,
      code: d.code,
      stepIndex: d.stepIndex,
      commandVersion: 2,
      operation: action,
      idempotencyKey: `${d.id}:${d.attemptId}`,
      source: "adapter",
      transport: "poc",
      bindingId: "pdd-poc.v1",
      stopped: true,
    };
    assert.equal(
      validateAdapterReceipt(d, { ...r, result: { screenshot: "screen.png" } }),
      false,
    );
    assert.equal(
      validateAdapterReceipt(d, {
        ...r,
        result: { target: "goods-1", fullText: "", complete: true },
      }),
      false,
    );
    assert.equal(
      validateAdapterReceipt(d, {
        ...r,
        result: { target: "goods-1", fullText: "文字", complete: false },
      }),
      false,
    );
    assert.equal(
      validateAdapterReceipt(d, {
        ...r,
        result: { target: "goods-1", fullText: "文字", complete: true },
      }),
      true,
    );
  }
});

test("registry cannot replace installed handlers or evict duplicate protection silently", async () => {
  const registry = createCommandAdapterRegistry({ maxDispatches: 1 });
  install(registry, "poc", (request, { binding }) => receipt(request, binding));
  assert.throws(
    () => install(registry, "poc", () => {}),
    error("duplicate_handler"),
  );
  assert.throws(
    () => install(registry, "adb", () => {}, []),
    error("invalid_handler"),
  );
  await executeBoundCommand(command(), { registry });
  assert.throws(
    () => executeBoundCommand({ ...command(), id: "command-2" }, { registry }),
    error("dispatch_capacity"),
  );
  assert.equal(registry.getDispatch("command-2"), null);
});

test("developer-specific output shapes use their pinned schema without forcing another platform's fields", async () => {
  const registry = createCommandAdapterRegistry();
  const c = command("custom");
  c.code = c.definition.code = "pdd.detail";
  c.definition.action = c.definition.bindings[0].operation = "detail";
  c.definition.outputSchema = object({
    product: object({ sku: string, description: string }),
  });
  install(
    registry,
    "custom",
    (request, { binding }) => ({
      ...receipt(request, binding),
      result: { product: { sku: "goods-1", description: "商品描述" } },
    }),
    ["detail"],
  );
  const result = await executeBoundCommand(c, { registry });
  assert.equal(validateAdapterReceipt(c, result), true);
  assert.equal(result.result.product.sku, "goods-1");
});
