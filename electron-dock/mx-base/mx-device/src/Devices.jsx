import {
  DeviceMobile,
  PlugsConnected,
  WarningCircle,
} from "@phosphor-icons/react";
import { labels, time } from "./data.js";
export function Devices({ devices, selected, onSelect }) {
  if (!devices.length)
    return (
      <div className="empty">
        <DeviceMobile size={32} />
        <p>尚未登记{selected?.mode === "sim" ? "模拟" : ""}设备</p>
        <span>添加设备后，可在这里选择与查看。</span>
      </div>
    );
  const groups = Object.groupBy(devices, (d) => `${d.rack} / ${d.host}`);
  return (
    <div className="device-groups">
      {Object.entries(groups).map(([name, list]) => (
        <section key={name}>
          <h3>{name}</h3>
          <div className="device-list">
            {list.map((d) => (
              <button
                key={d.id}
                className={`device-tile ${selected?.id === d.id ? "selected" : ""}`}
                aria-pressed={selected?.id === d.id}
                onClick={() => onSelect(d.id)}
              >
                <DeviceMobile size={41} weight="light" />
                <span>
                  <strong>{d.name}</strong>
                  <small className={d.state === "quarantined" ? "warning" : ""}>
                    <i
                      className={`dot ${d.connected === "offline" ? "off" : d.enabled ? "on" : "paused"}`}
                    />
                    {d.connected === "offline"
                      ? "模拟离线"
                      : d.state === "running"
                        ? "执行中"
                        : d.state === "quarantined"
                          ? "待核验"
                          : d.enabled
                            ? "空闲"
                            : "已暂停"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
export function DeviceControls({ device: d, onControl, onProbe, busy }) {
  if (!d) return null;
  return (
    <div className="device-controls">
      <dl>
        <div>
          <dt>连接</dt>
          <dd>
            {d.connected === "unknown"
              ? "未知"
              : d.mode === "sim" && d.connected === "online"
                ? "模拟在线"
                : labels[d.connected] || d.connected}
          </dd>
        </div>
        <div>
          <dt>执行槽</dt>
          <dd>
            {labels[d.state]} · {d.enabled ? "接收任务" : "停止领取"}
          </dd>
        </div>
        <div>
          <dt>最近检查</dt>
          <dd>{time(d.probe?.at)}</dd>
        </div>
      </dl>
      {d.mode === "real" && (
        <p className="small muted">
          物理身份及控制权未自动核验；截图不证明独占。
          {d.probe?.projection?.isBusy === true
            ? "手机报告忙碌，不能启用。"
            : ""}
        </p>
      )}
      <div className="button-row">
        {d.mode === "real" && d.adapter !== "mobile-agent" && (
          <button
            disabled={busy || d.state === "running"}
            onClick={() => onProbe(d)}
          >
            <PlugsConnected size={17} />
            检查连接（只读）
          </button>
        )}
        {d.state === "quarantined" ? (
          <button disabled={busy} onClick={() => onControl(d, "recover")}>
            <WarningCircle size={17} />
            人工核验恢复
          </button>
        ) : (
          <button
            disabled={
              busy ||
              d.adapter === "mobile-agent" ||
              ["waiting", "held"].includes(d.session?.status) ||
              (!d.enabled && d.state === "running")
            }
            onClick={() => onControl(d, d.enabled ? "pause" : "enable")}
          >
            {d.adapter === "mobile-agent"
              ? "仅观察 · 不派发任务"
              : d.enabled
                ? "暂停领取"
                : "启用调度"}
          </button>
        )}
        {d.mode === "sim" && (
          <button
            disabled={busy}
            onClick={() =>
              onControl(
                d,
                d.connected === "offline" ? "reconnect" : "disconnect",
              )
            }
          >
            {d.connected === "offline" ? "恢复模拟连接" : "模拟断线"}
          </button>
        )}
      </div>
      <p className="small muted">暂停只停止新领取，不中断当前操作，不关机。</p>
    </div>
  );
}
export function Connections({ state, onAdd, onConnectReal }) {
  return (
    <section className="panel settings">
      <div className="section-head">
        <h2>连接设置</h2>
        <button className="primary" onClick={onAdd}>
          添加设备
        </button>
      </div>
      <div className="panel-body">
        <h3>服务器现有 mobile-agent</h3>
        <p>
          真实画面使用 http://127.0.0.1:8787 + ADB
          序列号。同一宿主机可共用一个服务端口连接多台手机，不需要新增容器或端口。
          旧 PoC 搜索/详情仍使用 18081–18180
          的独立入口，不能把不同序列号填进同一个 PoC 入口当成不同手机。
          已有设备请在工作台「配置画面连接」补接截图，浏览器不会直接连接手机。
        </p>
        <button onClick={onConnectReal}>登记服务器真实手机</button>
        <h3>执行器</h3>
        <p className="muted">
          执行器心跳与手机可用性是两件事。页面刷新只读取本中心记录。
        </p>
        {!state.workers.length ? (
          <p className="notice">
            尚无执行器上线。登记与任务记录仍可使用；任务不会被派发。
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>标识</th>
                  <th>最近心跳</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {state.workers.map((w) => (
                  <tr key={w.id}>
                    <td>{w.id}</td>
                    <td>{time(w.at)}</td>
                    <td>
                      {Date.now() - w.at < 10000 ? "心跳正常" : "心跳过期"}
                      {w.lastError && ` · ${w.lastError}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>兼容接入边界</h3>
        <p>
          Mobile-Agent
          适配器只调用指定序列号的单帧截图，不启动视频、不执行动作或写旧配置。每台主机分配独立执行器标识；跨主机的
          127.0.0.1 由各自主机执行器解析。Worker 心跳正常不代表手机就绪。
        </p>
        <p>
          真机初次启用前，请先停止旧 Hub
          外设调度和其他调用方，等待在途任务结束。现有 mobile-agent 容器、18081
          映射、ADB 和手机应用均保持原样。
        </p>
        <p className="notice">
          没有重启、安装、任意命令、自动修复 busy
          或真机强制接管功能。下一阶段接入具备稳定设备身份与执行令牌校验的主机代理后，再提供安全跨机接管。
        </p>
      </div>
    </section>
  );
}
