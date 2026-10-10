import { useState } from "react";
import {
  PlayCircle,
  SlidersHorizontal,
  Code,
  Plus,
  Clock,
  CheckCircle,
  DeviceMobile,
} from "@phosphor-icons/react";
import { api, time, appName, jobTitle, labels } from "./data.js";
import { Modal } from "./Forms.jsx";
import { requestId } from "./request-id.mjs";
import {
  COMMANDS,
  DEMO_RACK,
  commandByCode,
} from "../server/workflow-catalog.mjs";
const defaults = {
  maxInsertions: 3,
  maxDetourMs: 15000,
  windowMs: 60000,
  smallLimit: 3,
  largeLimit: 1,
  cooldownMinMs: 4000,
  cooldownMaxMs: 8000,
  commandDelayMs: 1400,
};
const seconds = (n) => `${(Math.max(0, n || 0) / 1000).toFixed(1)}s`;
const latestDefinitions = (rows) =>
  rows.filter(
    (d) => !rows.some((x) => x.code === d.code && x.version > d.version),
  );

export default function SchedulerLab({
  state,
  mode,
  busy,
  run,
  onInspect,
  onDevices,
  failure,
  notice,
}) {
  const [selected, setSelected] = useState(null),
    [modal, setModal] = useState(null);
  const devices = state.devices
    .filter((d) => d.rack === DEMO_RACK && d.slot)
    .sort((a, b) => a.slot - b.slot);
  const device = devices.find((d) => d.id === selected) || devices[0];
  const jobs = state.jobs.filter(
    (j) => j.workflow && j.placement?.rack === DEMO_RACK,
  );
  const active = state.jobs.some((j) =>
    ["queued", "running"].includes(j.status),
  );
  const latestRun = [...jobs]
    .filter((j) => j.runId)
    .sort((a, b) => b.createdAt - a.createdAt)[0]?.runId;
  const currentJobs = latestRun
    ? jobs.filter((j) => j.runId === latestRun || !j.runId)
    : jobs;
  const ids = new Set(currentJobs.map((j) => j.id));
  const commands = (state.commands || []).filter((c) => ids.has(c.jobId));
  const now = state.now || Date.now();
  const policy = state.loopPolicies?.find((p) => p.rack === DEMO_RACK) || {
    ...defaults,
    revision: 0,
  };
  const defs = latestDefinitions(state.definitions || []);
  const byJob = new Map(state.jobs.map((j) => [j.id, j]));
  const selectedCommands = commands
    .filter((c) => c.deviceId === device?.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const pending = state.jobs.filter(
    (j) =>
      j.status === "queued" &&
      (j.deviceId === device?.id ||
        (!j.deviceId && j.placement?.rack === DEMO_RACK)),
  );
  const start = () =>
    run(
      () => api("scenarios", "sim", { kind: "rack20", key: requestId() }),
      "20 条模拟任务已入池，观察插槽、检查点插入和冷却时间线",
    );
  if (mode !== "sim")
    return (
      <section className="panel empty">
        <h2>组合调度当前仅模拟</h2>
        <p>
          真实设备保留已有截图、状态与 PoC
          能力。应用启动、OCR、点赞及检查点恢复须先完成 adapter 契约与验收。
        </p>
        <button onClick={onDevices}>查看真实设备</button>
      </section>
    );
  return (
    <div className="lab">
      <section className="panel lab-intro">
        <div>
          <span className="lab-eyebrow">SIMULATION / 10 SLOTS</span>
          <h2>看见任务怎样流过一座机架</h2>
          <p className="muted">
            5 个大循环 + 15
            个小任务。每槽一条指令流，检查点可插入，冷却独立计时。
          </p>
        </div>
        <div className="button-row">
          <button className="primary" disabled={busy || active} onClick={start}>
            <PlayCircle size={20} />
            开始 20 任务演示
          </button>
          <button
            disabled={busy || !devices.length}
            onClick={() => setModal("policy")}
          >
            <SlidersHorizontal size={18} />
            循环策略
          </button>
        </div>
      </section>
      <div className="lab-metrics">
        {[
          ["插槽", `${devices.length} / 10`],
          ["执行指令", commands.filter((c) => c.status === "running").length],
          ["等待任务", currentJobs.filter((j) => j.status === "queued").length],
          [
            "任务完成",
            `${currentJobs.filter((j) => j.status === "succeeded").length} / ${currentJobs.length || 20}`,
          ],
          [
            "已确认指令",
            commands.filter((c) => c.status === "succeeded").length,
          ],
        ].map(([k, v]) => (
          <div key={k}>
            <span>{k}</span>
            <strong>{v}</strong>
          </div>
        ))}
      </div>
      <section className="panel lab-rack">
        <div className="section-head">
          <div>
            <h2>{DEMO_RACK}</h2>
            <p className="small muted">
              每个大任务最多插入 {policy.maxInsertions} 个小任务 · 插入预算{" "}
              {policy.maxDetourMs / 1000} 秒 · 每条模拟指令{" "}
              {policy.commandDelayMs / 1000} 秒
            </p>
          </div>
          <button
            disabled={!devices.length || busy}
            onClick={() => setModal("job")}
          >
            <Plus size={17} />
            提交定义任务
          </button>
        </div>
        <div className="slot-grid">
          {Array.from({ length: 10 }, (_, i) => {
            const d = devices.find((d) => d.slot === i + 1),
              running = commands.find(
                (c) => c.deviceId === d?.id && c.status === "running",
              ),
              job = byJob.get(running?.jobId);
            const parentAttempt = state.attempts.find(
                (a) => a.id === d?.workflowAttemptId,
              ),
              parent = byJob.get(parentAttempt?.jobId);
            const apps = (state.apps || []).filter((a) => a.deviceId === d?.id);
            return (
              <button
                key={i}
                className={`slot-card ${d?.id === device?.id ? "selected" : ""} ${running ? "working" : ""}`}
                disabled={!d}
                onClick={() => setSelected(d.id)}
                aria-label={`查看插槽 ${String(i + 1).padStart(2, "0")}`}
                aria-pressed={d?.id === device?.id}
              >
                <div className="slot-head">
                  <span className="slot-number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>
                    {!d
                      ? "待创建"
                      : d.state === "quarantined"
                        ? "隔离待核验"
                        : running
                          ? appName(running.appId)
                          : parent
                            ? "检查点等待"
                            : !d.enabled
                              ? "已暂停"
                              : "空闲"}
                  </span>
                  <DeviceMobile size={19} />
                </div>
                <strong className="slot-job">
                  {job?.workflow?.name ||
                    parent?.workflow?.name ||
                    "等待任务分配"}
                </strong>
                <span className="slot-command">
                  {running
                    ? running.code
                    : parent
                      ? parent.reason
                      : "一个物理执行槽"}
                </span>
                {parent ? (
                  <>
                    <progress
                      max={parent.workflow.plan.length}
                      value={parent.workflow.nextStep}
                    />
                    <span className="small">
                      大循环 {parent.workflow.nextStep}/
                      {parent.workflow.plan.length} · 已插入{" "}
                      {parent.workflow.insertions}/
                      {parent.workflow.policySnapshot.maxInsertions}
                    </span>
                  </>
                ) : (
                  <span className="slot-progress-placeholder">
                    {job
                      ? `小循环 ${job.workflow.nextStep}/${job.workflow.plan.length}`
                      : "—"}
                  </span>
                )}
                <div className="slot-apps">
                  {apps.map((a) => (
                    <span
                      key={a.appId}
                      className={a.cooldownUntil > now ? "cooling" : ""}
                    >
                      {appName(a.appId)}{" "}
                      {a.cooldownUntil > now
                        ? seconds(a.cooldownUntil - now)
                        : "就绪"}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
        <p className="small muted lab-foot">
          插槽是本中心的模拟资源。点击插槽查看指令与累计时间；演示会保留任务、策略和冷却历史。
        </p>
      </section>
      <Timeline
        devices={devices}
        commands={commands}
        jobs={currentJobs}
        apps={state.apps || []}
        now={now}
        onInspect={onInspect}
        byJob={byJob}
      />
      {device && (
        <div className="lab-details">
          <section className="panel">
            <div className="section-head">
              <h2>插槽 {String(device.slot).padStart(2, "0")} · 执行账本</h2>
              <button
                className="text-button"
                disabled={busy || (!device.enabled && device.state !== "idle")}
                onClick={() =>
                  run(
                    () =>
                      api(`devices/${device.id}/control`, mode, {
                        action: device.enabled ? "pause" : "enable",
                        revision: device.revision,
                      }),
                    device.enabled
                      ? "已停止新领取；保留中的大任务继续收尾"
                      : "已启用插槽",
                  )
                }
              >
                {device.enabled ? "暂停新领取" : "启用插槽"}
              </button>
            </div>
            <div className="panel-body">
              <div className="lab-totals">
                <span>
                  本轮指令累计
                  <strong>
                    {seconds(
                      selectedCommands.reduce(
                        (n, c) => n + ((c.completedAt || now) - c.createdAt),
                        0,
                      ),
                    )}
                  </strong>
                </span>
                <span>
                  本轮指令数<strong>{selectedCommands.length}</strong>
                </span>
                <span>
                  等待此槽 / 未绑定<strong>{pending.length}</strong>
                </span>
              </div>
              <div className="lab-app-history">
                {(state.apps || [])
                  .filter((a) => a.deviceId === device.id)
                  .map((a) => {
                    const recent = (a.recentRuns || []).filter(
                      (r) => r.at > now - policy.windowMs,
                    );
                    return (
                      <article key={a.appId}>
                        <strong>{appName(a.appId)}</strong>
                        <p>
                          {policy.windowMs / 1000}s 内完成{" "}
                          {recent.filter((r) => r.loop === "small").length} 小 /{" "}
                          {recent.filter((r) => r.loop === "large").length} 大
                        </p>
                        <p className="small muted">
                          本轮计数{" "}
                          {
                            (a.burstRuns || []).filter(
                              (r) =>
                                r.at > now - policy.windowMs &&
                                r.loop === "small",
                            ).length
                          }
                          /{policy.smallLimit} 小 ·{" "}
                          {
                            (a.burstRuns || []).filter(
                              (r) =>
                                r.at > now - policy.windowMs &&
                                r.loop === "large",
                            ).length
                          }
                          /{policy.largeLimit} 大
                        </p>
                        <p className="small">
                          {a.rest
                            ? `最近抽取 ${seconds(a.rest.durationMs)} · 截止 ${time(a.rest.until)}`
                            : "尚未触发窗口冷却"}
                        </p>
                      </article>
                    );
                  })}
              </div>
              <div className="command-ledger">
                {selectedCommands.slice(0, 24).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => onInspect(byJob.get(c.jobId))}
                  >
                    <span className={`command-dot ${c.appId} ${c.status}`} />
                    <span>
                      <strong>{c.code}</strong>
                      <small>
                        {c.loop === "large" ? "大循环" : "小循环"} ·{" "}
                        {time(c.createdAt)} →{" "}
                        {c.completedAt ? time(c.completedAt) : "执行中"}
                      </small>
                    </span>
                    <span>
                      {seconds((c.completedAt || now) - c.createdAt)}
                      <small>{labels[c.status] || c.status}</small>
                    </span>
                  </button>
                ))}
                {!selectedCommands.length && (
                  <p className="muted">此槽尚无指令回执。</p>
                )}
              </div>
            </div>
          </section>
          <section className="panel">
            <div className="section-head">
              <h2>等待与任务定义</h2>
              <button
                className="text-button"
                onClick={() => setModal("definition")}
              >
                <Code size={18} />
                编辑定义
              </button>
            </div>
            <div className="panel-body">
              <p className="small muted">
                HTTP
                请求按定义版本展开。大小循环是执行契约，不由名称或预计耗时推断。
              </p>
              {pending.slice(0, 8).map((j) => (
                <button
                  className="lab-pending"
                  key={j.id}
                  onClick={() => onInspect(j)}
                >
                  <span>
                    {jobTitle(j)}
                    <small>
                      优先级 {j.priority} · 已等待 {seconds(now - j.createdAt)}
                    </small>
                    <small>
                      {state.scheduling?.queue
                        ?.find((q) => q.jobId === j.id)
                        ?.reasons?.map((r) => r.message)
                        .join("；") || j.reason}
                    </small>
                  </span>
                  <span>{j.deviceId ? "绑定此槽" : "待选槽"}</span>
                </button>
              ))}
              <div className="definition-list">
                {defs.map((d) => (
                  <div key={d.id}>
                    <strong>{d.name}</strong>
                    <span>
                      {d.loop === "large" ? "大" : "小"}循环 ·{" "}
                      {d.steps.reduce((n, s) => n + s.repeat, 0)} 条指令 · v
                      {d.version}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}
      <section className="panel">
        <div className="section-head">
          <h2>指令码与 adapter 能力</h2>
          <span className="small muted">当前全部组合指令仅模拟执行</span>
        </div>
        <div className="table-scroll">
          <table className="command-map">
            <thead>
              <tr>
                <th>指令码</th>
                <th>能力</th>
                <th>执行/映射状态</th>
              </tr>
            </thead>
            <tbody>
              {COMMANDS.map((c) => (
                <tr key={c.code}>
                  <td>
                    <code>{c.code}</code>
                  </td>
                  <td>
                    {c.name}
                    <small className="task-reason">
                      {c.effect === "write"
                        ? "外部写动作（仅模拟）"
                        : c.effect === "read"
                          ? "读取/验证"
                          : "上下文操作"}
                    </small>
                  </td>
                  <td>{c.mapping}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {modal && (
        <Modal
          title={
            modal === "policy"
              ? "循环与随机冷却策略"
              : modal === "definition"
                ? "版本化任务定义"
                : "按定义提交模拟任务"
          }
          onClose={() => setModal(null)}
        >
          {failure && notice && (
            <p className="feedback error" role="alert">
              {notice}
            </p>
          )}
          {modal === "policy" ? (
            <LoopPolicyForm
              policy={policy}
              busy={busy}
              onSubmit={async (b) => {
                if (
                  await run(
                    () =>
                      api("loop-policy", mode, {
                        ...b,
                        rack: DEMO_RACK,
                        revision: policy.revision,
                      }),
                    "循环策略已保存；在途大任务保留原插入预算",
                  )
                )
                  setModal(null);
              }}
            />
          ) : modal === "definition" ? (
            <DefinitionForm
              definitions={state.definitions || []}
              busy={busy}
              onSubmit={async (b) => {
                if (
                  await run(
                    () => api("task-definitions", mode, b),
                    "新版本已保存，原任务定义不变",
                  )
                )
                  setModal(null);
              }}
            />
          ) : (
            <WorkflowForm
              definitions={defs}
              devices={devices}
              busy={busy}
              onSubmit={async (b) => {
                if (
                  await run(
                    () =>
                      api("jobs", mode, {
                        ...b,
                        rack: DEMO_RACK,
                      }),
                    "定义任务已进入持久队列",
                  )
                )
                  setModal(null);
              }}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
function Timeline({ devices, commands, jobs, apps, now, onInspect, byJob }) {
  const start = Math.min(now, ...jobs.map((j) => j.createdAt)),
    span = Math.max(60000, Math.ceil((now - start + 10000) / 30000) * 30000);
  const rests = apps
    .flatMap((a) =>
      (a.restHistory || []).map((r) => ({
        ...r,
        deviceId: a.deviceId,
        appId: a.appId,
      })),
    )
    .filter((r) => r.at >= start);
  return (
    <section className="panel">
      <div className="section-head">
        <div>
          <h2>插槽时间线</h2>
          <p className="small muted">
            实心条是实际指令区间；细虚线是 App 冷却，可与另一 App
            执行同时存在。点击指令查看回执。
          </p>
        </div>
        <div className="timeline-legend">
          <span className="xhs">小红书</span>
          <span className="weibo">微博</span>
          <span>┄ App 冷却</span>
        </div>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-chart">
          <div className="time-axis">
            <span>插槽</span>
            <div>
              {[0, 1, 2, 3, 4].map((i) => (
                <span style={{ left: `${i * 25}%` }} key={i}>
                  +{Math.round((span * i) / 4000)}s
                </span>
              ))}
            </div>
          </div>
          {devices.map((d) => (
            <div className="timeline-row" key={d.id}>
              <strong>{String(d.slot).padStart(2, "0")}</strong>
              <div className="timeline-track">
                {rests
                  .filter((r) => r.deviceId === d.id)
                  .map((r, i) => (
                    <span
                      key={`rest-${i}`}
                      className={`rest-segment ${r.appId}`}
                      style={{
                        left: `${((r.at - start) / span) * 100}%`,
                        width: `${(Math.min(r.durationMs, Math.max(0, start + span - r.at)) / span) * 100}%`,
                        bottom: r.appId === "xhs" ? "5px" : "1px",
                      }}
                      title={`${appName(r.appId)} 冷却 ${seconds(r.durationMs)}`}
                    />
                  ))}
                {commands
                  .filter((c) => c.deviceId === d.id)
                  .map((c) => (
                    <button
                      key={c.id}
                      className={`time-segment ${c.appId} ${c.status}`}
                      style={{
                        left: `${((c.createdAt - start) / span) * 100}%`,
                        width: `${Math.max(0.5, (((c.completedAt || now) - c.createdAt) / span) * 100)}%`,
                      }}
                      onClick={() => onInspect(byJob.get(c.jobId))}
                      aria-label={`${d.name} ${c.code} ${seconds((c.completedAt || now) - c.createdAt)}`}
                      title={`${c.code} · ${seconds((c.completedAt || now) - c.createdAt)} · ${c.loop === "large" ? "大" : "小"}循环`}
                    />
                  ))}
              </div>
            </div>
          ))}
          {!devices.length && (
            <p className="empty">
              开始演示后，十个插槽将展示真实记录的模拟时间段。
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
function LoopPolicyForm({ policy, busy, onSubmit }) {
  const fields = [
    ["maxInsertions", "每个大任务最多插入小任务数", 1, 0, 5],
    ["maxDetourMs", "累计插入预算（秒）", 1000, 1, 60],
    ["windowMs", "统计窗口（秒）", 1000, 1, 3600],
    ["smallLimit", "窗口内小任务阈值", 1, 1, 100],
    ["largeLimit", "窗口内大任务阈值", 1, 1, 100],
    ["cooldownMinMs", "随机冷却下限（秒）", 1000, 0, 600],
    ["cooldownMaxMs", "随机冷却上限（秒）", 1000, 0, 600],
    ["commandDelayMs", "每条模拟指令时间（秒）", 1000, 0.2, 5],
  ];
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        onSubmit(
          Object.fromEntries(
            fields.map(([key, , scale]) => [
              key,
              Math.round(Number(data.get(key)) * scale),
            ]),
          ),
        );
      }}
    >
      <p>
        达到任一 App
        的大小任务阈值后抽取一次冷却，保存截止时间并开启下一轮计数。当前冷却不会清零；机架成员共用策略，各
        App / 账号分别计数。
      </p>
      <div className="form-grid">
        {fields.map(([key, label, scale, min, max]) => (
          <label key={key}>
            {label}
            <input
              required
              name={key}
              type="number"
              defaultValue={policy[key] / scale}
              min={min}
              max={max}
              step={scale === 1 ? 1 : 0.1}
            />
          </label>
        ))}
      </div>
      <p className="notice">
        插入预算在检查点检查；已经开始的小任务会完成收尾，冷却等待仍须满足。只在模拟器演示恢复，不中断真实
        App。
      </p>
      <button className="primary" disabled={busy}>
        保存循环策略
      </button>
    </form>
  );
}
function DefinitionForm({ definitions, busy, onSubmit }) {
  const latest = latestDefinitions(definitions),
    [selected, setSelected] = useState(latest[0]?.id),
    [draft, setDraft] = useState(() => ({
      ...latest[0],
      code: "custom.flow",
      name: "我的组合任务",
    }));
  const update = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const steps = draft.steps || [];
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          ...draft,
          expectedVersion: Math.max(
            0,
            ...definitions
              .filter((d) => d.code === draft.code)
              .map((d) => d.version),
          ),
        });
      }}
    >
      <label>
        从定义复制
        <select
          aria-label="从定义复制"
          value={selected}
          onChange={(e) => {
            const d = latest.find((d) => d.id === e.target.value);
            setSelected(d.id);
            setDraft({ ...d, code: "custom.flow", name: `组合 · ${d.name}` });
          }}
        >
          {latest.map((d) => (
            <option value={d.id} key={d.id}>
              {d.name} v{d.version}
            </option>
          ))}
        </select>
      </label>
      <div className="form-grid">
        <label>
          定义代码
          <input
            required
            value={draft.code}
            onChange={(e) => update("code", e.target.value)}
            pattern={"[a-z][a-z0-9_.\\-]{2,59}"}
          />
        </label>
        <label>
          名称
          <input
            required
            value={draft.name}
            onChange={(e) => update("name", e.target.value)}
          />
        </label>
        <label>
          App
          <select
            aria-label="App"
            value={draft.appId}
            onChange={(e) => {
              update("appId", e.target.value);
              update("steps", [{ code: "app.open", repeat: 1 }]);
            }}
          >
            <option value="xhs">小红书</option>
            <option value="weibo">微博</option>
          </select>
        </label>
        <label>
          循环类型
          <select
            aria-label="循环类型"
            value={draft.loop}
            onChange={(e) => update("loop", e.target.value)}
          >
            <option value="small">小循环 · 最多 4 条指令</option>
            <option value="large">大循环 · 最多 30 条指令</option>
          </select>
        </label>
      </div>
      <div className="definition-steps">
        {steps.map((step, i) => (
          <div key={i}>
            <span>{i + 1}</span>
            <select
              aria-label={`第 ${i + 1} 组指令`}
              value={step.code}
              onChange={(e) =>
                update(
                  "steps",
                  steps.map((s, n) =>
                    n === i ? { ...s, code: e.target.value } : s,
                  ),
                )
              }
            >
              {COMMANDS.filter(
                (c) => !c.internal && (!c.appId || c.appId === draft.appId),
              ).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              aria-label={`第 ${i + 1} 组重复次数`}
              min="1"
              max="10"
              required
              value={step.repeat}
              onChange={(e) =>
                update(
                  "steps",
                  steps.map((s, n) =>
                    n === i ? { ...s, repeat: Number(e.target.value) } : s,
                  ),
                )
              }
            />
            <button
              type="button"
              className="text-button"
              disabled={steps.length <= 1}
              onClick={() =>
                update(
                  "steps",
                  steps.filter((_, n) => n !== i),
                )
              }
            >
              移除
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={steps.length >= 12}
        onClick={() =>
          update("steps", [
            ...steps,
            {
              code: draft.appId === "xhs" ? "xhs.list" : "weibo.list",
              repeat: 1,
            },
          ])
        }
      >
        添加指令组
      </button>
      {draft.loop === "large" && (
        <label className="check">
          <input
            type="checkbox"
            checked={!!draft.resumable}
            onChange={(e) => update("resumable", e.target.checked)}
          />
          允许模拟检查点恢复与小任务插入
        </label>
      )}
      <p className="small muted">
        同代码保存为下一版本。任务保存提交时的指令展开结果；不执行自由文本命令、Shell
        或任意 URL。OCR 与点赞均为合成演示。
      </p>
      <button className="primary" disabled={busy}>
        保存新版本
      </button>
    </form>
  );
}
function WorkflowForm({ definitions, devices, busy, onSubmit }) {
  const [id, setId] = useState(definitions[0]?.id),
    [key] = useState(() => requestId());
  const d = definitions.find((d) => d.id === id);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...Object.fromEntries(new FormData(e.currentTarget)), key });
      }}
    >
      <label>
        任务定义
        <select
          name="definitionId"
          aria-label="任务定义"
          value={id}
          onChange={(e) => setId(e.target.value)}
        >
          {definitions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · v{d.version}
            </option>
          ))}
        </select>
      </label>
      <p className="notice">
        {d?.steps
          .map((s) => `${s.code}${s.repeat > 1 ? ` ×${s.repeat}` : ""}`)
          .join(" → ")}
      </p>
      <div className="form-grid">
        <label>
          关键词
          <input name="keyword" defaultValue="杭州美食" maxLength={200} />
        </label>
        <label>
          目标标识
          <input name="target" defaultValue="demo-note-1" maxLength={200} />
        </label>
        <label>
          优先级
          <select name="priority" aria-label="优先级" defaultValue="5">
            <option value="1">1 · 高</option>
            <option value="3">3 · 较高</option>
            <option value="5">5 · 普通</option>
            <option value="8">8 · 后台</option>
          </select>
        </label>
        <label>
          指定插槽
          <select name="deviceId" aria-label="指定插槽">
            <option value="">由中心分配</option>
            {devices
              .filter((d) => d.enabled)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <button className="primary" disabled={busy}>
        提交定义任务
      </button>
    </form>
  );
}
