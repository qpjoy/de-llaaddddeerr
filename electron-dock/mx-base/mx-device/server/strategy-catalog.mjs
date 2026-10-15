import { DEFAULT_POOL_POLICY, normalizePoolPolicy } from "./pool-policy.mjs";

// Shared UI/server metadata. These are bounded simulation parameters, not
// platform-approved rate limits or a claim of globally optimal scheduling.
export const RULE_KINDS = [
  {
    kind: "placement",
    name: "设备分配",
    phase: 1,
    description: "在合格设备中选择同 App 亲和、空闲分散或随空闲比例自适应。",
    defaults: {
      strategy: "adaptive",
      idleSpreadThresholdPct: 50,
      maxAffinityDelayMs: 3000,
    },
  },
  {
    kind: "queue",
    name: "队列预算",
    phase: 2,
    description: "限制候选设备队列长度、预计排队时间和短任务亲和阈值。",
    defaults: {
      maxQueueWaitMs: 30000,
      maxQueuePerDevice: 100,
      shortTaskMs: 15000,
    },
  },
  {
    kind: "app-budget",
    name: "App 通用预算",
    phase: 3,
    description: "按设备与 App 记录执行次数、服务时间和冷却；不锁住其他 App。",
    defaults: { ...DEFAULT_POOL_POLICY.appDefaults },
  },
  {
    kind: "app-override",
    name: "单个 App 预算",
    phase: 4,
    description: "覆盖指定 App 的通用预算；每个 App 最多配置一条。",
    defaults: {
      appId: "pdd",
      policy: {
        ...DEFAULT_POOL_POLICY.appDefaults,
        maxRuns: 2,
        cooldownMs: 8000,
      },
    },
  },
];

// Rule fields added after the first catalog release. They are optional in
// stored rules and default from the pool policy (see normalizeRule).
export const RULE_OPTIONAL_DEFAULTS = Object.freeze({
  placement: Object.freeze({
    switchCostMs: DEFAULT_POOL_POLICY.switchCostMs,
  }),
  queue: Object.freeze({
    stickyGainMs: DEFAULT_POOL_POLICY.stickyGainMs,
    stickyGainPct: DEFAULT_POOL_POLICY.stickyGainPct,
    maxPlanMoves: DEFAULT_POOL_POLICY.maxPlanMoves,
    planFreezeMs: DEFAULT_POOL_POLICY.planFreezeMs,
  }),
});

export const HARD_SCHEDULING_CONSTRAINTS = [
  {
    code: "one-stream",
    name: "单机一条指令流",
    description: "任务领取后锁定设备；当前任务不会被优先级或策略切换抢占。",
  },
  {
    code: "eligible-only",
    name: "能力与状态先过滤",
    description: "离线、暂停、隔离、App 冷却或指令能力不匹配的设备不领取任务。",
  },
  {
    code: "unknown-quarantine",
    name: "结果未知即隔离",
    description:
      "未取得可信停止回执时保留执行证据，不自动重派可能仍在运行的任务。",
  },
  {
    code: "queued-movable",
    name: "仅未领取任务可重排",
    description:
      "候选队列是可更新计划，真正领取在事务中完成；不同设备可以并行执行。",
  },
];

const seedRule = (code, name, kind, config, description) => ({
  id: `sim:${code}:1`,
  mode: "sim",
  code,
  name,
  description,
  kind,
  config,
  version: 1,
  archived: false,
  createdAt: 0,
});
export const BUILTIN_RULE_DEFINITIONS = [
  seedRule(
    "placement.adaptive",
    "均衡分配 · 自适应",
    "placement",
    { ...RULE_KINDS[0].defaults },
    "空闲设备超过 50% 时倾向分散；否则优先复用同 App，额外等待不超过 3 秒。",
  ),
  seedRule(
    "placement.spread",
    "空闲设备优先",
    "placement",
    { ...RULE_KINDS[0].defaults, strategy: "spread" },
    "更重视尽快开始任务，适合资源充裕的演练。",
  ),
  seedRule(
    "placement.affinity",
    "同 App 亲和优先",
    "placement",
    { ...RULE_KINDS[0].defaults, strategy: "affinity" },
    "优先复用同 App 上下文，仍受队列、冷却和等待预算限制。",
  ),
  seedRule(
    "queue.bounded",
    "有界候选队列",
    "queue",
    { ...RULE_KINDS[1].defaults },
    "预计排队超过 30 秒时保留在中心等待；每机最多 100 个候选任务，15 秒短任务阈值。",
  ),
  seedRule(
    "budget.default",
    "App 默认运行预算",
    "app-budget",
    { ...RULE_KINDS[2].defaults },
    "60 秒窗口，最多 3 个任务或 60 秒服务时间，达到预算后休息 5 秒。",
  ),
  seedRule(
    "budget.pdd",
    "拼多多预算示例",
    "app-override",
    structuredClone(RULE_KINDS[3].defaults),
    "模拟参考：最多 2 个任务后休息 8 秒；不代表真实平台安全限额。",
  ),
];

// Seeds stay byte-identical to migration 008; later optional fields are
// defaulted when a strategy is compiled or applied, not stored in the seed.
const seedPolicy = (policy) => {
  for (const key of Object.values(RULE_OPTIONAL_DEFAULTS).flatMap(Object.keys))
    delete policy[key];
  return policy;
};
const seedStrategy = (
  code,
  name,
  placement,
  description,
  recommended = false,
) => {
  const rules = [placement, "queue.bounded", "budget.default"].map((code) => {
    const definition = BUILTIN_RULE_DEFINITIONS.find(
      (row) => row.code === code,
    );
    return {
      code,
      version: definition.version,
      definition: structuredClone(definition),
    };
  });
  return {
    id: `sim:${code}:1`,
    mode: "sim",
    code,
    name,
    description,
    version: 1,
    archived: false,
    recommended,
    rules,
    policy: seedPolicy(
      normalizePoolPolicy({
        ...rules[0].definition.config,
        ...rules[1].definition.config,
        appDefaults: rules[2].definition.config,
      }),
    ),
    createdAt: 0,
  };
};
export const BUILTIN_STRATEGY_DEFINITIONS = [
  seedStrategy(
    "pool.balanced",
    "均衡自适应",
    "placement.adaptive",
    "推荐起点：资源充裕时分散，资源忙碌时复用同 App；具体效果需用场景对照验证。",
    true,
  ),
  seedStrategy(
    "pool.spread",
    "空闲分散",
    "placement.spread",
    "优先启动空闲设备，便于观察延迟与上下文切换成本的取舍。",
  ),
  seedStrategy(
    "pool.affinity",
    "亲和聚合",
    "placement.affinity",
    "优先同 App 排队执行；聚合指设备与上下文复用，不会合并任务数据或完成回执。",
  ),
];

const canonical = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
    : value;

// A manual loop-policy change is shown as an override without erasing the
// strategy snapshot. Legacy insertion/display speed fields are not pool rules.
export function strategyStatus(loopPolicy) {
  const snapshot = loopPolicy?.strategySnapshot || null;
  if (!snapshot) return { state: "unmanaged", snapshot: null };
  if (!loopPolicy.scheduler) return { state: "modified", snapshot };
  try {
    const same =
      JSON.stringify(canonical(normalizePoolPolicy(loopPolicy.scheduler))) ===
      JSON.stringify(canonical(normalizePoolPolicy(snapshot.policy)));
    return { state: same ? "applied" : "modified", snapshot };
  } catch {
    return { state: "modified", snapshot };
  }
}
