import { Desktop, ArrowSquareOut } from "@phosphor-icons/react";
import PhoneProjection from "./PhoneProjection.jsx";
import { appName, jobTitle, labels, time } from "./data.js";
import { commandByCode } from "../server/workflow-catalog.mjs";
const duration = (ms) => `${(Math.max(0, ms || 0) / 1000).toFixed(1)} 秒`;

export default function DevicePresentation({
  device: d,
  state,
  onInspect,
  onWorkbench,
}) {
  if (!d) return <p className="form">设备已不在当前列表中。</p>;
  const now = state.now || Date.now();
  const commands = (state.commands || [])
    .filter((c) => c.deviceId === d.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const current = commands.find((c) => c.status === "running");
  const currentJob = state.jobs.find((j) => j.id === current?.jobId);
  const parentAttempt = state.attempts.find(
    (a) => a.id === d.workflowAttemptId,
  );
  const parent = state.jobs.find((j) => j.id === parentAttempt?.jobId);
  const pending = state.jobs.filter((j) => {
    if (j.status !== "queued") return false;
    if (j.deviceId) return j.deviceId === d.id;
    return (
      !j.placement ||
      (j.placement.rack === d.rack &&
        (!j.placement.host || j.placement.host === d.host))
    );
  });
  const apps = (state.apps || []).filter((a) => a.deviceId === d.id);
  return (
    <div className="device-presentation">
      <section className="presentation-screen">
        <span className="lab-eyebrow">
          SLOT {String(d.slot).padStart(2, "0")} / SIMULATION
        </span>
        <PhoneProjection device={d} />
        <p className="small muted">
          手机内显示最近确认结果；右侧显示当前执行。打开、关闭展示层只读取本中心记录。
        </p>
        <button onClick={onWorkbench}>
          <Desktop size={18} />
          前往工作台调试
        </button>
      </section>
      <div className="presentation-details">
        <section className="presentation-current" aria-label="当前执行">
          <div className="sub-head">
            <h3>当前执行</h3>
            <span className={`status ${d.state}`}>
              {current
                ? "执行中"
                : parent
                  ? "检查点等待"
                  : labels[d.state] || d.state}
            </span>
          </div>
          <strong>
            {currentJob
              ? jobTitle(currentJob)
              : parent
                ? jobTitle(parent)
                : "等待下一条任务"}
          </strong>
          <p className="current-command">
            {current
              ? commandByCode(current.code)?.name
              : parent?.reason || (d.enabled ? "插槽已启用" : "已暂停新领取")}
          </p>
          {current && (
            <p className="small muted">
              <code>{current.code}</code> · 已执行{" "}
              {duration(now - current.createdAt)}
            </p>
          )}
          {parent && (
            <div className="parent-session">
              <div>
                <span>保留的大循环</span>
                <strong>
                  {parent.workflow.nextStep}/{parent.workflow.plan.length} 步
                </strong>
              </div>
              <progress
                aria-label="大循环进度"
                max={parent.workflow.plan.length}
                value={parent.workflow.nextStep}
              />
              <p className="small">
                已插入 {parent.workflow.insertions}/
                {parent.workflow.policySnapshot.maxInsertions} 个小任务 ·
                累计等待{" "}
                {duration(
                  parent.workflow.detourMs +
                    (parent.workflow.detourStartedAt != null
                      ? now - parent.workflow.detourStartedAt
                      : 0),
                )}
              </p>
              {currentJob && currentJob.id !== parent.id && (
                <p className="insertion-note">
                  小任务插入中；父任务仍保留此槽。
                </p>
              )}
            </div>
          )}
        </section>
        <section>
          <h3>App 冷却与最近处理</h3>
          <div className="presentation-apps">
            {apps.map((a) => (
              <article key={a.id}>
                <div>
                  <strong>{appName(a.appId)}</strong>
                  <span className={a.cooldownUntil > now ? "cooling" : "ready"}>
                    {a.cooldownUntil > now
                      ? `冷却 ${duration(a.cooldownUntil - now)}`
                      : "冷却已就绪"}
                  </span>
                </div>
                <small>上次完成 {time(a.lastFinishedAt)}</small>
                {a.rest && (
                  <small>最近随机冷却 {duration(a.rest.durationMs)}</small>
                )}
              </article>
            ))}
          </div>
        </section>
        <section>
          <div className="sub-head">
            <h3>指令流水</h3>
            <span className="small muted">
              最近 {Math.min(commands.length, 8)} 条
            </span>
          </div>
          <div className="presentation-ledger">
            {commands.slice(0, 8).map((c) => (
              <button key={c.id} onClick={() => onInspect({ id: c.jobId })}>
                <span className={`command-dot ${c.appId} ${c.status}`} />
                <span>
                  <strong>{commandByCode(c.code)?.name || c.code}</strong>
                  <small>
                    <code>{c.code}</code> · {time(c.createdAt)}
                  </small>
                </span>
                <span>
                  {labels[c.status] || c.status}
                  <small>
                    {duration((c.completedAt || now) - c.createdAt)}
                  </small>
                </span>
                <ArrowSquareOut size={16} />
              </button>
            ))}
            {!commands.length && (
              <p className="muted small">尚无指令记录，开始演示后自动更新。</p>
            )}
          </div>
        </section>
        <section>
          <h3>等待分配到此槽 · {pending.length}</h3>
          {pending.slice(0, 3).map((j) => (
            <button
              className="presentation-waiting"
              key={j.id}
              onClick={() => onInspect(j)}
            >
              <strong>{jobTitle(j)}</strong>
              <small>
                {state.scheduling?.queue
                  ?.find((q) => q.jobId === j.id)
                  ?.reasons.map((r) => r.message)
                  .join("；") || j.reason}
              </small>
            </button>
          ))}
          {!pending.length && (
            <p className="small muted">当前没有匹配的排队任务。</p>
          )}
        </section>
      </div>
    </div>
  );
}
