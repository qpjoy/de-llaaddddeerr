import { useState } from "react";
import { appName } from "./data.js";
import "./catalog.css";

export const latestDefinitions = (rows = []) => {
  const latest = new Map();
  for (const row of rows) {
    if (!latest.has(row.code) || latest.get(row.code).version < row.version)
      latest.set(row.code, row);
  }
  return [...latest.values()];
};
const active = (row) => !row.archived && !row.archivedAt;
const platforms = ["xhs", "weibo", "xianyu", "pdd"];

export default function DefinitionForm({
  definitions = [],
  commandDefinitions = [],
  busy,
  onSubmit,
  initialDefinition,
  lockedCode = false,
  editing = false,
}) {
  const latest = latestDefinitions(definitions).filter(active);
  const commands = latestDefinitions(commandDefinitions).filter(
    (c) => active(c) && !c.internal,
  );
  const initial = initialDefinition || {
    ...latest[0],
    code: "custom.flow",
    name: "我的组合任务",
  };
  const [selected, setSelected] = useState(
    initialDefinition ? "__seed" : latest[0]?.id || "",
  );
  const [draft, setDraft] = useState(() => ({
    appId: "pdd",
    loop: "small",
    steps: [],
    ...initial,
  }));
  const [inputs, setInputs] = useState(() =>
    (initial.steps || []).map((s) =>
      s.input ? JSON.stringify(s.input, null, 2) : "{}",
    ),
  );
  const [error, setError] = useState("");
  const compatible = commands.filter(
    (c) => !c.appId || c.appId === draft.appId,
  );
  const steps = draft.steps || [];
  const update = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const stepFor = (command) => ({
    code: command.code,
    repeat: 1,
    commandVersion: command.version,
  });
  const load = (value) => {
    setDraft(value);
    setInputs(
      (value.steps || []).map((s) => JSON.stringify(s.input || {}, null, 2)),
    );
    setError("");
  };
  return (
    <form
      className="form catalog-editor"
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        try {
          if (!steps.length) throw Error("请至少添加一组指令。");
          const normalized = steps.map((step, i) => {
            const input = JSON.parse(inputs[i] || "{}");
            if (!input || typeof input !== "object" || Array.isArray(input))
              throw Error(`第 ${i + 1} 组输入必须是 JSON 对象。`);
            const command = compatible.find((c) => c.code === step.code);
            if (!command)
              throw Error(
                `第 ${i + 1} 组指令已归档或不属于当前平台，请重新选择。`,
              );
            return {
              code: step.code,
              repeat: step.repeat,
              commandVersion: step.commandVersion || command.version,
              input,
            };
          });
          onSubmit({
            code: draft.code,
            name: draft.name,
            appId: draft.appId,
            loop: draft.loop,
            resumable: draft.loop === "large" && !!draft.resumable,
            steps: normalized,
            expectedVersion: editing ? initialDefinition.version : 0,
          });
        } catch (cause) {
          setError(
            cause instanceof SyntaxError
              ? "步骤输入不是有效的 JSON，请检查格式。"
              : cause.message,
          );
        }
      }}
    >
      {!editing && (
        <label>
          从定义复制
          <select
            aria-label="从定义复制"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              if (e.target.value === "__seed")
                return load({ ...initialDefinition });
              const row = latest.find((d) => d.id === e.target.value);
              if (row)
                load({
                  ...row,
                  code: "custom.flow",
                  name: `组合 · ${row.name}`,
                });
            }}
          >
            {initialDefinition && <option value="__seed">当前任务步骤</option>}
            {!latest.length && !initialDefinition && (
              <option value="">空白任务</option>
            )}
            {latest.map((d) => (
              <option value={d.id} key={d.id}>
                {d.name} v{d.version}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="form-grid">
        <label>
          定义代码
          <input
            required
            aria-label="定义代码"
            value={draft.code || ""}
            readOnly={lockedCode}
            onChange={(e) => update("code", e.target.value)}
            pattern={"[a-z][a-z0-9_.\\-]{2,59}"}
          />
        </label>
        <label>
          名称
          <input
            required
            aria-label="任务名称"
            value={draft.name || ""}
            maxLength={80}
            onChange={(e) => update("name", e.target.value)}
          />
        </label>
        <label>
          App
          <select
            aria-label="App"
            value={draft.appId}
            onChange={(e) => {
              const appId = e.target.value;
              const open =
                commands.find(
                  (c) => c.appId === appId && c.action === "open",
                ) || commands.find((c) => c.code === "app.open");
              setDraft((d) => ({
                ...d,
                appId,
                steps: open ? [stepFor(open)] : [],
              }));
              setInputs(["{}"]);
            }}
          >
            {platforms.map((id) => (
              <option value={id} key={id}>
                {appName(id)}
              </option>
            ))}
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
      <div className="catalog-steps">
        {steps.map((step, i) => (
          <div className="catalog-step" key={i}>
            <div className="catalog-step-controls">
              <span className="catalog-step-index">{i + 1}</span>
              <label>
                指令
                <select
                  aria-label={`第 ${i + 1} 组指令`}
                  value={`${step.code}:${step.commandVersion || compatible.find((c) => c.code === step.code)?.version || 1}`}
                  onChange={(e) => {
                    const [code, version] = e.target.value.split(":");
                    const command = compatible.find((c) => c.code === code);
                    if (!command) return;
                    update(
                      "steps",
                      steps.map((s, n) =>
                        n === i
                          ? {
                              ...s,
                              code: command.code,
                              commandVersion: Number(version),
                            }
                          : s,
                      ),
                    );
                  }}
                >
                  {!compatible.some(
                    (c) =>
                      c.code === step.code &&
                      (!step.commandVersion ||
                        step.commandVersion === c.version),
                  ) && (
                    <option value={`${step.code}:${step.commandVersion || 1}`}>
                      {step.code} · v{step.commandVersion || 1}（当前绑定）
                    </option>
                  )}
                  {compatible.map((c) => (
                    <option key={c.code} value={`${c.code}:${c.version || 1}`}>
                      {c.name} · {c.code} · v{c.version || 1}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                重复
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
              </label>
              <button
                type="button"
                className="text-button"
                aria-label={`移除第 ${i + 1} 组指令`}
                disabled={steps.length <= 1 || busy}
                onClick={() => {
                  update(
                    "steps",
                    steps.filter((_, n) => n !== i),
                  );
                  setInputs((all) => all.filter((_, n) => n !== i));
                }}
              >
                移除
              </button>
            </div>
            <details>
              <summary>
                固定输入 JSON · 指令版本 v
                {step.commandVersion ||
                  compatible.find((c) => c.code === step.code)?.version ||
                  1}
              </summary>
              <label className="catalog-step-input">
                步骤输入
                <textarea
                  aria-label={`第 ${i + 1} 组输入 JSON`}
                  rows={3}
                  value={inputs[i] || "{}"}
                  onChange={(e) =>
                    setInputs((all) => {
                      const next = [...all];
                      next[i] = e.target.value;
                      return next;
                    })
                  }
                />
              </label>
              <p className="small muted">
                填写该指令的固定参数。上游结果可用{" "}
                {'{"fromStep": 1, "path": ["items", 0, "goodsId"]}'}{" "}
                引用，fromStep 从 0
                开始按展开后的指令计数。保存后绑定所选指令版本。
              </p>
            </details>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={busy || steps.length >= 12 || !compatible.length}
        onClick={() => {
          const command =
            compatible.find(
              (c) =>
                c.appId === draft.appId &&
                ["read", "refresh", "search"].includes(c.action),
            ) || compatible[0];
          update("steps", [...steps, stepFor(command)]);
          setInputs((all) => [...all, "{}"]);
        }}
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
        每次保存创建新版本，已提交任务保留指令快照。当前组合任务及 OCR
        在模拟器执行；接口绑定不代表真机执行能力已上线。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy || !compatible.length}>
        {busy ? "保存中…" : "保存新版本"}
      </button>
    </form>
  );
}
