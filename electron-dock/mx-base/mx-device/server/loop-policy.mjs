import { randomInt, randomUUID } from "node:crypto";
import { requireThat, str } from "./model.mjs";
export const DEFAULT_LOOP_POLICY = {
  maxInsertions: 3,
  maxDetourMs: 15000,
  windowMs: 60000,
  smallLimit: 3,
  largeLimit: 1,
  cooldownMinMs: 4000,
  cooldownMaxMs: 8000,
  commandDelayMs: 1400,
};
export const loopPolicyFor = (s, d) =>
  (s.loopPolicies || []).find((p) => p.mode === d.mode && p.rack === d.rack);
export function configureLoops(s, now, mode, body) {
  requireThat(
    mode === "sim",
    "组合循环策略当前仅用于模拟，不改变真实控制",
    403,
  );
  const rack = str(body.rack, "机架");
  requireThat(
    s.devices.some((d) => d.mode === mode && d.rack === rack),
    "机架不存在",
    404,
  );
  s.loopPolicies ||= [];
  let row = s.loopPolicies.find((p) => p.mode === mode && p.rack === rack);
  requireThat(
    body.revision === (row?.revision || 0),
    "循环策略已更新，请刷新后重试",
  );
  const limits = {
    maxInsertions: [0, 5],
    maxDetourMs: [1000, 60000],
    windowMs: [1000, 3600000],
    smallLimit: [1, 100],
    largeLimit: [1, 100],
    cooldownMinMs: [0, 600000],
    cooldownMaxMs: [0, 600000],
    commandDelayMs: [200, 5000],
  };
  const config = {};
  for (const [key, [min, max]] of Object.entries(limits)) {
    requireThat(
      Number.isInteger(body[key]) && body[key] >= min && body[key] <= max,
      `${key} 须为 ${min}–${max} 的整数`,
      400,
    );
    config[key] = body[key];
  }
  requireThat(
    config.cooldownMinMs <= config.cooldownMaxMs,
    "冷却下限不能大于上限",
    400,
  );
  if (!row) {
    row = { id: randomUUID(), mode, rack, revision: 0 };
    s.loopPolicies.push(row);
  }
  Object.assign(row, config, { revision: row.revision + 1, updatedAt: now });
  s.events.push({
    id: randomUUID(),
    mode,
    at: now,
    type: "loop-policy",
    message: `${rack} 更新循环策略：最多插入 ${config.maxInsertions} 个小任务；累计预算 ${config.maxDetourMs / 1000} 秒；已有大任务保留领取时的插入预算`,
  });
  return row;
}
export function recordLoopUsage(s, now, device, app, attempt) {
  const loop = attempt.loop || "small";
  app.recentRuns ||= [];
  app.recentRuns.push({
    jobId: attempt.jobId,
    attemptId: attempt.id,
    at: now,
    loop,
  });
  app.recentRuns = app.recentRuns
    .filter((r) => r.loop === loop)
    .slice(-100)
    .concat(app.recentRuns.filter((r) => r.loop !== loop).slice(-100));
  const policy = loopPolicyFor(s, device);
  if (!policy) return;
  app.burstRuns = (app.burstRuns || []).filter(
    (r) => r.at > now - policy.windowMs,
  );
  app.burstRuns.push({ at: now, loop });
  const small = app.burstRuns.filter((r) => r.loop === "small").length,
    large = app.burstRuns.filter((r) => r.loop === "large").length;
  if (small < policy.smallLimit && large < policy.largeLimit) return;
  const durationMs = randomInt(policy.cooldownMinMs, policy.cooldownMaxMs + 1);
  app.rest = {
    at: now,
    until: now + durationMs,
    durationMs,
    small,
    large,
    policyRevision: policy.revision,
    windowMs: policy.windowMs,
  };
  app.cooldownUntil = Math.max(app.cooldownUntil, app.rest.until);
  app.totalRestMs = (app.totalRestMs || 0) + durationMs;
  app.restHistory = [...(app.restHistory || []), app.rest].slice(-50);
  app.burstRuns = [];
  s.events.push({
    id: randomUUID(),
    mode: device.mode,
    at: now,
    type: "app-rest",
    deviceId: device.id,
    jobId: attempt.jobId,
    message: `${device.name} ${app.appId} 窗口内 ${small} 小 / ${large} 大，生成冷却 ${(durationMs / 1000).toFixed(1)} 秒（已保存，不随刷新重抽）`,
  });
}
