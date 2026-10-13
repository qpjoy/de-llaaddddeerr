import { useEffect, useState } from "react";
import {
  Archive,
  ArrowClockwise,
  Code,
  Copy,
  PencilSimple,
  PlayCircle,
  Plus,
  Stack,
} from "@phosphor-icons/react";
import { api, appName } from "./data.js";
import { Modal } from "./Forms.jsx";
import DefinitionForm, { latestDefinitions } from "./DefinitionForm.jsx";
import { requestId } from "./request-id.mjs";
import "./catalog.css";

const platformIds = ["pdd", "xhs", "weibo", "xianyu"];
const actions = [
  "open",
  "search",
  "list",
  "refresh",
  "next",
  "scroll",
  "detail",
  "ocr",
  "back",
  "home",
  "like",
];
const actionName = {
  open: "打开应用",
  search: "搜索",
  list: "读取列表",
  refresh: "下拉刷新",
  next: "下一页",
  scroll: "滚动",
  detail: "获取详情",
  ocr: "OCR 识别",
  back: "返回",
  home: "回到起点",
  restore: "恢复上下文",
  like: "点赞",
};
const active = (row) => !row.archived && !row.archivedAt;
const formatJson = (value) =>
  JSON.stringify(
    value || {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    null,
    2,
  );
async function archiveRow(path, row) {
  const response = await fetch(
    `/api/${path}/${encodeURIComponent(row.id)}?mode=sim`,
    {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: row.version }),
      signal: AbortSignal.timeout(8000),
    },
  );
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "归档失败");
  return value;
}

function CommandForm({ initial, editing, busy, onSubmit }) {
  const [draft, setDraft] = useState(() => ({
    code: "pdd.custom",
    name: "拼多多 · 自定义操作",
    appId: "pdd",
    action: "list",
    estimateMs: 2000,
    timeoutMs: 15000,
    effect: "read",
    mapping: "",
    bindings: [],
    ...initial,
  }));
  const [input, setInput] = useState(() => formatJson(initial?.inputSchema));
  const [output, setOutput] = useState(() => formatJson(initial?.outputSchema));
  const [error, setError] = useState("");
  const change = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const binding = (index, key, value) =>
    change(
      "bindings",
      draft.bindings.map((row, n) =>
        n === index ? { ...row, [key]: value } : row,
      ),
    );
  return (
    <form
      className="form catalog-editor"
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        try {
          const inputSchema = JSON.parse(input),
            outputSchema = JSON.parse(output);
          if (
            [inputSchema, outputSchema].some(
              (v) => !v || typeof v !== "object" || Array.isArray(v),
            )
          )
            throw Error("输入和输出 Schema 都必须是 JSON 对象。");
          onSubmit({
            code: draft.code,
            name: draft.name,
            appId: draft.appId,
            action: draft.action,
            estimateMs: draft.estimateMs,
            timeoutMs: draft.timeoutMs,
            effect: draft.effect,
            mapping: draft.mapping,
            bindings: draft.bindings.map(({ kind, adapterId, operation }) => ({
              kind,
              adapterId,
              operation,
            })),
            inputSchema,
            outputSchema,
            expectedVersion: editing ? initial.version : 0,
          });
        } catch (cause) {
          setError(
            cause instanceof SyntaxError
              ? "Schema 不是有效的 JSON，请检查格式。"
              : cause.message,
          );
        }
      }}
    >
      <div className="form-grid">
        <label>
          指令代码
          <input
            aria-label="指令代码"
            required
            readOnly={editing}
            pattern={"[a-z][a-z0-9_.\\-]{2,79}"}
            value={draft.code}
            onChange={(e) => change("code", e.target.value)}
          />
        </label>
        <label>
          指令名称
          <input
            aria-label="指令名称"
            required
            maxLength={80}
            value={draft.name}
            onChange={(e) => change("name", e.target.value)}
          />
        </label>
        <label>
          平台
          <select
            aria-label="指令平台"
            value={draft.appId || ""}
            onChange={(e) => change("appId", e.target.value || null)}
          >
            <option value="">跨平台通用</option>
            {platformIds.map((id) => (
              <option key={id} value={id}>
                {appName(id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          标准操作
          <select
            aria-label="标准操作"
            value={draft.action}
            onChange={(e) =>
              setDraft((previous) => ({
                ...previous,
                action: e.target.value,
                effect: ["open", "back", "home"].includes(e.target.value)
                  ? "navigation"
                  : e.target.value === "like"
                    ? "write"
                    : "read",
              }))
            }
          >
            {actions.map((action) => (
              <option key={action} value={action}>
                {actionName[action]} · {action}
              </option>
            ))}
          </select>
        </label>
        <label>
          预计耗时（毫秒）
          <input
            aria-label="预计耗时"
            type="number"
            required
            min="50"
            max="600000"
            value={draft.estimateMs}
            onChange={(e) => change("estimateMs", Number(e.target.value))}
          />
        </label>
        <label>
          超时（毫秒）
          <input
            aria-label="指令超时"
            type="number"
            required
            min={draft.estimateMs}
            max="900000"
            value={draft.timeoutMs}
            onChange={(e) => change("timeoutMs", Number(e.target.value))}
          />
        </label>
        <label>
          操作性质
          <select aria-label="操作性质" value={draft.effect} disabled>
            <option value="read">读取数据</option>
            <option value="navigation">页面导航</option>
            <option value="write">产生写入</option>
          </select>
        </label>
        <label>
          适配说明
          <input
            aria-label="适配说明"
            maxLength={500}
            value={draft.mapping || ""}
            onChange={(e) => change("mapping", e.target.value)}
          />
        </label>
      </div>
      <div className="form-grid">
        <label>
          输入 Schema（JSON）
          <textarea
            aria-label="输入 Schema"
            rows={7}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <label>
          输出 Schema（JSON）
          <textarea
            aria-label="输出 Schema"
            rows={7}
            value={output}
            onChange={(e) => setOutput(e.target.value)}
          />
        </label>
      </div>
      <fieldset className="catalog-bindings">
        <legend>执行接口绑定</legend>
        <p className="small muted">
          选择 PoC、ADB 或自定义接口，填写连接器 ID
          和注册操作名。实际地址、凭证及执行逻辑由服务器连接器负责；此处保存适配契约。
        </p>
        {draft.bindings.map((row, i) => (
          <div className="catalog-binding" key={i}>
            <label>
              类型
              <select
                aria-label={`绑定 ${i + 1} 类型`}
                value={row.kind}
                onChange={(e) => binding(i, "kind", e.target.value)}
              >
                <option value="poc">PoC</option>
                <option value="adb">ADB</option>
                <option value="custom">自定义接口</option>
              </select>
            </label>
            <label>
              连接器 ID
              <input
                aria-label={`绑定 ${i + 1} 连接器`}
                required
                value={row.adapterId}
                placeholder="pdd-adb"
                onChange={(e) => binding(i, "adapterId", e.target.value)}
              />
            </label>
            <label>
              注册操作名
              <input
                aria-label={`绑定 ${i + 1} 操作`}
                required
                value={row.operation}
                placeholder="pdd.search"
                onChange={(e) => binding(i, "operation", e.target.value)}
              />
            </label>
            <button
              type="button"
              className="text-button"
              aria-label={`移除绑定 ${i + 1}`}
              onClick={() =>
                change(
                  "bindings",
                  draft.bindings.filter((_, n) => n !== i),
                )
              }
            >
              移除
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={draft.bindings.length >= 8}
          onClick={() =>
            change("bindings", [
              ...draft.bindings,
              { kind: "custom", adapterId: "", operation: "" },
            ])
          }
        >
          <Plus size={16} />
          添加接口绑定
        </button>
      </fieldset>
      <p className="small muted">
        保存后生成新的指令版本。历史任务继续使用原版本；模拟执行不会发送
        PoC、ADB 或自定义接口请求。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? "保存中…" : "保存指令版本"}
      </button>
    </form>
  );
}

function SubmitTemplate({ definition, devices, busy, onSubmit }) {
  const [key] = useState(() => requestId());
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          ...Object.fromEntries(new FormData(e.currentTarget)),
          definitionId: definition.id,
          key,
        });
      }}
    >
      <p className="notice">
        {definition.name} · v{definition.version}
        <br />
        {definition.steps
          .map((s) => `${s.code}${s.repeat > 1 ? ` × ${s.repeat}` : ""}`)
          .join(" → ")}
      </p>
      <div className="form-grid">
        <label>
          关键词
          <input
            name="keyword"
            defaultValue={definition.appId === "pdd" ? "保温杯" : "杭州美食"}
            maxLength={200}
          />
        </label>
        <label>
          目标标识
          <input name="target" defaultValue="demo-goods-1" maxLength={200} />
        </label>
        <label>
          优先级
          <select name="priority" defaultValue="5">
            <option value="1">1 · 高</option>
            <option value="5">5 · 普通</option>
            <option value="8">8 · 后台</option>
          </select>
        </label>
        <label>
          模拟设备
          <select name="deviceId">
            <option value="">由调度中心分配</option>
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
      <p className="small muted">
        等待兼容平台和指令能力的模拟设备。每台手机串行执行完整任务，任务内输入引用按步骤传递。
      </p>
      <button className="primary" disabled={busy}>
        提交模拟任务
      </button>
    </form>
  );
}

export default function Catalog({ state, mode, busy, run }) {
  const [tab, setTab] = useState("commands"),
    [platform, setPlatform] = useState("pdd"),
    [query, setQuery] = useState(""),
    [showArchived, setShowArchived] = useState(false);
  const [catalog, setCatalog] = useState({
      commands: [],
      history: [],
      definitions: [],
    }),
    [loadError, setLoadError] = useState(""),
    [loading, setLoading] = useState(true),
    [reload, setReload] = useState(0),
    [modal, setModal] = useState(null),
    [localError, setLocalError] = useState("");
  useEffect(() => {
    if (mode !== "sim") return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    Promise.all([
      api("command-definitions", "sim", null, controller.signal),
      api("task-definitions", "sim", null, controller.signal),
    ])
      .then(([commands, tasks]) => {
        setCatalog({
          commands: commands.commands || [],
          history: commands.history || commands.commands || [],
          definitions: tasks.definitions || [],
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mode, reload]);
  if (mode !== "sim")
    return (
      <section className="panel">
        <div className="panel-body">
          <h2>指令与任务库</h2>
          <p className="muted">
            请切换至「模拟演练」管理平台指令、任务模板和接口绑定。组合任务经过模拟验证后，仍需对应真实连接器的能力验收。
          </p>
        </div>
      </section>
    );
  const commandsTab = tab === "commands",
    source = commandsTab ? catalog.history : catalog.definitions;
  const rows = latestDefinitions(source).filter(
    (row) =>
      !row.internal &&
      (showArchived || active(row)) &&
      (!platform || row.appId === platform || (commandsTab && !row.appId)) &&
      (!query.trim() ||
        `${row.code} ${row.name}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
  );
  const latestCommands = latestDefinitions(catalog.history).filter(
    (row) => active(row) && !row.internal,
  );
  const path = commandsTab ? "command-definitions" : "task-definitions";
  function open(kind, row) {
    setLocalError("");
    setModal({ kind, row });
  }
  async function save(body) {
    let caught;
    const result = await run(
      async () => {
        try {
          return await api(path, "sim", body);
        } catch (error) {
          caught = error.message;
          throw error;
        }
      },
      commandsTab ? "指令版本已保存" : "任务模板版本已保存",
    );
    if (result) {
      setModal(null);
      setReload((n) => n + 1);
    } else setLocalError(caught || "保存失败，请检查输入并重试。");
  }
  const defaultApp = platform || "pdd";
  const modalTitle =
    modal?.kind === "history"
      ? `${modal.row.name} · 版本历史`
      : modal?.kind === "archive"
        ? `归档${commandsTab ? "指令" : "任务模板"}`
        : modal?.kind === "submit"
          ? "提交模板任务"
          : `${modal?.kind === "edit" ? (active(modal.row) ? "编辑" : "恢复") : modal?.kind === "clone" ? "复制" : "新建"}${commandsTab ? "指令" : "任务模板"}`;
  return (
    <section className="catalog-page" aria-label="指令与任务库">
      <div className="catalog-summary">
        <div>
          <span className="catalog-eyebrow">PLATFORM CATALOG</span>
          <h2>操作可复用，任务可编排</h2>
          <p>用统一操作描述各平台差异；耗时、输入输出和接口绑定各自版本化。</p>
        </div>
        <div className="catalog-counts">
          <div>
            <strong>{latestCommands.length}</strong>
            <span>可用指令</span>
          </div>
          <div>
            <strong>
              {latestDefinitions(catalog.definitions).filter(active).length}
            </strong>
            <span>任务模板</span>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="catalog-toolbar">
          <div className="catalog-tabs" role="tablist" aria-label="目录类型">
            <button
              role="tab"
              aria-selected={commandsTab}
              onClick={() => setTab("commands")}
            >
              <Code size={19} />
              指令表
            </button>
            <button
              role="tab"
              aria-selected={!commandsTab}
              onClick={() => setTab("tasks")}
            >
              <Stack size={19} />
              任务表
            </button>
          </div>
          <button
            className="primary"
            disabled={busy || loading}
            onClick={() => open("create")}
          >
            <Plus size={18} />
            新建{commandsTab ? "指令" : "任务模板"}
          </button>
        </div>
        <div className="catalog-filters">
          <label>
            平台
            <select
              aria-label="平台筛选"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              <option value="">全部平台</option>
              {platformIds.map((id) => (
                <option key={id} value={id}>
                  {appName(id)}
                </option>
              ))}
            </select>
          </label>
          <label className="catalog-search">
            查找
            <input
              aria-label="搜索指令或任务"
              placeholder="名称或代码"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label className="catalog-archived">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            包含已归档
          </label>
          <button
            className="icon-button"
            aria-label="刷新目录"
            disabled={loading}
            onClick={() => setReload((n) => n + 1)}
          >
            <ArrowClockwise size={19} />
          </button>
        </div>
        {loadError && (
          <p role="alert" className="error catalog-empty">
            {loadError}
          </p>
        )}
        {loading ? (
          <p className="catalog-empty muted">读取版本化目录…</p>
        ) : (
          <div className="catalog-table-wrap">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th>{commandsTab ? "平台指令" : "组合任务"}</th>
                  <th>{commandsTab ? "操作与耗时" : "执行步骤"}</th>
                  <th>{commandsTab ? "接口绑定" : "调度类型"}</th>
                  <th>版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id || `${row.code}:${row.version}`}
                    className={!active(row) ? "is-archived" : ""}
                  >
                    <td>
                      <strong>{row.name}</strong>
                      <code>{row.code}</code>
                      <span className="small muted">
                        {row.appId ? appName(row.appId) : "跨平台通用"}
                      </span>
                      {!active(row) && (
                        <span className="catalog-tag">已归档</span>
                      )}
                    </td>
                    <td>
                      {commandsTab ? (
                        <>
                          <span>
                            {actionName[row.action] || row.action || row.effect}
                          </span>
                          <small>
                            {(row.estimateMs / 1000).toFixed(1)} 秒预计 ·{" "}
                            {(row.timeoutMs / 1000).toFixed(1)} 秒超时
                          </small>
                        </>
                      ) : (
                        <>
                          <span>
                            {(row.steps || []).reduce(
                              (sum, s) => sum + s.repeat,
                              0,
                            )}{" "}
                            条指令
                          </span>
                          <small className="catalog-flow">
                            {(row.steps || [])
                              .map(
                                (s) =>
                                  `${s.code}${s.repeat > 1 ? ` ×${s.repeat}` : ""}`,
                              )
                              .join(" → ")}
                          </small>
                        </>
                      )}
                    </td>
                    <td>
                      {commandsTab ? (
                        <div className="catalog-tags">
                          {row.bindings?.length ? (
                            row.bindings.map((binding, i) => (
                              <span
                                className="catalog-tag"
                                key={i}
                                title={`${binding.adapterId} / ${binding.operation}`}
                              >
                                {binding.kind.toUpperCase()}
                              </span>
                            ))
                          ) : (
                            <span className="small muted">待绑定</span>
                          )}
                        </div>
                      ) : (
                        <span>
                          {row.loop === "large" ? "大循环" : "小循环"}
                          {row.resumable ? " · 可模拟恢复" : ""}
                        </span>
                      )}
                    </td>
                    <td>
                      <button
                        className="text-button"
                        aria-label={`查看 ${row.code} 版本历史`}
                        onClick={() => open("history", row)}
                      >
                        v{row.version}
                      </button>
                    </td>
                    <td>
                      <div className="catalog-row-actions">
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => open("edit", row)}
                          aria-label={`${active(row) ? "编辑" : "恢复"} ${row.code}`}
                        >
                          <PencilSimple size={16} />
                          {active(row) ? "编辑" : "恢复"}
                        </button>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => open("clone", row)}
                          aria-label={`复制 ${row.code}`}
                        >
                          <Copy size={16} />
                          复制
                        </button>
                        {active(row) && (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => open("archive", row)}
                            aria-label={`归档 ${row.code}`}
                          >
                            <Archive size={16} />
                            归档
                          </button>
                        )}
                        {!commandsTab && active(row) && (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => open("submit", row)}
                            aria-label={`运行 ${row.code}`}
                          >
                            <PlayCircle size={16} />
                            模拟运行
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <p className="catalog-empty muted">
                暂无符合筛选条件的{commandsTab ? "指令" : "任务模板"}。
              </p>
            )}
          </div>
        )}
        <div className="catalog-footer">
          编辑创建新版本；归档保留历史与执行证据。接口绑定是连接器契约，真实适配器验收前仅执行模拟。
        </div>
      </div>
      {modal && (
        <Modal
          title={modalTitle}
          className="catalog-modal"
          onClose={() => !busy && setModal(null)}
        >
          {localError && (
            <p className="error modal-error" role="alert">
              {localError}
            </p>
          )}
          {modal.kind === "history" ? (
            <div className="form">
              <p className="small muted">
                历史版本只读。修改、恢复或复制会保留原版本与已提交任务。
              </p>
              {source
                .filter((r) => r.code === modal.row.code)
                .sort((a, b) => b.version - a.version)
                .map((r) => (
                  <details
                    key={r.id || r.version}
                    open={r.version === modal.row.version}
                  >
                    <summary>
                      v{r.version} · {r.name}
                      {!active(r) ? " · 已归档" : ""}
                    </summary>
                    <pre>{JSON.stringify(r, null, 2)}</pre>
                  </details>
                ))}
            </div>
          ) : modal.kind === "archive" ? (
            <div className="form">
              <p>
                归档「{modal.row.name}
                」后，目录默认隐藏它。已有任务和历史版本仍保留，可从“包含已归档”中恢复。
              </p>
              {commandsTab && (
                <p className="small muted">
                  引用此指令的模板会保留其绑定版本；如需替换，请同时更新相关任务模板。
                </p>
              )}
              <div className="button-row">
                <button disabled={busy} onClick={() => setModal(null)}>
                  返回
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    let caught;
                    const result = await run(async () => {
                      try {
                        return await archiveRow(path, modal.row);
                      } catch (error) {
                        caught = error.message;
                        throw error;
                      }
                    }, "已归档，历史版本保留");
                    if (result) {
                      setModal(null);
                      setReload((n) => n + 1);
                    } else setLocalError(caught || "归档失败");
                  }}
                >
                  确认归档
                </button>
              </div>
            </div>
          ) : modal.kind === "submit" ? (
            <SubmitTemplate
              definition={modal.row}
              devices={state.devices}
              busy={busy}
              onSubmit={async (body) => {
                let caught;
                const result = await run(async () => {
                  try {
                    return await api("jobs", "sim", body);
                  } catch (error) {
                    caught = error.message;
                    throw error;
                  }
                }, "模板任务已入池，可在任务池查看指令执行证据");
                if (result) setModal(null);
                else setLocalError(caught || "任务提交失败");
              }}
            />
          ) : commandsTab ? (
            <CommandForm
              busy={busy}
              editing={modal.kind === "edit"}
              initial={
                modal.kind === "edit"
                  ? modal.row
                  : modal.kind === "clone"
                    ? {
                        ...modal.row,
                        code: `${modal.row.code}.copy`,
                        name: `${modal.row.name} · 副本`,
                      }
                    : {
                        appId: defaultApp,
                        code: `${defaultApp}.custom`,
                        name: `${appName(defaultApp)} · 自定义操作`,
                      }
              }
              onSubmit={save}
            />
          ) : (
            <DefinitionForm
              definitions={catalog.definitions}
              commandDefinitions={catalog.history}
              busy={busy}
              editing={modal.kind === "edit"}
              lockedCode={modal.kind === "edit"}
              initialDefinition={
                modal.kind === "edit"
                  ? modal.row
                  : modal.kind === "clone"
                    ? {
                        ...modal.row,
                        code: `${modal.row.code}.copy`,
                        name: `${modal.row.name} · 副本`,
                      }
                    : {
                        code: `${defaultApp}.custom.flow`,
                        name: `${appName(defaultApp)} · 自定义任务`,
                        appId: defaultApp,
                        loop: "small",
                        resumable: false,
                        steps: latestCommands.some(
                          (c) => c.code === `${defaultApp}.open`,
                        )
                          ? [
                              {
                                code: `${defaultApp}.open`,
                                repeat: 1,
                                commandVersion: latestCommands.find(
                                  (c) => c.code === `${defaultApp}.open`,
                                ).version,
                              },
                            ]
                          : [
                              {
                                code: "app.open",
                                repeat: 1,
                                commandVersion:
                                  latestCommands.find(
                                    (c) => c.code === "app.open",
                                  )?.version || 1,
                              },
                            ],
                      }
              }
              onSubmit={save}
            />
          )}
        </Modal>
      )}
    </section>
  );
}
