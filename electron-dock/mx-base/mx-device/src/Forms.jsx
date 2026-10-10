import { useEffect, useRef, useState, useId } from "react";
import { X } from "@phosphor-icons/react";
import { defaultDurationMs } from "./data.js";
import { requestId } from "./request-id.mjs";
export function Modal({ title, children, onClose, className }) {
  const titleId = useId();
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby={titleId}
    >
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={22} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function DeviceForm({ mode, workers, onSubmit, busy }) {
  const [adapter, setAdapter] = useState("mobile-agent");
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const b = Object.fromEntries(new FormData(e.currentTarget));
        onSubmit({ ...b, approved: b.approved === "on" });
      }}
    >
      <p className="muted">
        {mode === "sim"
          ? "添加合成设备，不会连接手机。"
          : "保存为暂停状态。先登记接口，再显式检查；不会自动抢占现有手机。"}
      </p>
      <div className="form-grid">
        {mode === "real" && (
          <label className="span-two">
            接入方式
            <select
              name="adapter"
              value={adapter}
              onChange={(e) => setAdapter(e.target.value)}
            >
              <option value="mobile-agent">
                Mobile-Agent · 真实画面 / 多设备观察
              </option>
              <option value="legacy-poc">
                旧 PoC · 搜索 / 详情（需确认空闲）
              </option>
            </select>
          </label>
        )}
        <label>
          设备名称
          <input
            name="name"
            required
            maxLength={80}
            defaultValue={mode === "real" ? "外设手机 01" : ""}
            placeholder={mode === "real" ? "外设手机 01" : "模拟手机 C"}
          />
        </label>
        <label>
          机架
          <input
            name="rack"
            defaultValue={mode === "real" ? "机架 01" : "演示机架"}
            required
          />
        </label>
        <label>
          宿主机标识
          <input
            name="host"
            defaultValue={mode === "real" ? "mx-internal-server" : "模拟宿主机"}
            required
          />
        </label>
        {mode === "real" && (
          <>
            <label>
              执行器标识
              <input
                name="workerId"
                list="workers"
                defaultValue={workers[0]?.id || "mx-internal-server-worker"}
                required
              />
              <datalist id="workers">
                {workers.map((w) => (
                  <option key={w.id} value={w.id} />
                ))}
              </datalist>
            </label>
            <label>
              账号资源标识
              <input
                name="accountKey"
                defaultValue="xhs-account-01"
                placeholder="xhs-account-01（不是密码）"
                required
              />
            </label>
            <label>
              ADB 序列号
              {adapter === "mobile-agent" ? "（必填）" : "（可暂不填写）"}
              <input
                name="serial"
                required={adapter === "mobile-agent"}
                placeholder="例如 8ad5ef10；每台手机唯一"
              />
            </label>
            <label className="span-two">
              宿主机服务入口
              <input
                type="url"
                name="origin"
                key={adapter}
                defaultValue={
                  adapter === "mobile-agent"
                    ? "http://127.0.0.1:8787"
                    : "http://127.0.0.1:18081"
                }
                required
              />
            </label>
          </>
        )}
      </div>
      {mode === "real" && (
        <>
          <p className="notice">
            {adapter === "mobile-agent"
              ? "同一宿主机的多台手机共用 8787，以 ADB 序列号区分，不需要每台新增端口。此适配器仅观察，不执行点击或采集。已有 PoC 设备请在原设备上配置画面，勿重复登记。"
              : "旧 PoC 使用宿主机 18081–18180，只支持独立入口，不会根据序列号切换手机。"}
            地址由所选执行器访问，不是浏览器的 localhost；不修改 Docker/ADB。
          </p>
          <label className="check">
            <input type="checkbox" name="approved" required />
            批准连接这个本机入口；不迁移、不重启现有 mobile-agent。
          </label>
        </>
      )}
      <div className="form-actions">
        <button className="primary" disabled={busy}>
          {mode === "real" ? "保存为暂停状态" : "添加模拟设备"}
        </button>
      </div>
    </form>
  );
}
export function ObserverForm({ device, busy, onSubmit }) {
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const b = Object.fromEntries(new FormData(e.currentTarget));
        onSubmit({
          ...b,
          approved: b.approved === "on",
          revision: device.revision,
        });
      }}
    >
      <p>
        给「{device.name}」附加只读画面，不替换原 PoC 接口、不改变其 busy
        或任务。
      </p>
      <label>
        Mobile-Agent 服务地址
        <input
          name="origin"
          type="url"
          required
          defaultValue={device.observer?.origin || "http://127.0.0.1:8787"}
        />
      </label>
      <label>
        ADB 序列号
        <input
          name="serial"
          required
          defaultValue={device.serial || ""}
          readOnly={!!device.serial}
          placeholder="例如 8ad5ef10"
        />
      </label>
      <p className="notice">
        允许执行器本机
        8787–8797。同一服务可连接多台手机，必须明确指定序列号。保存不会连接手机。
      </p>
      <label className="check">
        <input name="approved" type="checkbox" required />
        批准该只读目标；不修改 mobile-agent、VPN 或手机应用。
      </label>
      <button className="primary" disabled={busy}>
        保存画面连接
      </button>
    </form>
  );
}
export function JobForm({
  mode,
  devices,
  selectedDeviceId,
  demo = false,
  onSubmit,
  busy,
}) {
  const ref = useRef(null);
  const requestKey = useRef(null);
  const [keyError, setKeyError] = useState("");
  const [appId, setAppId] = useState("xhs");
  const [operation, setOperation] = useState("search");
  const [pages, setPages] = useState(1);
  const [rack, setRack] = useState(""),
    [host, setHost] = useState("");
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const b = Object.fromEntries(new FormData(e.currentTarget));
        try {
          requestKey.current ??= requestId();
          setKeyError("");
        } catch (error) {
          setKeyError(error.message);
          return;
        }
        onSubmit({
          ...b,
          key: requestKey.current,
          ...(b.estimatedSeconds
            ? {
                estimatedDurationMs: Math.round(
                  Number(b.estimatedSeconds) * 1000,
                ),
              }
            : {}),
          confirmed: b.confirmed === "on",
          followup: demo,
        });
      }}
    >
      <p className="muted">
        {demo
          ? "本次将提交两个真实任务：一页搜索 → 使用搜索首条笔记的 detailInput 抓取详情。详情沿用同一设备和账号，保留完整访问令牌；搜索失败或首条链接不可用时不会调用详情接口。"
          : "搜索会话最多三页，执行中不抢占。详情任务请粘贴已有搜索结果中的完整链接。"}
      </p>
      {mode === "sim" ? (
        <label>
          任务 App
          <select
            name="appId"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
          >
            <option value="xhs">小红书 · 模拟</option>
            <option value="weibo">微博 · 模拟</option>
          </select>
        </label>
      ) : (
        <p className="small muted">当前真实执行适配器仅支持小红书。</p>
      )}
      {demo ? (
        <input type="hidden" name="operation" value="search" />
      ) : (
        <label>
          任务类型
          <select
            name="operation"
            defaultValue="search"
            onChange={(e) => {
              ref.current.dataset.operation = e.target.value;
              setOperation(e.target.value);
            }}
          >
            <option value="search">搜索</option>
            <option value="note">列表中的笔记详情</option>
          </select>
        </label>
      )}
      <div ref={ref} data-operation="search" className="operation-fields">
        <div className="search-fields form-grid">
          <label>
            关键词
            <input name="keyword" defaultValue="美食" maxLength={200} />
          </label>
          <label>
            最多页数
            <select
              name="pages"
              value={pages}
              onChange={(e) => setPages(Number(e.target.value))}
            >
              <option value="1">1 页</option>
              {!demo && <option value="2">2 页</option>}
              {!demo && <option value="3">3 页</option>}
            </select>
          </label>
        </div>
        <label className="note-fields">
          详情链接
          <input
            name="input"
            placeholder={
              appId === "weibo"
                ? "https://weibo.com/1000000000/demo11"
                : "https://www.xiaohongshu.com/explore/…?xsec_token=…"
            }
          />
        </label>
      </div>
      {!demo && (
        <label>
          预计执行耗时（秒，可选）
          <input
            name="estimatedSeconds"
            type="number"
            min="1"
            max="180"
            step="0.001"
            placeholder={`默认 ${defaultDurationMs(operation, pages) / 1000} 秒`}
          />
          <span className="small muted">
            用于同优先级短任务排序，不是超时设置。会话执行中不抢占；等待满 30
            秒后，同有效优先级按入池顺序。
          </span>
        </label>
      )}
      {mode === "sim" && (
        <div className="form-grid">
          <label>
            调度机架
            <select
              name="rack"
              value={rack}
              onChange={(e) => {
                setRack(e.target.value);
                setHost("");
              }}
            >
              <option value="">任意机架</option>
              {[...new Set(devices.map((d) => d.rack))].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label>
            调度宿主机
            <select
              name="host"
              value={host}
              disabled={!rack}
              onChange={(e) => setHost(e.target.value)}
            >
              <option value="">任意宿主机</option>
              {[
                ...new Set(
                  devices.filter((d) => d.rack === rack).map((d) => d.host),
                ),
              ].map((h) => (
                <option key={h}>{h}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="form-grid">
        <label>
          调度优先级
          <select name="priority" defaultValue="5">
            <option value="1">1 · 高</option>
            <option value="5">5 · 普通</option>
            <option value="8">8 · 后台</option>
          </select>
        </label>
        <label>
          设备
          <select
            key={`${rack}:${host}`}
            name="deviceId"
            required={mode === "real"}
            defaultValue={mode === "real" ? selectedDeviceId : ""}
          >
            {mode === "sim" && <option value="">任意可用模拟设备</option>}
            {devices
              .filter(
                (d) =>
                  d.enabled &&
                  d.state !== "quarantined" &&
                  (!rack || d.rack === rack) &&
                  (!host || d.host === host),
              )
              .map((d) => (
                <option value={d.id} key={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {mode === "real" && (
        <label className="check">
          <input type="checkbox" name="confirmed" required />
          {demo
            ? "确认让真实手机执行一次搜索和一次依赖详情，仅限授权范围；结果不明时不自动重试。"
            : "确认会让真实手机执行授权范围内的操作。结果不明时不自动重试。"}
        </label>
      )}
      {keyError && (
        <p role="alert" className="error">
          {keyError}
        </p>
      )}
      <div className="form-actions">
        <button className="primary" disabled={busy}>
          {demo
            ? "确认提交真机演示"
            : `提交${mode === "sim" ? "模拟" : "真实"}任务`}
        </button>
      </div>
    </form>
  );
}
