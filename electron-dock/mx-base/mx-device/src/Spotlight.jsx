import { useRef, useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  Circle,
  Crosshair,
  PushPin,
  Question,
} from "@phosphor-icons/react";
import PhoneProjection from "./PhoneProjection.jsx";
import PhoneScreen from "./phone/PhoneScreen.jsx";
import { screenModel } from "./phone/screen-model.mjs";
import { APPS } from "./phone/synth.mjs";
import { appName, jobTitle, time } from "./data.js";
import "./spotlight.css";

// Focus view for demos (workbench "聚焦"): a large phone that follows the
// device that just started a command, what its task is doing step by step
// and why the scheduler put it there, the rack as a filmstrip, and the latest
// events as sentences. Read-only: it changes nothing.
const DWELL_MS = 8000; // stay on a device at least this long while it works
const STRIP_MAX = 24;
const STATUS = {
  running: "执行中",
  idle: "空闲",
  cooling: "冷却中",
  quarantined: "待核验",
  paused: "已暂停",
  offline: "离线",
  reserved: "会话预留",
  suspect: "失联待确认",
};
const EVENT = {
  queued: "入池",
  claimed: "分配",
  checkpoint: "回执",
  succeeded: "完成",
  failed: "失败",
  unknown: "待核验",
  cancelled: "取消",
  "workflow-insert": "插入",
  "lease-returned": "退回",
  "app-rest": "冷却",
  "device-rest": "休息",
  expired: "过期",
};
const seconds = (ms) => `${Math.max(0, Math.round(ms / 1000))} 秒`;

/** Auto-follow: rotate among the phones executing a command, the one shown
 * least recently first; stay DWELL_MS on each while it works. */
function useFeatured(rows, pinned) {
  const current = useRef({ id: null, at: 0, shown: new Map() });
  if (pinned) {
    const row = rows.find((r) => r.device.id === pinned);
    if (row) return row;
  }
  const c = current.current;
  c.shown ||= new Map();
  const kept = rows.find((r) => r.device.id === c.id);
  const wall = Date.now();
  if (kept && kept.status === "running" && wall - c.at < DWELL_MS) return kept;
  const active = rows
    .filter((r) => r.command && r.device.id !== c.id)
    .sort(
      (a, b) =>
        (c.shown.get(a.device.id) || 0) - (c.shown.get(b.device.id) || 0) ||
        b.command.createdAt - a.command.createdAt,
    );
  const next =
    active[0] ||
    (kept?.status === "running" ? kept : null) ||
    rows.find((r) => r.status === "running") ||
    kept ||
    rows[0];
  if (next && next.device.id !== c.id) {
    c.id = next.device.id;
    c.at = wall;
    c.shown.set(next.device.id, wall);
  }
  return next;
}

function receiptLine(p) {
  if (!p) return null;
  if (p.blocks?.length) return `识别到 ${p.blocks.length} 段文字`;
  if (p.liked) return "点赞已确认";
  if (p.detail) return `正文 ${p.detail.content?.length || 0} 字已核验`;
  if (p.page) return `第 ${p.page} 页 · ${p.count ?? 0} 条结果已核验`;
  if (p.count) return `${p.count} 条结果已核验`;
  return p.status || null;
}

function Steps({ job, command, now }) {
  const plan = job.workflow?.plan || [];
  const next = job.workflow?.nextStep || 0;
  const current = command ? command.stepIndex : next;
  // Long plans: the done steps fold, the window follows the current step.
  const from = Math.max(0, Math.min(current - 2, plan.length - 7));
  const shown = plan.slice(from, from + 7);
  return (
    <ol className="sl-steps">
      {from > 0 && <li className="sl-fold">已完成 {from} 步…</li>}
      {shown.map((step, i) => {
        const index = from + i;
        const done = index < next;
        const live = command && index === command.stepIndex;
        const elapsed = live ? now - command.createdAt : 0;
        const estimate = live
          ? command.simulationDurationMs || command.estimatedDurationMs || 1
          : 1;
        return (
          <li
            key={index}
            className={
              done ? "done" : live ? "live" : index === next ? "next" : ""
            }
          >
            {done ? (
              <CheckCircle weight="fill" />
            ) : (
              <Circle weight={live ? "fill" : "regular"} />
            )}
            <span>
              {step.name || step.code}
              {step.page ? ` · 第 ${step.page} 页` : ""}
            </span>
            {live && (
              <i className="sl-bar">
                <b
                  style={{
                    width: `${Math.min(100, (elapsed / estimate) * 100)}%`,
                  }}
                />
              </i>
            )}
          </li>
        );
      })}
      {from + 7 < plan.length && (
        <li className="sl-fold">还有 {plan.length - from - 7} 步</li>
      )}
    </ol>
  );
}

function Story({ row, state, now, onExplain }) {
  const { device: d, job, command, status } = row;
  const p = d.projection;
  if (!job)
    return (
      <div className="sl-story">
        <h3>{STATUS[status] || status} · 等待调度</h3>
        {row.queue.length ? (
          <p>
            下一个计划给它的任务：
            <b>{jobTitle(row.queue[0].job)}</b>
            {row.queue[0].assignment?.startAt &&
              `，约 ${seconds(row.queue[0].assignment.startAt - now)} 后开始`}
          </p>
        ) : (
          <p className="muted">中央队列里暂时没有计划给这台手机的任务。</p>
        )}
        {receiptLine(p) && (
          <p className="sl-receipt">
            上一次回执（{time(p.observedAt)}）：{receiptLine(p)}
          </p>
        )}
      </div>
    );
  const plan = job.workflow?.plan || [];
  const app = APPS[job.appId];
  return (
    <div className="sl-story">
      <div className="sl-job">
        <i style={{ background: app?.bg, color: app?.fg }}>{app?.mark}</i>
        <div>
          <h3>{jobTitle(job)}</h3>
          <small>
            {job.input?.keyword && `「${job.input.keyword}」 · `}
            {job.client ? `${job.client.name} · ` : ""}第{" "}
            {Math.min(
              (job.workflow?.nextStep || 0) + (command ? 1 : 0),
              plan.length,
            )}{" "}
            / {plan.length} 步
            {job.startedAt ? ` · 已执行 ${seconds(now - job.startedAt)}` : ""}
          </small>
        </div>
        {onExplain && (
          <button
            className="ws-why"
            onClick={() => onExplain(job.id)}
            title="为什么在这里、为什么还在等、计划历史"
          >
            <Question size={14} />
            解释
          </button>
        )}
      </div>
      <Steps job={job} command={command} now={now} />
      {receiptLine(p) && p.jobId === job.id && (
        <p className="sl-receipt">最近回执：{receiptLine(p)}</p>
      )}
      {row.attempt?.status === "yielded" && (
        <p className="sl-note">
          大循环停在检查点：可在这里插入小任务，或等冷却后继续。
        </p>
      )}
      {job.reason && (
        <p className="sl-why">
          <b>为什么是这台：</b>
          {job.reason}
        </p>
      )}
    </div>
  );
}

// Events as short sentences: who did what, in the task's own words.
function sentence(e, job, device) {
  const task = job ? `「${jobTitle(job)}」` : "任务";
  if (e.type === "queued") return `${task}进入中央队列`;
  if (e.type === "claimed") return `${device} 开始执行${task}`;
  if (e.type === "succeeded") return `${device} 完成${task}，全部回执已核验`;
  if (e.type === "checkpoint")
    return `${device} 回执已核验：${e.projection?.status || e.message}`;
  const text = e.message || "";
  return device && !text.startsWith(device) ? `${device}：${text}` : text;
}
function Narration({ state, rows }) {
  const ids = new Set(rows.map((r) => r.device.id));
  const names = new Map(rows.map((r) => [r.device.id, r.device.name]));
  const jobs = new Map(state.jobs.map((j) => [j.id, j]));
  const lines = [];
  for (let i = state.events.length - 1; i >= 0 && lines.length < 7; i--) {
    const e = state.events[i];
    if (!EVENT[e.type] || (e.deviceId && !ids.has(e.deviceId))) continue;
    if (!e.deviceId && e.type !== "queued") continue;
    const job = e.jobId && jobs.get(e.jobId);
    if (
      e.type === "queued" &&
      (!job || !rows.some((r) => r.device.rack === job.placement?.rack))
    )
      continue;
    lines.push({ e, job });
  }
  return (
    <ul className="sl-narration" aria-live="polite">
      {lines.map(({ e, job }) => {
        const app = APPS[job?.appId];
        return (
          <li key={e.id || `${e.at}-${e.type}`}>
            <time>{time(e.at)}</time>
            <i style={{ background: app?.bg || "#9aa6b5" }} />
            <b>{EVENT[e.type]}</b>
            <span>{sentence(e, job, names.get(e.deviceId))}</span>
          </li>
        );
      })}
      {!lines.length && <li className="muted">等待第一条调度事件…</li>}
    </ul>
  );
}

export default function Spotlight({
  state,
  rows,
  now,
  onOpenDevice,
  onExplain,
}) {
  const [pinned, setPinned] = useState(null);
  const featured = useFeatured(rows, pinned);
  if (!featured) return <p className="muted sl-empty">这个机架还没有设备。</p>;
  const running = rows.filter((r) => r.status === "running").length;
  // A large rack: the filmstrip keeps the busy phones (and the featured one).
  const strip =
    rows.length > STRIP_MAX
      ? [
          featured,
          ...rows.filter((r) => r.command && r !== featured),
          ...rows.filter((r) => !r.command && r !== featured),
        ].slice(0, STRIP_MAX)
      : rows;
  return (
    <div className="sl">
      <div className="sl-stage">
        <div className="sl-phone">
          <div className="sl-phone-head">
            <strong>{featured.device.name}</strong>
            <span className={`ws-state ws-state-${featured.status}`}>
              {STATUS[featured.status] || featured.status}
            </span>
          </div>
          <PhoneProjection device={featured.device} live={featured} now={now} />
        </div>
        <div className="sl-side">
          <div className="sl-follow">
            <span>
              <Crosshair size={16} />
              {pinned
                ? "已固定这台手机"
                : `自动跟随最新操作 · ${running} 台执行中`}
            </span>
            <button
              onClick={() => setPinned(pinned ? null : featured.device.id)}
            >
              <PushPin size={15} weight={pinned ? "fill" : "regular"} />
              {pinned ? "恢复自动跟随" : "固定这台"}
            </button>
            {onOpenDevice && (
              <button onClick={() => onOpenDevice(featured.device)}>
                <ArrowSquareOut size={15} />
                手机工作台
              </button>
            )}
          </div>
          <Story row={featured} state={state} now={now} onExplain={onExplain} />
          <h4>现场解说</h4>
          <Narration state={state} rows={rows} />
        </div>
      </div>
      <div className="sl-strip" role="list" aria-label="机架上的全部手机">
        {strip.map((row) => (
          <button
            key={row.device.id}
            role="listitem"
            className={`sl-thumb${row.device.id === featured.device.id ? " on" : ""}${row.command ? " busy" : ""}`}
            onClick={() => setPinned(row.device.id)}
            title={`${row.device.name} · ${STATUS[row.status] || row.status}${row.job ? ` · ${jobTitle(row.job)}` : ""}`}
          >
            <span className="ps-frame">
              <PhoneScreen
                tile
                model={screenModel({
                  device: row.device,
                  projection: row.device.projection,
                  command: row.command,
                  attempt: row.attempt,
                  job: row.job,
                  status: row.status,
                  now,
                  cooldownUntil: row.cooldownUntil,
                })}
              />
            </span>
            <small>{row.device.name}</small>
            <em>{row.job ? appName(row.job.appId) : STATUS[row.status]}</em>
          </button>
        ))}
      </div>
      {rows.length > STRIP_MAX && (
        <p className="sl-strip-note">
          共 {rows.length} 台，下方只列出执行中的前 {STRIP_MAX}{" "}
          台；选择机架可看全部。
        </p>
      )}
    </div>
  );
}
