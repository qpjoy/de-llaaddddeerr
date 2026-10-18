import { useRef, useState } from "react";
import {
  ArrowRight,
  Code,
  Gear,
  ListChecks,
  Plus,
} from "@phosphor-icons/react";
import Projection from "./Projection.jsx";
import AdapterBench from "./AdapterBench.jsx";
import { latestDefinitions } from "./DefinitionForm.jsx";
import { api, appName, jobTitle, labels, time } from "./data.js";
import { requestId } from "./request-id.mjs";
import "./device-workspace.css";

const platforms = ["xhs", "weibo", "xianyu", "pdd"];
const elapsedLabel = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds} 秒`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟`
      : seconds < 86400
        ? `${(seconds / 3600).toFixed(1)} 小时`
        : `${(seconds / 86400).toFixed(1)} 天`;
};
function CapabilityForm({ device, state, busy, run }) {
  const [apps, setApps] = useState(() => device.simApps || ["xhs", "weibo"]);
  const [limited, setLimited] = useState(!!device.simCommandCodes);
  const [codes, setCodes] = useState(() => device.simCommandCodes || []);
  const commands = latestDefinitions(state.commandDefinitions || []).filter(
    (c) => !c.archived && !c.internal,
  );
  const editable =
    !device.enabled &&
    device.state === "idle" &&
    !device.workflowAttemptId &&
    !["waiting", "held"].includes(device.session?.status) &&
    !state.attempts.some(
      (a) =>
        a.deviceId === device.id && ["running", "yielded"].includes(a.status),
    );
  const toggle = (set, value, checked) =>
    set((old) => (checked ? [...old, value] : old.filter((v) => v !== value)));
  return (
    <form
      className="device-capability-form"
      onSubmit={async (event) => {
        event.preventDefault();
        await run(
          () =>
            api(`devices/${device.id}/sim-capabilities`, "sim", {
              revision: device.revision,
              simApps: apps,
              simCommandCodes: limited ? codes : null,
            }),
          "模拟能力已保存；设备保持暂停，历史冷却仍保留",
        );
      }}
    >
      <div className="device-workspace-section-heading">
        <h3>设备能力</h3>
        <span className="status sim">模拟声明</span>
      </div>
      <p className="small muted">
        声明这台设备已迁入的平台和指令。删除能力前，先回收依赖它的绑定排队任务。
      </p>
      {!editable && (
        <p className="notice">
          暂停领取并等待当前任务及控制会话结束后，才能编辑能力。
        </p>
      )}
      <fieldset disabled={!editable || busy}>
        <legend>可操作的平台</legend>
        <div className="device-capability-platforms">
          {platforms.map((id) => (
            <label className="check" key={id}>
              <input
                type="checkbox"
                checked={apps.includes(id)}
                onChange={(e) => toggle(setApps, id, e.target.checked)}
              />
              {appName(id)}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={!editable || busy}>
        <legend>迁入指令</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={limited}
            onChange={(e) => {
              setLimited(e.target.checked);
              if (e.target.checked && !codes.length)
                setCodes(
                  commands
                    .filter((c) => !c.appId || apps.includes(c.appId))
                    .map((c) => c.code),
                );
            }}
          />
          限定这台设备支持的指令
        </label>
        <p className="small muted">
          未限定时，平台内全部已登记模拟指令都可匹配；平台能力仍会校验。
        </p>
        {limited && (
          <div className="device-capability-commands">
            {commands
              .filter((c) => !c.appId || apps.includes(c.appId))
              .map((c) => (
                <label className="check" key={c.code}>
                  <input
                    type="checkbox"
                    checked={codes.includes(c.code)}
                    onChange={(e) => toggle(setCodes, c.code, e.target.checked)}
                  />
                  <span>
                    {c.name}
                    <small>{c.code}</small>
                  </span>
                </label>
              ))}
          </div>
        )}
      </fieldset>
      <button
        className="primary"
        disabled={
          !editable || busy || !apps.length || (limited && !codes.length)
        }
      >
        保存设备能力
      </button>
    </form>
  );
}

function SubmitToDevice({ device, state, busy, run }) {
  const available = latestDefinitions(state.definitions || []).filter(
    (d) =>
      !d.archived &&
      (device.simApps || ["xhs", "weibo"]).includes(d.appId) &&
      (!device.simCommandCodes ||
        d.steps.every((s) => device.simCommandCodes.includes(s.code))),
  );
  const request = useRef(null);
  return (
    <details className="device-task-submit">
      <summary>
        <Plus size={17} /> 提交模板任务到此机
      </summary>
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          const body = Object.fromEntries(new FormData(event.currentTarget));
          const fingerprint = JSON.stringify(body);
          if (request.current?.fingerprint !== fingerprint)
            request.current = { key: requestId(), fingerprint };
          const result = await run(
            () =>
              api("jobs", "sim", {
                ...body,
                key: request.current.key,
                deviceId: device.id,
                rack: device.rack,
              }),
            "任务已排到此机，等待执行槽与冷却条件",
          );
          if (result) request.current = null;
        }}
      >
        <label>
          任务模板
          <select name="definitionId" required disabled={!available.length}>
            {available.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · v{d.version}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label>
            关键词
            <input
              name="keyword"
              defaultValue="演示关键词"
              maxLength={200}
              required
            />
          </label>
          <label>
            详情目标
            <input
              name="target"
              defaultValue="demo-item-1"
              maxLength={200}
              required
            />
          </label>
        </div>
        <button
          className="primary"
          disabled={
            busy ||
            !available.length ||
            !device.enabled ||
            device.state === "quarantined"
          }
        >
          加入此机队列
        </button>
      </form>
    </details>
  );
}

export default function DeviceWorkspace({
  device,
  state,
  history,
  busy,
  run,
  onInspect,
  onDefine,
  onConfigure,
  onControl,
  onRefresh,
  onProbe,
  onPacing,
  onLive,
  onSubmit,
}) {
  const [tab, setTab] = useState("execution");
  const availability = state.scheduling?.devices.find(
    (d) => d.deviceId === device.id,
  );
  const queue = new Map(
    (state.scheduling?.queue || []).map((q) => [q.jobId, q]),
  );
  const current = state.jobs.filter(
    (j) => j.status === "running" && j.lastDeviceId === device.id,
  );
  const pending = state.jobs
    .filter(
      (j) =>
        j.status === "queued" &&
        (j.deviceId === device.id ||
          queue.get(j.id)?.poolAssignment?.deviceId === device.id),
    )
    .sort(
      (a, b) => (queue.get(a.id)?.order || 0) - (queue.get(b.id)?.order || 0),
    );
  const commands = state.commands
    .filter((c) => c.deviceId === device.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 16);
  const now = state.now || Date.now();
  const inspectCommand = (c) => {
    const job = state.jobs.find((j) => j.id === c.jobId);
    if (job) onInspect(job);
  };
  return (
    <div className="device-workspace-layout">
      <Projection
        device={device}
        history={history}
        availability={availability}
        now={now}
        lease={{
          attempt: state.attempts.find(
            (a) =>
              a.deviceId === device.id &&
              ["running", "yielded"].includes(a.status),
          ),
          agent: (state.agents || []).find((a) => a.id === device.agentId),
        }}
        busy={busy}
        onLive={onLive}
        onConfigure={onConfigure}
        onRefresh={onRefresh}
        onControl={onControl}
        onProbe={onProbe}
        onPacing={onPacing}
      />
      <div className="device-workspace-content">
        <div className="device-workspace-identity">
          <span>
            {device.rack} / {device.host}
          </span>
          <strong>{device.name}</strong>
          <small>
            {device.mode === "sim" ? "模拟执行器" : device.adapter} ·
            一个物理执行槽
          </small>
        </div>
        <div className="device-workspace-tabs" aria-label="设备工作台视图">
          {[
            ["execution", "执行与队列", ListChecks],
            ["adapter", "Adapter 调试", Code],
            ...(device.mode === "sim"
              ? [["capabilities", "能力管理", Gear]]
              : []),
          ].map(([id, label, Icon]) => (
            <button
              key={id}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </div>
        {tab === "adapter" ? (
          <AdapterBench
            device={device}
            state={state}
            busy={busy}
            run={run}
            onInspect={onInspect}
            onDefine={onDefine}
            onConfigure={onConfigure}
          />
        ) : tab === "capabilities" ? (
          <CapabilityForm device={device} state={state} busy={busy} run={run} />
        ) : (
          <>
            <section aria-label="当前执行任务">
              <div className="device-workspace-section-heading">
                <h3>当前执行</h3>
                <span
                  className={`status ${current.length ? "running" : device.state}`}
                >
                  {current.length
                    ? "独占执行中"
                    : labels[device.state] || device.state}
                </span>
              </div>
              {current.length ? (
                current.map((j) => (
                  <button
                    className="device-current-task"
                    key={j.id}
                    onClick={() => onInspect(j)}
                  >
                    <strong>
                      {jobTitle(j)}
                      <ArrowRight size={18} />
                    </strong>
                    <span>
                      {j.workflow
                        ? `已确认 ${j.workflow.nextStep} / ${j.workflow.plan.length} 条指令`
                        : j.reason}
                    </span>
                    <progress
                      value={j.workflow?.nextStep || 0}
                      max={j.workflow?.plan.length || 1}
                    />
                    <small>领取 {time(j.startedAt)} · 当前会话不迁移</small>
                  </button>
                ))
              ) : (
                <p className="small muted">
                  当前没有运行中的任务。领取条件见手机下方状态与 App 冷却。
                </p>
              )}
            </section>
            <section aria-label="设备等待队列">
              <div className="device-workspace-section-heading">
                <h3>
                  等待队列 <span>{pending.length}</span>
                </h3>
                <small>领取前仍可重排</small>
              </div>
              {!pending.length && (
                <p className="small muted">
                  暂无绑定或计划到此机的任务。未分配任务在工作台中央队列中。
                </p>
              )}
              <div className="device-queue-list">
                {pending.map((j) => {
                  const q = queue.get(j.id),
                    fixed = j.deviceId === device.id;
                  return (
                    <article key={j.id}>
                      <div>
                        <button
                          className="text-button"
                          onClick={() => onInspect(j)}
                        >
                          {jobTitle(j)}
                        </button>
                        <span className={`status ${fixed ? "sim" : "queued"}`}>
                          {fixed ? "人工/请求绑定" : "计划候选"}
                        </span>
                      </div>
                      <p>
                        {q?.reasons.map((r) => r.message).join("；") ||
                          j.reason}
                      </p>
                      <div className="button-row">
                        <small>
                          等待 {elapsedLabel(now - j.createdAt)}
                          {q?.poolAssignment
                            ? ` · 预计开始 ${time(q.poolAssignment.startAt)}`
                            : ""}
                        </small>
                        {device.mode === "sim" && (
                          <>
                            <button
                              disabled={
                                busy ||
                                (!fixed &&
                                  (!device.enabled ||
                                    device.state === "quarantined"))
                              }
                              onClick={() =>
                                run(
                                  () =>
                                    api(`jobs/${j.id}/assignment`, "sim", {
                                      revision: j.revision || 0,
                                      deviceId: fixed ? null : device.id,
                                    }),
                                  fixed
                                    ? "已回收中央队列，保留原机架范围"
                                    : "已绑定此机，继续等待领取条件",
                                )
                              }
                            >
                              {fixed ? "回收中央队列" : "固定到此机"}
                            </button>
                            <button
                              disabled={busy}
                              onClick={() =>
                                run(
                                  () =>
                                    api(`jobs/${j.id}/queue-cancel`, "sim", {
                                      revision: j.revision || 0,
                                    }),
                                  "排队任务已取消，记录仍保留",
                                )
                              }
                            >
                              取消任务
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
            {device.mode === "sim" ? (
              <SubmitToDevice
                device={device}
                state={state}
                busy={busy}
                run={run}
              />
            ) : (
              <button disabled={busy} onClick={onSubmit}>
                提交真实任务
              </button>
            )}
            <section aria-label="设备指令流水">
              <div className="device-workspace-section-heading">
                <h3>实际指令流水</h3>
                <small>最近 {commands.length} 条</small>
              </div>
              <ol className="device-command-stream">
                {commands.map((c) => (
                  <li key={c.id}>
                    <i className={`device-command-dot ${c.status}`} />
                    <button onClick={() => inspectCommand(c)}>
                      <strong>{c.definition?.name || c.code}</strong>
                      <small>
                        {c.code} · {time(c.createdAt)}
                        {c.completedAt
                          ? ` · ${Math.max(0, (c.completedAt - c.createdAt) / 1000).toFixed(1)} 秒`
                          : ""}
                      </small>
                    </button>
                    <span className={`status ${c.status}`}>
                      {labels[c.status] || c.status}
                    </span>
                  </li>
                ))}
              </ol>
              {!commands.length && (
                <p className="small muted">
                  指令领取后会显示在这里；排队计划不算执行记录。
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
