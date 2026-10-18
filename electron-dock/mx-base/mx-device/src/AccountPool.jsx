import { useCallback, useEffect, useState } from "react";
import { api, appName, time } from "./data.js";
import { Modal } from "./Forms.jsx";

const STATUS = {
  active: ["正常", "succeeded"],
  limited: ["受限", "unknown"],
  review: ["待复核", "unknown"],
  retired: ["已停用", "blocked"],
};
const REST = {
  minGap: "账号间隔",
  windowRest: "窗口预算休息",
  signalBackoff: "风控退避",
};
const left = (until) => {
  const s = Math.ceil((until - Date.now()) / 1000);
  return s >= 120 ? `${Math.ceil(s / 60)} 分钟` : `${s} 秒`;
};

// Account pool: one row per platform account; status and budgets are hard
// pacing constraints. Restricting is immediate; restoring needs confirmation.
export default function AccountPool({ mode, busy, run }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("all"),
    [action, setAction] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api("accounts", mode));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [mode]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  const accounts = data?.accounts || [];
  const counts = Object.fromEntries(
    Object.keys(STATUS).map((s) => [
      s,
      accounts.filter((a) => a.status === s).length,
    ]),
  );
  const rows =
    filter === "all" ? accounts : accounts.filter((a) => a.status === filter);
  const submit = async (path, body, message) => {
    const ok = await run(() => api(path, mode, body), message);
    if (ok) setAction(null);
    await load();
  };
  return (
    <section className="panel account-pool">
      <div className="section-head">
        <div>
          <h2>账号池</h2>
          <p className="muted">
            每个 App 账号是独立的节奏作用域：状态、间隔、窗口预算与 24
            小时上限跟随账号，不随设备重置。平台信号会转人工复核并退避，不自动换号。
          </p>
        </div>
        <div className="button-row">
          {[["all", `全部 ${accounts.length}`]]
            .concat(
              Object.entries(STATUS).map(([s, [label]]) => [
                s,
                `${label} ${counts[s] || 0}`,
              ]),
            )
            .map(([key, label]) => (
              <button
                key={key}
                className={filter === key ? "primary" : ""}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
        </div>
      </div>
      {error && <p className="notice">{error}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>账号</th>
              <th>状态</th>
              <th>绑定设备</th>
              <th>24 小时</th>
              <th>在途</th>
              <th>冷却 / 退避</th>
              <th>最近信号</th>
              <th>累计</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr>
                <td colSpan={9} className="muted">
                  {data ? "没有符合条件的账号" : "读取中…"}
                </td>
              </tr>
            ) : (
              rows.map((a) => {
                const signal = a.signals?.at(-1);
                return (
                  <tr key={a.id}>
                    <td>
                      <strong>{appName(a.appId)}</strong>
                      <div className="muted" title={a.accountKey}>
                        {a.accountKey.length > 18
                          ? `${a.accountKey.slice(0, 8)}…${a.accountKey.slice(-6)}`
                          : a.accountKey}
                      </div>
                    </td>
                    <td>
                      <span className={`status ${STATUS[a.status][1]}`}>
                        {STATUS[a.status][0]}
                      </span>
                      {a.statusReason && (
                        <div className="muted">{a.statusReason}</div>
                      )}
                    </td>
                    <td>
                      {a.boundDeviceName || "未绑定"}
                      {a.rack && <div className="muted">{a.rack}</div>}
                    </td>
                    <td>
                      {a.daily}
                      {a.policy?.dailyCap ? ` / ${a.policy.dailyCap}` : ""}
                    </td>
                    <td>{a.inFlight}</td>
                    <td>
                      {a.cooldownUntil > Date.now()
                        ? `${REST[a.restReason] || "冷却"}约 ${left(a.cooldownUntil)}`
                        : "—"}
                    </td>
                    <td>
                      {signal ? (
                        <>
                          {data.signals[signal.kind]}
                          <div className="muted">{time(signal.at)}</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {a.totals?.sessions || 0} 次
                      <div className="muted">
                        {Math.round((a.totals?.serviceMs || 0) / 1000)} 秒
                      </div>
                    </td>
                    <td>
                      {a.status !== "retired" && (
                        <div className="button-row">
                          {a.status === "active" ? (
                            <>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  setAction({ account: a, status: "limited" })
                                }
                              >
                                标记受限
                              </button>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  setAction({ account: a, signal: true })
                                }
                              >
                                报告信号
                              </button>
                            </>
                          ) : (
                            <button
                              disabled={busy}
                              onClick={() =>
                                setAction({ account: a, status: "active" })
                              }
                            >
                              恢复正常
                            </button>
                          )}
                          <button
                            disabled={busy}
                            onClick={() =>
                              setAction({ account: a, status: "retired" })
                            }
                          >
                            停用
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {action && (
        <Modal
          title={
            action.signal
              ? "报告平台信号"
              : action.status === "active"
                ? "恢复账号"
                : action.status === "retired"
                  ? "停用账号"
                  : "标记账号受限"
          }
          onClose={() => setAction(null)}
        >
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (action.signal)
                void submit(
                  "account-signal",
                  {
                    id: action.account.id,
                    kind: f.get("kind"),
                    detail: f.get("reason"),
                  },
                  "已记录平台信号：账号转人工复核并退避",
                );
              else
                void submit(
                  "account-status",
                  {
                    id: action.account.id,
                    status: action.status,
                    reason: f.get("reason"),
                    revision: action.account.revision,
                    confirmed: f.get("confirmed") === "on",
                  },
                  "账号状态已更新",
                );
            }}
          >
            <p className="muted">
              {appName(action.account.appId)} · {action.account.accountKey}
              {action.account.boundDeviceName
                ? ` · ${action.account.boundDeviceName}`
                : ""}
            </p>
            {action.signal && (
              <label>
                信号类型
                <select name="kind" defaultValue="captcha">
                  {Object.entries(data.signals).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {action.signal ? "说明（可选）" : "原因"}
              <input name="reason" required={!action.signal} maxLength={300} />
            </label>
            {action.status === "limited" && (
              <p className="muted">
                标记后该账号立即停止领取新任务；在途任务照常完成。恢复时需要确认。
              </p>
            )}
            {action.status === "retired" && (
              <p className="notice">
                停用不可撤销：该账号以后不能再恢复，绑定设备上的这个 App
                不再领取任务。
              </p>
            )}
            {action.status === "active" && (
              <label className="check">
                <input type="checkbox" name="confirmed" required />
                已在平台侧核实账号可正常使用；已生成的退避截止时间不会缩短
              </label>
            )}
            <button className="primary" type="submit" disabled={busy}>
              确认
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
