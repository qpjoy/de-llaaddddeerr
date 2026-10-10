import { DeviceMobile, House, CheckCircle } from "@phosphor-icons/react";
import { appName, time } from "./data.js";

export default function PhoneProjection({
  device,
  projection: p = device?.projection,
}) {
  const simulated = device?.mode === "sim";
  const launcher = p?.commandCode === "session.home";
  const opened = ["app.open", "session.back", "session.restore"].includes(
    p?.commandCode,
  );
  const liked = p?.commandCode === "weibo.like";
  return (
    <div
      className={`phone ${simulated ? "simulated-phone" : ""}`}
      aria-label={simulated ? "模拟手机投影" : "接口结果投影"}
    >
      <div className="notch" />
      <div className="phone-content">
        <div className="projection-source">
          {simulated ? "合成投影 · 非真实截图" : "接口结果 · 非实时屏幕"}
        </div>
        <h3>{device?.name || "未选择设备"}</h3>
        {p ? (
          <>
            <p className="phone-caption">
              {appName(p.appId)} · 最近确认 {time(p.observedAt)}
            </p>
            <h4>
              {launcher
                ? "模拟桌面"
                : p.detail
                  ? "正文详情"
                  : opened
                    ? appName(p.appId)
                    : p.keyword || "当前状态"}
            </h4>
            <p className="phone-status">
              {p.status}
              {p.isBusy === true ? " · 忙碌" : ""}
            </p>
            {p.page ? (
              <div className="page-marker">
                {simulated ? "模拟" : "接口报告"}第 {p.page} 页 · {p.count ?? 0}{" "}
                条
              </div>
            ) : null}
            {launcher ? (
              <div className="phone-action-result">
                <House size={46} />
                <strong>已确认回到起点</strong>
                <p>等待下一条调度指令</p>
              </div>
            ) : liked ? (
              <div className="phone-action-result">
                <CheckCircle size={46} />
                <strong>模拟点赞已确认</strong>
                <p>这是合成回执，没有真实点赞。</p>
              </div>
            ) : opened ? (
              <div className="phone-action-result">
                <DeviceMobile size={46} />
                <strong>
                  {p.commandCode === "session.restore"
                    ? "大任务上下文已恢复"
                    : "应用上下文已确认"}
                </strong>
                <p>后续列表、正文和页码会随已确认回执更新。</p>
              </div>
            ) : p.detail ? (
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
                      <small>
                        {item.authorName ||
                          (simulated ? "模拟内容" : "作者未返回")}
                      </small>
                    </div>
                  </article>
                ))}
                {!p.items?.length && <p className="muted">尚无列表结果</p>}
              </div>
            )}
          </>
        ) : (
          <div className="phone-empty">
            <DeviceMobile size={68} weight="light" />
            <h4>等待任务</h4>
            <p>尚无已确认结果</p>
          </div>
        )}
      </div>
    </div>
  );
}
