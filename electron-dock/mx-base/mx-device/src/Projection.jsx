import { DeviceMobile, ArrowCounterClockwise } from "@phosphor-icons/react";
import { time } from "./data.js";
import { DeviceControls } from "./Devices.jsx";
export default function Projection({ device, history, onLive, ...controls }) {
  const p = history?.projection || device?.projection;
  return (
    <aside className="panel projection">
      <h2>手机状态投影</h2>
      <p className="muted small">
        非实时屏幕{history ? ` · 历史 ${time(history.at)}` : ""}
      </p>
      {history && (
        <button className="text-button replay" onClick={onLive}>
          <ArrowCounterClockwise size={16} />
          返回最新记录
        </button>
      )}
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
                  已确认第 {p.page} 页 · {p.count ?? 0} 条
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
      <DeviceControls device={device} {...controls} />
    </aside>
  );
}
