import { useEffect, useState } from "react";
import { DeviceMobile, Camera, Eye, StopCircle } from "@phosphor-icons/react";
import { api, time } from "./data.js";
import { Modal } from "./Forms.jsx";

export function LiveScreen({ device, onConfigure }) {
  const [watching, setWatching] = useState(false),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [tick, setTick] = useState(Date.now()),
    [expanded, setExpanded] = useState(false);
  const id = device.id,
    version = device.observer?.version;
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!watching || !version) return;
    let alive = true,
      timer;
    const controller = new AbortController();
    const next = async () => {
      if (!document.hidden) {
        try {
          await api(`devices/${id}/capture`, "real", {}, controller.signal);
          if (alive) setError("");
        } catch (e) {
          if (alive) {
            setError(e.message);
            setWatching(false);
          }
          return;
        }
      }
      if (alive) timer = setTimeout(next, 2200);
    };
    void next();
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [watching, id, version]);
  const frame = device.frame,
    age = frame
      ? Math.max(0, Math.floor((tick - frame.receivedAt) / 1000))
      : null;
  const stale = age === null || age > 10 || device.capture?.status === "failed";
  const imageUrl =
    frame && `/api/devices/${id}/frame?mode=real&captureId=${frame.id}`;
  return (
    <section className="live-screen" aria-label="真实手机画面">
      <p className="small muted">
        {device.serial || "尚未指定手机"} · 低帧率真机镜像 · 只读
      </p>
      <div className={`real-phone ${stale ? "stale" : ""}`}>
        {frame ? (
          <img
            key={imageUrl}
            src={imageUrl}
            alt={`${device.name} 的真实截图（${time(frame.receivedAt)}收到）`}
            onError={() => setError("图片读取失败或已更新，请重新取帧")}
          />
        ) : (
          <div className="screen-placeholder">
            <DeviceMobile size={64} weight="light" />
            <strong>等待真实画面</strong>
            <span>点击开始观看，不会点击手机</span>
          </div>
        )}
      </div>
      <p
        className={`frame-status small ${stale ? "warning" : ""}`}
        role="status"
      >
        {frame
          ? `最近收到 ${time(frame.receivedAt)} · ${age} 秒前${stale ? " · 旧画面，不代表当前状态" : " · 非实时"}`
          : "尚无截图；接口投影不能代表当前屏幕"}
        {device.capture &&
          ["queued", "running"].includes(device.capture.status) && (
            <>
              <br />
              {device.capture.expiresAt < tick
                ? "等待执行器超时，请检查心跳"
                : "截图请求处理中"}
            </>
          )}
      </p>
      {(error || device.capture?.error) && (
        <p className="small error" role="alert">
          {error || device.capture.error}
        </p>
      )}
      <div className="button-row">
        <button disabled={!version} onClick={() => setWatching((x) => !x)}>
          {watching ? <StopCircle size={17} /> : <Eye size={17} />}
          {watching ? "停止观看" : "开始观看"}
        </button>
        <button
          disabled={!version || pending || watching}
          onClick={async () => {
            setPending(true);
            setError("");
            try {
              await api(`devices/${id}/capture`, "real", {});
            } catch (e) {
              setError(e.message);
            } finally {
              setPending(false);
            }
          }}
        >
          <Camera size={17} />
          单次截图
        </button>
        {frame && <button onClick={() => setExpanded(true)}>放大画面</button>}
        <button className="text-button" onClick={onConfigure}>
          配置画面连接
        </button>
      </div>
      <p className="small muted">
        离开此页或切换设备后停止观看。已派发的一次截图可能继续完成；不会开启录屏或改变
        VPN。
      </p>
      {expanded && (
        <Modal title="放大真实画面" onClose={() => setExpanded(false)}>
          <div className="screen-large">
            <p>
              {device.name} · {time(frame.receivedAt)} 收到 · 只读截图
            </p>
            <img src={imageUrl} alt="放大的真实手机截图" />
          </div>
        </Modal>
      )}
    </section>
  );
}

export function ControlSession({ device, onRefresh }) {
  const [token, setToken] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const id = device.id,
    mode = device.mode;
  const session = device.session,
    active = ["held", "waiting"].includes(session?.status);
  const ownsSession = active && token?.id === session?.id;
  useEffect(() => {
    if (!ownsSession) return;
    let alive = true,
      running = false;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        await api(
          `devices/${id}/session`,
          mode,
          { action: "renew", token: token.value },
          controller.signal,
        );
      } catch (e) {
        if (alive) {
          setError(e.message);
          setToken(null);
        }
      } finally {
        running = false;
      }
    }, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [id, mode, token, ownsSession]);
  async function act(action) {
    if (
      ["acquire", "takeover"].includes(action) &&
      !confirm(
        mode === "real"
          ? "仅预留本中心执行槽，不会阻止旧页面、脚本或 PoC 操作手机；本轮不提供真实点击。继续？"
          : action === "takeover"
            ? "仅模拟：撤销旧会话并中断当前模拟尝试，任务保留。继续？"
            : "等待当前模拟任务完成，暂停后续领取并取得模拟会话？",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const r = await api(`devices/${id}/session`, mode, {
        action,
        token: token?.value,
        revision: device.revision,
        confirmed: true,
      });
      if (r.token) setToken({ value: r.token, id: r.device.session.id });
      if (action === "release") setToken(null);
      await onRefresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="control-session" aria-label="控制会话">
      <h3>{mode === "real" ? "本中心会话预留" : "模拟控制会话"}</h3>
      <p className="small" role="status">
        {{
          waiting: "等待当前任务收尾，不抢占",
          held: ownsSession ? "本窗口已预留执行槽" : "已被其他会话预留",
          released: "已释放 · 仍暂停领取",
          expired: "会话过期 · 仍暂停领取",
          blocked: "执行结果不明 · 禁止接管",
        }[session?.status] || "未预留"}
      </p>
      {mode === "real" && (
        <p className="notice small">
          外部控制入口未隔离。本中心预留 ≠
          物理独占；真实点击、复位和强制接管未开放。
        </p>
      )}
      <div className="button-row">
        <button
          disabled={busy || active || device.state === "quarantined"}
          onClick={() => act("acquire")}
        >
          {mode === "real" ? "预留执行槽" : "申请模拟接管"}
        </button>
        <button disabled={busy || !ownsSession} onClick={() => act("release")}>
          解除本窗口控制
        </button>
        <button
          disabled={busy || mode === "real"}
          onClick={() => act("takeover")}
        >
          {mode === "real" ? "强制接管未开放" : "模拟强制接管"}
        </button>
        {mode === "sim" && (
          <button
            disabled={busy || !ownsSession || session?.status !== "held"}
            onClick={() => act("reset")}
          >
            模拟复位
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="small error">
          {error}
        </p>
      )}
      <p className="small muted">
        离开后不再续期，60 秒内过期；不会自动恢复领取或清空任务池。
      </p>
    </section>
  );
}
