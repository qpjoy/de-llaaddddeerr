// Versioned, simulation-only scheduling controls. No transport or model dependency.
export const DEFAULT_POOL_POLICY = Object.freeze({
  version: 1,
  enabled: true,
  strategy: "adaptive",
  idleSpreadThresholdPct: 50,
  maxAffinityDelayMs: 3000,
  maxQueueWaitMs: 30000,
  maxQueuePerDevice: 100,
  shortTaskMs: 15000,
  // Extra device time to open an App that is not the device's warm App.
  switchCostMs: 3000,
  // Plan stability: a planned job moves to another device only if that finishes
  // at least max(stickyGainMs, stickyGainPct% of its remaining time) earlier,
  // at most maxPlanMoves times, and never within planFreezeMs of its start.
  stickyGainMs: 2000,
  stickyGainPct: 20,
  maxPlanMoves: 3,
  planFreezeMs: 1000,
  // Strategy pacing (rule kind "pacing"); null keeps the rack's legacy settings.
  pacing: null,
  appDefaults: Object.freeze({
    windowMs: 60000,
    maxRuns: 3,
    maxServiceMs: 60000,
    cooldownMs: 5000,
  }),
  appPolicies: Object.freeze({}),
});
const invalid = (message) => {
  const error = new Error(message);
  error.status = 400;
  throw error;
};
const object = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} 须为对象`);
};
const bounds = (obj, limits, label) => {
  for (const [key, [min, max]] of Object.entries(limits))
    if (!Number.isInteger(obj[key]) || obj[key] < min || obj[key] > max)
      invalid(`${label}.${key} 须为 ${min}–${max} 的整数`);
};
const appLimits = {
  windowMs: [1000, 86400000],
  maxRuns: [1, 10000],
  maxServiceMs: [200, 86400000],
  cooldownMs: [0, 86400000],
};
function normalizeApp(value, defaults, label) {
  object(value, label);
  for (const key of Object.keys(value))
    if (!(key in appLimits)) invalid(`${label}.${key} 未知`);
  const result = { ...defaults, ...value };
  bounds(result, appLimits, label);
  return result;
}
// Each part is optional (null = not governed by the strategy). Zero caps mean
// "no limit" where noted: account maxRuns/maxServiceMs/dailyCap.
const PACING_LIMITS = {
  burst: {
    windowMs: [1000, 86400000],
    smallLimit: [1, 1000],
    largeLimit: [1, 1000],
    restMinMs: [0, 86400000],
    restMaxMs: [0, 86400000],
  },
  continuous: { capMs: [1000, 86400000], restMs: [0, 86400000] },
  account: {
    minGapMs: [0, 86400000],
    windowMs: [1000, 86400000],
    maxRuns: [0, 100000],
    maxServiceMs: [0, 864000000],
    restMs: [0, 86400000],
    dailyCap: [0, 100000],
  },
};
export function normalizePacing(input) {
  if (input == null) return null;
  object(input, "pacing");
  for (const key of Object.keys(input))
    if (!Object.hasOwn(PACING_LIMITS, key)) invalid(`pacing.${key} 未知`);
  const out = {};
  for (const [part, limits] of Object.entries(PACING_LIMITS)) {
    const value = input[part];
    if (value == null) {
      out[part] = null;
      continue;
    }
    object(value, `pacing.${part}`);
    for (const key of Object.keys(value))
      if (!Object.hasOwn(limits, key)) invalid(`pacing.${part}.${key} 未知`);
    bounds(value, limits, `pacing.${part}`);
    out[part] = Object.fromEntries(
      Object.keys(limits).map((k) => [k, value[k]]),
    );
  }
  if (out.burst && out.burst.restMinMs > out.burst.restMaxMs)
    invalid("pacing.burst 休息下限不能大于上限");
  return Object.values(out).some(Boolean) ? out : null;
}
// Policies in state are replaced, never edited in place, so the normalized
// form is cached per object (planning calls this per device and task).
const NORMALIZED = new WeakMap();
export function normalizedPolicy(input) {
  if (!input || typeof input !== "object") return normalizePoolPolicy(input);
  let policy = NORMALIZED.get(input);
  if (!policy) NORMALIZED.set(input, (policy = normalizePoolPolicy(input)));
  return policy;
}
export function normalizePoolPolicy(input = {}) {
  object(input, "scheduler");
  for (const key of Object.keys(input))
    if (!Object.hasOwn(DEFAULT_POOL_POLICY, key))
      invalid(`scheduler.${key} 未知`);
  const policy = { ...DEFAULT_POOL_POLICY, ...input };
  if (policy.version !== 1) invalid("仅支持 scheduler.version 1");
  if (typeof policy.enabled !== "boolean")
    invalid("scheduler.enabled 须为布尔值");
  if (!["adaptive", "spread", "affinity"].includes(policy.strategy))
    invalid("未知调度策略");
  bounds(
    policy,
    {
      idleSpreadThresholdPct: [0, 100],
      maxAffinityDelayMs: [0, 3600000],
      maxQueueWaitMs: [0, 86400000],
      maxQueuePerDevice: [1, 10000],
      shortTaskMs: [1000, 180000],
      switchCostMs: [0, 600000],
      stickyGainMs: [0, 600000],
      stickyGainPct: [0, 100],
      maxPlanMoves: [0, 100],
      planFreezeMs: [0, 60000],
    },
    "scheduler",
  );
  policy.pacing = normalizePacing(input.pacing ?? null);
  policy.appDefaults = normalizeApp(
    input.appDefaults === undefined ? {} : input.appDefaults,
    DEFAULT_POOL_POLICY.appDefaults,
    "appDefaults",
  );
  object(policy.appPolicies, "appPolicies");
  if (Object.keys(policy.appPolicies).length > 32)
    invalid("最多配置 32 个 App 策略");
  policy.appPolicies = Object.fromEntries(
    Object.entries(policy.appPolicies).map(([id, value]) => {
      if (!/^[a-z][a-z0-9_.-]{0,59}$/.test(id)) invalid("App 策略标识格式无效");
      return [id, normalizeApp(value, policy.appDefaults, `appPolicies.${id}`)];
    }),
  );
  return policy;
}
export const poolAppPolicy = (policy, appId) => ({
  ...policy.appDefaults,
  ...policy.appPolicies?.[appId],
});
// A complete idle interval resets a burst; otherwise retain the sliding window.
// Unfinished dispatches always retain their reservation, even after the window.
export function poolRunHistory(app, now, policy) {
  const rows = (app.poolRuns || []).filter(
    (r) => r.finishedAt == null || r.at > now - policy.windowMs,
  );
  const unfinished = rows.some((r) => r.finishedAt == null);
  const lastFinish = Math.max(0, ...rows.map((r) => r.finishedAt || 0));
  return !unfinished && lastFinish + policy.cooldownMs <= now ? [] : rows;
}
