import { validateData } from "./command-registry.mjs";

const KINDS = new Set(["poc", "adb", "custom"]);
const registries = new WeakMap();
const identifier = (value) =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(value);
const keyFor = (kind, id) => `${kind}:${id}`;
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const snapshot = (value) => freeze(structuredClone(value));
const definitionFor = (command) =>
  command?.definition || command?.definitionSnapshot;

export class CommandAdapterError extends Error {
  constructor(code, message, dispatched = false) {
    super(message);
    this.name = "CommandAdapterError";
    this.code = code;
    this.dispatched = dispatched;
    this.ambiguous = dispatched;
    this.retryable = false;
  }
}
const fail = (code, message, dispatched = false) => {
  throw new CommandAdapterError(code, message, dispatched);
};

// A trusted process installs handlers. Catalog data can select only those handlers;
// it can never supply an executable, shell command, URL, or credential here.
export function createCommandAdapterRegistry({ maxDispatches = 10000 } = {}) {
  if (!Number.isInteger(maxDispatches) || maxDispatches < 1)
    fail("invalid_registry", "maxDispatches must be a positive integer");
  const state = { handlers: new Map(), dispatches: new Map(), maxDispatches };
  const registry = Object.freeze({
    register({ kind, id, operations, execute }) {
      if (
        !KINDS.has(kind) ||
        !identifier(id) ||
        typeof execute !== "function" ||
        !Array.isArray(operations) ||
        operations.length === 0 ||
        operations.some((operation) => !identifier(operation))
      )
        fail(
          "invalid_handler",
          "Handler requires kind, id, allowed operations and execute",
        );
      const key = keyFor(kind, id);
      if (state.handlers.has(key))
        fail(
          "duplicate_handler",
          "An adapter handler cannot be replaced while registered",
        );
      const handler = Object.freeze({
        kind,
        id,
        operations: Object.freeze([...new Set(operations)]),
        execute,
      });
      state.handlers.set(key, handler);
      return handler;
    },
    getDispatch(commandId) {
      const entry = state.dispatches.get(commandId);
      return entry ? snapshot(entry) : null;
    },
  });
  registries.set(registry, state);
  return registry;
}

function selectedBinding(definition, selector, state) {
  const bindings = definition.bindings || [];
  const matches = bindings.filter((binding) => {
    if (
      !KINDS.has(binding?.kind) ||
      !identifier(binding.adapterId) ||
      !identifier(binding.operation)
    )
      return false;
    if (selector)
      return typeof selector === "string"
        ? selector === binding.adapterId
        : selector.kind === binding.kind &&
            selector.adapterId === binding.adapterId &&
            selector.operation === binding.operation;
    const handler = state.handlers.get(keyFor(binding.kind, binding.adapterId));
    return handler?.operations.includes(binding.operation);
  });
  if (matches.length === 0)
    fail(
      "binding_unavailable",
      "No installed adapter matches the frozen command binding",
    );
  if (matches.length !== 1)
    fail(
      "binding_required",
      "Choose one binding from the frozen command definition",
    );
  const binding = snapshot(matches[0]);
  const handler = state.handlers.get(keyFor(binding.kind, binding.adapterId));
  if (!handler || !handler.operations.includes(binding.operation))
    fail(
      "operation_unavailable",
      "The selected handler has not registered this operation",
    );
  return { binding, handler };
}

function requestFor(command, definition, binding) {
  if (!command || command.mode !== "real")
    fail("realm_or_state", "Only a real command can enter an adapter");
  if (
    ![
      command.id,
      command.attemptId,
      command.deviceId,
      command.appId,
      command.code,
    ].every(identifier) ||
    definition.code !== command.code ||
    (definition.appId && definition.appId !== command.appId) ||
    !Number.isInteger(definition.version) ||
    definition.version < 1 ||
    (command.commandVersion !== undefined &&
      command.commandVersion !== definition.version)
  )
    fail(
      "invalid_command",
      "Command identity does not match its frozen definition",
    );
  if (
    !Number.isInteger(definition.timeoutMs) ||
    definition.timeoutMs < 1 ||
    definition.timeoutMs > 900000
  )
    fail(
      "invalid_timeout",
      "Command timeout must be between 1 and 900000 milliseconds",
    );
  const input = command.input || command.params || {};
  try {
    validateData(input, definition.inputSchema, "Adapter input");
  } catch {
    fail("invalid_input", "Command input does not match its frozen schema");
  }
  return snapshot({
    commandId: command.id,
    ...(command.jobId ? { jobId: command.jobId } : {}),
    attemptId: command.attemptId,
    deviceId: command.deviceId,
    appId: command.appId,
    code: command.code,
    ...(command.stepIndex !== undefined
      ? { stepIndex: command.stepIndex }
      : {}),
    commandVersion: definition.version,
    operation: binding.operation,
    input,
    timeoutMs: definition.timeoutMs,
    idempotencyKey: `${command.id}:${command.attemptId}`,
  });
}

export function validateAdapterReceipt(command, receipt) {
  try {
    const definition = definitionFor(command);
    if (
      !definition ||
      receipt?.source !== "adapter" ||
      receipt.stopped !== true
    )
      return false;
    const binding = definition.bindings?.find(
      (entry) =>
        entry.kind === receipt.transport &&
        entry.adapterId === receipt.bindingId &&
        entry.operation === receipt.operation,
    );
    if (!binding) return false;
    const request = requestFor(command, definition, binding);
    if (
      [
        "commandId",
        "attemptId",
        "deviceId",
        "appId",
        "code",
        "commandVersion",
        "operation",
        "idempotencyKey",
      ].some((field) => receipt[field] !== request[field])
    )
      return false;
    if (request.jobId && receipt.jobId !== request.jobId) return false;
    if (
      request.stepIndex !== undefined &&
      receipt.stepIndex !== request.stepIndex
    )
      return false;
    validateData(receipt.result, definition.outputSchema, "Adapter output");
    const result = receipt.result;
    const has = (field) =>
      Object.hasOwn(definition.outputSchema.properties, field);
    if (
      definition.action === "open" &&
      has("foregroundAppId") &&
      result.foregroundAppId !== command.appId
    )
      return false;
    if (definition.action === "back" && has("backed") && result.backed !== true)
      return false;
    if (definition.action === "home" && has("home") && result.home !== true)
      return false;
    if (
      ["detail", "ocr"].includes(definition.action) &&
      ((has("complete") && result.complete !== true) ||
        (has("fullText") &&
          (typeof result.fullText !== "string" || !result.fullText.length)) ||
        (has("target") &&
          request.input.target &&
          result.target !== request.input.target))
    )
      return false;
    if (
      ["search", "list", "refresh", "next", "scroll"].includes(
        definition.action,
      )
    ) {
      if (
        has("keyword") &&
        request.input.keyword &&
        result.keyword !== request.input.keyword
      )
        return false;
      if (has("page") && command.page != null && result.page !== command.page)
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

// The caller must already own a durable device lease and persist dispatch before
// calling this outside its DB transaction. This process-local ledger is an extra
// duplicate guard, not durable fencing or evidence that a physical phone stopped.
export function executeBoundCommand(
  command,
  { binding: selector, registry, signal } = {},
) {
  const state = registries.get(registry);
  if (!state)
    fail("invalid_registry", "A command adapter registry is required");
  const definition = definitionFor(command);
  if (!definition)
    fail("missing_definition", "A frozen command definition is required");
  if (command.status !== "running")
    fail(
      "realm_or_state",
      "Only a claimed running command can enter an adapter",
    );
  const { binding, handler } = selectedBinding(definition, selector, state);
  const request = requestFor(command, definition, binding);
  if (signal && !(signal instanceof AbortSignal))
    fail("invalid_signal", "signal must be an AbortSignal");
  if (signal?.aborted)
    fail("aborted_before_dispatch", "Command was aborted before dispatch");
  if (state.dispatches.has(command.id))
    fail(
      "duplicate_dispatch",
      "This command has already entered an adapter; inspect its receipt",
      true,
    );
  if (state.dispatches.size >= state.maxDispatches)
    fail(
      "dispatch_capacity",
      "Adapter dispatch ledger reached its configured capacity",
    );

  // Copy before giving control to developer code, including for late validation.
  const frozenCommand = snapshot(command);
  const controller = new AbortController();
  const entry = {
    commandId: request.commandId,
    attemptId: request.attemptId,
    transport: binding.kind,
    bindingId: binding.adapterId,
    status: "running",
    dispatchedAt: Date.now(),
  };
  state.dispatches.set(command.id, entry);
  return new Promise((resolve, reject) => {
    let settled = false,
      handlerStarted = false;
    const finishUnknown = (code, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      entry.status = "unknown";
      entry.errorCode = code;
      entry.settledAt = Date.now();
      controller.abort();
      reject(new CommandAdapterError(code, message, true));
    };
    const onAbort = () =>
      finishUnknown(
        "aborted_after_dispatch",
        "Adapter was aborted; physical stop is unproven",
      );
    const timer = setTimeout(
      () =>
        finishUnknown(
          "timeout",
          "Adapter timed out; physical stop is unproven",
        ),
      request.timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        if (settled) return;
        handlerStarted = true;
        return handler.execute(
          request,
          Object.freeze({ signal: controller.signal, binding }),
        );
      })
      .then((receipt) => {
        if (!handlerStarted) return;
        const valid =
          validateAdapterReceipt(frozenCommand, receipt) &&
          receipt.transport === binding.kind &&
          receipt.bindingId === binding.adapterId &&
          receipt.operation === binding.operation;
        let accepted;
        if (valid) {
          const { input, timeoutMs, ...identity } = request;
          accepted = snapshot({
            ...identity,
            stopped: true,
            source: "adapter",
            transport: binding.kind,
            bindingId: binding.adapterId,
            result: receipt.result,
          });
        }
        if (settled) {
          entry.lateEvidence = valid
            ? { at: Date.now(), receipt: accepted }
            : { at: Date.now(), errorCode: "invalid_receipt" };
          return;
        }
        if (!valid)
          return finishUnknown(
            "invalid_receipt",
            "Adapter receipt does not prove this command completed",
          );
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        entry.status = "succeeded";
        entry.settledAt = Date.now();
        entry.receipt = accepted;
        resolve(entry.receipt);
      })
      .catch(() => {
        if (settled)
          entry.lateEvidence = { at: Date.now(), errorCode: "handler_failed" };
        else
          finishUnknown(
            "handler_failed",
            "Adapter failed after dispatch; physical stop is unproven",
          );
      });
  });
}
