import "./dataport-support.css";
import { useCallback, useState } from "react";
import { adminApi } from "./api.js";
import {
  DropdownField,
  ErrorState,
  Field,
  PageHeading,
  useRemoteData,
} from "./components.jsx";
const statuses = { saved: "已提交", processing: "处理中", closed: "已关闭" };
const when = (value) => (value ? new Date(value).toLocaleString("zh-CN") : "—");
export function DataportSupportPage({ token, onUnauthorized }) {
  const [page, setPage] = useState(1),
    [q, setQ] = useState(""),
    [status, setStatus] = useState(""),
    [tenantId, setTenant] = useState(""),
    [selected, setSelected] = useState(null);
  const load = useCallback(
    () =>
      adminApi.dataportTickets(token, { query: { page, q, status, tenantId } }),
    [token, page, q, status, tenantId],
  );
  const state = useRemoteData(load, onUnauthorized);
  return (
    <div className="mih-page mih-dataport-admin">
      <PageHeading
        title="数港服务工单"
        description="处理企业提交的问题，回复与状态变更会通知提交人。"
        loading={state.loading}
        onRefresh={state.refresh}
      />
      <section className="qp-panel mih-panel">
        <div className="mih-dataport-filters">
          <Field label="搜索工单">
            <input
              className="qp-input"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="问题、编号或企业名称"
            />
          </Field>
          <Field label="企业编号">
            <input
              className="qp-input"
              value={tenantId}
              onChange={(e) => {
                setTenant(e.target.value);
                setPage(1);
              }}
              placeholder="留空查看全部企业"
            />
          </Field>
          <DropdownField
            label="状态"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={[
              { value: "", label: "全部状态" },
              ...Object.entries(statuses).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
        </div>
        {state.error ? <ErrorState error={state.error} /> : null}
        <div className="qp-table-wrap">
          <table className="qp-table">
            <thead>
              <tr>
                <th>企业 / 工单</th>
                <th>优先级</th>
                <th>状态</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {state.data?.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong>{t.tenantName}</strong>
                    <p>{t.content.slice(0, 80)}</p>
                    <small>{t.id}</small>
                  </td>
                  <td>{t.priority === "urgent" ? "紧急" : "普通"}</td>
                  <td>{statuses[t.status] || t.status}</td>
                  <td>{when(t.updated_at)}</td>
                  <td>
                    <button
                      className="qp-button qp-button--outline"
                      onClick={() => setSelected(t)}
                    >
                      处理
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!state.loading && !state.data?.total ? <p>暂无匹配工单。</p> : null}
        <div className="mih-page-actions">
          <span>共 {state.data?.total ?? 0} 条</span>
          <button
            className="qp-button qp-button--outline"
            disabled={state.loading || page <= 1}
            onClick={() => setPage((v) => v - 1)}
          >
            上一页
          </button>
          <span>{page}</span>
          <button
            className="qp-button qp-button--outline"
            disabled={state.loading || page * 10 >= (state.data?.total || 0)}
            onClick={() => setPage((v) => v + 1)}
          >
            下一页
          </button>
        </div>
      </section>
      {selected ? (
        <TicketWorkspace
          key={selected.id}
          {...{ token, onUnauthorized }}
          ticket={selected}
          onSaved={state.refresh}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
function TicketWorkspace({ token, ticket, onUnauthorized, onSaved, onClose }) {
  const load = useCallback(
    () => adminApi.dataportTicket(token, ticket.tenant_id, ticket.id),
    [token, ticket.tenant_id, ticket.id],
  );
  const state = useRemoteData(load, onUnauthorized),
    [reply, setReply] = useState(""),
    [status, setStatus] = useState(ticket.status),
    [pending, setPending] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [notice, setNotice] = useState("");
  async function save(event) {
    event.preventDefault();
    if (busy || !state.data) return;
    setBusy(true);
    setError(null);
    setNotice("");
    const command = pending || {
      commandId: crypto.randomUUID(),
      revision: state.data.revision,
      status,
      reply,
    };
    setPending(command);
    try {
      await adminApi.dataportTicket(token, ticket.tenant_id, ticket.id, {
        method: "POST",
        body: command,
      });
      setPending(null);
      setReply("");
      setNotice("已保存，并向工单提交人发送站内通知。");
      state.refresh();
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="qp-panel mih-panel">
      <PageHeading title="处理工单" description={ticket.id}>
        <button
          className="qp-button qp-button--outline"
          disabled={busy}
          onClick={onClose}
        >
          关闭处理面板
        </button>
      </PageHeading>
      {state.error ? <ErrorState error={state.error} /> : null}
      {error ? <ErrorState error={error} /> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {state.data?.content}
      </p>
      <p>联系方式：{state.data?.contact || "未填写"}</p>
      {state.data?.replies.map((r) => (
        <article key={r.id}>
          <strong>
            {statuses[r.status]} · {when(r.created_at)}
          </strong>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {r.reply || "状态已更新"}
          </p>
        </article>
      ))}
      <form onSubmit={save}>
        <DropdownField
          label="处理状态"
          value={status}
          onChange={setStatus}
          disabled={busy || !!pending}
          options={Object.entries(statuses).map(([value, label]) => ({
            value,
            label,
          }))}
        />
        <Field label="客服回复" hint="回复仅向有权查看该工单的成员展示。">
          <textarea
            className="qp-input"
            rows={5}
            maxLength={5000}
            value={reply}
            disabled={busy || !!pending}
            onChange={(e) => setReply(e.target.value)}
          />
        </Field>
        <div className="mih-page-actions">
          <button
            className="qp-button qp-button--primary"
            disabled={
              busy ||
              state.loading ||
              !state.data ||
              (!pending && !reply.trim() && status === state.data.status)
            }
          >
            {busy ? "保存中…" : pending ? "重试原操作" : "保存处理并通知"}
          </button>
          <button
            type="button"
            className="qp-button qp-button--outline"
            disabled={busy}
            onClick={() => {
              state.refresh();
              onSaved();
              setPending(null);
            }}
          >
            刷新确认结果
          </button>
        </div>
        {pending && !busy ? (
          <p>
            上次结果尚未确认。重试会使用原操作编号；修改内容前请先刷新确认。
          </p>
        ) : null}
      </form>
    </section>
  );
}
