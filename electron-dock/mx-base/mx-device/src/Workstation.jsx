import { useMemo, useState } from "react";
import {
  DeviceMobile,
  Clock,
  WarningCircle,
  Queue,
  SquaresFour,
  List,
  Plus,
  Sliders,
  ArrowRight,
} from "@phosphor-icons/react";
import { api, appName, jobTitle, time } from "./data.js";
import { requestId } from "./request-id.mjs";
import { Modal } from "./Forms.jsx";
import { strategyStatus } from "../server/strategy-catalog.mjs";
import { latestCatalog, workstationView } from "./workstation-view.mjs";
import "./workstation.css";

const statusNames = {
  idle: "空闲",
  running: "执行中",
  paused: "已暂停",
  cooling: "冷却中",
  quarantined: "待核验",
  offline: "离线",
  reserved: "会话预留",
};
export const durationLabel = (ms) => {
  const n = Math.max(0, Math.ceil(ms / 1000));
  return n < 60
    ? `${n} 秒`
    : n < 3600
      ? `${Math.ceil(n / 60)} 分钟`
      : `${(n / 3600).toFixed(1)} 小时`;
};
function PolicySummary({ policy }) {
  if (!policy?.enabled)
    return <span>尚未启用调度池 · 可为此机架应用推荐策略</span>;
  return (
    <span>
      {policy.strategy === "adaptive"
        ? `空闲超过 ${policy.idleSpreadThresholdPct}% 时分散`
        : policy.strategy === "spread"
          ? "优先预计最早完成，分散负载"
          : "优先复用同 App 上下文"}
      <b>→</b> 同 App 额外等待最多 {durationLabel(policy.maxAffinityDelayMs)}
      <b>→</b> 单机串行，每机最多排 {policy.maxQueuePerDevice} 个任务
    </span>
  );
}
function MiniScreen({ row }) {
  const { device: d, job, command, status } = row,
    p = d.projection;
  if (d.mode === "real")
    return (
      <div className="ws-phone ws-phone-real">
        <DeviceMobile size={30} />
        <strong>真实设备</strong>
        <span>打开工作台查看画面</span>
        <small>不会自动连接手机</small>
      </div>
    );
  return (
    <div className={`ws-phone ${command ? "ws-phone-active" : ""}`}>
      <div className="ws-phone-top">
        <span>{appName(p?.appId || job?.appId || d.simApps?.[0])}</span>
        <i />
      </div>
      {status === "quarantined" ? (
        <div className="ws-phone-empty">
          <WarningCircle size={27} />
          <strong>执行结果待核验</strong>
          <span>已隔离，等待处理</span>
        </div>
      ) : p ? (
        <div className="ws-phone-content">
          <strong>
            {p.detail
              ? "正文详情"
              : p.keyword ||
                (p.page
                  ? `搜索结果 · 第 ${p.page} 页`
                  : p.status || "模拟页面")}
          </strong>
          {p.detail ? (
            <p>
              {typeof p.detail === "string"
                ? p.detail
                : p.detail.content ||
                  p.detail.text ||
                  p.detail.title ||
                  p.detail.body ||
                  "详情内容已返回"}
            </p>
          ) : (
            (p.items || []).slice(0, 3).map((item, i) => (
              <div className="ws-result" key={item.id || i}>
                <i>{i + 1}</i>
                <span>
                  {item.title || item.name || "模拟结果"}
                  <small>{item.price || item.description || "合成数据"}</small>
                </span>
              </div>
            ))
          )}
          {!p.detail && !p.items?.length && (
            <p>{p.subtitle || "应用已就绪，等待下一条指令"}</p>
          )}
        </div>
      ) : (
        <div className="ws-phone-empty">
          <DeviceMobile size={30} />
          <strong>{statusNames[status]}</strong>
          <span>{status === "idle" ? "等待任务到达" : "暂无已确认页面"}</span>
        </div>
      )}
      <div className="ws-phone-bottom">
        {command?.definition?.name ||
          command?.code ||
          (status === "running" ? "等待指令回执" : "合成投影 · 非实时屏幕")}
      </div>
    </div>
  );
}
function AppChips({ row, now }) {
  return (
    <div className="ws-app-chips">
      {(row.apps.length
        ? row.apps
        : (row.device.simApps || []).map((appId) => ({ appId }))
      ).map((a) => {
        const remaining = (a.cooldownUntil || 0) - now;
        return (
          <span className={remaining > 0 ? "is-cooling" : ""} key={a.appId}>
            {appName(a.appId)}
            {remaining > 0 && ` · ${durationLabel(remaining)}`}
          </span>
        );
      })}
    </div>
  );
}
function DeviceTile({ row, now, onOpen }) {
  const completed = row.job?.workflow?.nextStep || 0,
    total = row.job?.workflow?.plan?.length || 0;
  return (
    <button
      className={`ws-device ws-device-${row.status}`}
      onClick={() => onOpen(row.device)}
      aria-label={`打开 ${row.device.name} 手机工作台`}
    >
      <div className="ws-device-heading">
        <strong>{row.device.name}</strong>
        <span className={`ws-state ws-state-${row.status}`}>
          {statusNames[row.status]}
        </span>
      </div>
      <MiniScreen row={row} />
      <div className="ws-device-task">
        {row.job
          ? jobTitle(row.job)
          : row.status === "idle"
            ? "执行槽空闲"
            : statusNames[row.status]}
      </div>
      <div className="ws-device-progress">
        <span>
          {total
            ? `步骤 ${Math.min(completed + 1, total)} / ${total}`
            : row.command
              ? "指令执行中"
              : "—"}
        </span>
        <span>
          预计队列 <b>{row.queue.length}</b>
        </span>
      </div>
      <AppChips row={row} now={now} />
    </button>
  );
}
function QueueRows({
  rows,
  devicesById,
  now,
  mode,
  busy,
  onInspect,
  onAssign,
  onCancel,
}) {
  return (
    <div className="ws-queue-list">
      {rows.length ? (
        rows
          .slice(0, 12)
          .map(({ job, planned, assignment, deviceId, binding }) => (
            <article className="ws-queue-job" key={job.id}>
              <div className="ws-queue-title">
                <button className="text-link" onClick={() => onInspect(job)}>
                  {jobTitle(job)}
                </button>
                <span>P{job.priority}</span>
              </div>
              <div className="ws-queue-meta">
                <span>等待 {durationLabel(now - job.createdAt)}</span>
                <span className={binding === "指定设备" ? "ws-bound" : ""}>
                  {binding}
                </span>
              </div>
              <div className="ws-queue-target">
                <ArrowRight size={14} />
                {devicesById.get(deviceId)?.name || "中央任务池"}
              </div>
              <p>
                {[
                  assignment?.reason,
                  ...(planned?.reasons || []).map((r) => r.message),
                ]
                  .filter(Boolean)
                  .join("；") || "等待可用执行槽"}
              </p>
              <div className="ws-queue-actions">
                {mode === "sim" && (
                  <button disabled={busy} onClick={() => onAssign(job)}>
                    指派 / 回池
                  </button>
                )}
                <button disabled={busy} onClick={() => onCancel(job)}>
                  取消排队
                </button>
              </div>
            </article>
          ))
      ) : (
        <div className="ws-empty">
          <Queue size={32} />
          <strong>队列已清空</strong>
          <p>任务领取后会显示在对应设备中。</p>
        </div>
      )}
      {rows.length > 12 && (
        <p className="small muted">
          显示前 12 个任务，共 {rows.length} 个；完整记录见任务中心。
        </p>
      )}
    </div>
  );
}
function AssignmentForm({ job, state, busy, onSubmit }) {
  const [deviceId, setDeviceId] = useState(job.deviceId || ""),
    [clearPlacement, setClearPlacement] = useState(false);
  const devices = state.devices.filter(
    (d) =>
      d.enabled &&
      d.state !== "quarantined" &&
      d.connected !== "offline" &&
      !["held", "waiting"].includes(d.session?.status) &&
      (d.simApps || ["xhs", "weibo"]).includes(job.appId || "xhs") &&
      (!d.simCommandCodes ||
        (job.workflow?.plan || []).every((s) =>
          d.simCommandCodes.includes(s.code),
        )) &&
      (!job.placement ||
        (d.rack === job.placement.rack &&
          (!job.placement.host || d.host === job.placement.host))),
  );
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          revision: job.revision || 0,
          deviceId: deviceId || null,
          clearPlacement: !deviceId && clearPlacement,
        });
      }}
    >
      <p>{jobTitle(job)}</p>
      <p className="notice">
        仅可调整尚未领取的任务。指定忙碌或冷却设备后会继续等待，不中断当前任务。
      </p>
      <label>
        分配目标
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
          <option value="">交回中央队列 · 自动调度</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.rack} / {d.name}
            </option>
          ))}
        </select>
      </label>
      {!deviceId && job.placement && (
        <label className="check">
          <input
            type="checkbox"
            checked={clearPlacement}
            onChange={(e) => setClearPlacement(e.target.checked)}
          />
          同时取消机架 / 宿主机范围限制
        </label>
      )}
      <button
        className="primary"
        disabled={
          busy || (!!deviceId && !devices.some((d) => d.id === deviceId))
        }
      >
        保存任务分配
      </button>
    </form>
  );
}
export function TemplateJobForm({ state, rack, busy, onSubmit }) {
  const definitions = latestCatalog(state.definitions),
    [definitionId, setDefinitionId] = useState(
      definitions.find((d) => d.appId === "pdd")?.id ||
        definitions[0]?.id ||
        "",
    ),
    [inputError, setInputError] = useState("");
  const [key] = useState(() => requestId());
  const selected = definitions.find((d) => d.id === definitionId);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.currentTarget));
        try {
          const input = f.extra.trim() ? JSON.parse(f.extra) : {};
          if (!input || Array.isArray(input) || typeof input !== "object")
            throw Error("附加参数应为 JSON 对象");
          setInputError("");
          onSubmit({
            key,
            definitionId,
            keyword: f.keyword,
            target: f.target,
            input,
            priority: Number(f.priority),
            rack: f.rack,
            deviceId: f.deviceId,
          });
        } catch (error) {
          setInputError(error.message);
        }
      }}
    >
      <p className="notice">
        任务会冻结指令和模板版本，经中央队列调度后在单台设备顺序执行。
      </p>
      <label>
        任务模板
        <select
          aria-label="任务模板"
          value={definitionId}
          onChange={(e) => setDefinitionId(e.target.value)}
        >
          {definitions.map((d) => (
            <option value={d.id} key={d.id}>
              {d.name} · v{d.version}
            </option>
          ))}
        </select>
      </label>
      <div className="form-grid">
        <label>
          关键词
          <input name="keyword" defaultValue="运动鞋" maxLength={200} />
        </label>
        <label>
          目标标识 / 详情链接
          <input name="target" placeholder="模板需要时填写" />
        </label>
        <label>
          机架范围
          <select name="rack" defaultValue={rack}>
            <option value="">任意常规机架</option>
            {[...new Set(state.devices.map((d) => d.rack))].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label>
          优先级
          <select name="priority" defaultValue="5">
            <option value="1">1 · 高</option>
            <option value="5">5 · 普通</option>
            <option value="8">8 · 后台</option>
          </select>
        </label>
      </div>
      <label>
        指定设备
        <select name="deviceId" key={definitionId}>
          <option value="">自动调度</option>
          {state.devices
            .filter(
              (d) =>
                d.enabled &&
                d.state !== "quarantined" &&
                (d.simApps || ["xhs", "weibo"]).includes(selected?.appId),
            )
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.rack} / {d.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        附加输入参数（JSON，可选）
        <textarea name="extra" rows={3} placeholder={'{"limit": 10}'} />
      </label>
      {inputError && (
        <p className="error" role="alert">
          {inputError}
        </p>
      )}
      <button className="primary" disabled={busy || !selected}>
        提交模拟任务
      </button>
    </form>
  );
}
export default function Workstation({
  state,
  mode,
  busy,
  run,
  rack,
  setRack,
  onOpenDevice,
  onInspect,
  onScenarios,
  onRackManage,
  onAdd,
  onRealSubmit,
}) {
  const [view, setView] = useState("screens"),
    [filter, setFilter] = useState("all"),
    [strategyId, setStrategyId] = useState(""),
    [modal, setModal] = useState(null),
    [localError, setLocalError] = useState("");
  const model = useMemo(() => workstationView(state, rack), [state, rack]);
  const racks = [...new Set(state.devices.map((d) => d.rack))].sort(),
    strategies = latestCatalog(state.strategyDefinitions);
  const loop = state.loopPolicies.find((p) => p.rack === rack),
    status = strategyStatus(loop);
  const strategy =
    strategies.find((s) => s.id === strategyId) ||
    strategies.find((s) => s.code === loop?.strategySnapshot?.code) ||
    strategies.find((s) => s.recommended) ||
    strategies[0];
  const shown = model.devices.filter(
    (d) => filter === "all" || d.status === filter,
  );
  const groups = [
    ...new Set(
      shown.map((d) => JSON.stringify([d.device.rack, d.device.host])),
    ),
  ];
  const act = async (fn, message) => {
    setLocalError("");
    const result = await run(async () => {
      try {
        return await fn();
      } catch (e) {
        setLocalError(e.message);
        throw e;
      }
    }, message);
    if (result) setModal(null);
  };
  const events = state.events
    .filter(
      (e) =>
        !rack ||
        !e.deviceId ||
        model.devices.some((d) => d.device.id === e.deviceId),
    )
    .slice(-8)
    .reverse();
  return (
    <div className="workstation">
      <div className="ws-metrics">
        {[
          {
            title: "设备总数",
            value: model.metrics.total,
            unit: "台",
            icon: DeviceMobile,
          },
          {
            title: "正在执行",
            value: model.metrics.running,
            unit: "台",
            icon: SquaresFour,
          },
          {
            title: "等待领取",
            value: model.metrics.queued,
            unit: "个任务",
            icon: Queue,
          },
          {
            title: "App 冷却",
            value: model.metrics.cooling,
            unit: "个应用槽",
            icon: Clock,
          },
          {
            title: "待核验",
            value: model.metrics.quarantined,
            unit: "台",
            icon: WarningCircle,
          },
        ].map((m) => (
          <div className="ws-metric" key={m.title}>
            <m.icon size={20} />
            <span>{m.title}</span>
            <strong>
              {m.value}
              <small>{m.unit}</small>
            </strong>
          </div>
        ))}
      </div>
      <section className="panel ws-toolbar">
        <label>
          机架
          <select
            aria-label="查看机架"
            value={rack}
            onChange={(e) => {
              setRack(e.target.value);
              setStrategyId("");
            }}
          >
            <option value="">全部机架</option>
            {racks.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        {mode === "sim" && (
          <>
            <label className="ws-strategy-select">
              默认调度策略
              <select
                aria-label="默认调度策略"
                value={strategy?.id || ""}
                onChange={(e) => setStrategyId(e.target.value)}
              >
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · v{s.version}
                    {s.recommended ? "（推荐）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="outline"
              disabled={busy || !rack || !strategy}
              onClick={() =>
                run(
                  () =>
                    api("strategy-apply", mode, {
                      rack,
                      revision: loop?.revision || 0,
                      strategyId: strategy.id,
                    }),
                  "机架策略已应用；未领取任务重新规划",
                )
              }
            >
              应用到机架
            </button>
          </>
        )}
        <div className="ws-view-toggle" role="group" aria-label="查看方式">
          <button
            className={view === "screens" ? "selected" : ""}
            aria-pressed={view === "screens"}
            onClick={() => setView("screens")}
          >
            <SquaresFour size={18} />
            屏幕墙
          </button>
          <button
            className={view === "list" ? "selected" : ""}
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <List size={18} />
            列表
          </button>
        </div>
      </section>
      {mode === "sim" && (
        <div className="ws-policy-strip">
          <Sliders size={18} />
          <div>
            <strong>
              {rack
                ? status.snapshot
                  ? `${status.snapshot.name} · v${status.snapshot.version}${status.state === "modified" ? " · 参数已有手动调整" : ""}`
                  : "此机架尚未绑定策略库"
                : "选择一个机架，查看和设置默认策略"}
            </strong>
            {rack && (
              <>
                <PolicySummary policy={loop?.scheduler} />
                <small>
                  既有循环冷却仍生效；应用冷却相互独立，预计队列随可用资源动态变化。
                </small>
              </>
            )}
          </div>
          <button className="text-link" onClick={onScenarios}>
            场景与策略 <ArrowRight />
          </button>
        </div>
      )}
      <div className="ws-main-grid">
        <section className="panel ws-rack">
          <div className="ws-section-head">
            <div>
              <h2>{rack || "全部机架"}</h2>
              <p>
                {mode === "sim"
                  ? "模拟画面随已确认指令变化 · 点击手机查看完整工作台"
                  : "设备执行状态总览 · 打开手机工作台查看画面"}
              </p>
            </div>
            <div className="ws-rack-tools">
              <select
                aria-label="设备状态筛选"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">全部状态</option>
                {Object.entries(statusNames).map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </select>
              <button
                className="icon-button"
                aria-label="管理机架资源"
                onClick={onRackManage}
              >
                <Sliders size={20} />
              </button>
            </div>
          </div>
          {shown.length ? (
            groups.map((key) => {
              const [r, h] = JSON.parse(key),
                rows = shown.filter(
                  (d) => d.device.rack === r && d.device.host === h,
                );
              return (
                <div className="ws-host" key={key}>
                  <div className="ws-host-heading">
                    <strong>
                      {r} <span>/ {h}</span>
                    </strong>
                    <span>{rows.length} 台</span>
                  </div>
                  {view === "screens" ? (
                    <div className="ws-screen-grid">
                      {rows.map((row) => (
                        <DeviceTile
                          key={row.device.id}
                          row={row}
                          now={model.now}
                          onOpen={onOpenDevice}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="table-wrap">
                      <table className="ws-device-table">
                        <thead>
                          <tr>
                            <th>设备</th>
                            <th>状态</th>
                            <th>当前任务 / 指令</th>
                            <th>预计队列</th>
                            <th>App 状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => (
                            <tr key={row.device.id}>
                              <td>
                                <button
                                  className="text-link"
                                  onClick={() => onOpenDevice(row.device)}
                                >
                                  {row.device.name}
                                </button>
                              </td>
                              <td>
                                <span
                                  className={`ws-state ws-state-${row.status}`}
                                >
                                  {statusNames[row.status]}
                                </span>
                              </td>
                              <td>
                                {row.job ? jobTitle(row.job) : "—"}
                                <small>{row.command?.code || ""}</small>
                              </td>
                              <td>{row.queue.length}</td>
                              <td>
                                <AppChips row={row} now={model.now} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="ws-empty ws-rack-empty">
              <DeviceMobile size={38} />
              <h3>
                {filter === "all" ? "还没有可展示的设备" : "此筛选下没有设备"}
              </h3>
              <p>从场景创建独立模拟机架，或添加已有设备。</p>
              <div className="row-actions">
                {mode === "sim" && (
                  <button className="primary" onClick={onScenarios}>
                    选择演练场景
                  </button>
                )}
                <button className="outline" onClick={onAdd}>
                  添加设备
                </button>
              </div>
            </div>
          )}
        </section>
        <aside className="panel ws-central-queue">
          <div className="ws-section-head">
            <div>
              <h2>
                中央任务队列 <span>{model.queue.length}</span>
              </h2>
              <p>未领取可重新指派；预计分配不是执行锁。</p>
            </div>
          </div>
          <button
            className="outline ws-submit"
            onClick={() => {
              setLocalError("");
              mode === "sim" ? setModal({ type: "submit" }) : onRealSubmit();
            }}
          >
            <Plus size={16} />
            提交任务
          </button>
          <QueueRows
            rows={model.queue}
            devicesById={model.devicesById}
            now={model.now}
            mode={mode}
            busy={busy}
            onInspect={onInspect}
            onAssign={(job) => {
              setLocalError("");
              setModal({ type: "assign", job });
            }}
            onCancel={(job) =>
              run(
                () =>
                  api(
                    `jobs/${job.id}/${mode === "sim" ? "queue-cancel" : "cancel"}`,
                    mode,
                    mode === "sim" ? { revision: job.revision || 0 } : {},
                  ),
                "已取消排队任务",
              )
            }
          />
        </aside>
      </div>
      <section className="panel ws-events">
        <div className="ws-section-head">
          <div>
            <h2>最近调度活动</h2>
            <p>提交 → 动态分配 → 单机串行执行 → 回执确认 → 独立冷却</p>
          </div>
        </div>
        {events.length ? (
          events.map((e) => (
            <div className="ws-event" key={e.id}>
              <time>{time(e.at)}</time>
              <span>{e.message || e.type}</span>
            </div>
          ))
        ) : (
          <p className="muted">暂无活动。读取工作台不会派发任务。</p>
        )}
      </section>
      {modal && (
        <Modal
          title={modal.type === "submit" ? "提交模板任务" : "调整排队任务"}
          onClose={() => setModal(null)}
        >
          {localError && (
            <p className="error" role="alert">
              {localError}
            </p>
          )}
          {modal.type === "submit" ? (
            <TemplateJobForm
              state={state}
              rack={rack}
              busy={busy}
              onSubmit={(body) =>
                act(() => api("jobs", mode, body), "任务已进入中央队列")
              }
            />
          ) : (
            <AssignmentForm
              job={modal.job}
              state={state}
              busy={busy}
              onSubmit={(body) =>
                act(
                  () => api(`jobs/${modal.job.id}/assignment`, mode, body),
                  "任务分配已更新",
                )
              }
            />
          )}
        </Modal>
      )}
    </div>
  );
}
