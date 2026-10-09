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
          物理身份未自动核验 · 开机、登录状态未知。
          {d.probe?.projection?.isBusy === true
            ? "手机报告忙碌，不能启用。"
            : ""}
        </p>
      )}
      <div className="button-row">
        {d.mode === "real" && (
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
            disabled={busy || (!d.enabled && d.state === "running")}
            onClick={() => onControl(d, d.enabled ? "pause" : "enable")}
          >
            {d.enabled ? "暂停领取" : "启用调度"}
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
export function Connections({ state, onAdd }) {
  return (
    <section className="panel settings">
      <div className="section-head">
        <h2>连接设置</h2>
        <button className="primary" onClick={onAdd}>
          添加设备
        </button>
      </div>
      <div className="panel-body">
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
          当前适配器使用执行器宿主机的回环地址，只调用状态、搜索、翻页与详情四个接口。序列号可以后补核验，不能凭接口可达声称手机已开机或登录。
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
