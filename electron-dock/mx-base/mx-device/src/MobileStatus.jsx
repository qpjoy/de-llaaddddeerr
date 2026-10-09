import { useState } from "react";
import { api, time } from "./data.js";

export default function MobileStatus({ device: d, onRefresh }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const report = d.mobileStatus,
    pending =
      ["queued", "running"].includes(d.inspection?.status) &&
      d.inspection.expiresAt > Date.now();
  async function act(path, body) {
    setBusy(true);
    setError("");
    try {
      await api(`devices/${d.id}/${path}`, "real", body);
      await onRefresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mobile-status" aria-label="Mobile-Agent 状态与通道">
      <h3>Mobile-Agent 状态</h3>
      <p className="small muted">
        读取已有设备记录与运行器报告，不扫描 USB、不刷新旧设备库、不调用 18081。
      </p>
      <button
        disabled={busy || !d.observer || pending}
        onClick={() => act("mobile-status", {})}
      >
        {pending ? "状态读取已排队…" : "读取 Mobile-Agent 状态"}
      </button>
      {d.inspection?.status === "failed" ||
      (d.inspection?.expiresAt < Date.now() &&
        pending === false &&
        ["queued", "running"].includes(d.inspection?.status)) ? (
        <p role="alert" className="small error">
          {d.inspection.error || "状态读取超时，请检查执行器心跳"}
        </p>
      ) : null}
      {report ? (
        <>
          <p className="small muted">
            本中心收到：{time(report.receivedAt)}
            {Date.now() - report.receivedAt > 30000
              ? " · 旧报告，请重新读取"
              : ""}
          </p>
          <dl className="mobile-facts">
            <div>
              <dt>上游连接记录</dt>
              <dd>
                {
                  {
                    online: "记录为在线",
                    offline: "记录为离线",
                    unknown: "未知",
                  }[report.connection]
                }
              </dd>
            </div>
            <div>
              <dt>机型 / 系统</dt>
              <dd>
                {report.model || "未知"} / {report.androidVersion || "未知"}
              </dd>
            </div>
            <div>
              <dt>电量 / 分辨率</dt>
              <dd>
                {report.battery || "未知"} / {report.resolution || "未知"}
              </dd>
            </div>
            <div>
              <dt>前台应用记录</dt>
              <dd>{report.currentApp || "未知"}</dd>
            </div>
            <div>
              <dt>原记录时间</dt>
              <dd>{report.lastSeenRaw || "未提供"}（上游原值）</dd>
            </div>
            <div>
              <dt>旧控制端占用</dt>
              <dd>
                {
                  {
                    "reported-busy": "报告有任务占用",
                    "not-reported": "未报告占用（不等于独占）",
                    unknown: "未知，不能判定空闲",
                  }[report.occupancy]
                }
                {report.taskId ? ` · 任务 ${report.taskId}` : ""}
              </dd>
            </div>
          </dl>
          {(report.deviceRecord !== "available" ||
            report.runnerReport !== "available") && (
            <p className="small warning">
              部分接口不可用或记录不匹配；未将失败解释为空闲。
            </p>
          )}
          {report.unassignedRunner && (
            <p className="small warning">
              发现未标明手机的运行器，不能排除其他控制端占用。
            </p>
          )}
        </>
      ) : (
        <p className="small muted">尚未读取；打开页面不会自动查询旧服务。</p>
      )}
      <p className="small muted">
        设备字段可能是旧缓存。此报告不能证明开机、解锁、独占或所有外部脚本已停止，不用于自动启用调度。
      </p>
      <h3>可选 PoC 数据通道</h3>
      {d.adapter === "mobile-agent" ? (
        <p className="small">
          未接入 PoC；仅依赖 Mobile-Agent 提供设备观察能力。
        </p>
      ) : (
        <>
          <p className="small">
            {d.pocDisabled
              ? "旧 PoC 调用已停用；画面与历史保留。"
              : "旧 PoC 仅用于兼容搜索 / 详情，不是设备中心启动依赖。"}
          </p>
          <button
            disabled={busy || d.enabled || d.state !== "idle"}
            onClick={() => {
              if (
                confirm(
                  d.pocDisabled
                    ? "恢复本中心旧 PoC 兼容通道，但保持暂停；启用前需重新检查空闲。继续？"
                    : "仅停用 mx-device 对旧 PoC 的检查与采集调用；不停止手机 PoC/VPN，不改变 mobile-agent。历史与画面保留。继续？",
                )
              )
                void act("poc-channel", {
                  enabled: !!d.pocDisabled,
                  confirmed: true,
                  revision: d.revision,
                });
            }}
          >
            {d.pocDisabled ? "恢复旧 PoC 通道" : "停用旧 PoC 通道"}
          </button>
          <p className="small muted">
            需先暂停并处理完待执行任务；恢复不会自动开始采集。
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="small error">
          {error}
        </p>
      )}
    </section>
  );
}
