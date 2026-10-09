import { DeviceMobile, ArrowCounterClockwise } from "@phosphor-icons/react";
import { time } from "./data.js";
import { DeviceControls } from "./Devices.jsx";
import { useState } from "react";
import { LiveScreen, ControlSession } from "./PhoneConsole.jsx";
export default function Projection({
  device,
  history,
  onLive,
  onConfigure,
  onRefresh,
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
          <div className="phone">
            <div className="notch" />
            <div className="phone-content">
              <h3>{device?.name || "未选择设备"}</h3>
              {p ? (
                <>
                  <p className="phone-caption">
                    {p.source === "sim" ? "模拟结果" : "接口返回"} ·{" "}
                    {time(p.observedAt)}
                  </p>
                  <h4>{p.detail ? "笔记详情" : p.keyword || "当前状态"}</h4>
                  <p className="phone-status">
                    {p.status}
                    {p.isBusy === true ? " · 忙碌" : ""}
                  </p>
                  {p.page && (
                    <div className="page-marker">
                      {p.source === "sim" ? "模拟" : "接口报告"}第 {p.page} 页 ·{" "}
                      {p.count ?? 0} 条
                    </div>
                  )}
                  {p.detail ? (
                    <article className="phone-note">
                      <strong>{p.detail.title}</strong>
                      <p>{p.detail.content}</p>
                    </article>
                  ) : (
                    <div className="phone-results">
                      {(p.items || []).map((item, i) => (
                        <article key={`${item.id}-${i}`}>
                          <span>{String(i + 1).padStart(2, "0")}</span>
                          <div>
                            <strong>{item.title || item.id}</strong>
                            <small>{item.authorName || "作者未返回"}</small>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                  {!p.items?.length && !p.detail && (
                    <p className="muted">尚无列表结果</p>
                  )}
                </>
              ) : (
                <div className="phone-empty">
                  <DeviceMobile size={77} weight="light" />
                  <h4>等待任务</h4>
                  <p>尚无已确认结果</p>
                </div>
              )}
            </div>
          </div>
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
      {device && (
        <ControlSession key={device.id} device={device} onRefresh={onRefresh} />
      )}
    </aside>
  );
}
