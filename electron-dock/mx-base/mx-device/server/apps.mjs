import { recordLoopUsage } from "./loop-policy.mjs";
// Scheduling metadata only. An App entry never creates another physical slot.
export const APP_NAMES = { xhs: "小红书", weibo: "微博" };
export const appName = (id = "xhs") => APP_NAMES[id] || id;
export const jobApp = (job) => job.appId || "xhs";
export const deviceInterval = (device) =>
  device.taskIntervalMs ?? (device.mode === "real" ? 2000 : 300);
export const supportedApps = (device) =>
  device.mode === "sim"
    ? ["xhs", "weibo"]
    : device.adapter === "legacy-poc"
      ? ["xhs"]
      : [];

export function initialApp(device, appId) {
  return {
    id: `${device.id}/${appId}`,
    mode: device.mode,
    deviceId: device.id,
    appId,
    accountKey: appId === "xhs" ? device.accountKey : `sim:${device.id}:weibo`,
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

export function deviceApps(state, device) {
  return supportedApps(device).map(
    (id) =>
      (state.apps || []).find(
        (a) =>
          a.mode === device.mode && a.deviceId === device.id && a.appId === id,
      ) || initialApp(device, id),
  );
}

export function ensureApps(state, device) {
  state.apps ||= [];
  for (const app of deviceApps(state, device))
    if (!state.apps.some((a) => a.id === app.id)) state.apps.push(app);
  return deviceApps(state, device);
}

export function appBlockers(state, now, device, job) {
  const appId = jobApp(job);
  const app = deviceApps(state, device).find((a) => a.appId === appId);
  if (!app)
    return [
      {
        code: "app-unsupported",
        message: `当前适配器不支持${appName(appId)}任务`,
      },
    ];
  if (app.cooldownUntil > now)
    return [
      {
        code: "app-cooldown",
        appId,
        until: app.cooldownUntil,
        message: `${appName(appId)}账号冷却中，约 ${Math.ceil((app.cooldownUntil - now) / 1000)} 秒；其他 App 可独立匹配`,
      },
    ];
  return [];
}

export function recordAppDispatch(state, now, device, attempt) {
  const app = ensureApps(state, device).find(
    (a) => a.appId === jobApp(attempt),
  );
  if (!app) return;
  app.lastDispatchedAt = now;
  app.lastAttemptId = attempt.id;
  // Charge even when the subsequent response is lost. Completion may extend this.
  app.cooldownUntil = Math.max(app.cooldownUntil, now + app.cooldownMs);
  device.lastDispatchedAt = now;
  device.cooldownUntil = Math.max(
    device.cooldownUntil || 0,
    now + deviceInterval(device),
  );
}

export function recordAppFinish(state, now, device, attempt) {
  const app = ensureApps(state, device).find(
    (a) => a.appId === jobApp(attempt),
  );
  if (!app) return;
  app.lastFinishedAt = now;
  app.lastSucceededAt = now;
  recordLoopUsage(state, now, device, app, attempt);
  app.lastAttemptId = attempt.id;
  app.cooldownUntil = Math.max(app.cooldownUntil, now + app.cooldownMs);
  device.lastFinishedAt = now;
  device.lastSucceededAt = now;
  device.cooldownUntil = Math.max(
    device.cooldownUntil || 0,
    now + deviceInterval(device),
  );
}
