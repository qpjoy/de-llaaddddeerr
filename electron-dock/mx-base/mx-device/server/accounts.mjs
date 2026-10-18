// Platform accounts: a pacing scope that follows the account, not the device.
// Each device App row names one account (DB-unique per App), so today an
// account is bound to exactly one device; its history and status live here so
// a future rebinding cannot reset them. Account policy comes from the
// strategy's pacing rule (scheduler.pacing.account); without one, usage is
// still recorded (bounded) and status still applies.
//
// Never rotate accounts to get around a limit: a platform signal puts the
// account under review and backs it off; only an operator returns it to active.
import { randomUUID } from "node:crypto";
import { appName } from "./apps.mjs";
import { normalizedPolicy } from "./pool-policy.mjs";
import { appRowOf } from "./apps.mjs";

export const ACCOUNT_STATUSES = ["active", "limited", "review", "retired"];
export const ACCOUNT_SIGNALS = {
  captcha: "出现验证码",
  "rate-limited": "平台限流",
  "logged-out": "登录失效",
  "risk-warning": "风险提示",
};
const STATUS_TEXT = {
  limited: "已标记受限",
  review: "待人工复核",
  retired: "已停用",
};
const HOUR = 3600000;
const SIGNAL_BACKOFF_MS = 10 * 60000;
const MAX_BACKOFF_MS = 24 * HOUR;
const secs = (ms) => Math.ceil(ms / 1000);

export const accountId = (mode, appId, accountKey) =>
  `${mode}/${appId}/${accountKey}`;
export function initialAccount(mode, appId, accountKey, now = 0) {
  return {
    id: accountId(mode, appId, accountKey),
    mode,
    appId,
    accountKey,
    status: "active",
    statusReason: null,
    statusAt: null,
    revision: 1,
    cooldownUntil: 0,
    restReason: null,
    runs: [],
    hourly: { hour: Math.floor(now / HOUR), counts: [] },
    totals: { sessions: 0, serviceMs: 0 },
    signals: [],
    lastDispatchedAt: null,
    lastFinishedAt: null,
  };
}
const appRow = appRowOf;
// The account id of an App row (rows are replaced, never edited in place).
const ACCOUNT_IDS = new WeakMap();
// Accounts by id, cached per array (rebuilt when rows are added).
const ACCOUNT_INDEX = new WeakMap();
function accountsById(state) {
  const rows = state.accounts || [];
  let hit = ACCOUNT_INDEX.get(rows);
  if (!hit || hit.length !== rows.length) {
    const map = new Map();
    for (const a of rows) if (!map.has(a.id)) map.set(a.id, a);
    ACCOUNT_INDEX.set(rows, (hit = { length: rows.length, map }));
  }
  return hit.map;
}
// Read-only lookup; returns null when the account row does not exist yet.
export function findAccount(state, device, appId) {
  const app = appRow(state, device, appId);
  if (!app) return null;
  let id = ACCOUNT_IDS.get(app);
  if (!id)
    ACCOUNT_IDS.set(app, (id = accountId(device.mode, appId, app.accountKey)));
  return accountsById(state).get(id) || null;
}
export const ensureAccountFor = (state, device, app) =>
  ensureAccount(state, 0, device, app);
function ensureAccount(state, now, device, app) {
  state.accounts ||= [];
  const id = accountId(device.mode, app.appId, app.accountKey);
  let account = state.accounts.find((a) => a.id === id);
  if (!account) {
    account = initialAccount(device.mode, app.appId, app.accountKey, now);
    state.accounts.push(account);
  }
  return account;
}

/** Account budget from the rack strategy's pacing rule, or null (no budget). */
export function accountPolicy(state, device, appId) {
  const scheduler = (state.loopPolicies || []).find(
    (p) => p.mode === device.mode && p.rack === device.rack,
  )?.scheduler;
  if (device.mode !== "sim" || !scheduler?.enabled) return null;
  const account = normalizedPolicy(scheduler).pacing?.account;
  return account ? { ...account, appId, source: "strategy" } : null;
}

// Rolling 24 hourly buckets: constant size, enough for a daily cap.
function rollHours(account, now) {
  const hour = Math.floor(now / HOUR);
  const h = account.hourly || { hour, counts: [] };
  const shift = Math.min(24, Math.max(0, hour - h.hour));
  const counts = [...Array(shift).fill(0), ...(h.counts || [])].slice(0, 24);
  return { hour, counts };
}
const dailyUsed = (account, now) =>
  rollHours(account, now).counts.reduce((n, c) => n + (c || 0), 0);
const service = (r) => r.serviceMs ?? r.reservedMs ?? 0;
const windowRuns = (account, now, policy) =>
  (account.runs || []).filter(
    (r) => r.finishedAt == null || r.at > now - policy.windowMs,
  );

export function accountBlockers(state, now, device, appId) {
  const account = findAccount(state, device, appId);
  if (!account) return [];
  const name = appName(appId);
  const out = [];
  if (account.status !== "active")
    out.push({
      code: `account-${account.status}`,
      scope: "account",
      primitive: "status",
      appId,
      accountId: account.id,
      message: `${name}账号${STATUS_TEXT[account.status]}${account.statusReason ? `：${account.statusReason}` : ""}；不自动换号绕过`,
    });
  if (account.cooldownUntil > now)
    out.push({
      code: "account-cooldown",
      scope: "account",
      primitive: account.restReason || "minGap",
      appId,
      accountId: account.id,
      until: account.cooldownUntil,
      message: `${name}账号${account.restReason === "signalBackoff" ? "风控退避" : account.restReason === "windowRest" ? "窗口预算休息" : "间隔"}中，约 ${secs(account.cooldownUntil - now)} 秒`,
    });
  const policy = accountPolicy(state, device, appId);
  if (policy?.dailyCap && dailyUsed(account, now) >= policy.dailyCap)
    out.push({
      code: "account-daily-cap",
      scope: "account",
      primitive: "dailyCap",
      appId,
      accountId: account.id,
      message: `${name}账号 24 小时内已达上限 ${policy.dailyCap} 次`,
    });
  if (policy?.maxRuns) {
    const runs = windowRuns(account, now, policy);
    if (
      runs.length >= policy.maxRuns ||
      (policy.maxServiceMs > 0 &&
        runs.reduce((n, r) => n + service(r), 0) >= policy.maxServiceMs)
    )
      out.push({
        code: "account-window",
        scope: "account",
        primitive: "windowBudget",
        appId,
        accountId: account.id,
        message: `${name}账号窗口预算已用完（${runs.length}/${policy.maxRuns} 次）`,
      });
  }
  return out;
}

/** First dispatch of an attempt charges its account once. */
export function accountDispatch(state, now, device, app, attempt) {
  const account = ensureAccount(state, now, device, app);
  if ((account.runs || []).some((r) => r.attemptId === attempt.id)) return;
  const policy = accountPolicy(state, device, app.appId);
  account.runs = (policy ? windowRuns(account, now, policy) : [])
    .concat({
      attemptId: attempt.id,
      deviceId: device.id,
      at: now,
      reservedMs: attempt.estimatedDurationMs,
      finishedAt: null,
    })
    .slice(-100);
  const hours = rollHours(account, now);
  hours.counts[0] = (hours.counts[0] || 0) + 1;
  account.hourly = hours;
  account.totals = {
    sessions: (account.totals?.sessions || 0) + 1,
    serviceMs: account.totals?.serviceMs || 0,
  };
  account.lastDispatchedAt = now;
  if (policy?.minGapMs) extend(account, now + policy.minGapMs, "minGap");
}
/** Completion settles the measured service and may earn a window rest. */
export function accountSettle(state, now, device, app, attempt) {
  const account = findAccount(state, device, app.appId);
  const run = account?.runs?.find((r) => r.attemptId === attempt.id);
  if (!run) return;
  run.finishedAt = now;
  run.serviceMs = Math.max(0, now - run.at);
  account.totals = {
    sessions: account.totals?.sessions || 0,
    serviceMs: (account.totals?.serviceMs || 0) + run.serviceMs,
  };
  account.lastFinishedAt = now;
  const policy = accountPolicy(state, device, app.appId);
  if (!policy) {
    // Without a budget only the in-flight reservation is kept.
    account.runs = account.runs.filter((r) => r.finishedAt == null);
    return;
  }
  if (policy.minGapMs) extend(account, now + policy.minGapMs, "minGap");
  const runs = windowRuns(account, now, policy);
  account.runs = runs;
  if (
    policy.maxRuns &&
    (runs.length >= policy.maxRuns ||
      (policy.maxServiceMs > 0 &&
        runs.reduce((n, r) => n + service(r), 0) >= policy.maxServiceMs))
  ) {
    extend(account, now + policy.restMs, "windowRest");
    account.runs = runs.filter((r) => r.finishedAt == null);
  }
}
function extend(account, until, reason) {
  if (until > (account.cooldownUntil || 0)) {
    account.cooldownUntil = until;
    account.restReason = reason;
  }
}

const findById = (state, mode, id) => {
  const account = (state.accounts || []).find(
    (a) => a.mode === mode && a.id === id,
  );
  if (!account) throw Object.assign(new Error("账号不存在"), { status: 404 });
  return account;
};
const fault = (message, status = 400) =>
  Object.assign(new Error(message), { status });

/** Operator status change. Restricting is always allowed; returning to active
 * requires an explicit confirmation and a reason, and never shortens a backoff. */
export function setAccountStatus(state, now, mode, id, body) {
  const account = findById(state, mode, id);
  if (!body || body.revision !== account.revision)
    throw fault("账号状态已更新，请刷新后重试", 409);
  if (!ACCOUNT_STATUSES.includes(body.status)) throw fault("无效的账号状态");
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  if (!reason) throw fault("请填写原因");
  if (body.status === "active" && body.confirmed !== true)
    throw fault("恢复账号需确认已在平台侧核实正常");
  if (account.status === "retired" && body.status !== "retired")
    throw fault("已停用的账号不能直接恢复，请登记新账号", 409);
  const before = account.status;
  account.status = body.status;
  account.statusReason = reason;
  account.statusAt = now;
  account.revision++;
  state.events.push({
    id: randomUUID(),
    mode,
    at: now,
    type: "account-status",
    accountId: id,
    message: `${appName(account.appId)}账号 ${account.accountKey}：${before} → ${body.status}（${reason}）`,
  });
  return account;
}

/** A platform signal (from an adapter, or reported by an operator): the account
 * goes to review and backs off exponentially; the backoff only ever extends. */
export function recordAccountSignal(state, now, mode, id, body) {
  const account = findById(state, mode, id);
  if (!body || !Object.hasOwn(ACCOUNT_SIGNALS, body.kind))
    throw fault("未知的平台信号");
  const detail =
    typeof body.detail === "string" ? body.detail.trim().slice(0, 300) : "";
  const recent = (account.signals || []).filter((s) => s.at > now - 24 * HOUR);
  const backoff = Math.min(
    MAX_BACKOFF_MS,
    SIGNAL_BACKOFF_MS * 2 ** recent.length,
  );
  account.signals = [
    ...(account.signals || []),
    { kind: body.kind, at: now, detail, backoffMs: backoff },
  ].slice(-20);
  extend(account, now + backoff, "signalBackoff");
  if (account.status === "active") {
    account.status = "review";
    account.statusReason = `${ACCOUNT_SIGNALS[body.kind]}${detail ? `：${detail}` : ""}`;
    account.statusAt = now;
  }
  account.revision++;
  state.events.push({
    id: randomUUID(),
    mode,
    at: now,
    type: "account-signal",
    accountId: id,
    message: `${appName(account.appId)}账号 ${account.accountKey} ${ACCOUNT_SIGNALS[body.kind]}：转人工复核，退避 ${Math.round(backoff / 60000)} 分钟；不自动换号`,
  });
  return account;
}

/** Read model for the account pool page. */
export function accountView(state, now, account) {
  const app = (state.apps || []).find(
    (a) =>
      a.mode === account.mode &&
      a.appId === account.appId &&
      a.accountKey === account.accountKey,
  );
  const device = app && state.devices.find((d) => d.id === app.deviceId);
  return {
    ...account,
    boundDeviceId: device?.id ?? null,
    boundDeviceName: device?.name ?? null,
    rack: device?.rack ?? null,
    daily: dailyUsed(account, now),
    policy: device ? accountPolicy(state, device, account.appId) : null,
    inFlight: (account.runs || []).filter((r) => r.finishedAt == null).length,
  };
}
