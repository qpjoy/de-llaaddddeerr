import { useRef, useState } from "react";
import {
  Code,
  PlayCircle,
  Camera,
  Pulse,
  PlugsConnected,
} from "@phosphor-icons/react";
import {
  COMMANDS,
  adapterTestDefinition,
} from "../server/workflow-catalog.mjs";
import { api, appName, labels, time } from "./data.js";
import { requestId } from "./request-id.mjs";

export default function AdapterBench({
  device: d,
  state,
  busy,
  run,
  onInspect,
  onDefine,
  onConfigure,
}) {
  const [appId, setAppId] = useState("xhs"),
    [code, setCode] = useState("app.open"),
    [keyword, setKeyword] = useState("杭州美食"),
    [target, setTarget] = useState("demo-note-1"),
    [submitted, setSubmitted] = useState(null);
  const request = useRef(null);
  const sim = d.mode === "sim",
    now = state.now || Date.now();
  const command = COMMANDS.find((c) => c.code === code);
  const preview = adapterTestDefinition(code, appId);
  const tests = state.jobs
    .filter((j) => j.deviceId === d.id && j.adapterTest)
    .sort((a, b) => b.createdAt - a.createdAt);
  const latest =
    state.jobs.find((j) => j.id === submitted?.id) || submitted || tests[0];
  const disabledReason = !d.enabled
    ? "此设备暂停领取；请先在手机工作台启用调度。"
    : d.state === "quarantined"
      ? "设备待核验，不能提交试运行。"
      : ["held", "waiting"].includes(d.session?.status)
        ? "控制会话预留中；请先释放会话，再启用调度。"
        : null;
  async function test() {
    const body = { code, appId, keyword, target };
    const fingerprint = JSON.stringify(body);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, key: requestId() };
    const result = await run(
      () =>
        api(`devices/${d.id}/adapter-test`, "sim", {
          ...body,
          key: request.current.key,
        }),
      "模拟试运行已入池，遵守设备占用和冷却策略",
    );
    if (result) {
      setSubmitted(result);
      request.current = null;
    }
  }
  async function read(path, body = {}) {
    await run(
      () => api(`devices/${d.id}/${path}`, "real", body),
      "读取请求已提交；短期重复请求会合并，结果由执行器更新",
    );
  }
  return (
    <section className="adapter-bench" aria-label="Adapter 调试">
      <div className="sub-head">
        <div>
          <h3>Adapter 调试</h3>
          <p className="small muted">
            {d.name} · {sim ? "模拟执行器" : "真实设备能力"}
          </p>
        </div>
        <span className={`status ${sim ? "sim" : "queued"}`}>
          {sim ? "可模拟试运行" : "已接入只读事件"}
        </span>
      </div>
      {!sim && (
        <>
          <div className="adapter-read-actions">
            <button
              disabled={
                busy ||
                !d.observer ||
                (["queued", "running"].includes(d.capture?.status) &&
                  d.capture.expiresAt > now)
              }
              onClick={() => read("capture")}
            >
              <Camera size={18} />
              请求单次截图
            </button>
            <button
              disabled={
                busy ||
                !d.observer ||
                (["queued", "running"].includes(d.inspection?.status) &&
                  d.inspection.expiresAt > now)
              }
              onClick={() => read("mobile-status")}
            >
              <Pulse size={18} />
              读取设备状态
            </button>
            <button
              disabled={
                busy ||
                d.adapter !== "legacy-poc" ||
                d.pocDisabled ||
                d.probePending
              }
              onClick={() => read("probe", { revision: d.revision })}
            >
              <PlugsConnected size={18} />
              检查 PoC 连接
            </button>
          </div>
          <p className="small muted">
            截图：
            {d.capture
              ? labels[d.capture.status] || d.capture.status
              : "未请求"}{" "}
            · 最近收到 {time(d.frame?.receivedAt)}；状态：
            {d.inspection
              ? labels[d.inspection.status] || d.inspection.status
              : "未请求"}{" "}
            · 最近收到 {time(d.mobileStatus?.receivedAt)}
          </p>
          {(d.capture?.error || d.inspection?.error) && (
            <p role="alert" className="error small">
              {d.capture?.error || d.inspection?.error}
            </p>
          )}
          {!d.observer && (
            <button className="text-button" onClick={onConfigure}>
              配置截图与状态连接
            </button>
          )}
          <p className="notice small">
            下面是控制指令目录。打开
            App、返回、Home、点赞等尚未接入真实执行；切换模拟模式可以试运行并编排。
          </p>
        </>
      )}
      <div className="adapter-editor">
        <div className="adapter-pickers">
          <label>
            目标 App
            <select
              aria-label="调试目标 App"
              value={appId}
              disabled={busy}
              onChange={(e) => {
                setAppId(e.target.value);
                setCode("app.open");
              }}
            >
              <option value="xhs">小红书</option>
              <option value="weibo">微博</option>
            </select>
          </label>
          <label>
            常用指令
            <select
              aria-label="常用 Adapter 指令"
              value={code}
              disabled={busy}
              onChange={(e) => setCode(e.target.value)}
            >
              {COMMANDS.filter(
                (c) => !c.internal && (!c.appId || c.appId === appId),
              ).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} · {c.code}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="adapter-shortcuts">
          {["app.open", "session.back", "session.home"].map((c) => (
            <button
              key={c}
              disabled={busy}
              aria-pressed={code === c}
              onClick={() => setCode(c)}
            >
              {COMMANDS.find((x) => x.code === c).name}
            </button>
          ))}
        </div>
        <p className="small muted">{command.mapping}</p>
        {sim && (
          <div className="form-grid">
            <label>
              调试关键词
              <input
                aria-label="调试关键词"
                value={keyword}
                maxLength={200}
                disabled={busy}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </label>
            <label>
              调试目标标识
              <input
                aria-label="调试目标标识"
                value={target}
                maxLength={200}
                disabled={busy}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
          </div>
        )}
        <div className="adapter-sequence" aria-label="试运行步骤">
          <span>准备与执行</span>
          {preview.steps.map((step, i) => (
            <code key={i}>
              {i + 1}. {step.code}
            </code>
          ))}
        </div>
        {sim && (
          <>
            <p className="small muted">
              先准备 {appName(appId)}{" "}
              上下文，再执行所选指令。下一页会先搜索；所有步骤保存回执，已有任务不会被强行中断。
            </p>
            {disabledReason && (
              <p className="small warning">{disabledReason}</p>
            )}
            <div className="button-row">
              <button
                className="primary"
                disabled={busy || !!disabledReason}
                onClick={test}
              >
                <PlayCircle size={19} />
                试运行（模拟）
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  onDefine({
                    ...preview,
                    code: `custom.${appId}.${code}`,
                    name: `${appName(appId)} · ${command.name}`,
                  })
                }
              >
                <Code size={18} />
                编辑为任务定义
              </button>
            </div>
          </>
        )}
      </div>
      {sim && (
        <div className="adapter-test-results">
          <h4>试运行记录</h4>
          {latest && (
            <p role="status">
              最近试运行：{labels[latest.status] || latest.status} ·{" "}
              {latest.reason}
            </p>
          )}
          {tests.slice(0, 5).map((j) => (
            <button key={j.id} onClick={() => onInspect(j)}>
              <span>
                {j.workflow.name}
                <small>
                  {j.adapterTest.code} · {time(j.createdAt)}
                </small>
              </span>
              <span>{labels[j.status]} →</span>
            </button>
          ))}
          {!tests.length && (
            <p className="small muted">
              选择指令后试运行，点击记录查看完整指令回执。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
