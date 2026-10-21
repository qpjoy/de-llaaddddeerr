import { useState } from "react";
import { HardDrives, Plus } from "@phosphor-icons/react";
import { api, appName, time } from "./data.js";
import { Modal } from "./Forms.jsx";

const SIM_APPS = ["xhs", "weibo", "xianyu", "pdd"];

// Host Agents (V2-3): register an Agent, see its liveness and leases, and
// adopt the simulated devices it reports. Simulation realm only for now.
export default function AgentPanel({ state, busy, run }) {
  const [modal, setModal] = useState(null);
  const agents = state.agents || [];
  const submit = async (fn, message, keepOpen) => {
    const result = await run(fn, message);
    if (result && !keepOpen) setModal(null);
    return result;
  };
  return (
    <section className="panel agent-panel">
      <div className="section-head">
        <div>
          <h2>宿主机 Agent</h2>
          <p className="muted small">
            Agent
            主动连接设备中心，按租约执行本机设备；与中心失联时只完成手上的指令，在安全点停下。目前只接入模拟设备。
          </p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => setModal({ type: "create" })}
        >
          <Plus size={18} />
          登记 Agent
        </button>
      </div>
      {!agents.length ? (
        <p className="muted agent-empty">
          还没有登记 Agent。登记后把凭证写入 Agent 配置文件，运行{" "}
          <code>npm run agent:sim</code>。
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>状态</th>
                <th>最近心跳</th>
                <th>托管设备</th>
                <th>在途租约</th>
                <th>待登记</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.name}</strong>
                    <div className="muted">
                      {a.host}
                      {a.version ? ` · ${a.version}` : ""}
                      {a.driver === "poc" ? " · PoC 驱动（L0）" : ""}
                    </div>
                  </td>
                  <td>
                    <span
                      className={`status ${a.status !== "active" ? "blocked" : a.online ? "succeeded" : "unknown"}`}
                    >
                      {a.status !== "active"
                        ? "已停用"
                        : a.online
                          ? "在线"
                          : "离线"}
                    </span>
                    {a.buffered > 0 && (
                      <div className="muted">缓冲回执 {a.buffered} 条</div>
                    )}
                  </td>
                  <td>
                    {a.lastSeenAt ? time(a.lastSeenAt) : "从未连接"}
                    {a.clockOffsetMs != null && (
                      <div className="muted">
                        时钟偏差 {Math.round(a.clockOffsetMs)} 毫秒
                      </div>
                    )}
                  </td>
                  <td>
                    {a.devices.length} 台
                    {a.devices.length > 0 && (
                      <div className="muted">
                        {[...new Set(a.devices.map((d) => d.rack))].join("、")}
                      </div>
                    )}
                  </td>
                  <td>{a.leases}</td>
                  <td>
                    {a.pending.length ? (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => setModal({ type: "adopt", agent: a })}
                      >
                        {a.pending.length} 台待登记
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <div className="button-row agent-actions">
                      <button
                        disabled={busy}
                        onClick={() =>
                          submit(
                            () =>
                              api(`agents/${a.id}`, "sim", {
                                action:
                                  a.status === "active" ? "disable" : "enable",
                                revision: a.revision,
                              }),
                            a.status === "active"
                              ? "Agent 已停用：不再签发新租约"
                              : "Agent 已启用",
                          )
                        }
                      >
                        {a.status === "active" ? "停用" : "启用"}
                      </button>
                      <button
                        disabled={busy}
                        onClick={async () => {
                          const r = await submit(
                            () =>
                              api(`agents/${a.id}`, "sim", {
                                action: "rotate",
                                revision: a.revision,
                              }),
                            "已更换凭证；旧凭证立即失效",
                            true,
                          );
                          if (r)
                            setModal({
                              type: "token",
                              agent: r.agent,
                              token: r.token,
                            });
                        }}
                      >
                        更换凭证
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal?.type === "create" && (
        <Modal title="登记宿主机 Agent" onClose={() => setModal(null)}>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const r = await submit(
                () =>
                  api("agents", "sim", {
                    name: f.get("name"),
                    host: f.get("host"),
                  }),
                "已登记 Agent",
                true,
              );
              if (r)
                setModal({ type: "token", agent: r.agent, token: r.token });
            }}
          >
            <label>
              名称
              <input
                name="name"
                required
                maxLength={80}
                defaultValue="模拟宿主机 Agent"
              />
            </label>
            <label>
              宿主机
              <input
                name="host"
                required
                maxLength={80}
                defaultValue="模拟宿主机"
              />
            </label>
            <button className="primary" disabled={busy}>
              登记并生成凭证
            </button>
          </form>
        </Modal>
      )}
      {modal?.type === "token" && (
        <Modal title="Agent 凭证（只显示一次）" onClose={() => setModal(null)}>
          <div className="form">
            <p className="notice">
              关闭后无法再次查看，中心只保存它的摘要。请写入 Agent
              配置文件（例如 <code>.runtime/agent.json</code> 的 token
              字段），不要放进网址或聊天记录。
            </p>
            <label>
              {modal.agent.name}
              <input
                readOnly
                value={modal.token}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <button className="primary" onClick={() => setModal(null)}>
              已保存
            </button>
          </div>
        </Modal>
      )}
      {modal?.type === "adopt" && (
        <Modal title="登记 Agent 设备" onClose={() => setModal(null)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void submit(
                () =>
                  api(`agents/${modal.agent.id}/adopt`, "sim", {
                    serial: f.get("serial"),
                    name: f.get("name") || f.get("serial"),
                    rack: f.get("rack"),
                    slot: f.get("slot") || undefined,
                    simApps: SIM_APPS.filter(
                      (id) => f.get(`app-${id}`) === "on",
                    ),
                  }),
                "设备已由 Agent 托管；默认可领取模拟任务",
              );
            }}
          >
            <p className="muted">
              {modal.agent.name}{" "}
              上报了这些尚未登记的模拟设备。登记后，此设备的会话由 Agent
              按租约执行。
            </p>
            <label>
              序列号
              <select name="serial">
                {modal.agent.pending.map((serial) => (
                  <option key={serial}>{serial}</option>
                ))}
              </select>
            </label>
            <label>
              设备名称（可选）
              <input name="name" maxLength={80} />
            </label>
            <label>
              机架
              <input
                name="rack"
                required
                maxLength={80}
                defaultValue="Agent 机架"
              />
            </label>
            <label>
              插槽号（可选，1–200，同一机架内唯一）
              <input name="slot" type="number" min="1" max="200" />
            </label>
            {modal.agent.driver === "poc" ? (
              <p className="notice">
                这台 Agent 用 PoC 驱动：手机只能执行 PoC
                已有的小红书搜索、翻页和详情（L0），App
                与指令按驱动上报登记，不能在这里勾选。
              </p>
            ) : (
              <fieldset className="agent-apps">
                <legend>模拟 App</legend>
                {SIM_APPS.map((id) => (
                  <label className="check" key={id}>
                    <input type="checkbox" name={`app-${id}`} defaultChecked />
                    {appName(id)}
                  </label>
                ))}
              </fieldset>
            )}
            <button className="primary" disabled={busy}>
              <HardDrives size={18} />
              登记设备
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
