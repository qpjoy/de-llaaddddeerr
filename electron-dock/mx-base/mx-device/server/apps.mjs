import { pacingBlockers } from "./ledger.mjs";
import { ensureAccountFor } from "./accounts.mjs";
// Scheduling metadata only. An App entry never creates another physical slot.
export const APP_NAMES = {
  xhs: "小红书",
  weibo: "微博",
  xianyu: "闲鱼",
  pdd: "拼多多",
};
export const appName = (id = "xhs") => APP_NAMES[id] || id;
export const jobApp = (job) => job.appId || "xhs";
export const deviceInterval = (device) =>
  device.taskIntervalMs ?? (device.mode === "real" ? 2000 : 300);
export const supportedApps = (device) =>
  device.mode === "sim"
    ? device.simApps || ["xhs", "weibo"]
    : device.adapter === "legacy-poc"
      ? ["xhs"]
      : [];

export function initialApp(device, appId) {
  return {
    id: `${device.id}/${appId}`,
    mode: device.mode,
    deviceId: device.id,
    appId,
    accountKey:
      appId === "xhs" ? device.accountKey : `sim:${device.id}:${appId}`,
    cooldownMs: 0,
    cooldownUntil: 0,
    lastClaimedAt: null,
    lastDispatchedAt: null,
    lastFinishedAt: null,
    lastSucceededAt: null,
    lastAttemptId: null,
    revision: 1,
  };
}

export const appKey = (mode, deviceId, appId) =>
  `${mode}\u0000${deviceId}\u0000${appId}`;
// App rows by device id then App id, cached per array (rebuilt when rows are
// added; rows are never replaced in place). The first row wins, like find().
const APP_INDEX = new WeakMap();
function appsByDevice(state) {
  const rows = state.apps || [];
  let hit = APP_INDEX.get(rows);
  if (!hit || hit.length !== rows.length) {
    const map = new Map();
    for (const a of rows) {
      let apps = map.get(a.deviceId);
      if (!apps) map.set(a.deviceId, (apps = new Map()));
      if (!apps.has(a.appId)) apps.set(a.appId, a);
    }
    APP_INDEX.set(rows, (hit = { length: rows.length, map }));
  }
  return hit.map;
}
/** The App row of a device, or undefined. */
export function appRowOf(state, device, appId) {
  const row = appsByDevice(state).get(device.id)?.get(appId);
  return row?.mode === device.mode ? row : undefined;
}
// index (optional): a read-only schedulingIndex built for this state; results are identical.
export function deviceApps(state, device, index) {
  return supportedApps(device).map(
    (id) =>
      (index
        ? index.apps.get(appKey(device.mode, device.id, id))
        : appRowOf(state, device, id)) || initialApp(device, id),
  );
}

export function ensureApps(state, device) {
  state.apps ||= [];
  for (const app of deviceApps(state, device))
    if (!state.apps.some((a) => a.id === app.id)) {
      state.apps.push(app);
      // Every App row names an account; it joins the account pool at once.
      ensureAccountFor(state, device, app);
    }
  return deviceApps(state, device);
}

export function appBlockers(state, now, device, job, index) {
  const appId = jobApp(job);
  const app = deviceApps(state, device, index).find((a) => a.appId === appId);
  if (!app)
    return [
      {
        code: "app-unsupported",
        message: `当前适配器不支持${appName(appId)}任务`,
      },
    ];
  if (
    device.mode === "sim" &&
    device.simCommandCodes &&
    job.workflow?.plan.some(
      (step) => !device.simCommandCodes.includes(step.code),
    )
  )
    return [
      {
        code: "command-unsupported",
        message: "此设备尚未迁入任务所需的全部指令",
      },
    ];
  // Session and account pacing come from the ledger (scope, primitive, until).
  return pacingBlockers(state, now, device, job, app);
}
