// Strategy 2.0: traffic-driven profile switching and shadow evaluation.
//
// A rack may switch between a calm and a busy strategy by queue pressure
// (queued, ready jobs per runnable device). Entry and exit thresholds differ
// (hysteresis), a profile stays at least minDwellMs, and switches per hour are
// capped. Only the single active scheduler switches (inside its epoch-fenced
// dispatch transaction). A switch is an ordinary strategy application: queued
// work is re-planned, running sessions and earned cooldowns are kept.
import { randomUUID } from "node:crypto";
import {
  applyStrategy,
  compileStrategyRules,
  resolveStrategy,
} from "./strategy-registry.mjs";
import { planPool } from "./pool-planner.mjs";

const check = (ok, message, status = 400) => {
  if (!ok) throw Object.assign(new Error(message), { status });
};
const FIELDS = [
  "rack",
  "revision",
  "enabled",
  "calmStrategyId",
  "busyStrategyId",
  "enterPressure",
  "exitPressure",
  "minDwellMs",
  "maxSwitchesPerHour",
];
const number = (value, min, max, name) => {
  check(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max,
    `${name} 须在 ${min}–${max} 之间`,
  );
  return Math.round(value * 100) / 100;
};
const usable = (state, id) => {
  const strategy = resolveStrategy(state, id);
  return (
    strategy &&
    strategy.id === id &&
    resolveStrategy(state, strategy.code) &&
    strategy
  );
};

/** Queue pressure of a simulation rack: ready queued jobs per runnable device. */
export function rackPressure(state, now, rack) {
  const devices = state.devices.filter(
    (d) =>
      d.mode === "sim" &&
      d.rack === rack &&
      d.enabled &&
      d.connected !== "offline" &&
      d.state !== "quarantined",
  );
  const ids = new Set(devices.map((d) => d.id));
  const queued = state.jobs.filter(
    (j) =>
      j.mode === "sim" &&
      j.status === "queued" &&
      j.notBefore <= now &&
      (j.placement?.rack === rack || ids.has(j.deviceId)),
  ).length;
  return {
    queued,
    devices: devices.length,
    pressure: Math.round((queued / Math.max(1, devices.length)) * 100) / 100,
  };
}

export function configureAutoProfile(state, now, mode, body) {
  check(mode === "sim", "自动切换策略当前仅用于模拟机架", 403);
  check(
    body &&
      typeof body === "object" &&
      Object.keys(body).every((k) => FIELDS.includes(k)),
    "自动切换请求含不支持字段",
  );
  const row = (state.loopPolicies || []).find(
    (p) => p.mode === mode && p.rack === body.rack,
  );
  check(row, "机架尚未配置调度策略", 404);
  check(body.revision === row.revision, "机架策略已更新，请刷新后重试", 409);
  check(typeof body.enabled === "boolean", "enabled 须为布尔值");
  if (!body.enabled) {
    row.autoProfile = { ...(row.autoProfile || {}), enabled: false };
    row.revision++;
    state.events.push({
      id: randomUUID(),
      mode,
      at: now,
      type: "profile-auto",
      message: `${row.rack} 停用按流量自动切换策略；保留当前策略`,
    });
    return structuredClone(row);
  }
  const calm = usable(state, body.calmStrategyId),
    busy = usable(state, body.busyStrategyId);
  check(calm && busy, "平静或繁忙策略不存在或已归档", 404);
  check(calm.id !== busy.id, "平静与繁忙策略不能相同");
  const enterPressure = number(body.enterPressure, 0.1, 100, "进入繁忙阈值");
  const exitPressure = number(body.exitPressure, 0, 100, "退出繁忙阈值");
  check(exitPressure < enterPressure, "退出阈值须低于进入阈值（迟滞）");
  check(
    Number.isInteger(body.minDwellMs) &&
      body.minDwellMs >= 5000 &&
      body.minDwellMs <= 86400000,
    "最短驻留须为 5000–86400000 毫秒",
  );
  check(
    Number.isInteger(body.maxSwitchesPerHour) &&
      body.maxSwitchesPerHour >= 1 &&
      body.maxSwitchesPerHour <= 60,
    "每小时切换上限须为 1–60",
  );
  // Start in the profile the current pressure calls for.
  const metrics = rackPressure(state, now, row.rack);
  const current = metrics.pressure >= enterPressure ? "busy" : "calm";
  const target = current === "busy" ? busy : calm;
  if (row.strategySnapshot?.id !== target.id)
    applyStrategy(state, now, mode, {
      rack: row.rack,
      revision: row.revision,
      strategyId: target.id,
    });
  row.autoProfile = {
    enabled: true,
    calmStrategyId: calm.id,
    busyStrategyId: busy.id,
    enterPressure,
    exitPressure,
    minDwellMs: body.minDwellMs,
    maxSwitchesPerHour: body.maxSwitchesPerHour,
    current,
    since: now,
    switches: (row.autoProfile?.switches || []).filter(
      (t) => t > now - 3600000,
    ),
    lastSwitch: null,
  };
  row.revision++;
  state.events.push({
    id: randomUUID(),
    mode,
    at: now,
    type: "profile-auto",
    message: `${row.rack} 启用按流量自动切换：压力 ≥ ${enterPressure} 用「${busy.name}」，≤ ${exitPressure} 回到「${calm.name}」，最短驻留 ${body.minDwellMs / 1000} 秒；当前 ${current === "busy" ? "繁忙" : "平静"}（压力 ${metrics.pressure}）`,
  });
  return structuredClone(row);
}

/** Called by the single active scheduler before placing simulation work. */
export function autoSwitchProfiles(state, now) {
  for (const row of (state.loopPolicies || []).filter(
    (p) => p.mode === "sim" && p.autoProfile?.enabled,
  )) {
    const a = row.autoProfile;
    const metrics = rackPressure(state, now, row.rack);
    const target =
      a.current === "busy"
        ? metrics.pressure <= a.exitPressure
          ? "calm"
          : "busy"
        : metrics.pressure >= a.enterPressure
          ? "busy"
          : "calm";
    if (target === a.current || now - a.since < a.minDwellMs) continue;
    const recent = (a.switches || []).filter((t) => t > now - 3600000);
    if (recent.length >= a.maxSwitchesPerHour) continue;
    const strategyId = target === "busy" ? a.busyStrategyId : a.calmStrategyId;
    if (!usable(state, strategyId)) {
      a.enabled = false;
      a.lastError = "目标策略已归档，自动切换已停用";
      row.revision++;
      continue;
    }
    applyStrategy(state, now, "sim", {
      rack: row.rack,
      revision: row.revision,
      strategyId,
    });
    a.lastSwitch = { at: now, from: a.current, to: target, ...metrics };
    a.current = target;
    a.since = now;
    a.switches = [...recent, now];
    state.events.push({
      id: randomUUID(),
      mode: "sim",
      at: now,
      type: "profile-switch",
      message: `${row.rack} 排队压力 ${metrics.pressure}（${metrics.queued} 个 / ${metrics.devices} 台）：切换到${target === "busy" ? "繁忙" : "平静"}策略；在途会话与已生成冷却不变`,
    });
  }
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
    : 0;
};
function summary(plan, now) {
  const waits = plan.assignments.map((a) => a.startAt - now);
  const blocked = {};
  for (const b of plan.blocked) blocked[b.code] = (blocked[b.code] || 0) + 1;
  return {
    assigned: plan.assignments.length,
    blocked,
    startNow: plan.assignments.filter((a) => a.startAt <= now).length,
    waitAvgMs: waits.length
      ? Math.round(waits.reduce((n, w) => n + w, 0) / waits.length)
      : 0,
    waitP95Ms: percentile(waits, 0.95),
    lastFinishMs: plan.assignments.length
      ? Math.max(...plan.assignments.map((a) => a.finishAt)) - now
      : 0,
    switches: plan.assignments.filter((a) => a.switchMs > 0).length,
    switchMs: plan.assignments.reduce((n, a) => n + (a.switchMs || 0), 0),
  };
}
/** Shadow evaluation: plan the rack's current queue under the current and a
 * candidate strategy. Both are planned fresh, ignoring sticky plans made under
 * the current strategy, so the columns compare the strategies themselves (and
 * applying one also drops those plans). Read-only; nothing is persisted. */
export function shadowStrategy(state, now, mode, body, executorSlots = null) {
  check(mode === "sim", "影子评估当前仅用于模拟机架", 403);
  check(body && typeof body.rack === "string", "请选择机架");
  const strategy = usable(state, body.strategyId);
  check(strategy, "策略版本不存在或已归档", 404);
  const row = (state.loopPolicies || []).find(
    (p) => p.mode === mode && p.rack === body.rack,
  );
  check(
    state.devices.some((d) => d.mode === mode && d.rack === body.rack),
    "机架不存在",
    404,
  );
  const candidate = compileStrategyRules(strategy.rules);
  return {
    rack: body.rack,
    at: now,
    executorSlots,
    strategy: {
      id: strategy.id,
      name: strategy.name,
      version: strategy.version,
    },
    current: row?.scheduler?.enabled
      ? {
          id: row.strategySnapshot?.id || null,
          name: row.strategySnapshot?.name || "当前机架配置",
          version: row.strategySnapshot?.version || null,
          ...summary(
            planPool(state, now, {
              rack: body.rack,
              executorSlots,
              fresh: true,
            }),
            now,
          ),
        }
      : null,
    candidate: summary(
      planPool(state, now, {
        rack: body.rack,
        policy: candidate,
        executorSlots,
        fresh: true,
      }),
      now,
    ),
  };
}
