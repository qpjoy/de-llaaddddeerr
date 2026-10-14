import { randomUUID } from "node:crypto";
import { normalizePoolPolicy } from "./pool-policy.mjs";
import { configureLoops } from "./loop-policy.mjs";
import {
  BUILTIN_RULE_DEFINITIONS,
  BUILTIN_STRATEGY_DEFINITIONS,
  RULE_KINDS,
} from "./strategy-catalog.mjs";
export { strategyStatus } from "./strategy-catalog.mjs";

const check = (condition, message, status = 400) => {
  if (!condition) throw Object.assign(new Error(message), { status });
};
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keys = (value, allowed, label) =>
  check(
    plain(value) && Object.keys(value).every((key) => allowed.includes(key)),
    `${label} 含不支持或只读字段`,
  );
const text = (value, label, max, empty = false) => {
  check(
    typeof value === "string" &&
      (empty || value.trim().length > 0) &&
      value.trim().length <= max &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value),
    `${label} 无效`,
  );
  return value.trim();
};
const codePattern = /^[a-z][a-z0-9_.-]{1,79}$/;
const catalogs = {
  rule: {
    key: "ruleDefinitions",
    seeds: BUILTIN_RULE_DEFINITIONS,
    label: "规则",
    max: 2048,
  },
  strategy: {
    key: "strategyDefinitions",
    seeds: BUILTIN_STRATEGY_DEFINITIONS,
    label: "策略",
    max: 1024,
  },
};
function list(state, type, { includeArchived = false, history = false } = {}) {
  const catalog = catalogs[type];
  const rows = (state[catalog.key] || catalog.seeds).filter(
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
export const listRules = (state, options) => list(state, "rule", options);
export const listStrategies = (state, options) =>
  list(state, "strategy", options);
function resolve(
  state,
  type,
  codeOrId,
  { version, allowArchived = false } = {},
) {
  const exactId = typeof codeOrId === "string" && codeOrId.startsWith("sim:");
  const rows = list(state, type, {
    includeArchived: true,
    history: exactId || version !== undefined,
  });
  const row = rows.find((row) =>
    exactId
      ? row.id === codeOrId
      : row.code === codeOrId &&
        (version === undefined || row.version === version),
  );
  return row && (allowArchived || !row.archived) ? row : null;
}
export const resolveRule = (state, codeOrId, options) =>
  resolve(state, "rule", codeOrId, options);
export const resolveStrategy = (state, codeOrId, options) =>
  resolve(state, "strategy", codeOrId, options);

function prepare(state, type, mode, code, expectedVersion) {
  check(mode === "sim", "策略与规则当前仅用于模拟调度", 403);
  const previous = resolve(state, type, code, { allowArchived: true });
  check(
    Number.isInteger(expectedVersion) &&
      expectedVersion === (previous?.version || 0),
    `${catalogs[type].label}版本已更新，请刷新后重试`,
    409,
  );
  check(
    (state[catalogs[type].key] || catalogs[type].seeds).length <
      catalogs[type].max,
    `${catalogs[type].label}版本数量已达上限`,
    429,
  );
  return previous;
}
function append(state, type, row) {
  const catalog = catalogs[type];
  state[catalog.key] ||= structuredClone(catalog.seeds);
  state[catalog.key].push(row);
  state.events ||= [];
  state.events.push({
    id: randomUUID(),
    mode: "sim",
    at: row.createdAt,
    type: `${type}-definition`,
    message: `${row.archived ? "归档" : "保存"}${catalog.label} ${row.code} v${row.version}；已应用机架保持原策略快照`,
  });
  return structuredClone(row);
}
function metadata(body) {
  const code = text(body.code, "代码", 80);
  check(codePattern.test(code), "代码格式无效");
  return {
    code,
    name: text(body.name, "名称", 80),
    description:
      body.description === undefined
        ? ""
        : text(body.description, "说明", 600, true),
  };
}
function normalizeRule(kind, input) {
  check(
    RULE_KINDS.some((row) => row.kind === kind),
    "规则类型无效",
  );
  const allowed = {
    placement: ["strategy", "idleSpreadThresholdPct", "maxAffinityDelayMs"],
    queue: ["maxQueueWaitMs", "maxQueuePerDevice", "shortTaskMs"],
    "app-budget": ["windowMs", "maxRuns", "maxServiceMs", "cooldownMs"],
    "app-override": ["appId", "policy"],
  }[kind];
  keys(input, allowed, "规则配置");
  check(
    allowed.every((key) => Object.hasOwn(input, key)),
    "规则配置缺少必填字段",
  );
  if (kind === "placement" || kind === "queue") {
    const policy = normalizePoolPolicy(input);
    return Object.fromEntries(allowed.map((key) => [key, policy[key]]));
  }
  if (kind === "app-budget")
    return normalizePoolPolicy({ appDefaults: input }).appDefaults;
  const appId = text(input.appId, "App", 60);
  check(
    /^[a-z][a-z0-9_.-]{0,59}$/.test(appId) &&
      !["constructor", "prototype", "__proto__"].includes(appId),
    "App 标识无效",
  );
  // App overrides are complete pinned budgets, so later edits to the general
  // budget cannot silently change an omitted override field.
  const policy = normalizeRule("app-budget", input.policy);
  return { appId, policy };
}
export function saveRule(state, now, mode, body) {
  keys(
    body,
    ["code", "name", "description", "kind", "config", "expectedVersion"],
    "规则",
  );
  const info = metadata(body);
  const previous = prepare(
    state,
    "rule",
    mode,
    info.code,
    body.expectedVersion,
  );
  const version = (previous?.version || 0) + 1;
  return append(state, "rule", {
    id: `${mode}:${info.code}:${version}`,
    mode,
    ...info,
    kind: body.kind,
    config: normalizeRule(body.kind, body.config),
    version,
    archived: false,
    createdAt: now,
  });
}
export function compileStrategyRules(rules) {
  check(
    Array.isArray(rules) && rules.length >= 3 && rules.length <= 35,
    "策略须包含分配、队列、App 通用预算，可附加最多 32 个 App 覆盖",
  );
  const seen = new Set(),
    overrides = {},
    policy = {};
  for (const ref of rules) {
    const definition = ref.definition;
    check(
      definition &&
        definition.mode === "sim" &&
        definition.code === ref.code &&
        definition.version === ref.version &&
        !definition.archived,
      "规则快照无效",
    );
    const config = normalizeRule(definition.kind, definition.config);
    const key =
      definition.kind === "app-override"
        ? `${definition.kind}:${config.appId}`
        : definition.kind;
    check(!seen.has(key), "同阶段规则冲突或 App 覆盖重复；请替换已有规则");
    seen.add(key);
    if (definition.kind === "app-budget") policy.appDefaults = config;
    else if (definition.kind === "app-override")
      overrides[config.appId] = config.policy;
    else Object.assign(policy, config);
  }
  check(
    ["placement", "queue", "app-budget"].every((kind) => seen.has(kind)),
    "策略缺少分配、队列或 App 通用预算规则",
  );
  return normalizePoolPolicy({
    ...policy,
    enabled: true,
    appPolicies: overrides,
  });
}
export function saveStrategy(state, now, mode, body) {
  keys(
    body,
    ["code", "name", "description", "rules", "expectedVersion"],
    "策略",
  );
  const info = metadata(body);
  const previous = prepare(
    state,
    "strategy",
    mode,
    info.code,
    body.expectedVersion,
  );
  check(
    Array.isArray(body.rules) && body.rules.length <= 35,
    "策略规则列表无效",
  );
  const rules = body.rules
    .map((ref) => {
      keys(ref, ["code", "version"], "规则引用");
      check(
        typeof ref.code === "string" &&
          codePattern.test(ref.code) &&
          (ref.version === undefined ||
            (Number.isInteger(ref.version) && ref.version > 0)),
        "规则引用无效",
      );
      check(
        resolveRule(state, ref.code),
        `规则 ${ref.code} 已归档或不存在`,
        400,
      );
      const definition = resolveRule(state, ref.code, { version: ref.version });
      check(definition, `规则 ${ref.code} 的版本不存在或已归档`, 400);
      return { code: definition.code, version: definition.version, definition };
    })
    .sort((a, b) => {
      const phase = (ref) =>
        RULE_KINDS.find((kind) => kind.kind === ref.definition.kind).phase;
      return phase(a) - phase(b) || a.code.localeCompare(b.code);
    });
  const policy = compileStrategyRules(rules);
  const version = (previous?.version || 0) + 1;
  return append(state, "strategy", {
    id: `${mode}:${info.code}:${version}`,
    mode,
    ...info,
    version,
    archived: false,
    recommended: info.code === "pool.balanced",
    rules,
    policy,
    createdAt: now,
  });
}
function archive(state, now, mode, type, id, body) {
  check(mode === "sim", "策略与规则当前仅用于模拟调度", 403);
  keys(body, ["expectedVersion"], "归档请求");
  const row = resolve(state, type, id, { allowArchived: true });
  check(row, `${catalogs[type].label}不存在`, 404);
  const previous = prepare(state, type, mode, row.code, body.expectedVersion);
  check(
    previous.id === id && !previous.archived,
    `${catalogs[type].label}已更新或归档，请刷新后重试`,
    409,
  );
  const version = previous.version + 1;
  return append(state, type, {
    ...previous,
    id: `${mode}:${row.code}:${version}`,
    version,
    archived: true,
    createdAt: now,
  });
}
export const archiveRule = (state, now, mode, id, body) =>
  archive(state, now, mode, "rule", id, body);
export const archiveStrategy = (state, now, mode, id, body) =>
  archive(state, now, mode, "strategy", id, body);

export function applyStrategy(state, now, mode, body) {
  check(mode === "sim", "策略当前仅应用于模拟机架", 403);
  keys(body, ["rack", "revision", "strategyId"], "应用策略请求");
  const strategy = resolveStrategy(state, body.strategyId);
  check(
    strategy &&
      strategy.id === body.strategyId &&
      resolveStrategy(state, strategy.code),
    "策略版本不存在或策略已归档",
    404,
  );
  // Recompile the pinned snapshots, never follow newer rule definitions.
  const policy = compileStrategyRules(strategy.rules);
  const row = configureLoops(state, now, mode, {
    rack: body.rack,
    revision: body.revision,
    scheduler: policy,
  });
  row.strategySnapshot = {
    id: strategy.id,
    code: strategy.code,
    name: strategy.name,
    version: strategy.version,
    rules: structuredClone(strategy.rules),
    policy: structuredClone(policy),
    appliedAt: now,
  };
  state.events.push({
    id: randomUUID(),
    mode,
    at: now,
    type: "strategy-applied",
    message: `${row.rack} 应用 ${strategy.name} v${strategy.version}；仅改变后续排队分配，保留在途任务与已生成冷却`,
  });
  return structuredClone(row);
}
