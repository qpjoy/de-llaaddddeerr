import { randomUUID } from "node:crypto";
import {
  BUILTIN_COMMAND_DEFINITIONS,
  COMMAND_ACTIONS,
} from "./workflow-catalog.mjs";

const check = (condition, message, status = 400) => {
  if (!condition) throw Object.assign(new Error(message), { status });
};
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const namePattern = /^[a-z][a-z0-9_.-]{1,79}$/;
const propertyPattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const forbiddenKey = (key) =>
  ["__proto__", "constructor", "prototype"].includes(key);
const types = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
];
const allowedSchemaKeys = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "enum",
]);

// Deliberately small declarative subset: no executable validators, regex, remote refs,
// defaults, credentials, or unbounded recursion. Normalized limits are persisted.
export function validateSchema(schema, label = "Schema") {
  let nodes = 0;
  check(JSON.stringify(schema)?.length <= 24000, `${label} 过大`);
  const visit = (value, depth) => {
    check(
      plain(value) && depth <= 6 && ++nodes <= 100,
      `${label} 结构或深度无效`,
    );
    check(
      Object.keys(value).every((key) => allowedSchemaKeys.has(key)),
      `${label} 含不支持的字段`,
    );
    const alternatives = Array.isArray(value.type) ? value.type : [value.type];
    check(
      alternatives.length >= 1 &&
        alternatives.length <= 2 &&
        new Set(alternatives).size === alternatives.length &&
        alternatives.every((type) => types.includes(type)) &&
        (alternatives.length === 1 || alternatives.includes("null")),
      `${label} type 无效`,
    );
    const type = alternatives.find((type) => type !== "null") || "null";
    const result = { type: structuredClone(value.type) };
    for (const key of ["title", "description"])
      if (own(value, key)) {
        check(
          typeof value[key] === "string" && value[key].length <= 500,
          `${label} ${key} 无效`,
        );
        result[key] = value[key];
      }
    const specific = {
      object: ["properties", "required", "additionalProperties"],
      array: ["items", "minItems", "maxItems"],
      string: ["minLength", "maxLength"],
      number: ["minimum", "maximum"],
      integer: ["minimum", "maximum"],
      boolean: [],
      null: [],
    }[type];
    check(
      Object.keys(value).every((key) =>
        ["type", "title", "description", "enum", ...specific].includes(key),
      ),
      `${label} 字段与 type 不匹配`,
    );
    if (type === "object") {
      const props = value.properties || {};
      check(
        plain(props) && Object.keys(props).length <= 24,
        `${label} properties 无效`,
      );
      check(
        Object.keys(props).every(
          (key) => propertyPattern.test(key) && !forbiddenKey(key),
        ),
        `${label} 属性名无效`,
      );
      result.properties = Object.fromEntries(
        Object.entries(props).map(([key, property]) => [
          key,
          visit(property, depth + 1),
        ]),
      );
      const required = value.required || [];
      check(
        Array.isArray(required) &&
          new Set(required).size === required.length &&
          required.every((key) => typeof key === "string" && own(props, key)),
        `${label} required 无效`,
      );
      result.required = [...required];
      check(
        value.additionalProperties === undefined ||
          value.additionalProperties === false,
        `${label} 禁止任意附加属性`,
      );
      result.additionalProperties = false;
    } else if (type === "array") {
      result.items = visit(value.items, depth + 1);
      result.minItems = value.minItems ?? 0;
      result.maxItems = value.maxItems ?? 100;
      check(
        Number.isInteger(result.minItems) &&
          Number.isInteger(result.maxItems) &&
          result.minItems >= 0 &&
          result.maxItems >= result.minItems &&
          result.maxItems <= 200,
        `${label} 数组长度无效`,
      );
    } else if (type === "string") {
      result.minLength = value.minLength ?? 0;
      result.maxLength = value.maxLength ?? 2000;
      check(
        Number.isInteger(result.minLength) &&
          Number.isInteger(result.maxLength) &&
          result.minLength >= 0 &&
          result.maxLength >= result.minLength &&
          result.maxLength <= 10000,
        `${label} 字符串长度无效`,
      );
    } else if (["number", "integer"].includes(type)) {
      for (const key of ["minimum", "maximum"])
        if (own(value, key)) {
          check(
            Number.isFinite(value[key]) &&
              (type !== "integer" || Number.isSafeInteger(value[key])),
            `${label} ${key} 无效`,
          );
          result[key] = value[key];
        }
      check(
        result.minimum === undefined ||
          result.maximum === undefined ||
          result.minimum <= result.maximum,
        `${label} 数值范围无效`,
      );
    }
    if (own(value, "enum")) {
      check(
        !["object", "array"].includes(type) &&
          Array.isArray(value.enum) &&
          value.enum.length >= 1 &&
          value.enum.length <= 20,
        `${label} enum 无效`,
      );
      check(
        value.enum.every(
          (item) =>
            item === null ||
            ["string", "number", "boolean"].includes(typeof item),
        ),
        `${label} enum 必须为基本值`,
      );
      for (const item of value.enum) validateData(item, result, label);
      result.enum = structuredClone(value.enum);
    }
    return result;
  };
  return visit(schema, 0);
}

// A validator shared by task parameter expansion and trusted adapter receipts.
export function validateData(value, schema, label = "数据") {
  let nodes = 0;
  const visit = (value, rule, path, depth) => {
    check(depth <= 8 && ++nodes <= 20000, `${label} 数据过大`);
    const alternatives = Array.isArray(rule.type) ? rule.type : [rule.type];
    const matches = (type) =>
      type === "null"
        ? value === null
        : type === "object"
          ? plain(value)
          : type === "array"
            ? Array.isArray(value)
            : type === "integer"
              ? Number.isSafeInteger(value)
              : type === "number"
                ? Number.isFinite(value)
                : typeof value === type;
    check(alternatives.some(matches), `${label} ${path} 类型不匹配`);
    if (rule.enum)
      check(rule.enum.includes(value), `${label} ${path} 不在 enum 中`);
    if (value === null) return;
    if (typeof value === "string")
      check(
        value.length >= (rule.minLength ?? 0) &&
          value.length <= (rule.maxLength ?? 2000),
        `${label} ${path} 长度无效`,
      );
    if (typeof value === "number")
      check(
        (rule.minimum === undefined || value >= rule.minimum) &&
          (rule.maximum === undefined || value <= rule.maximum),
        `${label} ${path} 超出范围`,
      );
    if (Array.isArray(value)) {
      check(
        value.length >= (rule.minItems ?? 0) &&
          value.length <= (rule.maxItems ?? 100),
        `${label} ${path} 数组长度无效`,
      );
      value.forEach((item, index) =>
        visit(item, rule.items, `${path}[${index}]`, depth + 1),
      );
    } else if (plain(value)) {
      check(
        Object.keys(value).every(
          (key) => !forbiddenKey(key) && own(rule.properties || {}, key),
        ),
        `${label} ${path} 含未声明属性`,
      );
      check(
        (rule.required || []).every((key) => own(value, key)),
        `${label} ${path} 缺少必填属性`,
      );
      for (const [key, item] of Object.entries(value))
        visit(item, rule.properties[key], `${path}.${key}`, depth + 1);
    }
  };
  visit(value, schema, "$", 0);
  return true;
}

export function commandDefinitions(
  state,
  { includeArchived = false, history = false } = {},
) {
  const rows = (state.commandDefinitions || BUILTIN_COMMAND_DEFINITIONS).filter(
    (row) => row.mode === "sim",
  );
  const latest = new Map();
  for (const row of rows)
    if (!latest.has(row.code) || latest.get(row.code).version < row.version)
      latest.set(row.code, row);
  return structuredClone(
    (history ? rows : [...latest.values()]).filter(
      (row) => includeArchived || !row.archived,
    ),
  );
}
export function resolveCommand(
  state,
  code,
  { version, allowArchived = false } = {},
) {
  const row = commandDefinitions(state, {
    includeArchived: true,
    history: version !== undefined,
  }).find(
    (row) =>
      row.code === code && (version === undefined || row.version === version),
  );
  return row && (allowArchived || !row.archived) ? row : null;
}
const editable = new Set([
  "code",
  "name",
  "appId",
  "action",
  "estimateMs",
  "timeoutMs",
  "effect",
  "inputSchema",
  "outputSchema",
  "bindings",
  "mapping",
  "expectedVersion",
]);
const text = (value, label, max) => {
  check(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.trim().length <= max &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value),
    `${label} 无效`,
  );
  return value.trim();
};
function prepare(state, mode, code, expectedVersion) {
  check(mode === "sim", "指令目录仅允许模拟；真实 adapter 尚未验收", 403);
  const rows = state.commandDefinitions || BUILTIN_COMMAND_DEFINITIONS;
  const previous = resolveCommand(state, code, { allowArchived: true });
  check(!previous?.internal, "内部恢复指令不可编辑或归档", 403);
  check(
    Number.isInteger(expectedVersion) &&
      expectedVersion === (previous?.version || 0),
    "指令版本已更新，请刷新后重试",
    409,
  );
  check(rows.length < 2048, "指令定义版本数量已达上限", 429);
  return previous;
}
function append(state, row) {
  state.commandDefinitions ||= structuredClone(BUILTIN_COMMAND_DEFINITIONS);
  state.commandDefinitions.push(row);
  state.events ||= [];
  state.events.push({
    id: randomUUID(),
    mode: "sim",
    at: row.createdAt,
    type: "command-definition",
    message: `${row.archived ? "归档" : "保存"}指令 ${row.code} v${row.version}；已有任务保留原快照`,
  });
  return structuredClone(row);
}
// Platform fields may differ, but these action-specific names participate in
// completion evidence. Reject incompatible declarations before they can be queued.
function validateCanonicalSchemas(action, inputSchema, outputSchema) {
  const alternatives = (schema) => [schema.type].flat();
  const compatible = (schema, allowed) =>
    schema && alternatives(schema).every((type) => allowed.includes(type));
  for (const key of ["keyword", "target", "appId"]) {
    if (own(inputSchema.properties, key))
      check(
        compatible(inputSchema.properties[key], ["string"]),
        `输入 ${key} 须为 string`,
      );
  }
  if (own(inputSchema.properties, "page"))
    check(
      compatible(inputSchema.properties.page, ["integer", "null"]),
      "输入 page 须为 integer / null",
    );
  const listAction = ["search", "list", "refresh", "next", "scroll"].includes(
    action,
  );
  const outputFields =
    action === "open"
      ? { foregroundAppId: "string" }
      : action === "home"
        ? { home: "boolean" }
        : action === "back"
          ? { backed: "boolean" }
          : action === "like"
            ? { target: "string", liked: "boolean" }
            : ["detail", "ocr"].includes(action)
              ? { target: "string", fullText: "string", complete: "boolean" }
              : listAction
                ? { keyword: "string", items: "array" }
                : {};
  for (const [key, type] of Object.entries(outputFields)) {
    if (!own(outputSchema.properties, key)) continue;
    check(
      compatible(outputSchema.properties[key], [type]),
      `输出 ${key} 与 ${action} 的 ${type} 完成契约不兼容`,
    );
    if (["keyword", "target"].includes(key))
      check(
        compatible(inputSchema.properties[key], ["string"]),
        `输出 ${key} 需要输入 Schema 声明对应 string 字段`,
      );
  }
  if (listAction && own(outputSchema.properties, "page")) {
    const pageTypes = alternatives(outputSchema.properties.page);
    check(
      compatible(outputSchema.properties.page, ["integer", "null"]) &&
        pageTypes.includes(
          ["search", "next"].includes(action) ? "integer" : "null",
        ),
      "输出 page 与当前 action 的 integer / null 页码契约不兼容",
    );
  }
}
export function saveCommand(state, now, mode, body) {
  check(
    plain(body) && Object.keys(body).every((key) => editable.has(key)),
    "指令含不支持或只读字段",
  );
  const code = text(body.code, "指令代码", 80);
  check(namePattern.test(code), "指令代码格式无效");
  const previous = prepare(state, mode, code, body.expectedVersion);
  check(
    body.appId === null ||
      ["xhs", "weibo", "xianyu", "pdd"].includes(body.appId),
    "无效平台",
  );
  check(
    COMMAND_ACTIONS.includes(body.action) && body.action !== "restore",
    "无效 action",
  );
  check(
    (["open", "back", "home"].includes(body.action)
      ? "navigation"
      : body.action === "like"
        ? "write"
        : "read") === body.effect,
    "effect 必须符合 action 的操作语义",
  );
  check(
    Number.isInteger(body.estimateMs) &&
      body.estimateMs >= 50 &&
      body.estimateMs <= 600000,
    "预估耗时须为 50–600000 毫秒",
  );
  check(
    Number.isInteger(body.timeoutMs) &&
      body.timeoutMs >= body.estimateMs &&
      body.timeoutMs <= 900000,
    "超时须不小于预估耗时且不大于 900000 毫秒",
  );
  check(
    Array.isArray(body.bindings) && body.bindings.length <= 8,
    "bindings 最多 8 项",
  );
  const seen = new Set();
  const bindings = body.bindings.map((binding) => {
    check(
      plain(binding) &&
        Object.keys(binding).length === 3 &&
        Object.keys(binding).every((key) =>
          ["kind", "adapterId", "operation"].includes(key),
        ),
      "绑定只允许 kind、adapterId、operation 引用",
    );
    check(
      ["poc", "adb", "custom"].includes(binding.kind) &&
        typeof binding.adapterId === "string" &&
        typeof binding.operation === "string" &&
        namePattern.test(binding.adapterId) &&
        namePattern.test(binding.operation),
      "绑定引用无效；禁止 URL、shell 或凭证",
    );
    const identity = `${binding.kind}:${binding.adapterId}:${binding.operation}`;
    check(!seen.has(identity), "绑定引用重复");
    seen.add(identity);
    return {
      kind: binding.kind,
      adapterId: binding.adapterId,
      operation: binding.operation,
    };
  });
  const inputSchema = validateSchema(body.inputSchema, "输入 Schema");
  const outputSchema = validateSchema(body.outputSchema, "输出 Schema");
  check(
    inputSchema.type === "object" && outputSchema.type === "object",
    "输入和输出根 Schema 须为 object",
  );
  validateCanonicalSchemas(body.action, inputSchema, outputSchema);
  const version = (previous?.version || 0) + 1;
  return append(state, {
    id: `${mode}:${code}:${version}`,
    mode,
    code,
    version,
    archived: false,
    name: text(body.name, "指令名称", 80),
    appId: body.appId,
    action: body.action,
    effect: body.effect,
    estimateMs: body.estimateMs,
    timeoutMs: body.timeoutMs,
    inputSchema,
    outputSchema,
    bindings,
    mapping: body.mapping
      ? text(body.mapping, "映射说明", 500)
      : "自定义指令；仅模拟，真实 handler 待验收",
    createdAt: now,
  });
}
export function archiveCommand(state, now, mode, id, body) {
  check(mode === "sim", "指令目录仅允许模拟；真实 adapter 尚未验收", 403);
  check(
    plain(body) && Object.keys(body).every((key) => key === "expectedVersion"),
    "归档请求含不支持字段",
  );
  const row = (state.commandDefinitions || BUILTIN_COMMAND_DEFINITIONS).find(
    (row) => row.id === id && row.mode === mode,
  );
  check(row, "指令定义不存在", 404);
  const previous = prepare(state, mode, row.code, body.expectedVersion);
  check(
    previous.id === id && !previous.archived,
    "指令已更新或归档，请刷新后重试",
    409,
  );
  const version = previous.version + 1;
  return append(state, {
    ...structuredClone(previous),
    id: `${mode}:${row.code}:${version}`,
    version,
    archived: true,
    createdAt: now,
  });
}
