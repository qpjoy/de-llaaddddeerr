import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { api, appName, jobTitle, labels, time } from "./data.js";

const secs = (ms) =>
  ms == null
    ? "—"
    : Math.abs(ms) < 60000
      ? `${Math.round(ms / 100) / 10} 秒`
      : `${Math.round(ms / 6000) / 10} 分钟`;

/** Why a job is where it is (plan and alternatives), why it still waits
 * (ledger blockers and earliest start) and how its plan changed. */
export default function ExplainPanel({
  state,
  mode = "sim",
  jobId,
  now,
  onClose,
  onOpenDevice,
}) {
  const job = state.jobs.find((j) => j.id === jobId);
  // The live queue lists the first entries only; fetch this job's entry from
  // the latest full plan, and refresh it while the panel stays open.
  const [fetched, setFetched] = useState(null);
  const queued = job?.status === "queued";
  useEffect(() => {
    setFetched(null);
    let alive = true;
    const load = () =>
      api(`explain?jobId=${jobId}&mode=${mode}`, null)
        .then((value) => alive && setFetched(value))
        .catch(() => {});
    void load();
    // Plans move while the job waits; history is fixed once it runs.
    const timer = queued ? setInterval(load, 3000) : null;
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [jobId, mode, queued]);
  const devices = new Map(state.devices.map((d) => [d.id, d]));
  const name = (id) => devices.get(id)?.name || "—";
  if (!job)
    return (
      <aside className="explain-panel" aria-label="解释面板">
        <div className="explain-head">
          <strong>任务已不在当前视图</strong>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </aside>
    );
  const entry =
    fetched?.entry ||
    (state.scheduling?.queue || []).find((q) => q.jobId === jobId);
  const plan = entry?.poolAssignment;
  const attempt = state.attempts
    .filter((a) => a.jobId === jobId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const target = plan?.deviceId || job.deviceId;
  const app = (state.scheduling?.devices || [])
    .find((d) => d.deviceId === target)
    ?.apps.find((a) => a.appId === job.appId);
  const blockers = [
    ...(entry?.reasons || []),
    ...(app?.blockers || []).filter(
      (b) => !(entry?.reasons || []).some((r) => r.code === b.code),
    ),
  ];
  return (
    <aside className="explain-panel" aria-label="解释面板">
      <div className="explain-head">
        <div>
          <small>
            {appName(job.appId)} · P{job.priority}
          </small>
          <strong>{jobTitle(job)}</strong>
          <span className={`status ${job.status}`}>
            {labels[job.status] || job.status}
          </span>
        </div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {job.status === "queued" && (
        <section>
          <h4>为什么在这里</h4>
          {plan ? (
            <>
              <p>
                计划到 <b>{name(plan.deviceId)}</b>：{plan.reason}
              </p>
              <dl>
                <dt>预计开始</dt>
                <dd>
                  {time(plan.startAt)}
                  {plan.startAt > now
                    ? `（再等 ${secs(plan.startAt - now)}）`
                    : "（可立即开始，等待领取）"}
                </dd>
                <dt>预计完成</dt>
                <dd>{time(plan.finishAt)}</dd>
                <dt>耗时</dt>
                <dd>
                  {secs(plan.durationMs)}
                  {plan.switchMs ? ` + App 切换 ${secs(plan.switchMs)}` : ""}
                </dd>
                <dt>同 App 亲和</dt>
                <dd>{plan.affinity ? "是（复用前台 App）" : "否"}</dd>
                {plan.candidates != null && (
                  <>
                    <dt>候选设备</dt>
                    <dd>{plan.candidates} 台</dd>
                  </>
                )}
              </dl>
              {plan.sticky && (
                <p className="muted small">
                  稳定性：改派可提前 {secs(plan.sticky.gainMs)}，门槛{" "}
                  {secs(plan.sticky.thresholdMs)}，
                  {plan.sticky.kept ? "保留原计划" : "已改派"}。
                </p>
              )}
              {plan.alternatives?.length > 0 && (
                <table className="explain-table">
                  <thead>
                    <tr>
                      <th>其他候选</th>
                      <th>开始</th>
                      <th>完成相差</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.alternatives.map((alt) => (
                      <tr key={alt.deviceId}>
                        <td>
                          {name(alt.deviceId)}
                          {alt.affinity && <small> · 亲和</small>}
                        </td>
                        <td>{time(alt.startAt)}</td>
                        <td>+{secs(alt.finishAt - plan.finishAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : (
            <p className="muted">
              {job.deviceId
                ? `已指定 ${name(job.deviceId)}，等待该设备可用`
                : "此机架未启用调度池，或暂无可规划的设备"}
            </p>
          )}
        </section>
      )}
      {job.status === "queued" && (
        <section>
          <h4>为什么还在等</h4>
          {blockers.length ? (
            <ul>
              {blockers.map((b, i) => (
                <li key={`${b.code}-${i}`}>
                  {b.message}
                  {b.until > now && <small> · 截止 {time(b.until)}</small>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">没有阻塞，等待下一轮领取。</p>
          )}
          <p className="small muted">
            已等待 {secs(now - job.createdAt)}
            {plan ? `；最早可开始 ${time(plan.startAt)}` : ""}
          </p>
        </section>
      )}
      {attempt && (
        <section>
          <h4>
            {["running", "yielded"].includes(attempt.status)
              ? "当前执行"
              : "最近一次执行"}
          </h4>
          <dl>
            <dt>设备</dt>
            <dd>
              {onOpenDevice ? (
                <button
                  className="text-link"
                  onClick={() => onOpenDevice(attempt.deviceId)}
                >
                  {name(attempt.deviceId)}
                </button>
              ) : (
                name(attempt.deviceId)
              )}
            </dd>
            <dt>状态</dt>
            <dd>{labels[attempt.status] || attempt.status}</dd>
            <dt>开始</dt>
            <dd>{time(attempt.dispatchedAt ?? attempt.createdAt)}</dd>
            {attempt.queuedMs != null && (
              <>
                <dt>排队用时</dt>
                <dd>{secs(attempt.queuedMs)}</dd>
              </>
            )}
            {attempt.executor === "agent" && (
              <>
                <dt>租约</dt>
                <dd>
                  token {attempt.token} · seq {attempt.seq || 0}
                  {attempt.status === "running" &&
                    ` · 剩余 ${secs(attempt.leaseUntil - now)}`}
                </dd>
              </>
            )}
          </dl>
        </section>
      )}
      <section>
        <h4>计划历史</h4>
        {fetched?.planHistory?.length ? (
          <ol className="explain-history">
            {[...fetched.planHistory].reverse().map((h, i) => (
              <li key={i}>
                <time>{time(h.at)}</time>
                <span>
                  {h.from ? `${name(h.from)} → ` : ""}
                  {name(h.to)}
                  <small>
                    {h.reason}
                    {h.gainMs != null ? `；提前 ${secs(h.gainMs)}` : ""}
                  </small>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted small">没有改派记录。</p>
        )}
      </section>
    </aside>
  );
}
