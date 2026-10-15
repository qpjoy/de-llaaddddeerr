import { resolveCommand, validateData } from "./command-registry.mjs";

const check = (ok, message) => {
  if (!ok) throw Object.assign(new Error(message), { status: 400 });
};
const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const reference = (value) => plain(value) && Object.hasOwn(value, "fromStep");
const safeKey = (key) =>
  typeof key === "string" &&
  /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) &&
  !["constructor", "prototype", "__proto__"].includes(key);

export function expandDefinition(state, definition) {
  const plan = [];
  let page = 0;
  for (const step of definition.steps) {
    // Legacy saved definitions predate the registry and therefore mean catalog v1.
    const command =
      step.commandDefinition ||
      resolveCommand(state, step.code, { version: step.commandVersion || 1 });
    check(command && !command.archived, "任务引用的指令版本不存在");
    for (let n = 0; n < step.repeat; n++) {
      if (command.action === "search") page = 1;
      else if (command.action === "next") page++;
      plan.push({
        code: command.code,
        commandVersion: command.version,
        definition: structuredClone(command),
        page: ["search", "next"].includes(command.action) ? page : null,
        ordinal: plan.length + 1,
        ...(step.input === undefined
          ? {}
          : { input: structuredClone(step.input) }),
      });
    }
  }
  return plan;
}

export function validateStepInput(step, index, plan) {
  if (step.input === undefined) return;
  check(
    plain(step.input) && JSON.stringify(step.input).length <= 8000,
    "步骤 input 须为有界对象",
  );
  for (const [key, value] of Object.entries(step.input)) {
    const rule = step.definition.inputSchema.properties[key];
    check(safeKey(key) && rule, "步骤输入属性未在指令 Schema 声明");
    if (!reference(value)) {
      validateData(value, rule, `步骤输入 ${key}`);
      continue;
    }
    check(
      Object.keys(value).every((k) => ["fromStep", "path"].includes(k)) &&
        Number.isInteger(value.fromStep) &&
        value.fromStep >= 0 &&
        value.fromStep < index,
      "fromStep 只能引用之前已展开的步骤（从 0 开始）",
    );
    check(
      Array.isArray(value.path) &&
        value.path.length >= 1 &&
        value.path.length <= 8,
      "结果引用 path 无效",
    );
    let source = plan[value.fromStep].definition.outputSchema;
    for (const part of value.path) {
      const types = [source?.type].flat();
      if (
        Number.isInteger(part) &&
        part >= 0 &&
        part < 200 &&
        types.includes("array")
      )
        source = source.items;
      else if (safeKey(part) && types.includes("object"))
        source = source.properties?.[part];
      else source = null;
      check(source, "结果引用路径未在上游输出 Schema 声明");
    }
    check(
      [source.type]
        .flat()
        .some(
          (t) =>
            [rule.type].flat().includes(t) ||
            (t === "integer" && rule.type === "number"),
        ),
      "结果引用与输入 Schema 类型不匹配",
    );
  }
}

export function commandInput(state, job, attempt, step, preflight = false) {
  const schema = step.definition.inputSchema;
  const available = { ...job.input, appId: job.appId, page: step.page ?? null };
  const params = Object.fromEntries(
    Object.keys(schema.properties)
      .filter((key) => Object.hasOwn(available, key))
      .map((key) => [key, available[key]]),
  );
  const deferred = new Set();
  for (const [key, value] of Object.entries(step.input || {})) {
    if (!reference(value)) {
      params[key] = structuredClone(value);
      continue;
    }
    if (preflight) {
      deferred.add(key);
      delete params[key];
      continue;
    }
    const source = state.commands.find(
      (c) =>
        c.jobId === job.id &&
        c.attemptId === attempt?.id &&
        c.stepIndex === value.fromStep &&
        !c.restoring &&
        c.status === "succeeded",
    );
    let result = source?.receipt?.result;
    for (const part of value.path) {
      check(
        result !== null &&
          typeof result === "object" &&
          Object.hasOwn(result, part),
        "上游回执中没有所需数据，任务未派发下一指令",
      );
      result = result[part];
    }
    params[key] = structuredClone(result);
  }
  validateData(
    params,
    preflight
      ? {
          ...schema,
          required: (schema.required || []).filter((k) => !deferred.has(k)),
        }
      : schema,
    "指令输入",
  );
  return params;
}

// Deterministic synthetic data for catalog simulation; this is never real app data.
export function sampleOutput(schema, candidate) {
  if (schema.enum)
    return schema.enum.includes(candidate) ? candidate : schema.enum[0];
  const types = [schema.type].flat();
  if (candidate === null && types.includes("null")) return null;
  const type = types.find((t) => t !== "null") || "null";
  if (type === "object")
    return Object.fromEntries(
      Object.entries(schema.properties || {}).map(([key, rule]) => [
        key,
        sampleOutput(rule, candidate?.[key]),
      ]),
    );
  if (type === "array") {
    const items = Array.isArray(candidate) ? candidate : [];
    const count = Math.max(
      schema.minItems || 0,
      Math.min(schema.maxItems ?? 100, items.length),
    );
    return Array.from({ length: count }, (_, index) =>
      sampleOutput(schema.items, items[index]),
    );
  }
  if (type === "string") {
    const value = typeof candidate === "string" ? candidate : "模拟数据";
    return value
      .padEnd(schema.minLength || 0, "x")
      .slice(0, schema.maxLength ?? 2000);
  }
  if (["integer", "number"].includes(type)) {
    const value =
      typeof candidate === "number" && Number.isFinite(candidate)
        ? candidate
        : 0;
    const limited = Math.max(
      schema.minimum ?? -Number.MAX_SAFE_INTEGER,
      Math.min(schema.maximum ?? Number.MAX_SAFE_INTEGER, value),
    );
    return type === "integer" ? Math.round(limited) : limited;
  }
  if (type === "boolean")
    return typeof candidate === "boolean" ? candidate : true;
  return null;
}
