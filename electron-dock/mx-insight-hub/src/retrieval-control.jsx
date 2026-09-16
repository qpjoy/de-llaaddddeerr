import { useCallback, useEffect, useState } from 'react'
import { adminApi } from './api.js'
import { ErrorState, LoadingState, useRemoteData, formatDate } from './components.jsx'
import './advanced-search.css'
const labels = { pending: '等待处理', running: '执行中', done: '已处理记录', dead: '需重试' }
const runLabels = {
  scanning: '扫描历史记录',
  draining: '处理已入队记录',
  completed: '已完成',
  cancelled: '已停止',
}
export function RetrievalControlPanel({ token, onUnauthorized }) {
  const load = useCallback(() => adminApi.retrievalControl(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  const [draft, setDraft] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null),
    [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (state.data?.settings && !draft) {
      const s = state.data.settings
      setDraft({
        enabled: s.enabled,
        paused: s.paused,
        maxConcurrency: s.max_concurrency,
        dailyTokenBudget: Number(s.daily_token_budget),
      })
    }
  }, [state.data, draft])
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) state.refresh()
    }, 30000)
    return () => clearInterval(id)
  }, [state.refresh])
  const execute = async (action) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const data =
        action === 'settings'
          ? await adminApi.retrievalSettings(token, draft)
          : await adminApi.retrievalAction(token, action)
      state.setData(data)
      setDraft({
        enabled: data.settings.enabled,
        paused: data.settings.paused,
        maxConcurrency: data.settings.max_concurrency,
        dailyTokenBudget: Number(data.settings.daily_token_budget),
      })
      setConfirm(false)
    } catch (e) {
      if (e.status === 401) onUnauthorized?.(e)
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  const data = state.data,
    active = ['scanning', 'draining'].includes(data?.run?.status)
  return (
    <section className="qp-panel mih-browser-panel">
      <h2>向量化与 RAG 索引</h2>
      <p className="mih-browser-note">
        后台处理已入库的文本；全文索引重建与模型向量化分别控制。计算出的向量保存在 PostgreSQL，可重复投影到
        ES。
      </p>
      {state.loading && !data ? <LoadingState /> : null}
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      {error ? <ErrorState error={error} /> : null}
      {data && draft ? (
        <>
          <p className="mih-browser-note">
            {data.ready ? 'Embedding 与向量索引已配置；实际处理进度见下方。' : data.reason} · {data.scope}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              execute('settings')
            }}
          >
            <div className="mih-retrieval-settings">
              <label className="mih-advanced-check">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft((v) => ({ ...v, enabled: e.target.checked }))}
                />
                启用后台向量化
              </label>
              <label className="mih-advanced-check">
                <input
                  type="checkbox"
                  checked={draft.paused}
                  onChange={(e) => setDraft((v) => ({ ...v, paused: e.target.checked }))}
                />
                暂停新任务
              </label>
              <label className="qp-field">
                集群任务并发上限
                <input
                  className="qp-input"
                  type="number"
                  min={1}
                  max={16}
                  required
                  value={draft.maxConcurrency}
                  onChange={(e) => setDraft((v) => ({ ...v, maxConcurrency: Number(e.target.value) }))}
                />
              </label>
              <label className="qp-field">
                每日预估 token 预算
                <input
                  className="qp-input"
                  type="number"
                  min={1000}
                  max={1000000000}
                  required
                  value={draft.dailyTokenBudget}
                  onChange={(e) => setDraft((v) => ({ ...v, dailyTokenBudget: Number(e.target.value) }))}
                />
              </label>
            </div>
            <div className="mih-retrieval-actions">
              <button className="qp-button qp-button--primary" disabled={busy}>
                保存设置
              </button>
              <button
                type="button"
                className="qp-button qp-button--secondary"
                onClick={state.refresh}
                disabled={busy}
              >
                刷新状态
              </button>
            </div>
          </form>
          <div className="mih-retrieval-progress">
            <div>
              <small>在线 Worker</small>
              <strong>{data.workers?.length || 0}</strong>
            </div>
            {Object.entries(labels).map(([key, label]) => (
              <div key={key}>
                <small>{label}</small>
                <strong>
                  {Number(data.jobs.find((j) => j.status === key)?.count || 0).toLocaleString('zh-CN')}
                </strong>
              </div>
            ))}
            <div>
              <small>今日已预留 token（UTC）</small>
              <strong>{data.reservedTokensToday.toLocaleString('zh-CN')}</strong>
            </div>
          </div>
          <p className="mih-browser-note">
            状态最多缓存 30 秒。预算是调用前的预估计数，包含失败尝试，实际供应商计费以供应商记录为准。并发还受
            Worker 副本数、HanLP 与模型服务容量约束。
          </p>
          <div className="mih-retrieval-actions">
            <button
              className="qp-button qp-button--secondary"
              disabled={busy || active || !data.ready || !data.settings.enabled || data.settings.paused}
              onClick={() => setConfirm((v) => !v)}
            >
              全库向量化 / 补齐索引
            </button>
            <button
              className="qp-button qp-button--secondary"
              disabled={busy}
              onClick={() => execute('retry')}
            >
              重试失败记录
            </button>
            {active ? (
              <button
                className="qp-button qp-button--secondary"
                disabled={busy}
                onClick={() => execute('cancel')}
              >
                停止回填并暂停新任务
              </button>
            ) : null}
          </div>
          {confirm ? (
            <div className="mih-advanced-notice">
              <strong>为全部当前文本建立向量索引</strong>
              <p>
                此操作会调用已配置的 Embedding
                服务，可能产生费用。历史记录分批入队，新数据优先；已有同版本向量复用。不会删除现有全文索引，也不会重新采集。短于
                24 字符的记录保留全文检索。
              </p>
              <button
                className="qp-button qp-button--primary"
                disabled={busy}
                onClick={() => execute('backfill')}
              >
                确认开始后台任务
              </button>{' '}
              <button className="qp-button qp-button--ghost" onClick={() => setConfirm(false)}>
                取消
              </button>
            </div>
          ) : null}
          <p>
            {data.run
              ? `最近任务：${runLabels[data.run.status] || data.run.status} · 已扫描 ${Number(data.run.seeded).toLocaleString('zh-CN')} 条 · 开始于 ${formatDate(data.run.started_at)}`
              : '尚未启动全库向量化任务'}
          </p>
          {data.failures?.length ? (
            <details>
              <summary>最近失败记录</summary>
              {data.failures.map((f) => (
                <p key={f.record_id}>
                  {f.record_id} · {f.last_error_code} · {formatDate(f.updated_at)}
                </p>
              ))}
            </details>
          ) : null}
          <p className="mih-browser-note">
            暂停后，已执行中的小批次会收尾，队列保留；删除同步继续。{data.ha}
            。全文与向量任务失败均可恢复，不阻塞平台接口的模型调用链。
          </p>
        </>
      ) : null}
    </section>
  )
}
