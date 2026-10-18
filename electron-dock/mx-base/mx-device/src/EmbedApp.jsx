import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, UserCircle } from "@phosphor-icons/react";
import Workstation from "./Workstation.jsx";
import { Modal } from "./Forms.jsx";
import { api, labels, time, useSnapshot } from "./data.js";
import "./clients.css";

// The workbench embedded in Hub behind its reverse proxy (V2-5, plan §10.1).
// Hub's backend adds the caller key and the viewer's scope; this page holds
// no credentials and offers no writes. ops: the live workbench, read-only.
// client: the caller's own tasks and a summary of the pool.
const CLASS = { interactive: "交互", standard: "标准", batch: "批量" };
const noop = () => {};
const STATUS_TONE = {
  queued: "queued",
  planned: "queued",
  running: "running",
  stopping: "running",
  succeeded: "succeeded",
  failed: "blocked",
  unknown: "unknown",
  cancelled: "blocked",
  expired: "blocked",
  blocked: "blocked",
  skipped: "blocked",
};
const COMPLETION = {
  succeeded: "全部完成",
  exhausted: "完成（来源已无更多结果）",
  partial: "部分完成",
  none: "未采集到数据",
};
const until = (at, now) => {
  if (at == null) return "—";
  const s = Math.round((at - now) / 1000);
  return s <= 0
    ? "现在"
    : s < 90
      ? `${s} 秒后`
      : `${Math.round(s / 60)} 分钟后`;
};

export default function EmbedApp() {
  const [session, setSession] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    api("session")
      .then(setSession)
      .catch((e) => setError(e.message));
  }, []);
  const expired = useCallback(
    () => setError("嵌入会话已失效，请在 Hub 中重新打开"),
    [],
  );
  const { state, live } = useSnapshot("sim", expired);
  if (error)
    return (
      <div className="embed-message" role="alert">
        {error}
      </div>
    );
  if (!session) return <div className="embed-message">正在连接设备中心…</div>;
  return (
    <div className="embed-shell">
      <header className="embed-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          设备中心
        </div>
        <span className="embed-scope">
          <Eye size={16} />
          {session.scope === "ops"
            ? "运维视图 · 只读"
            : `${session.client.name} · 我的任务`}
        </span>
        <span className="embed-spacer" />
        <span className={`live-status live-${live}`}>
          <i />
          {live === "stream" ? "实时" : live === "poll" ? "轮询" : "连接中"}
        </span>
        {session.user && (
          <span className="embed-user">
            <UserCircle size={18} />
            {session.user}
          </span>
        )}
      </header>
      <main className="embed-main">
        {session.scope === "ops" ? (
          <OpsView state={state} />
        ) : (
          <ClientView state={state} />
        )}
      </main>
    </div>
  );
}

function OpsView({ state }) {
  const [rack, setRack] = useState("");
  return (
    <Workstation
      state={state}
      mode="sim"
      busy={false}
      run={noop}
      rack={rack}
      setRack={setRack}
      onOpenDevice={noop}
      onInspect={noop}
      onScenarios={noop}
      onRackManage={noop}
      onJobs={null}
      onAdd={noop}
      onRealSubmit={noop}
      readOnly
    />
  );
}

function ClientView({ state }) {
  const [open, setOpen] = useState(null);
  const pool = state.pool,
    jobs = state.jobs || [];
  // Server time advances locally between pushes.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const received = useRef({ at: Date.now(), now: state.now });
  if (received.current.now !== state.now)
    received.current = { at: Date.now(), now: state.now };
  const now = (state.now || Date.now()) + (Date.now() - received.current.at);
  return (
    <>
      <div className="embed-cards">
        {[
          ["我的排队", state.mine?.queued ?? 0, "violet"],
          ["我的执行中", state.mine?.running ?? 0, "teal"],
          [
            "设备池",
            pool ? `${pool.running}/${pool.devices}` : "—",
            "blue",
            "执行中 / 总数",
          ],
          ["池内排队", pool?.queued ?? "—", "amber", "全部调用方"],
        ].map(([label, value, tone, note]) => (
          <div className={`ws-metric ws-tone-${tone}`} key={label}>
            <div>
              <strong>{value}</strong>
              <span>{label}</span>
              {note && <small>{note}</small>}
            </div>
          </div>
        ))}
      </div>
      <section className="panel embed-jobs">
        <div className="section-head">
          <div>
            <h2>我的任务</h2>
            <p className="muted small">
              只显示本调用方提交的任务；看不到其他调用方的任务、手机画面或账号。
            </p>
          </div>
        </div>
        {!jobs.length ? (
          <p className="muted clients-empty">
            还没有任务。通过 Job API v1 提交后会出现在这里。
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th>进度</th>
                  <th>预计 / 完成</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <button
                        className="text-button embed-job-link"
                        onClick={() => setOpen(j.id)}
                      >
                        {j.name || j.template}
                      </button>
                      <div className="muted">
                        <code>{j.clientRequestId}</code> · {CLASS[j.class]}
                      </div>
                    </td>
                    <td>
                      <span className={`status ${STATUS_TONE[j.status] || ""}`}>
                        {labels[j.status] || j.status}
                      </span>
                      {j.queuePosition && j.status !== "running" && (
                        <div className="muted">队列第 {j.queuePosition} 位</div>
                      )}
                    </td>
                    <td>
                      <div
                        className="embed-progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={j.progress.steps}
                        aria-valuenow={j.progress.completedSteps}
                      >
                        <i
                          style={{
                            width: `${j.progress.steps ? (j.progress.completedSteps / j.progress.steps) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <small className="muted">
                        {j.progress.completedSteps}/{j.progress.steps} 步
                      </small>
                    </td>
                    <td>
                      {j.final ? (
                        time(j.completedAt)
                      ) : j.predicted ? (
                        <>
                          开始 {until(j.predicted.startAt, now)}
                          <div className="muted">
                            完成约 {time(j.predicted.finishAt)}
                          </div>
                        </>
                      ) : j.status === "running" ? (
                        `已开始 ${time(j.startedAt)}`
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="embed-reason">
                      {j.blockers[0]?.message ||
                        (j.final ? j.reason : "") ||
                        "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {open && (
        <Modal
          title="任务结果"
          className="wide-dialog"
          onClose={() => setOpen(null)}
        >
          <JobResult jobId={open} />
        </Modal>
      )}
    </>
  );
}

function JobResult({ jobId }) {
  const [view, setView] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () =>
      api(`jobs/${jobId}`)
        .then((v) => alive && setView(v))
        .catch((e) => alive && setError(e.message));
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [jobId]);
  if (error) return <p className="error form">{error}</p>;
  if (!view) return <p className="muted form">读取中…</p>;
  const r = view.result;
  return (
    <div className="form embed-result">
      <dl className="embed-facts">
        <dt>模板</dt>
        <dd>{view.template}</dd>
        <dt>状态</dt>
        <dd>{labels[view.status] || view.status}</dd>
        <dt>提交</dt>
        <dd>{time(view.createdAt)}</dd>
        <dt>完成</dt>
        <dd>{time(view.completedAt)}</dd>
        {r && (
          <>
            <dt>完成度</dt>
            <dd>{COMPLETION[r.completion]}</dd>
            <dt>证据</dt>
            <dd>
              {r.evidenceSummary.validatedReceipts} 条已核验回执 ·{" "}
              {r.evidenceSummary.source === "simulator" ? "模拟器" : "设备"}
            </dd>
          </>
        )}
      </dl>
      {!r ? (
        <p className="muted">任务结束后在这里显示结果。</p>
      ) : (
        <>
          {r.items.length > 0 && (
            <>
              <h3>
                列表结果 · {r.counts.items} 条
                {r.counts.pages ? ` · ${r.counts.pages} 页` : ""}
              </h3>
              <ul className="embed-items">
                {r.items.slice(0, 30).map((item, i) => (
                  <li key={`${item.id}-${i}`}>
                    {item.title}
                    {item.page ? <small> 第 {item.page} 页</small> : null}
                  </li>
                ))}
              </ul>
            </>
          )}
          {r.records.map((rec) => (
            <div className="embed-record" key={rec.step}>
              <h3>
                第 {rec.step} 步 · <code>{rec.code}</code>
              </h3>
              <p>{rec.fullText || rec.title || JSON.stringify(rec)}</p>
            </div>
          ))}
          {r.resultRef && (
            <p className="muted">
              结果较大，完整列表请调用 <code>{r.resultRef}</code>。
            </p>
          )}
        </>
      )}
      <p className="muted small">
        {view.final ? "" : "任务仍在进行，"}
        数据来自 Job API v1 结果（{r?.schema || "mx-device.result.v1"}）。
      </p>
    </div>
  );
}
