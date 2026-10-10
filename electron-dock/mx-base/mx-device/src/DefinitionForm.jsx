import { useState } from "react";
import { COMMANDS } from "../server/workflow-catalog.mjs";
const latestDefinitions = (rows) =>
  rows.filter(
    (d) => !rows.some((x) => x.code === d.code && x.version > d.version),
  );
export default function DefinitionForm({
  definitions,
  busy,
  onSubmit,
  initialDefinition,
}) {
  const latest = latestDefinitions(definitions),
    [selected, setSelected] = useState(
      initialDefinition ? "__seed" : latest[0]?.id,
    ),
    [draft, setDraft] = useState(() => ({
      ...latest[0],
      code: "custom.flow",
      name: "我的组合任务",
      ...initialDefinition,
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
            if (e.target.value === "__seed") {
              setSelected("__seed");
              setDraft({ ...initialDefinition });
              return;
            }
            const d = latest.find((d) => d.id === e.target.value);
            setSelected(d.id);
            setDraft({ ...d, code: "custom.flow", name: `组合 · ${d.name}` });
          }}
        >
          {initialDefinition && <option value="__seed">当前调试步骤</option>}
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
