import { appName, time } from "./data.js";

const PRIMITIVE = {
  minGap: "间隔",
  burstRest: "连续执行后随机休息",
  windowRest: "窗口预算休息",
  verifiedStop: "核验停止保护",
  continuousRest: "连续服务后休息",
  signalBackoff: "风控退避",
};
const SOURCE = {
  device: "设备设置",
  default: "默认",
  strategy: "策略",
  "rack-loop": "机架循环",
};
const ACCOUNT = { limited: "受限", review: "待复核", retired: "已停用" };
const secs = (ms) => `${Math.round(ms / 100) / 10} 秒`;
const left = (until, now) => Math.max(0, Math.ceil((until - now) / 1000));

// Pacing ledger view: every scope's rule, where it comes from, and what blocks now.
export function AppPacing({ device, availability, now, busy, onConfigure }) {
  if (!availability?.apps.length) return null;
  const editable =
    !device.enabled &&
    device.state === "idle" &&
    !["waiting", "held"].includes(device.session?.status);
  const ledger = availability.pacing;
  const byApp = new Map((ledger?.apps || []).map((a) => [a.appId, a]));
  return (
    <section className="app-pacing" aria-label={`${device.name} 节奏账本`}>
      <div className="app-pacing-heading">
        <strong>节奏账本</strong>
        <button
          className="text-button"
          disabled={busy || !editable}
          title="暂停设备并等待执行/预留结束后可修改设备间隔"
          onClick={() => onConfigure(device)}
        >
          设备间隔
        </button>
      </div>
      <p className="small muted">
        整机间隔 {availability.deviceIntervalMs / 1000} 秒（
        {SOURCE[ledger?.device.source] || "设备设置"}）· 一个执行槽
        {ledger?.device.continuous
          ? ` · 连续服务 ${secs(ledger.device.continuous.capMs)} 后休息 ${secs(ledger.device.continuous.restMs)}（策略）`
          : ""}
      </p>
      {ledger?.device.until > now && (
        <p className="small warning">
          设备{PRIMITIVE[ledger.device.primitive] || "冷却"}中，约{" "}
          {left(ledger.device.until, now)} 秒
        </p>
      )}
      {availability.apps.map((app) => {
        const pacing = byApp.get(app.appId);
        const remaining = left(app.cooldownUntil, now);
        const account = pacing?.account;
        return (
          <div className="app-pacing-row" key={app.appId}>
            <div className="app-pacing-heading">
              <strong>{appName(app.appId)}</strong>
              <span
                className={
                  remaining || (account && account.status !== "active")
                    ? "warning"
                    : "muted"
                }
              >
                {app.active
                  ? "执行中"
                  : account && account.status !== "active"
                    ? `账号${ACCOUNT[account.status]}`
                    : remaining
                      ? `${PRIMITIVE[pacing?.primitive] || "冷却"} ${remaining} 秒`
                      : account?.until > now
                        ? `账号${PRIMITIVE[account.restReason] || "冷却"} ${left(account.until, now)} 秒`
                        : app.blockers.length
                          ? "等待其他条件"
                          : "可领取"}
              </span>
            </div>
            <p className="small">
              任务后间隔 {app.cooldownMs / 1000} 秒
              {pacing?.burst
                ? ` · ${pacing.burst.smallLimit} 小 / ${pacing.burst.largeLimit} 大后休息 ${secs(pacing.burst.restMinMs)}–${secs(pacing.burst.restMaxMs)}（${SOURCE[pacing.burst.source]}）`
                : ""}
              {pacing?.window
                ? ` · 窗口 ${pacing.window.used}/${pacing.window.maxRuns} 次（策略）`
                : ""}
            </p>
            <p className="small muted">
              {app.active
                ? "完成后重算冷却"
                : account && account.status !== "active"
                  ? `账号${ACCOUNT[account.status]}${account.statusReason ? `：${account.statusReason}` : ""}，在账号池处理`
                  : app.nextAllowedAt > now
                    ? `最早通过冷却 ${time(app.nextAllowedAt)}`
                    : "冷却条件已满足"}{" "}
              · 上次派发 {time(app.lastDispatchedAt)}
              {account?.policy
                ? ` · 账号预算：${account.policy.dailyCap ? `24 小时 ≤ ${account.policy.dailyCap} 次` : ""}${account.policy.minGapMs ? ` 间隔 ${secs(account.policy.minGapMs)}` : ""}`
                : ""}
            </p>
          </div>
        );
      })}
      <p className="small muted">
        截止时间只会延长，不因刷新、改策略或停用规则而缩短。设备间隔需暂停并等待执行结束后修改；随机休息、窗口预算和账号预算在策略的节奏规则里设置。
      </p>
    </section>
  );
}

export function PacingForm({ device, availability, busy, onSubmit }) {
  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onSubmit({
          revision: device.revision,
          deviceIntervalMs: Math.round(
            Number(data.get("deviceSeconds")) * 1000,
          ),
          apps: availability.apps.map((app) => ({
            appId: app.appId,
            cooldownMs: Math.round(Number(data.get(app.appId)) * 1000),
          })),
        });
      }}
    >
      <p>
        「{device.name}」共用一个执行槽。每次任务完成后，分别等待整机间隔和该
        App 的账号冷却。
      </p>
      <label>
        整机任务间隔（秒）
        <input
          name="deviceSeconds"
          type="number"
          min={device.mode === "real" ? 2 : 0}
          max={86400}
          step="0.001"
          required
          defaultValue={availability.deviceIntervalMs / 1000}
        />
      </label>
      <div className="form-grid">
        {availability.apps.map((app) => (
          <label key={app.appId}>
            {appName(app.appId)}冷却（秒）
            <input
              name={app.appId}
              type="number"
              min={0}
              max={86400}
              step="0.001"
              required
              defaultValue={app.cooldownMs / 1000}
            />
            <span className="small muted app-account">
              账号资源：{app.accountKey}
            </span>
          </label>
        ))}
      </div>
      <p className="notice">
        0 表示不额外限制该
        App。缩短策略不会提前结束已记录的冷却；重启、暂停和切换 App
        也不会清零。间隔应按实际业务设置，不能保证账号免受平台风控。
      </p>
      <button className="primary" disabled={busy}>
        保存冷却策略
      </button>
    </form>
  );
}
