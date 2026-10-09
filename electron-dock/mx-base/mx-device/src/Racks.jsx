import { useState } from "react";
import { HardDrives, DeviceMobile, ArrowRight } from "@phosphor-icons/react";
import { time } from "./data.js";

export function Capacity({ counts = {} }) {
  return (
    <div className="capacity-grid" aria-label="当前模式资源汇总">
      {[
        ["登记设备", counts.total],
        ["候选设备", counts.candidates],
        ["正在执行", counts.running],
        ["排队任务", counts.queued],
        ["隔离待核验", counts.quarantined],
      ].map(([label, value]) => (
        <div className="capacity-item" key={label}>
          <span>{label}</span>
          <strong>{value ?? 0}</strong>
        </div>
      ))}
    </div>
  );
}

function ResourceState({ group, parent }) {
  return (
    <span
      className={`resource-state ${group.draining || parent?.draining ? "warning" : ""}`}
    >
      {parent?.draining
        ? "受机架排空限制"
        : group.draining
          ? group.running
            ? "排空中"
            : "已排空"
          : "本级允许领取"}
      {` · 并发 ${group.running} / ${group.maxConcurrent ?? "未设上限"}`}
    </span>
  );
}

function deviceLabel(d) {
  if (d.state === "quarantined") return "已隔离";
  if (d.state === "running") return "执行中";
  if (d.adapter === "mobile-agent") return "仅观察";
  if (d.connected === "offline") return "模拟离线";
  return d.enabled ? "等待分配" : "已暂停";
}

export function Racks({
  state,
  mode,
  busy,
  onOpenDevice,
  onPolicy,
  onPlacement,
  onAdd,
}) {
  const [rackFilter, setRackFilter] = useState(""),
    [status, setStatus] = useState("");
  const scheduling = state.scheduling;
  const groups = scheduling?.groups || [];
  const racks = groups
    .filter((g) => g.scope === "rack")
    .sort((a, b) => a.rack.localeCompare(b.rack));
  const availability = new Map(
    (scheduling?.devices || []).map((d) => [d.deviceId, d]),
  );
  const filtered = state.devices.filter(
    (d) =>
      (!rackFilter || d.rack === rackFilter) &&
      (!status ||
        (status === "candidate"
          ? availability.get(d.id)?.blockers.length === 0
          : status === "paused"
            ? !d.enabled
            : d.state === status)),
  );
  return (
    <div className="rack-overview">
      <Capacity counts={scheduling?.counts} />
      <div className="panel resource-intro">
        <div>
          <h2>机架 → 宿主机 → 设备</h2>
          <p className="muted">
            按登记归属组织资源。每部手机一个执行槽，多台手机可并行；候选设备数不等于能同时启动的任务数。
          </p>
        </div>
        <div className="resource-filters">
          <label>
            机架筛选
            <select
              value={rackFilter}
              onChange={(e) => setRackFilter(e.target.value)}
            >
              <option value="">全部机架</option>
              {racks.map((r) => (
                <option key={r.rack}>{r.rack}</option>
              ))}
            </select>
          </label>
          <label>
            设备筛选
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">全部设备</option>
              <option value="candidate">候选设备</option>
              <option value="running">执行中</option>
              <option value="paused">已暂停</option>
              <option value="quarantined">隔离待核验</option>
            </select>
          </label>
        </div>
      </div>
      {!racks.length ? (
        <div className="panel empty">
          <HardDrives size={36} />
          <h3>从第一台设备建立机架</h3>
          <p>登记设备时填写机架和宿主机。已有设备会自动出现在对应分组中。</p>
          <button onClick={onAdd}>添加设备</button>
        </div>
      ) : null}
      {racks
        .filter((r) => !rackFilter || r.rack === rackFilter)
        .map((rack) => (
          <section className="panel rack-panel" key={rack.resourceKey}>
            <div className="section-head rack-heading">
              <div>
                <h2>
                  <HardDrives size={23} />
                  {rack.rack}
                </h2>
                <p className="small muted">
                  {rack.total} 台登记 · {rack.running} 执行 · {rack.candidates}{" "}
                  候选 · {rack.queued} 绑定任务排队
                </p>
                <ResourceState group={rack} />
              </div>
              <button disabled={busy} onClick={() => onPolicy(rack)}>
                机架策略
              </button>
            </div>
            <div className="host-grid">
              {groups
                .filter((g) => g.scope === "host" && g.rack === rack.rack)
                .map((host) => {
                  const devices = filtered.filter((d) =>
                    host.deviceIds.includes(d.id),
                  );
                  return (
                    <section className="host-card" key={host.resourceKey}>
                      <div className="host-heading">
                        <div>
                          <h3>{host.host}</h3>
                          <ResourceState group={host} parent={rack} />
                        </div>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => onPolicy(host)}
                        >
                          主机策略
                        </button>
                      </div>
                      <div className="worker-evidence">
                        {mode === "sim"
                          ? "模拟资源 · 不代表实际 USB 宿主机"
                          : host.workerIds.map((id) => {
                              const w = state.workers.find((w) => w.id === id),
                                age = w
                                  ? Math.max(
                                      0,
                                      Math.floor((scheduling.at - w.at) / 1000),
                                    )
                                  : null;
                              return (
                                <p key={id}>
                                  <span>{id}</span>
                                  <strong
                                    className={
                                      !w || age >= 10 || w.lastError
                                        ? "warning"
                                        : ""
                                    }
                                  >
                                    {!w
                                      ? "无心跳记录"
                                      : w.lastError
                                        ? "执行器报告异常"
                                        : age >= 10
                                          ? `心跳过期 · ${age} 秒`
                                          : `心跳新鲜 · ${age} 秒`}
                                  </strong>
                                </p>
                              );
                            })}
                      </div>
                      <div className="rack-device-list">
                        {devices.map((d) => {
                          const blockers =
                            availability.get(d.id)?.blockers || [];
                          return (
                            <article className="rack-device" key={d.id}>
                              <div className="rack-device-heading">
                                <DeviceMobile size={28} />
                                <button
                                  className="text-button device-link"
                                  onClick={() => onOpenDevice(d.id)}
                                >
                                  {d.name}
                                  <ArrowRight size={15} />
                                </button>
                                <span
                                  className={`status ${d.state === "running" ? "running" : d.state === "quarantined" ? "unknown" : ""}`}
                                >
                                  {deviceLabel(d)}
                                </span>
                              </div>
                              <p className="small device-identity">
                                {mode === "sim"
                                  ? "模拟手机"
                                  : `serial · ${d.serial || "未核验"}`}
                              </p>
                              <p className="device-blocker">
                                {d.state === "running"
                                  ? "当前任务继续执行，完成后释放执行槽"
                                  : blockers[0]?.message ||
                                    "候选条件满足，等待执行器领取"}
                              </p>
                              <div className="rack-device-actions">
                                <span className="small muted">
                                  {d.adapter === "mobile-agent"
                                    ? "画面 / 状态"
                                    : "有界搜索 / 详情"}
                                </span>
                                <button
                                  className="text-button"
                                  disabled={
                                    busy ||
                                    d.enabled ||
                                    d.state !== "idle" ||
                                    ["waiting", "held"].includes(
                                      d.session?.status,
                                    )
                                  }
                                  title="暂停设备并等待执行/预留结束后可修改"
                                  onClick={() => onPlacement(d)}
                                >
                                  编辑归属
                                </button>
                              </div>
                            </article>
                          );
                        })}
                        {!devices.length && (
                          <p className="muted small">
                            此主机没有符合筛选条件的设备。
                          </p>
                        )}
                      </div>
                    </section>
                  );
                })}
            </div>
          </section>
        ))}
      <p className="small muted">
        本中心快照 {time(scheduling?.at)} ·
        心跳描述执行器，不代表手机在线或可独占。
        {(scheduling?.counts.unbound || 0) > 0
          ? ` ${scheduling.counts.unbound} 个未绑定任务保留在公共任务池。`
          : ""}
        机架与宿主机目前为逻辑分组；编辑归属不会改变物理接线或连接入口。
      </p>
    </div>
  );
}

export function ResourceForm({ group, busy, onSubmit }) {
  return (
    <div className="form">
      <p>
        {group.rack}
        {group.scope === "host" ? ` / ${group.host}` : ""} · {group.total}{" "}
        台设备 · {group.running} 正在执行
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const value = new FormData(e.currentTarget).get("limit");
          onSubmit({
            action: "limit",
            maxConcurrent: value === "" ? null : Number(value),
          });
        }}
      >
        <label>
          并发执行上限
          <input
            name="limit"
            type="number"
            min="1"
            max="64"
            defaultValue={group.maxConcurrent ?? ""}
            placeholder="留空表示不另设上限"
          />
        </label>
        <p className="small muted">
          机架与主机上限同时生效。调低上限时，在途任务继续；新任务等待空位。每台设备始终只有一个执行槽。
        </p>
        <button className="primary" disabled={busy}>
          保存并发上限
        </button>
      </form>
      <div className="resource-drain">
        <h3>{group.draining ? "解除排空" : "排空资源"}</h3>
        <p>
          {group.draining
            ? "解除机架或主机的领取限制，设备仍保持暂停。需要到设备工作台逐台启用。"
            : "暂停此分组全部设备的新领取，等待在途任务自然收尾；排队任务继续保留。排空期间新加入的设备也不能领取。"}
        </p>
        <button
          disabled={busy}
          onClick={() =>
            onSubmit({ action: group.draining ? "release" : "drain" })
          }
        >
          {group.draining ? "解除排空，保持设备暂停" : "停止领取并排空"}
        </button>
      </div>
    </div>
  );
}

export function PlacementForm({ device, devices, busy, onSubmit }) {
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          ...Object.fromEntries(new FormData(e.currentTarget)),
          revision: device.revision,
        });
      }}
    >
      <p className="muted">
        只修改本中心名称与分组。设备
        ID、执行器、连接入口和任务历史保持关联，保存后仍暂停。策略绑定原分组，新分组不继承原组策略。
      </p>
      <label>
        设备名称
        <input name="name" defaultValue={device.name} maxLength={80} required />
      </label>
      <label>
        机架
        <input
          name="rack"
          defaultValue={device.rack}
          list="placement-racks"
          maxLength={120}
          required
        />
      </label>
      <datalist id="placement-racks">
        {[...new Set(devices.map((d) => d.rack))].map((r) => (
          <option key={r}>{r}</option>
        ))}
      </datalist>
      <label>
        宿主机
        <input
          name="host"
          defaultValue={device.host}
          maxLength={120}
          required
        />
      </label>
      <button className="primary" disabled={busy}>
        保存归属
      </button>
    </form>
  );
}
