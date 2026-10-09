import { randomUUID } from "node:crypto";
import { requireThat, publicDevice } from "./model.mjs";
import { ensureApps, appName } from "./apps.mjs";

export function configurePacing(state, now, mode, id, body) {
  const device = state.devices.find((d) => d.id === id && d.mode === mode);
  requireThat(device, "设备不存在", 404);
  requireThat(
    device.revision === body.revision,
    "设备状态已更新，请刷新后重试",
  );
  requireThat(
    device.adapter !== "mobile-agent",
    "此设备仅观察，不能配置执行节奏",
    400,
  );
  requireThat(
    !device.enabled &&
      device.state === "idle" &&
      !state.attempts.some(
        (a) => a.deviceId === id && a.status === "running",
      ) &&
      !["waiting", "held"].includes(device.session?.status),
    "先暂停设备并等待执行/预留结束，再修改冷却策略",
  );
  const validMs = (v, min = 0) =>
    Number.isInteger(v) && v >= min && v <= 86400000;
  requireThat(
    validMs(body.deviceIntervalMs, mode === "real" ? 2000 : 0),
    mode === "real"
      ? "真机整机间隔须为 2000–86400000 毫秒"
      : "整机间隔须为 0–86400000 毫秒",
    400,
  );
  const apps = ensureApps(state, device);
  requireThat(
    Array.isArray(body.apps) &&
      body.apps.length === apps.length &&
      new Set(body.apps.map((a) => a?.appId)).size === apps.length &&
      body.apps.every(
        (a) =>
          a && apps.some((x) => x.appId === a.appId) && validMs(a.cooldownMs),
      ),
    "请提供当前适配器全部 App 的冷却策略（0–86400000 毫秒）",
    400,
  );
  device.taskIntervalMs = body.deviceIntervalMs;
  const last = Math.max(
    device.lastFinishedAt || 0,
    device.lastDispatchedAt || 0,
    device.lastVerifiedStoppedAt || 0,
  );
  if (last)
    device.cooldownUntil = Math.max(
      device.cooldownUntil || 0,
      last + device.taskIntervalMs,
    );
  for (const app of apps) {
    app.cooldownMs = body.apps.find((a) => a.appId === app.appId).cooldownMs;
    const lastAction = Math.max(
      app.lastFinishedAt || 0,
      app.lastDispatchedAt || 0,
      app.lastVerifiedStoppedAt || 0,
    );
    if (lastAction)
      app.cooldownUntil = Math.max(
        app.cooldownUntil,
        lastAction + app.cooldownMs,
      );
    app.revision++;
    app.updatedAt = now;
  }
  device.revision++;
  state.events.push({
    id: randomUUID(),
    mode,
    at: now,
    type: "pacing-policy",
    deviceId: id,
    message: `${device.name} 更新冷却：整机 ${body.deviceIntervalMs / 1000} 秒；${apps.map((a) => `${appName(a.appId)} ${a.cooldownMs / 1000} 秒`).join("、")}；已记录的冷却不缩短`,
  });
  return { device: publicDevice(device), apps };
}
