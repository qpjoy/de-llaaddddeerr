import { useCallback, useEffect, useState } from "react";
import { Plus, PlugsConnected } from "@phosphor-icons/react";
import { api, appName, labels, time } from "./data.js";
import { Modal } from "./Forms.jsx";
import "./clients.css";

const CLASSES = [
  ["interactive", "交互"],
  ["standard", "标准"],
  ["batch", "批量"],
];
const APPS = ["xhs", "weibo", "xianyu", "pdd"];
const EMBED = {
  none: "不开放嵌入",
  client: "客户视图（只看自己的任务）",
  ops: "运维视图（只读，可看全部机架）",
};
const DELIVERY = {
  pending: ["待投递", "unknown"],
  delivered: ["已送达", "succeeded"],
  dead: ["已放弃", "blocked"],
};
const seconds = (ms) =>
  ms == null
    ? "—"
    : Math.abs(ms) >= 60000
      ? `${(ms / 60000).toFixed(1)} 分钟`
      : `${Math.round(ms / 1000)} 秒`;
const percent = (part, total) =>
  total ? `${Math.round((part / total) * 100)}%` : "—";

// Callers of the Job API v1 (V2-5): API keys (shown once), scopes, quotas,
// fair-share weight, callback origins and embedding. Simulation realm only.
export default function Clients({ busy, run }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [modal, setModal] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api("clients", "sim"));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 3000);
    return () => clearInterval(timer);
  }, [load]);
  const change = async (client, body, message, keepOpen) => {
    const r = await run(
      () =>
        api(`clients/${client.id}`, "sim", {
          revision: client.revision,
          ...body,
        }),
      message,
    );
    await load();
    if (r && !keepOpen) setModal(null);
    return r;
  };
  const clients = data?.clients || [];
  const fair = data?.fairness;
  const service = fair
    ? fair.serviceMs.interactive +
      fair.serviceMs.standard +
      fair.serviceMs.batch
    : 0;
  return (
    <>
      <section className="panel clients-page">
        <div className="section-head">
          <div>
            <h2>调用方</h2>
            <p className="muted small">
              外部系统（例如 Hub）通过 Job API v1
              提交模板任务、查询或等待结果、接收签名回调。每个调用方一个 API
              密钥（中心只保存摘要），按权重公平分享设备时间；目前只用于模拟调度。
            </p>
          </div>
          <button
            className="primary"
            disabled={busy}
            onClick={() => setModal({ type: "edit" })}
          >
            <Plus size={18} />
            新增调用方
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {fair && (
          <div className="clients-fairness">
            <div>
              <span>系统虚拟时间</span>
              <strong>{seconds(fair.virtualTimeMs)}</strong>
              <small>有排队任务的调用方的加权平均</small>
            </div>
            {CLASSES.map(([k, label]) => (
              <div key={k}>
                <span>{label}等级用时（近 5 分钟衰减）</span>
                <strong>{percent(fair.serviceMs[k], service)}</strong>
                <small>
                  {seconds(fair.serviceMs[k])}
                  {k === "batch" ? " · 保底 10%" : ""}
                </small>
              </div>
            ))}
          </div>
        )}
        {!clients.length ? (
          <p className="muted clients-empty">
            还没有调用方。新增后把 API
            密钥配置到调用系统的服务端（不要放进浏览器或网址），按下方接入说明调用。
          </p>
        ) : (
          <div className="table-scroll">
            <table className="clients-table">
              <thead>
                <tr>
                  <th>调用方</th>
                  <th>权重 / 等级</th>
                  <th>配额</th>
                  <th>当前</th>
                  <th>结果</th>
                  <th>公平</th>
                  <th>嵌入</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="muted">
                        <span
                          className={`status ${c.status === "active" ? "succeeded" : "blocked"}`}
                        >
                          {c.status === "active" ? "启用" : "已停用"}
                        </span>{" "}
                        密钥 {c.keyHint}
                      </div>
                      <div className="muted">
                        {c.scopes.apps.length
                          ? c.scopes.apps.map(appName).join("、")
                          : "全部 App"}
                        {c.scopes.templates.length
                          ? ` · ${c.scopes.templates.length} 个模板`
                          : ""}
                      </div>
                    </td>
                    <td>
                      ×{c.weight}
                      <div className="muted">
                        {c.scopes.classes
                          .map((k) => CLASSES.find((x) => x[0] === k)[1])
                          .join(" / ")}
                      </div>
                    </td>
                    <td>
                      排队 ≤ {c.quotas.maxQueued}
                      <div className="muted">
                        并发 ≤ {c.quotas.maxInflight} · {c.quotas.ratePerMinute}
                        /分钟
                      </div>
                    </td>
                    <td>
                      排队 {c.live.queued}
                      <div className="muted">执行 {c.live.running}</div>
                    </td>
                    <td>
                      {c.outcomes ? (
                        <>
                          完成 {c.outcomes.succeeded || 0}
                          <div className="muted">
                            {[
                              ["failed", "失败"],
                              ["unknown", "待核验"],
                              ["cancelled", "取消"],
                              ["expired", "过期"],
                            ]
                              .filter(([k]) => c.outcomes[k])
                              .map(([k, label]) => `${label} ${c.outcomes[k]}`)
                              .join(" · ") || "无异常"}
                          </div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <span title="虚拟运行时间与系统虚拟时间之差：为正表示近期用得多，会让给别人">
                        {c.fair.lagMs > 0 ? "+" : ""}
                        {seconds(c.fair.lagMs)}
                      </span>
                      <div className="muted">
                        已用 {seconds(c.usage.servedMs)}
                      </div>
                    </td>
                    <td className="small">{EMBED[c.embed].split("（")[0]}</td>
                    <td>
                      <div className="button-row clients-actions">
                        <button
                          disabled={busy}
                          onClick={() => setModal({ type: "edit", client: c })}
                        >
                          编辑
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            setModal({ type: "deliveries", client: c })
                          }
                        >
                          回调记录
                        </button>
                        <button
                          disabled={busy}
                          onClick={async () => {
                            const r = await change(
                              c,
                              { rotateKey: true },
                              "已轮换密钥；旧密钥立即失效",
                              true,
                            );
                            if (r)
                              setModal({
                                type: "secrets",
                                client: r.client,
                                key: r.key,
                              });
                          }}
                        >
                          轮换密钥
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            change(
                              c,
                              {
                                status:
                                  c.status === "active" ? "disabled" : "active",
                              },
                              c.status === "active"
                                ? "已停用：拒绝新请求，已提交的任务照常执行"
                                : "已启用",
                            )
                          }
                        >
                          {c.status === "active" ? "停用" : "启用"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Integration />
      {modal?.type === "edit" && (
        <Modal
          title={
            modal.client ? `编辑调用方 · ${modal.client.name}` : "新增调用方"
          }
          onClose={() => setModal(null)}
        >
          <ClientForm
            client={modal.client}
            busy={busy}
            onSubmit={async (body, rotateCallback) => {
              if (modal.client) {
                const r = await change(
                  modal.client,
                  { ...body, rotateCallbackSecret: rotateCallback },
                  "调用方已更新",
                  rotateCallback,
                );
                if (r && rotateCallback)
                  setModal({
                    type: "secrets",
                    client: r.client,
                    callbackSecret: r.callbackSecret,
                  });
                return;
              }
              const r = await run(
                () => api("clients", "sim", body),
                "已新增调用方",
              );
              await load();
              if (r)
                setModal({
                  type: "secrets",
                  client: r.client,
                  key: r.key,
                  callbackSecret: r.callbackSecret,
                });
            }}
          />
        </Modal>
      )}
      {modal?.type === "secrets" && (
        <Modal title="密钥（只显示一次）" onClose={() => setModal(null)}>
          <div className="form">
            <p className="notice">
              关闭后无法再次查看。API
              密钥中心只保存摘要；请只配置在调用系统的服务端，不要放进浏览器、网址、日志或聊天记录。
            </p>
            {modal.key && (
              <label>
                API 密钥 · {modal.client.name}
                <input
                  readOnly
                  value={modal.key}
                  onFocus={(e) => e.target.select()}
                />
              </label>
            )}
            {modal.callbackSecret && (
              <label>
                回调签名密钥（校验 X-MX-Signature）
                <input
                  readOnly
                  value={modal.callbackSecret}
                  onFocus={(e) => e.target.select()}
                />
              </label>
            )}
            <button className="primary" onClick={() => setModal(null)}>
              已保存
            </button>
          </div>
        </Modal>
      )}
      {modal?.type === "deliveries" && (
        <Modal
          title={`回调记录 · ${modal.client.name}`}
          className="wide-dialog"
          onClose={() => setModal(null)}
        >
          <Deliveries client={modal.client} busy={busy} run={run} />
        </Modal>
      )}
    </>
  );
}

function ClientForm({ client, busy, onSubmit }) {
  const [rotate, setRotate] = useState(false);
  return (
    <form
      className="form client-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const lines = (name) =>
          String(f.get(name) || "")
            .split(/[\s,，]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        void onSubmit(
          {
            name: f.get("name"),
            weight: Number(f.get("weight")),
            classes: CLASSES.map(([k]) => k).filter(
              (k) => f.get(`class-${k}`) === "on",
            ),
            apps: APPS.filter((k) => f.get(`app-${k}`) === "on"),
            templates: lines("templates"),
            quotas: {
              maxQueued: Number(f.get("maxQueued")),
              maxInflight: Number(f.get("maxInflight")),
              ratePerMinute: Number(f.get("ratePerMinute")),
              burst: Number(f.get("burst")),
            },
            callbackHosts: lines("callbackHosts"),
            embed: f.get("embed"),
          },
          rotate,
        );
      }}
    >
      <div className="form-grid">
        <label>
          名称
          <input
            name="name"
            required
            maxLength={60}
            defaultValue={client?.name || "Hub"}
          />
        </label>
        <label>
          公平权重（0.1–100）
          <input
            name="weight"
            type="number"
            step="0.1"
            min="0.1"
            max="100"
            defaultValue={client?.weight ?? 1}
          />
        </label>
      </div>
      <fieldset>
        <legend>允许的等级（等级之间严格优先；批量保底 10% 设备时间）</legend>
        {CLASSES.map(([k, label]) => (
          <label className="check" key={k}>
            <input
              type="checkbox"
              name={`class-${k}`}
              defaultChecked={(
                client?.scopes.classes || ["standard", "batch"]
              ).includes(k)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>允许的 App（都不选表示全部）</legend>
        {APPS.map((k) => (
          <label className="check" key={k}>
            <input
              type="checkbox"
              name={`app-${k}`}
              defaultChecked={client?.scopes.apps.includes(k)}
            />
            {appName(k)}
          </label>
        ))}
      </fieldset>
      <label>
        允许的模板代码（空格或逗号分隔，留空表示全部）
        <input
          name="templates"
          placeholder="例如 xhs.detail weibo.list"
          defaultValue={client?.scopes.templates.join(" ") || ""}
        />
      </label>
      <div className="form-grid four">
        {[
          ["maxQueued", "排队上限", 200],
          ["maxInflight", "并发上限", 20],
          ["ratePerMinute", "每分钟提交", 120],
          ["burst", "突发", 30],
        ].map(([k, label, fallback]) => (
          <label key={k}>
            {label}
            <input
              name={k}
              type="number"
              min="1"
              defaultValue={client?.quotas[k] ?? fallback}
            />
          </label>
        ))}
      </div>
      <label>
        回调来源（完整来源，如 https://hub.internal:8443，每行一个）
        <textarea
          name="callbackHosts"
          rows={2}
          defaultValue={client?.callbackHosts.join("\n") || ""}
        />
      </label>
      <label>
        嵌入工作台
        <select name="embed" defaultValue={client?.embed || "client"}>
          {Object.entries(EMBED).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {client && (
        <label className="check">
          <input
            type="checkbox"
            checked={rotate}
            onChange={(e) => setRotate(e.target.checked)}
          />
          同时轮换回调签名密钥（新密钥只显示一次）
        </label>
      )}
      <button className="primary" disabled={busy}>
        {client ? "保存" : "新增并生成密钥"}
      </button>
    </form>
  );
}

function Deliveries({ client, busy, run }) {
  const [rows, setRows] = useState(null);
  const load = useCallback(
    () =>
      api(`clients/${client.id}/deliveries`, "sim")
        .then((v) => setRows(v.deliveries))
        .catch(() => setRows([])),
    [client.id],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);
  if (!rows) return <p className="muted">读取中…</p>;
  if (!rows.length)
    return (
      <p className="muted">
        还没有回调。提交任务时带上 <code>callback.url</code>
        （来源须在允许列表内），任务结束后在这里看到投递。
      </p>
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>任务</th>
            <th>状态</th>
            <th>尝试</th>
            <th>最近一次</th>
            <th>下次重试</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>
                <code>{d.clientRequestId}</code>
                <div className="muted">
                  任务
                  {d.jobStatus ? `${labels[d.jobStatus] || d.jobStatus}` : ""}
                </div>
              </td>
              <td>
                <span className={`status ${DELIVERY[d.status][1]}`}>
                  {DELIVERY[d.status][0]}
                </span>
              </td>
              <td>{d.attempts}</td>
              <td>
                {d.last
                  ? `${time(d.last.at)} · ${d.last.httpStatus ? `HTTP ${d.last.httpStatus}` : d.last.error}`
                  : "—"}
                {d.last?.ms != null && (
                  <div className="muted">{d.last.ms} 毫秒</div>
                )}
              </td>
              <td>
                {d.status === "pending" && d.nextAt ? time(d.nextAt) : "—"}
              </td>
              <td>
                {d.status !== "delivered" && (
                  <button
                    disabled={busy}
                    onClick={async () => {
                      await run(
                        () => api(`outbox/${d.id}/retry`, "sim", {}),
                        "已重新排入投递",
                      );
                      await load();
                    }}
                  >
                    立即重试
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SNIPPET_SUBMIT = `POST /v1/jobs
Authorization: Bearer <API 密钥>
Content-Type: application/json

{"clientRequestId":"order-1001","template":"xhs.detail",
 "params":{"keyword":"露营","target":"note-1"},"class":"standard",
 "ttlMs":600000,"callback":{"url":"https://hub.internal/mx-device/callback"}}

→ 202 {"jobId":"…","status":"queued","predicted":{"startAt":…,"finishAt":…}}
→ 429 Retry-After（配额）· 422 predictedFinishAt（截止时间不可行）`;
const SNIPPET_PROXY = `location /device-center/ {
  proxy_pass http://mx-device:18891/embed/;
  proxy_set_header Authorization "Bearer <API 密钥>";
  proxy_set_header X-MX-Embed-Scope $mx_scope;   # client 或 ops，按 Hub 用户决定
  proxy_set_header X-MX-Embed-User  $mx_user;    # 显示名，URL 编码
  proxy_buffering off;                            # 实时流
  proxy_read_timeout 60s;
}`;
function Integration() {
  return (
    <section className="panel clients-integration">
      <div className="section-head">
        <div>
          <h2>
            <PlugsConnected size={22} /> 接入说明
          </h2>
          <p className="muted small">
            同步调用用 <code>GET /v1/jobs/:id/wait?timeout=25</code>{" "}
            长轮询包装；异步调用接收回调（按 X-MX-Delivery-Id 去重，校验
            X-MX-Signature），或查询 <code>GET /v1/jobs/:id</code>
            。重复查询、等待和查看都不会再次操作手机。
          </p>
        </div>
      </div>
      <div className="clients-snippets">
        <div>
          <h3>提交任务</h3>
          <pre>{SNIPPET_SUBMIT}</pre>
        </div>
        <div>
          <h3>Hub 反向代理嵌入工作台</h3>
          <pre>{SNIPPET_PROXY}</pre>
          <p className="muted small">
            浏览器只持有 Hub 自己的会话；密钥由 Hub 后端加在转发请求上。Hub
            必须丢弃浏览器发来的 Authorization 与 X-MX-* 头，并把 /device-center
            重定向到 /device-center/。嵌入页只读。
          </p>
        </div>
      </div>
    </section>
  );
}
