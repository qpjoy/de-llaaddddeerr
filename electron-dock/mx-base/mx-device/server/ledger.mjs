// Pacing ledger: the single place that decides and records pacing.
//
// Scopes
//   device  — the physical slot: minimum gap between dispatches, continuous-service cap.
//   session — one App on one device: minimum gap, burst rest, window budget.
//   account — a platform account across devices: status, minimum gap, window
//             budget and daily cap (see accounts.mjs).
// Primitives produce deadlines (…Until) that are lower bounds: they are only ever
// extended, never shortened by a policy change, a page refresh or a disabled rule.
// Charges are taken at dispatch (a lost reply still counts) and settled with the
// measured service at completion; unknown outcomes stay charged.
//
// Storage stays where earlier releases kept it (device and device_app documents),
// so existing deadlines carry over unchanged; this module owns every read and
// write of those fields.
import { randomInt, randomUUID } from "node:crypto";
import { appName, deviceInterval, ensureApps, jobApp } from "./apps.mjs";
import {
  normalizedPolicy,
  poolAppPolicy,
  poolRunHistory,
} from "./pool-policy.mjs";
import {
  accountBlockers,
  accountDispatch,
  accountSettle,
  accountPolicy,
  findAccount,
} from "./accounts.mjs";

export { poolRunHistory };
const rackPolicy = (s, d) =>
  (s.loopPolicies || []).find((p) => p.mode === d.mode && p.rack === d.rack);
const enabledScheduler = (s, d) => {
  const scheduler = rackPolicy(s, d)?.scheduler;
  return d.mode === "sim" && scheduler?.enabled ? scheduler : null;
};
const service = (row) =>
  row.actualServiceMs ?? row.reservedServiceMs ?? row.serviceMs ?? 0;
const secs = (ms) => Math.ceil(ms / 1000);

/** Effective pacing for one device and App, with where each rule comes from.
 * The strategy's pacing rule (scheduler.pacing) supersedes the legacy rack loop
 * settings; device overrides set the minimum gaps. */
export function pacingFor(state, device, appId) {
  const loop = rackPolicy(state, device);
  const scheduler = enabledScheduler(state, device);
  const pacing = scheduler ? normalizedPolicy(scheduler).pacing : null;
  const app = (state.apps || []).find(
    (a) =>
      a.mode === device.mode && a.deviceId === device.id && a.appId === appId,
  );
  const burst = pacing?.burst
    ? { ...pacing.burst, source: "strategy" }
    : loop
      ? {
          windowMs: loop.windowMs,
          smallLimit: loop.smallLimit,
          largeLimit: loop.largeLimit,
          restMinMs: loop.cooldownMinMs,
          restMaxMs: loop.cooldownMaxMs,
          source: "rack-loop",
        }
      : null;
  return {
    device: {
      minGapMs: deviceInterval(device),
      source: device.taskIntervalMs == null ? "default" : "device",
      continuous: pacing?.continuous
        ? { ...pacing.continuous, source: "strategy" }
        : null,
    },
    session: {
      minGapMs: app?.cooldownMs ?? 0,
      minGapSource: "device",
      burst,
      window: scheduler
        ? { ...poolAppPolicy(scheduler, appId), source: "strategy" }
        : null,
    },
    account: accountPolicy(state, device, appId),
  };
}

// ---------------------------------------------------------------- admission

const DEVICE_REST = {
  minGap: (s) => `设备间隔中，约 ${s} 秒`,
  continuousRest: (s) => `设备连续服务后休息，约 ${s} 秒`,
  verifiedStop: (s) => `核验停止后的保护间隔，约 ${s} 秒`,
};
export function devicePacingBlockers(now, d) {
  if (!(d.cooldownUntil > now)) return [];
  const primitive = d.restReason || "minGap";
  return [
    {
      code: "cooldown",
      scope: "device",
      primitive,
      until: d.cooldownUntil,
      message: (DEVICE_REST[primitive] || DEVICE_REST.minGap)(
        secs(d.cooldownUntil - now),
      ),
    },
  ];
}
// Which primitive produced the current session deadline.
export function sessionPrimitive(app) {
  if (app.poolRestUntil && app.poolRestUntil === app.cooldownUntil)
    return "windowRest";
  if (app.rest?.until && app.rest.until === app.cooldownUntil)
    return "burstRest";
  if (app.verifiedStopUntil && app.verifiedStopUntil === app.cooldownUntil)
    return "verifiedStop";
  return "minGap";
}
const SESSION_REST = {
  minGap: (name, s) => `${name}账号冷却中，约 ${s} 秒；其他 App 可独立匹配`,
  burstRest: (name, s) =>
    `${name}连续执行后随机休息，约 ${s} 秒；其他 App 可独立匹配`,
  windowRest: (name, s) =>
    `${name}窗口预算已用完，休息约 ${s} 秒；其他 App 可独立匹配`,
  verifiedStop: (name, s) =>
    `${name}核验停止后的保护冷却，约 ${s} 秒；其他 App 可独立匹配`,
};
/** Read model for one device: every scope's rule, its source and current deadline. */
export function pacingSummary(state, now, device, apps) {
  const rule = pacingFor(state, device, null);
  return {
    device: {
      minGapMs: rule.device.minGapMs,
      source: rule.device.source,
      continuous: rule.device.continuous,
      until: device.cooldownUntil > now ? device.cooldownUntil : null,
      primitive:
        device.cooldownUntil > now ? device.restReason || "minGap" : null,
    },
    apps: apps.map((app) => {
      const p = pacingFor(state, device, app.appId);
      const account = findAccount(state, device, app.appId);
      return {
        appId: app.appId,
        minGapMs: p.session.minGapMs,
        burst: p.session.burst,
        window: p.session.window && {
          maxRuns: p.session.window.maxRuns,
          maxServiceMs: p.session.window.maxServiceMs,
          used: poolRunHistory(app, now, p.session.window).length,
          source: p.session.window.source,
        },
        until: app.cooldownUntil > now ? app.cooldownUntil : null,
        primitive: app.cooldownUntil > now ? sessionPrimitive(app) : null,
        account: account && {
          id: account.id,
          status: account.status,
          statusReason: account.statusReason,
          until: account.cooldownUntil > now ? account.cooldownUntil : null,
          restReason: account.cooldownUntil > now ? account.restReason : null,
          policy: p.account,
        },
      };
    }),
  };
}
export function sessionPacingBlockers(now, app, appId = app.appId) {
  if (!(app.cooldownUntil > now)) return [];
  const primitive = sessionPrimitive(app);
  return [
    {
      code: "app-cooldown",
      scope: "session",
      primitive,
      appId,
      until: app.cooldownUntil,
      message: SESSION_REST[primitive](
        appName(appId),
        secs(app.cooldownUntil - now),
      ),
    },
  ];
}
/** All pacing that blocks starting job's App on device now (session + account).
 * The device scope is reported once per device by devicePacingBlockers. */
export function pacingBlockers(state, now, device, job, app) {
  return [
    ...sessionPacingBlockers(now, app, jobApp(job)),
    ...accountBlockers(state, now, device, jobApp(job)),
  ];
}
/** Earliest time a yielded session may take its next step: the device gap and
 * another task's rest on its App block it; its own dispatch charge does not. */
export function sessionWaitUntil(device, app, ownAttemptId) {
  return Math.max(
    device.cooldownUntil || 0,
    app && app.lastAttemptId !== ownAttemptId ? app.cooldownUntil || 0 : 0,
  );
}
/** Window-budget admission of a whole session (planner). Returns the earliest
 * start honoring the App deadline and the budget, or a blocking code. */
export function windowAdmission(app, start, duration, policy) {
  if (duration > policy.maxServiceMs) return { code: "app-service-budget" };
  let at = Math.max(start, app.cooldownUntil || 0);
  let history = poolRunHistory(app, at, policy);
  const exhausted = (rows) =>
    rows.length >= policy.maxRuns ||
    rows.reduce((n, r) => n + service(r), 0) + duration > policy.maxServiceMs;
  if (exhausted(history)) {
    const last = Math.max(
      ...history.map((r) => r.finishedAt ?? r.at + service(r)),
    );
    at = Math.max(at, last + policy.cooldownMs);
    history = poolRunHistory(app, at, policy);
  }
  if (exhausted(history)) return { code: "app-budget-unresolved" };
  return { at, history };
}

// ---------------------------------------------------------------- recording

/** A command of the attempt is about to be sent. */
export function pacingDispatch(state, now, device, attempt) {
  const app = ensureApps(state, device).find(
    (a) => a.appId === jobApp(attempt),
  );
  if (!app) return;
  windowCharge(state, now, device, app, attempt);
  continuousStart(state, now, device);
  accountDispatch(state, now, device, app, attempt);
  app.lastDispatchedAt = now;
  app.lastAttemptId = attempt.id;
  // Charge even when the subsequent response is lost. Completion may extend this.
  app.cooldownUntil = Math.max(app.cooldownUntil, now + app.cooldownMs);
  device.lastDispatchedAt = now;
  extendDevice(device, now + deviceInterval(device), "minGap");
}
/** The attempt finished with a confirmed outcome (success or known failure). */
export function pacingSettle(state, now, device, attempt) {
  const app = ensureApps(state, device).find(
    (a) => a.appId === jobApp(attempt),
  );
  if (!app) return;
  app.lastFinishedAt = now;
  app.lastSucceededAt = now;
  windowSettle(state, now, device, app, attempt);
  burstRest(state, now, device, app, attempt);
  accountSettle(state, now, device, app, attempt);
  app.lastAttemptId = attempt.id;
  app.cooldownUntil = Math.max(app.cooldownUntil, now + app.cooldownMs);
  device.lastFinishedAt = now;
  device.lastSucceededAt = now;
  extendDevice(device, now + deviceInterval(device), "minGap");
  continuousSettle(state, now, device);
}
/** An operator verified a quarantined device stopped: protect every App it used. */
export function pacingVerifiedStop(state, now, device) {
  extendDevice(
    device,
    now + Math.max(2000, deviceInterval(device)),
    "verifiedStop",
  );
  device.lastVerifiedStoppedAt = now;
  for (const app of ensureApps(state, device).filter(
    (a) => a.lastDispatchedAt != null,
  )) {
    const until = now + app.cooldownMs;
    if (until > app.cooldownUntil) app.verifiedStopUntil = until;
    app.cooldownUntil = Math.max(app.cooldownUntil, until);
    app.lastVerifiedStoppedAt = now;
  }
}
function extendDevice(device, until, reason) {
  if (until > (device.cooldownUntil || 0)) {
    device.cooldownUntil = until;
    device.restReason = reason;
  }
}

// Window budget (strategy): reservation once per attempt at dispatch, replaced by
// the measured service at completion. Persisted in the device_app document.
function windowCharge(state, now, device, app, attempt) {
  const scheduler = enabledScheduler(state, device);
  if (!scheduler) return;
  const policy = poolAppPolicy(scheduler, app.appId);
  app.poolRuns = poolRunHistory(app, now, policy);
  if (app.poolRuns.some((r) => r.attemptId === attempt.id)) return;
  app.poolRuns.push({
    attemptId: attempt.id,
    at: now,
    reservedServiceMs: attempt.estimatedDurationMs,
    finishedAt: null,
    policySnapshot: { ...policy },
  });
  app.poolRuns = app.poolRuns.slice(-10000);
}
function windowSettle(state, now, device, app, attempt) {
  const charge = app.poolRuns?.find((r) => r.attemptId === attempt.id);
  if (!charge || device.mode !== "sim") return;
  charge.finishedAt = now;
  charge.actualServiceMs = Math.max(0, now - charge.at);
  const scheduler = enabledScheduler(state, device);
  const policy =
    charge.policySnapshot || (scheduler && poolAppPolicy(scheduler, app.appId));
  if (!policy) return;
  // Inspect the burst admitted at dispatch, before any window can expire while
  // the task is running. Once earned, this rest survives policy edits/disable.
  const usedMs = app.poolRuns.reduce((n, r) => n + service(r), 0);
  if (app.poolRuns.length >= policy.maxRuns || usedMs >= policy.maxServiceMs) {
    app.poolRestUntil = Math.max(
      app.poolRestUntil || 0,
      now + policy.cooldownMs,
    );
    app.cooldownUntil = Math.max(app.cooldownUntil || 0, app.poolRestUntil);
  }
}

// Burst rest: after smallLimit small or largeLimit large sessions in a window, a
// random rest in [restMinMs, restMaxMs]. Drawn once and stored, never redrawn.
function burstRest(state, now, device, app, attempt) {
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
  const policy = pacingFor(state, device, app.appId).session.burst;
  if (!policy) return;
  app.burstRuns = (app.burstRuns || []).filter(
    (r) => r.at > now - policy.windowMs,
  );
  app.burstRuns.push({ at: now, loop });
  const small = app.burstRuns.filter((r) => r.loop === "small").length,
    large = app.burstRuns.filter((r) => r.loop === "large").length;
  if (small < policy.smallLimit && large < policy.largeLimit) return;
  const durationMs = randomInt(policy.restMinMs, policy.restMaxMs + 1);
  app.rest = {
    at: now,
    until: now + durationMs,
    durationMs,
    small,
    large,
    policyRevision: rackPolicy(state, device)?.revision,
    source: policy.source,
    windowMs: policy.windowMs,
  };
  app.cooldownUntil = Math.max(app.cooldownUntil, app.rest.until);
  app.totalRestMs = (app.totalRestMs || 0) + durationMs;
  app.restHistory = [...(app.restHistory || []), app.rest].slice(-50);
  app.burstRuns = [];
  state.events.push({
    id: randomUUID(),
    mode: device.mode,
    at: now,
    type: "app-rest",
    deviceId: device.id,
    jobId: attempt.jobId,
    message: `${device.name} ${app.appId} 窗口内 ${small} 小 / ${large} 大，生成冷却 ${(durationMs / 1000).toFixed(1)} 秒（已保存，不随刷新重抽）`,
  });
}

// Continuous-service cap (strategy pacing): a device serving without a long
// enough break for capMs rests restMs before its next dispatch.
function continuousStart(state, now, device) {
  const cap = pacingFor(state, device, null).device.continuous;
  if (!cap) return;
  const streak = device.serviceStreak;
  if (!streak || now - (streak.lastFinishedAt ?? streak.since) >= cap.restMs)
    device.serviceStreak = { since: now, lastFinishedAt: null };
}
function continuousSettle(state, now, device) {
  const cap = pacingFor(state, device, null).device.continuous;
  const streak = device.serviceStreak;
  if (!cap || !streak) return;
  streak.lastFinishedAt = now;
  if (now - streak.since < cap.capMs) return;
  extendDevice(device, now + cap.restMs, "continuousRest");
  device.serviceStreak = null;
  state.events.push({
    id: randomUUID(),
    mode: device.mode,
    at: now,
    type: "device-rest",
    deviceId: device.id,
    message: `${device.name} 连续服务 ${secs(now - streak.since)} 秒，休息 ${secs(cap.restMs)} 秒`,
  });
}
