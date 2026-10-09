import { appName, time } from "./data.js";

export function AppPacing({ device, availability, now, busy, onConfigure }) {
  if (!availability?.apps.length) return null;
  const editable =
    !device.enabled &&
    device.state === "idle" &&
    !["waiting", "held"].includes(device.session?.status);
  return (
    <section className="app-pacing" aria-label={`${device.name} App 冷却`}>
      <div className="app-pacing-heading">
        <strong>App 独立冷却</strong>
        <button
          className="text-button"
          disabled={busy || !editable}
          title="暂停设备并等待执行/预留结束后可修改"
          onClick={() => onConfigure(device)}
        >
          冷却策略
        </button>
      </div>
      <p className="small muted">
        整机间隔 {availability.deviceIntervalMs / 1000} 秒 · 一个执行槽
      </p>
      {availability.apps.map((app) => {
        const remaining = Math.max(
          0,
          Math.ceil((app.cooldownUntil - now) / 1000),
        );
        return (
          <div className="app-pacing-row" key={app.appId}>
            <div className="app-pacing-heading">
              <strong>{appName(app.appId)}</strong>
              <span className={remaining ? "warning" : "muted"}>
                {app.active
                  ? "执行中"
                  : remaining
                    ? `冷却 ${remaining} 秒`
                    : app.blockers.length
                      ? "等待整机条件"
                      : "可领取"}
              </span>
            </div>
            <p className="small">
              任务后间隔 {app.cooldownMs / 1000} 秒 · 上次完成{" "}
              {time(app.lastFinishedAt)}
            </p>
            <p className="small muted">
              {app.active
                ? "完成后重算冷却"
                : app.nextAllowedAt > now
                  ? `最早通过冷却 ${time(app.nextAllowedAt)}`
                  : "冷却条件已满足"}{" "}
              · 上次派发 {time(app.lastDispatchedAt)}
            </p>
          </div>
        );
      })}
      <p className="small muted">
        暂停并等待执行结束后可设置。冷却到期仍需满足设备、机架和执行器条件。
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
