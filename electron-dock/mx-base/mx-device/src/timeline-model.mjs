// Lane timeline model (V2-4): one lane per device over [now - 2 min, now + 3 min].
// Pure functions over the /api/state payload, shared by the live view and
// tests; the replay view builds the same lane shape from simulator reports.
import { appName, jobTitle } from "./data.js";

export const PAST_MS = 120000;
export const FUTURE_MS = 180000;
// Categorical slots 1-4 of the validated palette (dataviz reference instance),
// assigned to Apps in a fixed order; checked with validate_palette.js.
export const APP_COLORS = {
  xhs: "#2a78d6",
  weibo: "#eb6834",
  xianyu: "#1baf7a",
  pdd: "#eda100",
};
export const CRITICAL = "#d03b3b";
// Ink on a fill: dark text where the fill is light (aqua, yellow).
export const inkOn = (hex) => {
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  const lum = 0.2126 * r ** 2.2 + 0.7152 * g ** 2.2 + 0.0722 * b ** 2.2;
  return lum > 0.3 ? "#0b0b0b" : "#ffffff";
};

const FAILED = new Set(["unknown", "failed"]);
/** Lanes for the devices in view; blocks carry start/end in server time. */
export function liveLanes(state, { rack = "", now, devices } = {}) {
  const start = now - PAST_MS,
    end = now + FUTURE_MS;
  const shown = (devices || state.devices).filter(
    (d) => !rack || d.rack === rack,
  );
  const jobs = new Map(state.jobs.map((j) => [j.id, j]));
  const doneSteps = new Map();
  for (const c of state.commands || [])
    if (c.status === "succeeded")
      doneSteps.set(c.attemptId, (doneSteps.get(c.attemptId) || 0) + 1);
  const availability = new Map(
    (state.scheduling?.devices || []).map((d) => [d.deviceId, d]),
  );
  const plans = new Map();
  for (const plan of state.scheduling?.poolPlans || [])
    for (const a of plan.assignments || []) {
      if (!plans.has(a.deviceId)) plans.set(a.deviceId, []);
      plans.get(a.deviceId).push(a);
    }
  const lanes = shown.map((d) => {
    const blocks = [];
    const attempts = state.attempts
      .filter((a) => a.deviceId === d.id)
      .map((a) => ({
        a,
        from: a.dispatchedAt ?? a.createdAt,
        to: a.completedAt ?? now,
      }))
      .filter(({ to }) => to >= start)
      .sort((x, y) => x.from - y.from);
    const lastEnd = new Map(); // appId -> when its last session ended
    let deviceLastEnd = null;
    for (const { a, from, to } of attempts) {
      const job = jobs.get(a.jobId);
      const live = ["running", "yielded"].includes(a.status);
      blocks.push({
        kind: FAILED.has(a.status) ? "failed" : "run",
        id: `run:${a.id}`,
        start: Math.max(from, start),
        end: live ? now : to,
        appId: a.appId,
        label: job ? jobTitle(job) : a.label || appName(a.appId),
        status: a.status,
        jobId: a.jobId,
        attemptId: a.id,
        steps: a.steps ?? null,
        done: doneSteps.get(a.id) || 0,
        estimateMs: a.estimatedDurationMs ?? null,
        actualMs: (live ? now : to) - from,
        executor: a.executor || null,
      });
      if (live && a.estimatedDurationMs && from + a.estimatedDurationMs > now)
        blocks.push({
          kind: "remaining",
          id: `rest-of:${a.id}`,
          start: now,
          end: Math.min(end, from + a.estimatedDurationMs),
          appId: a.appId,
          label: "预计剩余",
          jobId: a.jobId,
          attemptId: a.id,
        });
      if (!live) {
        lastEnd.set(a.appId, to);
        deviceLastEnd = Math.max(deviceLastEnd ?? 0, to);
      }
    }
    // Cooldowns per App (striped band) and whole-device rests (gray band).
    for (const app of availability.get(d.id)?.apps || [])
      if (app.cooldownUntil > now)
        blocks.push({
          kind: "cooldown",
          id: `cool:${d.id}:${app.appId}`,
          start: Math.max(start, lastEnd.get(app.appId) ?? now),
          end: Math.min(end, app.cooldownUntil),
          appId: app.appId,
          label: `${appName(app.appId)} 冷却`,
          until: app.cooldownUntil,
        });
    if (d.cooldownUntil > now)
      blocks.push({
        kind: "rest",
        id: `rest:${d.id}`,
        start: Math.max(start, deviceLastEnd ?? now),
        end: Math.min(end, d.cooldownUntil),
        label: "整机休息",
        until: d.cooldownUntil,
        reason: d.restReason || null,
      });
    // Soft plans: may still move; draggable to another lane.
    for (const p of plans.get(d.id) || []) {
      if (p.finishAt < now || p.startAt > end) continue;
      const job = jobs.get(p.jobId);
      blocks.push({
        kind: "plan",
        id: `plan:${p.jobId}`,
        start: Math.max(p.startAt, now),
        end: Math.min(end, p.finishAt),
        appId: p.appId,
        label: job ? jobTitle(job) : appName(p.appId),
        jobId: p.jobId,
        reason: p.reason,
        waitMs: p.waitMs,
        switchMs: p.switchMs,
        moves: p.moves,
        revision: job?.revision ?? 0,
      });
    }
    if (d.state === "quarantined")
      blocks.push({
        kind: "quarantine",
        id: `q:${d.id}`,
        start: Math.max(
          start,
          ...attempts
            .filter(({ a }) => FAILED.has(a.status))
            .map(({ to }) => to),
        ),
        end,
        label: "待核验 · 隔离，不参与计划",
      });
    return {
      id: d.id,
      name: d.name,
      rack: d.rack,
      host: d.host,
      agent: !!d.agentId,
      blocks: blocks.filter((b) => b.end > b.start),
    };
  });
  return { start, end, now, lanes };
}

/** Relative tick labels every 30 s around now: -2:00 … 现在 … +3:00. */
export function liveTicks(now, stepMs = 30000) {
  const ticks = [];
  for (let t = -PAST_MS; t <= FUTURE_MS; t += stepMs) {
    const s = Math.abs(t / 1000);
    ticks.push({
      at: now + t,
      label:
        t === 0
          ? "现在"
          : `${t < 0 ? "−" : "+"}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
    });
  }
  return ticks;
}

/** Lanes as of virtual time t: sessions not yet started are hidden, the ones
 * in progress end at t. */
export function lanesAt(lanes, t) {
  return lanes.map((lane) => ({
    ...lane,
    blocks: lane.blocks
      .filter((b) => b.start <= t)
      .map((b) => ({
        ...b,
        id: `run:${b.jobId}`,
        kind:
          b.status === "unknown" || b.status === "failed"
            ? b.end <= t
              ? "failed"
              : "run"
            : "run",
        end: Math.min(b.end, t),
        status: b.end <= t ? b.status : "running",
        actualMs: Math.min(b.end, t) - b.start,
      })),
  }));
}
