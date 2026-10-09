import { FileText, Clock, ArrowSquareOut } from "@phosphor-icons/react";
import { useState } from "react";
import {
  labels,
  time,
  jobTitle,
  appName,
  estimatedDuration,
  taskLane,
} from "./data.js";
import { Capacity } from "./Racks.jsx";
export function Tasks({ jobs, devices, scheduling, onInspect, onCancel }) {
  const queue = new Map((scheduling?.queue || []).map((q) => [q.jobId, q]));
  const names = new Map(devices.map((d) => [d.id, d.name])),
    rows = [...jobs].sort((a, b) => {
      const order = { running: 0, queued: 1 };
      return (
        (order[a.status] ?? 2) - (order[b.status] ?? 2) ||
        (a.status === "queued" && b.status === "queued"
          ? (queue.get(a.id)?.order || 0) - (queue.get(b.id)?.order || 0)
          : b.createdAt - a.createdAt)
      );
    });
  return (
    <div className="table-scroll task-table">
      <table>
        <thead>
          <tr>
            <th>任务</th>
            <th>优先级 / 耗时</th>
            <th>状态</th>
            <th>设备</th>
            <th>
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((j) => (
            <tr key={j.id}>
              <td>
                <button
                  className="text-button"
                  onClick={() => onInspect(j)}
                  title="查看执行证据"
                >
                  {jobTitle(j)}
                  <ArrowSquareOut size={13} />
                </button>
                <small className="task-reason">
                  {queue
                    .get(j.id)
                    ?.reasons.map((r) => r.message)
                    .join("；") || j.reason}
                </small>
                {queue.has(j.id) && (
                  <small className="task-reason">
                    排序 #{queue.get(j.id).order} · 已等待{" "}
                    {Math.floor(queue.get(j.id).waitMs / 1000)} 秒
                  </small>
                )}
              </td>
              <td>
                {j.priority} ·{" "}
                {j.priority < 3 ? "高" : j.priority > 6 ? "后台" : "普通"}
                <small className="task-reason">
                  预计 {estimatedDuration(j) / 1000} 秒 ·{" "}
                  {taskLane(j) === "short" ? "短任务" : "长任务"}
                </small>
                {queue.has(j.id) && (
                  <small className="task-reason">
                    当前有效 {queue.get(j.id).effectivePriority}
                  </small>
                )}
              </td>
              <td>
                <span className={`status ${j.status}`}>{labels[j.status]}</span>
              </td>
              <td>
                {names.get(j.lastDeviceId || j.deviceId) || "待分配"}
                {j.placement && (
                  <small className="task-reason">
                    {j.placement.rack}
                    {j.placement.host
                      ? ` / ${j.placement.host}`
                      : " / 任意主机"}
                  </small>
                )}
              </td>
              <td>
                {j.status === "queued" && (
                  <button
                    className="text-button subtle"
                    onClick={() => onCancel(j)}
                  >
                    取消
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <div className="empty">
          <FileText size={32} weight="light" />
          <p>选择一个演示场景，查看任务如何排队与执行。</p>
        </div>
      )}
    </div>
  );
}
export function Scheduler({
  state,
  busy,
  onInspect,
  onCancel,
  onSubmit,
  onScene,
  onReplay,
}) {
  const [status, setStatus] = useState("active"),
    [rack, setRack] = useState("");
  const active = state.jobs.some((j) =>
    ["queued", "running"].includes(j.status),
  );
  const devices = new Map(state.devices.map((d) => [d.id, d]));
  const jobs = state.jobs.filter(
    (j) =>
      (!rack ||
        j.placement?.rack === rack ||
        devices.get(j.deviceId || j.lastDeviceId)?.rack === rack) &&
      (status === "all" ||
        (status === "active"
          ? ["queued", "running"].includes(j.status)
          : status === "finished"
            ? !["queued", "running", "unknown"].includes(j.status)
            : j.status === status)),
  );
  return (
    <div className="scheduler-page">
      <Capacity counts={state.scheduling?.counts} />
      <section className="panel">
        <div className="section-head">
          <div>
            <h2>任务池与调度</h2>
            <p className="small muted">
              排队 → 条件匹配 → 独占执行槽 → 保存回执
            </p>
          </div>
          <button className="primary" onClick={onSubmit}>
            提交任务
          </button>
        </div>
        <div className="panel-body">
          <div className="scheduler-rules">
            <p>
              <strong>1–9 优先级</strong>
              <span>
                1 最高，每等待 30 秒提升一级。新任务同级短任务优先；等待满 30
                秒后同有效优先级按入池顺序。
              </span>
            </p>
            <p>
              <strong>两层任务循环</strong>
              <span>
                外层选任务与
                App；内层执行步骤、验收回执。整段会话独占手机，耗时估计不触发中断。
              </span>
            </p>
            <p>
              <strong>故障保留证据</strong>
              <span>
                真机结果未知即隔离，不自动跨机重试。未派发任务留在池中。
              </span>
            </p>
          </div>
          <div className="resource-filters task-filters">
            <label>
              任务状态
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="active">进行中与排队</option>
                <option value="queued">排队中</option>
                <option value="running">执行中</option>
                <option value="unknown">结果待核验</option>
                <option value="finished">已结束</option>
                <option value="all">全部记录</option>
              </select>
            </label>
            <label>
              任务机架
              <select value={rack} onChange={(e) => setRack(e.target.value)}>
                <option value="">全部（含未绑定）</option>
                {[...new Set(state.devices.map((d) => d.rack))].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <span className="small muted">
              {jobs.length} 个任务 · 快照 {time(state.scheduling?.at)}
            </span>
          </div>
          <Tasks
            jobs={jobs}
            devices={state.devices}
            scheduling={state.scheduling}
            onInspect={onInspect}
            onCancel={onCancel}
          />
          <p className="small muted">
            排序号是当前优先级顺序。依赖或设备不匹配时可跳过等待项；候选条件满足后仍需领取核验，不承诺开始时间。展示全部活动任务及最近
            100 条结束记录（另含活动依赖）。
          </p>
        </div>
      </section>
      {onScene && (
        <section className="panel">
          <div className="section-head">
            <h2>模拟调度演练</h2>
          </div>
          <div className="panel-body">
            <p className="muted">
              一机双 App 会设置首台设备：小红书冷却 12 秒、微博 6 秒、整机间隔
              0.3
              秒，策略在演示后保留。演练会重新准备模拟设备；已有冷却与资源并发策略继续生效。双机接管时，在工作台对正在执行的
              A 注入模拟断线。
            </p>
            <div className="button-row">
              <button
                disabled={busy || active}
                onClick={() => onScene("multiapp")}
              >
                一机双 App 冷却
              </button>
              <button disabled={busy || active} onClick={() => onScene("five")}>
                五任务串行
              </button>
              <button
                disabled={busy || active}
                onClick={() => onScene("priority")}
              >
                迟到高优先级
              </button>
              <button
                disabled={busy || active}
                onClick={() => onScene("failover")}
              >
                双机断线接管
              </button>
            </div>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="section-head">
          <h2>调度事件</h2>
        </div>
        <div className="panel-body">
          <Events events={state.events} onReplay={onReplay} />
        </div>
      </section>
    </div>
  );
}
export function Events({ events, onReplay }) {
  return (
    <div className="events">
      {events.length ? (
        <ol>
          {events
            .slice(-30)
            .reverse()
            .map((e) => (
              <li key={e.id}>
                <time>{time(e.at)}</time>
                <span>{e.message}</span>
                {e.projection && (
                  <button className="text-button" onClick={() => onReplay(e)}>
                    回放此刻
                  </button>
                )}
              </li>
            ))}
        </ol>
      ) : (
        <div className="empty">
          <Clock size={30} weight="light" />
          <p>尚无事件</p>
        </div>
      )}
    </div>
  );
}
export function JobDetail({ detail }) {
  if (!detail) return <p className="panel-body">读取中…</p>;
  return (
    <div className="form">
      <h3>{jobTitle(detail.job)}</h3>
      <p>
        {labels[detail.job.status]} · {detail.job.reason}
      </p>
      <p className="small muted">任务 ID：{detail.job.id}</p>
      <p className="small muted">
        预计 {estimatedDuration(detail.job) / 1000} 秒 ·
        整段会话独占执行。预计耗时不含排队和冷却，不承诺开始或完成时间。
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>尝试</th>
              <th>状态</th>
              <th>开始 / 租约</th>
              <th>检查点</th>
            </tr>
          </thead>
          <tbody>
            {detail.attempts.map((a, i) => (
              <tr key={a.id}>
                <td>
                  #{i + 1}
                  <small className="task-reason">{appName(a.appId)}</small>
                </td>
                <td>
                  {labels[a.status] || a.status}
                  {a.lateEvidence ? " · 有迟到证据" : ""}
                </td>
                <td>
                  {time(a.createdAt)} / {time(a.leaseUntil)}
                </td>
                <td>{a.checkpoints?.length || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>查看已保存的完整结果与尝试证据（可能包含访问令牌）</summary>
        <pre>{JSON.stringify(detail, null, 2)}</pre>
      </details>
    </div>
  );
}
