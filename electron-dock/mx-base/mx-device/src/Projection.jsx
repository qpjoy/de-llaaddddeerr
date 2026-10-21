import PhoneProjection from "./PhoneProjection.jsx";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { AppPacing } from "./AppPacing.jsx";
import { time } from "./data.js";
import { DeviceControls } from "./Devices.jsx";
import { useState } from "react";
import { LiveScreen, ControlSession } from "./PhoneConsole.jsx";
import MobileStatus from "./MobileStatus.jsx";
export default function Projection({
  device,
  history,
  onLive,
  onConfigure,
  onRefresh,
  availability,
  now,
  onPacing,
  lease,
  live: row,
  ...controls
}) {
  const [tab, setTab] = useState("screen");
  const p = history?.projection || device?.projection;
  const live = device?.mode === "real" && tab === "screen" && !history;
  return (
    <aside className="panel projection console-projection">
      <h2>{device?.mode === "real" ? "手机工作台" : "模拟手机工作台"}</h2>
      <p className="muted small">
        {live ? "真实画面与接口投影独立，不以 busy 推断屏幕" : "非实时屏幕"}
        {history ? ` · 历史 ${time(history.at)}` : ""}
      </p>
      {device?.mode === "real" && (
        <div className="screen-tabs" aria-label="画面类型">
          <button
            aria-pressed={live}
            onClick={() => {
              setTab("screen");
              onLive();
            }}
          >
            真实画面
          </button>
          <button aria-pressed={!live} onClick={() => setTab("projection")}>
            接口投影
          </button>
        </div>
      )}
      {history && (
        <button className="text-button replay" onClick={onLive}>
          <ArrowCounterClockwise size={16} />
          返回最新记录
        </button>
      )}
      {live ? (
        <LiveScreen
          key={`${device.id}:${device.observer?.version}`}
          device={device}
          onConfigure={onConfigure}
        />
      ) : (
        <>
          <PhoneProjection
            device={device}
            projection={p}
            live={row}
            history={!!history}
            now={now}
          />
          <p className="projection-foot">
            连接状态不等于开机状态
            {p?.progressAt && (
              <>
                <br />
                最近内容变化 {time(p.progressAt)}
              </>
            )}
          </p>
        </>
      )}
      <DeviceControls device={device} {...controls} />
      {device && <LeaseInfo device={device} now={now} {...lease} />}
      {device && (
        <AppPacing
          device={device}
          availability={availability}
          now={now}
          busy={controls.busy}
          onConfigure={onPacing}
        />
      )}
      {device?.mode === "real" && (
        <MobileStatus device={device} onRefresh={onRefresh} />
      )}
      {device && (
        <ControlSession key={device.id} device={device} onRefresh={onRefresh} />
      )}
    </aside>
  );
}
const left = (ms) => (ms > 0 ? `${Math.ceil(ms / 1000)} 秒` : "已到期");
/** Who executes this device and under which lease (token, seq, deadline). */
function LeaseInfo({ device, attempt, agent, now }) {
  return (
    <section className="lease-info" aria-label="执行与租约">
      <strong>执行与租约</strong>
      <dl>
        <dt>执行方</dt>
        <dd>
          {device.agentId
            ? `宿主机 Agent「${agent?.name || "未知"}」${agent ? (agent.online ? " · 在线" : " · 离线") : ""}`
            : device.mode === "sim"
              ? "中心进程（模拟执行器）"
              : `宿主机 Worker ${device.workerId}`}
        </dd>
        {agent && (
          <>
            <dt>Agent 心跳</dt>
            <dd>
              {agent.lastSeenAt ? time(agent.lastSeenAt) : "从未连接"}
              {agent.clockOffsetMs != null
                ? ` · 时钟偏差 ${agent.clockOffsetMs} 毫秒`
                : ""}
              {agent.buffered ? ` · 缓冲 ${agent.buffered} 条` : ""}
            </dd>
          </>
        )}
        {device.agentId && (
          <>
            <dt>设备令牌</dt>
            <dd>{device.leaseToken || 0}</dd>
          </>
        )}
        <dt>当前租约</dt>
        <dd>
          {!attempt
            ? "无"
            : attempt.status === "yielded"
              ? "大任务停在检查点，未持有租约"
              : [
                  attempt.executor === "agent"
                    ? `token ${attempt.token} · seq ${attempt.seq || 0} · ${attempt.agentState === "granted" ? "待确认" : "已确认"}`
                    : "中心执行",
                  `剩余 ${left(attempt.leaseUntil - now)}`,
                ].join(" · ")}
        </dd>
      </dl>
    </section>
  );
}
