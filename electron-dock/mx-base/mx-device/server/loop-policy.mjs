import { randomInt, randomUUID } from "node:crypto";
import { requireThat, str } from "./model.mjs";
import {
  normalizePoolPolicy,
  poolAppPolicy,
  poolRunHistory,
} from "./pool-policy.mjs";
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
    const value =
      body[key] === undefined
        ? (row?.[key] ?? DEFAULT_LOOP_POLICY[key])
        : body[key];
    requireThat(
      Number.isInteger(value) && value >= min && value <= max,
      `${key} 须为 ${min}–${max} 的整数`,
      400,
    );
    config[key] = value;
  }
  requireThat(
    config.cooldownMinMs <= config.cooldownMaxMs,
    "冷却下限不能大于上限",
    400,
  );
  if (body.scheduler !== undefined) {
    requireThat(
      body.scheduler &&
        typeof body.scheduler === "object" &&
        !Array.isArray(body.scheduler),
      "scheduler 须为对象",
      400,
    );
    normalizePoolPolicy(body.scheduler);
    const old = row?.scheduler || {};
    config.scheduler = normalizePoolPolicy({
      ...old,
      ...body.scheduler,
      appDefaults: { ...old.appDefaults, ...body.scheduler.appDefaults },
      appPolicies:
        body.scheduler.appPolicies === undefined
          ? old.appPolicies || {}
          : Object.fromEntries(
              Object.keys(body.scheduler.appPolicies).map((id) => [
                id,
                { ...old.appPolicies?.[id], ...body.scheduler.appPolicies[id] },
              ]),
            ),
    });
  }
  if (!row) {
    row = { id: randomUUID(), mode, rack, revision: 0 };
    s.loopPolicies.push(row);
  }
  // Sticky plans were chosen under the old scheduling objective; a new policy
  // replans the rack's queued jobs from scratch instead of being held by them.
  if (
    config.scheduler &&
    JSON.stringify(config.scheduler) !== JSON.stringify(row.scheduler)
  ) {
    const devices = new Set(
      s.devices
        .filter((d) => d.mode === mode && d.rack === rack)
        .map((d) => d.id),
    );
    for (const job of s.jobs)
      if (job.status === "queued" && devices.has(job.poolPlan?.deviceId))
        delete job.poolPlan;
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
