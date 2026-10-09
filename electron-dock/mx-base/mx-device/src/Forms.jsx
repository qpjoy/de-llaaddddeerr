import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { requestId } from "./request-id.mjs";
export function Modal({ title, children, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="dialog-title"
    >
      <div className="modal-head">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={22} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function DeviceForm({ mode, workers, onSubmit, busy }) {
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
              ADB 序列号（可暂不填写）
              <input name="serial" placeholder="仅登记，不调用 ADB" />
            </label>
            <label className="span-two">
              宿主机服务入口
              <input
                type="url"
                name="origin"
                defaultValue="http://127.0.0.1:18081"
                required
              />
            </label>
          </>
        )}
      </div>
      {mode === "real" && (
        <>
          <p className="notice">
            该地址由所选执行器所在宿主机访问，不是浏览器或 Hub 的
            localhost。当前服务器已有映射为 127.0.0.1:18081 →
            mobile-agent:18082，填写宿主机的 18081，不改
            Docker/ADB。兼容端口范围 18081–18180；物理身份需人工核验。
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
            <select name="pages" defaultValue="1">
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
            placeholder="https://www.xiaohongshu.com/explore/…?xsec_token=…"
          />
        </label>
      </div>
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
            name="deviceId"
            required={mode === "real"}
            defaultValue={mode === "real" ? selectedDeviceId : ""}
          >
            {mode === "sim" && <option value="">任意可用模拟设备</option>}
            {devices
              .filter((d) => d.enabled && d.state !== "quarantined")
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
