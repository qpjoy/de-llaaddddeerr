import { useEffect, useMemo, useRef, useState } from "react";
import {
  DeviceMobile,
  Clock,
  WarningCircle,
  Warning,
  PlayCircle,
  ListBullets,
  SquaresFour,
  List,
  Plus,
  Sliders,
  ArrowRight,
  CaretRight,
  Info,
  Timer,
  PauseCircle,
  WifiSlash,
  Lock,
  Rows,
  FlowArrow,
  Question,
} from "@phosphor-icons/react";
import { api, appName, jobTitle, time } from "./data.js";
import { requestId } from "./request-id.mjs";
import { Modal } from "./Forms.jsx";
import { strategyStatus } from "../server/strategy-catalog.mjs";
import { latestCatalog, workstationView } from "./workstation-view.mjs";
import LaneChart from "./LaneChart.jsx";
import FlowView from "./FlowView.jsx";
import ExplainPanel from "./ExplainPanel.jsx";
import { liveLanes, liveTicks } from "./timeline-model.mjs";
import "./workstation.css";

// Render a tile's mini screen only near the viewport (100 devices stay cheap).
function useVisible(ref) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== "function") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}

const statusNames = {
  idle: "空闲",
  running: "执行中",
  paused: "已暂停",
  cooling: "冷却中",
  quarantined: "待核验",
  offline: "离线",
  reserved: "会话预留",
  suspect: "失联待确认",
};
export const durationLabel = (ms) => {
  const n = Math.max(0, Math.ceil(ms / 1000));
  return n < 60
    ? `${n} 秒`
    : n < 3600
      ? `${Math.ceil(n / 60)} 分钟`
      : `${(n / 3600).toFixed(1)} 小时`;
};
// One-line reading of the rack's scheduling policy for the strategy bar.
function policyParts(policy, auto) {
  if (!policy?.enabled) return ["尚未启用调度池，可为此机架应用推荐策略"];
  return [
    policy.strategy === "adaptive"
      ? `空闲 ≥ ${policy.idleSpreadThresholdPct}% → 分散执行`
      : policy.strategy === "spread"
        ? "优先最早完成，分散负载"
        : "优先复用同 App 上下文",
    `${policy.strategy === "adaptive" ? "否则" : ""}同 App 最多等待 ${durationLabel(policy.maxAffinityDelayMs)}`,
    "单机串行",
    policy.pacing
      ? `节奏由策略管理${policy.pacing.account ? "（含账号预算）" : ""}`
      : "节奏沿用机架循环设置",
    auto?.enabled &&
      `自动切换：当前${auto.current === "busy" ? "繁忙" : "平静"}（≥ ${auto.enterPressure} 进入，≤ ${auto.exitPressure} 退出）`,
  ].filter(Boolean);
}
const APP_ICONS = {
  xhs: ["小红书", "#ff2442", "#fff"],
  weibo: ["微博", "#ff8200", "#fff"],
  xianyu: ["闲鱼", "#ffda00", "#3b3000"],
  pdd: ["拼多多", "#e02e24", "#fff"],
};
function AppIcon({ appId }) {
  const [label, bg, fg] = APP_ICONS[appId] || [
    appName(appId),
    "#5f7a8f",
    "#fff",
  ];
  return (
    <span className="ws-app-icon" style={{ background: bg, color: fg }}>
      {label}
    </span>
  );
}
// Priority 1 is the most urgent; the default is 5.
const priorityLevel = (p = 5) =>
  p <= 3 ? ["高", "high"] : p <= 6 ? ["中", "mid"] : ["低", "low"];
const taskTitle = (job) =>
  job.workflow?.name ||
  `${appName(job.appId)} · ${job.operation === "search" ? "搜索" : job.sourceJobId ? "详情" : "笔记详情"}`;
const keywordOf = (job) => job.input?.keyword || job.input?.target || "";
const CLIENT_CLASS = { interactive: "交互", standard: "标准", batch: "批量" };
const ms = (v) => durationLabel(v);
// Shadow evaluation: the current queue planned under the current and a candidate strategy.
function ShadowView({ mode, rack, strategy }) {
  const [result, setResult] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    api("strategy-shadow", mode, { rack, strategyId: strategy.id }).then(
      setResult,
      (e) => setError(e.message),
    );
  }, [mode, rack, strategy.id]);
  if (error)
    return (
      <div className="form">
        <p className="error">{error}</p>
      </div>
    );
  if (!result)
    return (
      <div className="form">
        <p className="muted">正在按两种策略规划当前队列…</p>
      </div>
    );
  const rows = [
    ["可规划任务", (r) => r.assigned],
    ["立即开始", (r) => r.startNow],
    ["平均预计等待", (r) => ms(r.waitAvgMs)],
    ["P95 预计等待", (r) => ms(r.waitP95Ms)],
    ["队列预计清空", (r) => ms(r.lastFinishMs)],
    ["App 切换", (r) => `${r.switches} 次 · ${ms(r.switchMs)}`],
    [
      "保留在中央队列",
      (r) =>
        Object.entries(r.blocked)
          .map(([k, v]) => `${k} ${v}`)
          .join("、") || "无",
    ],
  ];
  const same = result.current?.id === result.strategy.id;
  return (
    <div className="form">
      <p className="muted">
        只读评估：用当前排队任务与设备状态各重新规划一次（不沿用已有计划），不应用策略、不改动任务
        {result.executorSlots
          ? `；执行器 ${result.executorSlots} 个模拟槽`
          : ""}
        。预计值不是承诺。
      </p>
      {same && (
        <p className="notice">
          候选与机架当前策略相同；先在「默认调度策略」中选择另一个策略再评估。
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>指标</th>
              <th>
                {result.current
                  ? `当前：${result.current.name}${result.current.version ? ` · v${result.current.version}` : ""}`
                  : "当前（未启用调度池）"}
              </th>
              <th>
                候选：{result.strategy.name} · v{result.strategy.version}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, get]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{result.current ? get(result.current) : "—"}</td>
                <td>{get(result.candidate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function AutoProfileForm({ loop, strategies, busy, onSubmit }) {
  const auto = loop?.autoProfile || {};
  const recommended = strategies.find((s) => s.recommended) || strategies[0];
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const enabled = f.get("enabled") === "on";
        onSubmit(
          enabled
            ? {
                rack: loop.rack,
                revision: loop.revision,
                enabled,
                calmStrategyId: f.get("calm"),
                busyStrategyId: f.get("busy"),
                enterPressure: Number(f.get("enter")),
                exitPressure: Number(f.get("exit")),
                minDwellMs: Math.round(Number(f.get("dwell")) * 1000),
                maxSwitchesPerHour: Number(f.get("max")),
              }
            : { rack: loop.rack, revision: loop.revision, enabled },
        );
      }}
    >
      <p className="muted">
        排队压力 = 已可领取的排队任务数 ÷
        可用设备数。进入与退出阈值不同（迟滞），切换后至少驻留一段时间，并限制每小时次数。只由单活调度器执行；在途会话和已生成冷却不受影响。
      </p>
      <label className="check">
        <input type="checkbox" name="enabled" defaultChecked={auto.enabled} />
        启用按流量自动切换
      </label>
      {[
        [
          "calm",
          "平静时策略",
          auto.calmStrategyId ||
            (strategies.some((s) => s.id === loop?.strategySnapshot?.id)
              ? loop.strategySnapshot.id
              : recommended?.id),
        ],
        [
          "busy",
          "繁忙时策略",
          auto.busyStrategyId ||
            strategies.find((s) => s.code === "pool.affinity")?.id,
        ],
      ].map(([name, label, value]) => (
        <label key={name}>
          {label}
          <select name={name} defaultValue={value}>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · v{s.version}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="form-grid">
        <label>
          压力 ≥ 此值进入繁忙
          <input
            name="enter"
            type="number"
            step="0.1"
            min="0.1"
            max="100"
            defaultValue={auto.enterPressure ?? 1.5}
          />
        </label>
        <label>
          压力 ≤ 此值回到平静
          <input
            name="exit"
            type="number"
            step="0.1"
            min="0"
            max="100"
            defaultValue={auto.exitPressure ?? 0.5}
          />
        </label>
        <label>
          最短驻留（秒）
          <input
            name="dwell"
            type="number"
            min="5"
            max="86400"
            defaultValue={(auto.minDwellMs ?? 60000) / 1000}
          />
        </label>
        <label>
          每小时最多切换
          <input
            name="max"
            type="number"
            min="1"
            max="60"
            defaultValue={auto.maxSwitchesPerHour ?? 6}
          />
        </label>
      </div>
      {auto.lastSwitch && (
        <p className="small muted">
          上次切换 {time(auto.lastSwitch.at)}：
          {auto.lastSwitch.from === "busy" ? "繁忙" : "平静"} →{" "}
          {auto.lastSwitch.to === "busy" ? "繁忙" : "平静"}（压力{" "}
          {auto.lastSwitch.pressure}）
        </p>
      )}
      <button className="primary" type="submit" disabled={busy}>
        保存
      </button>
    </form>
  );
}
function MiniScreen({ row, now }) {
  const { device: d, job, command, status } = row,
    p = d.projection;
  if (d.mode === "real")
    return (
      <div className="ws-phone ws-phone-real">
        <div className="ws-phone-state">
          <DeviceMobile size={28} />
          <strong>真实设备</strong>
          <span>打开工作台查看画面</span>
        </div>
      </div>
    );
  const appId = job?.appId || p?.appId || row.coolingApps[0]?.appId;
  const cooldownUntil = Math.max(
    d.cooldownUntil || 0,
    ...row.coolingApps.map((a) => a.cooldownUntil),
  );
  const state =
    status === "quarantined"
      ? {
          tone: "danger",
          icon: <WarningCircle size={34} weight="fill" />,
          title: "需人工核验",
          note: "执行结果待核验 · 已隔离",
        }
      : status === "suspect"
        ? {
            tone: "warn",
            icon: <WifiSlash size={32} />,
            title: "失联待确认",
            note: "Agent 心跳中断，宽限期内等待证据",
          }
        : status === "cooling"
          ? {
              tone: "warn",
              icon: <Timer size={32} />,
              title: d.cooldownUntil > now ? "设备休息中" : "App 冷却中",
              note: `剩余 ${durationLabel(cooldownUntil - now)}`,
            }
          : status === "paused"
            ? {
                icon: <PauseCircle size={32} />,
                title: "已暂停",
                note: "不领取新任务",
              }
            : status === "offline"
              ? {
                  icon: <WifiSlash size={32} />,
                  title: "离线",
                  note: "等待重新连接",
                }
              : status === "reserved"
                ? {
                    icon: <Lock size={30} />,
                    title: "会话预留",
                    note: "等待当前工作收尾",
                  }
                : status !== "running"
                  ? {
                      icon: <DeviceMobile size={30} />,
                      title: "等待任务",
                      note: "空闲中",
                    }
                  : !p || p.jobId !== job?.id
                    ? {
                        icon: <AppIcon appId={appId} />,
                        title: appName(appId),
                        note:
                          command?.definition?.name ||
                          command?.code ||
                          "等待指令回执",
                        splash: true,
                      }
                    : null;
  return (
    <div className={`ws-phone ${command ? "ws-phone-active" : ""}`}>
      <i className="ws-notch" />
      {d.agentId && (
        <span className="ws-agent-tag" title="由宿主机 Agent 按租约执行">
          Agent
        </span>
      )}
      {state ? (
        <div className={`ws-phone-state ${state.tone || ""}`}>
          {state.icon}
          <strong>{state.title}</strong>
          <span>{state.note}</span>
          {appId && status !== "idle" && !state.splash && (
            <small>{appName(appId)}</small>
          )}
        </div>
      ) : (
        <div className="ws-phone-content">
          <strong className="ws-phone-app">{appName(p.appId || appId)}</strong>
          {p.keyword && (
            <span className="ws-phone-query">搜索：{p.keyword}</span>
          )}
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
          ) : p.items?.length ? (
            <ol>
              {p.items.slice(0, 3).map((item, i) => (
                <li key={item.id || i}>
                  {item.title || item.name || "模拟结果"}
                </li>
              ))}
            </ol>
          ) : (
            <p>{p.subtitle || p.status || "应用已就绪，等待下一条指令"}</p>
          )}
        </div>
      )}
      {command && !state && (
        <div className="ws-phone-command">
          {command.definition?.name || command.code}
        </div>
      )}
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
function tileTask(row) {
  const app = appName(
    row.job?.appId || row.device.projection?.appId || row.coolingApps[0]?.appId,
  );
  if (row.job) return taskTitle(row.job);
  return (
    {
      cooling: `${app} · 冷却等待`,
      quarantined: `${app} · 待人工核验`,
      paused: "已暂停",
      offline: "离线",
      reserved: "会话预留",
    }[row.status] || "空闲"
  );
}
function DeviceTile({ row, now, onOpen }) {
  const completed = row.job?.workflow?.nextStep || 0,
    total = row.job?.workflow?.plan?.length || 0;
  const ref = useRef(null),
    visible = useVisible(ref);
  return (
    <button
      ref={ref}
      className={`ws-device ws-device-${row.status}`}
      onClick={() => onOpen?.(row.device)}
      aria-label={
        onOpen ? `打开 ${row.device.name} 手机工作台` : row.device.name
      }
    >
      <div className="ws-device-heading">
        <i className={`ws-dot ws-dot-${row.status}`} />
        <strong>{row.device.name}</strong>
        <span className={`ws-state ws-state-${row.status}`}>
          {statusNames[row.status]}
        </span>
      </div>
      {visible ? (
        <MiniScreen row={row} now={now} />
      ) : (
        <div className="ws-phone ws-phone-placeholder" />
      )}
      <div className="ws-device-task" title={row.job ? jobTitle(row.job) : ""}>
        {tileTask(row)}
      </div>
      <div className="ws-progress">
        <i
          style={{
            width: `${total ? Math.round((Math.min(completed, total) / total) * 100) : row.status === "running" ? 15 : 0}%`,
          }}
        />
      </div>
      <div className="ws-device-foot">
        <span>
          {total
            ? `${Math.min(completed, total)} / ${total} 步`
            : row.status === "running"
              ? "执行中"
              : "0 / 0 步"}
        </span>
        <span>队列 {row.queue.length}</span>
      </div>
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
  onExplain,
  readOnly = false,
}) {
  return (
    <div className="ws-queue-list">
      {rows.length ? (
        rows
          .slice(0, 12)
          .map(({ job, planned, assignment, deviceId, binding }) => {
            const target = devicesById.get(deviceId)?.name,
              [level, tone] = priorityLevel(job.priority),
              keyword = keywordOf(job),
              reason =
                [
                  assignment?.reason,
                  assignment?.switchMs
                    ? `含 App 切换约 ${Math.round(assignment.switchMs / 1000)} 秒`
                    : null,
                  assignment?.moves
                    ? `计划已改派 ${assignment.moves} 次`
                    : null,
                  ...(planned?.reasons || []).map((r) => r.message),
                ]
                  .filter(Boolean)
                  .join("；") || "等待可用设备";
            return (
              <article className="ws-queue-job" key={job.id}>
                <div className="ws-queue-head">
                  <AppIcon appId={job.appId} />
                  <div className="ws-queue-name">
                    {readOnly ? (
                      <strong>{taskTitle(job)}</strong>
                    ) : (
                      <button
                        className="text-link"
                        onClick={() => onInspect(job)}
                      >
                        {taskTitle(job)}
                      </button>
                    )}
                    {job.client && (
                      <small className="ws-client-tag">
                        {job.client.name} · {CLIENT_CLASS[job.client.class]}
                      </small>
                    )}
                    {keyword && <small>“{keyword}”</small>}
                  </div>
                  <span
                    className={`ws-badge ${target ? "ws-badge-planned" : "ws-badge-waiting"}`}
                  >
                    {target
                      ? `${binding === "指定设备" ? "指定" : "预计到"} ${target}`
                      : "待分配"}
                  </span>
                </div>
                <div className="ws-queue-body">
                  <dl>
                    <dt>优先级</dt>
                    <dd className={`ws-priority-${tone}`}>
                      {level} · P{job.priority}
                    </dd>
                    <dt>预计到</dt>
                    <dd>{target || "—"}</dd>
                    <dt>等待时间</dt>
                    <dd>{durationLabel(now - job.createdAt)}</dd>
                    <dt>原因</dt>
                    <dd className="ws-queue-reason" title={reason}>
                      {reason}
                    </dd>
                  </dl>
                  <div className="ws-queue-actions">
                    {mode === "sim" && !readOnly && (
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => onAssign(job)}
                      >
                        指派
                      </button>
                    )}
                    {!readOnly && (
                      <button disabled={busy} onClick={() => onCancel(job)}>
                        取消
                      </button>
                    )}
                    <button
                      className="ws-why"
                      onClick={() => onExplain(job.id)}
                      title="为什么在这里、为什么还在等、计划历史"
                    >
                      <Question size={14} />
                      解释
                    </button>
                  </div>
                </div>
              </article>
            );
          })
      ) : (
        <div className="ws-empty">
          <ListBullets size={32} />
          <strong>队列已清空</strong>
          <p>任务领取后会显示在对应设备中。</p>
        </div>
      )}
      {rows.length > 12 && (
        <p className="small muted ws-queue-more">
          显示前 12 个任务，共 {rows.length} 个；完整记录见任务中心。
        </p>
      )}
    </div>
  );
}
// Event types shown in the flow table: label and tone.
const FLOW = {
  queued: ["已入池", "warn"],
  claimed: ["已分配", "ok"],
  checkpoint: ["回执确认", "ok"],
  succeeded: ["已完成", "ok"],
  failed: ["失败", "danger"],
  unknown: ["待核验", "danger"],
  late: ["迟到回执", "muted"],
  cancelled: ["已取消", "muted"],
  "app-rest": ["App 冷却", "warn"],
  "device-rest": ["设备休息", "warn"],
  "job-assignment": ["人工指派", "info"],
  "strategy-applied": ["策略应用", "info"],
  "profile-switch": ["策略切换", "info"],
  "profile-auto": ["自动切换", "info"],
  "loop-policy": ["循环策略", "info"],
  "account-status": ["账号状态", "info"],
  "account-signal": ["平台信号", "danger"],
};
function FlowTable({ events, devicesById, jobsById, onMore }) {
  return (
    <section className="panel ws-flow">
      <div className="ws-flow-head">
        {onMore ? (
          <button className="text-link" onClick={onMore}>
            最新流转 <CaretRight size={14} />
          </button>
        ) : (
          <strong>最新流转</strong>
        )}
        <span>提交 → 动态分配 → 单机串行执行 → 回执确认 → 独立冷却</span>
      </div>
      {events.length ? (
        <div className="table-wrap">
          <table>
            <tbody>
              {events.map((e) => {
                const [label, tone] = FLOW[e.type] || ["事件", "muted"],
                  job = e.jobId && jobsById.get(e.jobId),
                  device = e.deviceId && devicesById.get(e.deviceId);
                return (
                  <tr key={e.id}>
                    <td className="ws-flow-time">
                      <i className={`ws-flow-dot ${tone}`} />
                      {time(e.at)}
                    </td>
                    <td className="ws-flow-label">{label}</td>
                    <td className="ws-flow-subject">
                      {device?.name || (job ? "中央队列" : "—")}
                    </td>
                    <td className="ws-flow-task">
                      {job ? taskTitle(job) : "—"}
                    </td>
                    <td className="ws-flow-message">{e.message || e.type}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted ws-flow-empty">
          暂无活动。读取工作台不会派发任务。
        </p>
      )}
    </section>
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
  onJobs,
  onAdd,
  onRealSubmit,
  // Embedded ops view (V2-5): everything visible, nothing writable.
  readOnly = false,
}) {
  const [view, setView] = useState("screens"),
    [filter, setFilter] = useState("all"),
    [strategyId, setStrategyId] = useState(""),
    [modal, setModal] = useState(null),
    [localError, setLocalError] = useState("");
  const model = useMemo(() => workstationView(state, rack), [state, rack]);
  const [explain, setExplain] = useState(null);
  // Server time advances locally between pushes so the timeline keeps moving.
  const received = useRef({ at: Date.now(), now: model.now });
  if (received.current.now !== model.now)
    received.current = { at: Date.now(), now: model.now };
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!["lanes", "flow"].includes(view)) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [view]);
  const liveNow = model.now + (Date.now() - received.current.at);
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
  const timeline =
    view === "lanes"
      ? liveLanes(state, {
          now: liveNow,
          devices: shown.map((row) => row.device),
        })
      : null;
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
  // Latest flow, newest first: at most three receipts (one per device), so
  // command receipts do not crowd out claims, completions and cooldowns.
  const events = [],
    receipts = new Set();
  for (let i = state.events.length - 1; i >= 0 && events.length < 8; i--) {
    const e = state.events[i];
    if (
      rack &&
      e.deviceId &&
      !model.devices.some((d) => d.device.id === e.deviceId)
    )
      continue;
    if (e.type === "checkpoint") {
      if (receipts.has(e.deviceId) || receipts.size >= 3) continue;
      receipts.add(e.deviceId);
    }
    events.push(e);
  }
  const hosts = [...new Set(shown.map((d) => d.device.host))];
  const jobsById = new Map(state.jobs.map((j) => [j.id, j]));
  return (
    <div className="workstation">
      <div className="ws-metrics">
        {[
          {
            value: model.metrics.total,
            label: "台设备",
            icon: <DeviceMobile size={26} />,
            tone: "blue",
            filter: "all",
          },
          {
            value: model.metrics.running,
            label: "执行中",
            icon: <PlayCircle size={30} weight="fill" />,
            tone: "teal",
            filter: "running",
          },
          {
            value: model.metrics.queued,
            label: "排队任务",
            icon: <ListBullets size={24} weight="bold" />,
            tone: "violet",
            filter: "queue",
          },
          {
            value: model.metrics.cooling,
            label: "App 冷却",
            icon: <Clock size={30} weight="fill" />,
            tone: "amber",
            filter: "cooling",
          },
          {
            value: model.metrics.quarantined,
            label: "待核验",
            icon: <Warning size={30} weight="fill" />,
            tone: "red",
            filter: "quarantined",
          },
        ].map((m) => (
          <button
            className={`ws-metric ws-tone-${m.tone}${filter === m.filter ? " selected" : ""}`}
            key={m.label}
            title={m.filter === "queue" ? "查看中央队列" : "按此状态筛选设备"}
            onClick={() =>
              m.filter === "queue"
                ? document
                    .querySelector(".ws-central-queue")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                : setFilter(m.filter)
            }
          >
            <span className="ws-metric-icon">{m.icon}</span>
            <div>
              <strong>{m.value}</strong>
              <span>{m.label}</span>
            </div>
          </button>
        ))}
      </div>
      <section className="panel ws-toolbar">
        <label>
          <span>机架</span>
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
        {mode === "sim" && !readOnly && (
          <>
            <label className="ws-strategy-select">
              <span>默认策略</span>
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
              className="primary"
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
              应用策略
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
            屏幕
          </button>
          <button
            className={view === "list" ? "selected" : ""}
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <List size={18} />
            列表
          </button>
          <button
            className={view === "lanes" ? "selected" : ""}
            aria-pressed={view === "lanes"}
            onClick={() => setView("lanes")}
          >
            <Rows size={18} />
            泳道
          </button>
          <button
            className={view === "flow" ? "selected" : ""}
            aria-pressed={view === "flow"}
            onClick={() => setView("flow")}
          >
            <FlowArrow size={18} />
            流转
          </button>
        </div>
      </section>
      {mode === "sim" && (
        <div className="ws-policy-line">
          <Info
            size={18}
            alt="冷却与预算统一由节奏账本判定，截止时间只会延长；预计队列随可用资源动态变化。"
          />
          <p>
            {rack ? (
              <>
                {status.snapshot && (
                  <strong>
                    {status.snapshot.name} · v{status.snapshot.version}
                  </strong>
                )}
                {status.state === "modified" && (
                  <em className="ws-modified">参数已手动调整</em>
                )}
                {policyParts(loop?.scheduler, loop?.autoProfile).join(" · ")}
              </>
            ) : (
              `选择一个机架，查看${readOnly ? "" : "和设置"}默认策略`
            )}
          </p>
          {!readOnly && (
            <div className="ws-policy-links">
              {rack && strategy && (
                <button
                  className="text-link"
                  onClick={() => setModal({ type: "shadow" })}
                >
                  影子评估
                </button>
              )}
              {rack && loop && (
                <button
                  className="text-link"
                  onClick={() => setModal({ type: "auto" })}
                >
                  自动切换
                </button>
              )}
              <button className="text-link" onClick={onScenarios}>
                场景与策略 <ArrowRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}
      <div className="ws-main-grid">
        <section className="panel ws-rack">
          <div className="ws-section-head">
            <div className="ws-rack-title">
              <h2>{rack || "全部机架"}</h2>
              <span>
                {shown.length} 台
                {hosts.length === 1
                  ? ` · ${hosts[0]}`
                  : hosts.length
                    ? ` · ${hosts.length} 台宿主机`
                    : ""}
              </span>
            </div>
            <div className="ws-rack-tools">
              {mode === "sim" && (
                <span className="ws-synthetic">
                  <Info size={16} />
                  合成投影 · 非真实截图
                </span>
              )}
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
              {!readOnly && (
                <button
                  className="icon-button"
                  aria-label="管理机架资源"
                  title="管理机架资源"
                  onClick={onRackManage}
                >
                  <Sliders size={20} />
                </button>
              )}
            </div>
          </div>
          {view === "lanes" && shown.length ? (
            <div className="ws-host">
              <LaneChart
                lanes={timeline.lanes}
                start={timeline.start}
                end={timeline.end}
                now={timeline.now}
                ticks={liveTicks(timeline.now)}
                clock={time}
                compact={timeline.lanes.length > 24}
                onBlock={(b) => setExplain(b.jobId)}
                onLane={readOnly ? undefined : (lane) => onOpenDevice(lane.id)}
                onDropPlan={
                  mode === "sim" && !readOnly
                    ? (jobId, lane) => {
                        const job = state.jobs.find((j) => j.id === jobId);
                        if (!job || job.status !== "queued") return;
                        void run(
                          () =>
                            api(`jobs/${jobId}/assignment`, mode, {
                              revision: job.revision || 0,
                              deviceId: lane.id,
                            }),
                          `已指派到 ${lane.name}；不影响其他任务`,
                        );
                      }
                    : undefined
                }
              />
              <p className="ws-lane-note">
                {readOnly
                  ? "实色是已执行或执行中，虚线框是可变的软计划，细带是冷却与休息。点色块看解释。"
                  : "实色是已执行或执行中，虚线框是可变的软计划（可拖到其他泳道指派），细带是冷却与休息。点色块看解释，点设备名打开手机工作台。"}
              </p>
            </div>
          ) : view === "flow" ? (
            <div className="ws-host">
              <FlowView
                state={state}
                rack={rack}
                now={liveNow}
                onStage={(stage) =>
                  stage === "running"
                    ? (setView("screens"), setFilter("running"))
                    : ["queued", "planned", "accepted"].includes(stage)
                      ? document
                          .querySelector(".ws-central-queue")
                          ?.scrollIntoView({ behavior: "smooth" })
                      : null
                }
              />
            </div>
          ) : shown.length ? (
            groups.map((key) => {
              const [r, h] = JSON.parse(key),
                rows = shown.filter(
                  (d) => d.device.rack === r && d.device.host === h,
                );
              return (
                <div className="ws-host" key={key}>
                  {groups.length > 1 && (
                    <div className="ws-host-heading">
                      <strong>
                        {r} <span>/ {h}</span>
                      </strong>
                      <span>{rows.length} 台</span>
                    </div>
                  )}
                  {view === "screens" ? (
                    <div className="ws-screen-grid">
                      {rows.map((row) => (
                        <DeviceTile
                          key={row.device.id}
                          row={row}
                          now={model.now}
                          onOpen={readOnly ? null : onOpenDevice}
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
                                {readOnly ? (
                                  row.device.name
                                ) : (
                                  <button
                                    className="text-link"
                                    onClick={() => onOpenDevice(row.device)}
                                  >
                                    {row.device.name}
                                  </button>
                                )}
                              </td>
                              <td>
                                <span
                                  className={`ws-state ws-state-${row.status}`}
                                >
                                  <i
                                    className={`ws-dot ws-dot-${row.status}`}
                                  />
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
              {!readOnly && (
                <>
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
                </>
              )}
            </div>
          )}
        </section>
        <aside className="panel ws-central-queue">
          <div className="ws-section-head">
            <h2>
              中央任务队列 <span>{model.queue.length}</span>
            </h2>
            {!readOnly && (
              <button
                className="primary ws-submit"
                onClick={() => {
                  setLocalError("");
                  mode === "sim"
                    ? setModal({ type: "submit" })
                    : onRealSubmit();
                }}
              >
                <Plus size={16} />
                提交任务
              </button>
            )}
          </div>
          <p className="ws-queue-note">
            {readOnly
              ? "只读视图：指派、取消与暂停请在设备中心管理台进行。"
              : "未领取可重新指派；预计分配不是执行锁。"}
          </p>
          <QueueRows
            rows={model.queue}
            devicesById={model.devicesById}
            now={model.now}
            mode={mode}
            busy={busy}
            readOnly={readOnly}
            onInspect={onInspect}
            onExplain={setExplain}
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
      <FlowTable
        events={events}
        devicesById={model.devicesById}
        jobsById={jobsById}
        onMore={readOnly ? null : onJobs}
      />
      {mode === "sim" && (
        <p className="ws-footnote">合成投影，不是真实截图。</p>
      )}
      {explain && (
        <ExplainPanel
          state={state}
          mode={mode}
          jobId={explain}
          now={liveNow}
          onClose={() => setExplain(null)}
          onOpenDevice={readOnly ? null : (id) => onOpenDevice(id)}
        />
      )}
      {modal && (
        <Modal
          title={
            {
              submit: "提交模板任务",
              assign: "调整排队任务",
              shadow: "影子评估",
              auto: "按流量自动切换策略",
            }[modal.type]
          }
          onClose={() => setModal(null)}
        >
          {localError && (
            <p className="error" role="alert">
              {localError}
            </p>
          )}
          {modal.type === "shadow" ? (
            <ShadowView mode={mode} rack={rack} strategy={strategy} />
          ) : modal.type === "auto" ? (
            <AutoProfileForm
              loop={loop}
              strategies={strategies}
              busy={busy}
              onSubmit={(body) =>
                act(
                  () => api("strategy-auto", mode, body),
                  body.enabled
                    ? "已启用自动切换；只影响尚未领取的任务"
                    : "已停用自动切换；保留当前策略",
                )
              }
            />
          ) : modal.type === "submit" ? (
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
