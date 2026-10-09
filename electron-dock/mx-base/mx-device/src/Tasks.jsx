import { FileText, Clock, ArrowSquareOut } from "@phosphor-icons/react";
import { labels, time, jobTitle } from "./data.js";
export function Tasks({ jobs, devices, onInspect, onCancel }) {
  const names = new Map(devices.map((d) => [d.id, d.name])),
    rows = [...jobs].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="table-scroll task-table">
      <table>
        <thead>
          <tr>
            <th>任务</th>
            <th>优先级</th>
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
                <small className="task-reason">{j.reason}</small>
              </td>
              <td>
                {j.priority} ·{" "}
                {j.priority < 3 ? "高" : j.priority > 6 ? "后台" : "普通"}
              </td>
              <td>
                <span className={`status ${j.status}`}>{labels[j.status]}</span>
              </td>
              <td>{names.get(j.lastDeviceId || j.deviceId) || "待分配"}</td>
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
                <td>#{i + 1}</td>
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
