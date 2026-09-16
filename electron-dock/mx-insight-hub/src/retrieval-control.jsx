import { useCallback, useEffect, useState } from 'react'
import { adminApi } from './api.js'
import { ErrorState, LoadingState, useRemoteData, formatDate } from './components.jsx'
import './advanced-search.css'
import { IndexingObservation } from './indexing-observation.jsx'
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
    [initializationBudget, setInitializationBudget] = useState(1000000000),
    [budgetRunId, setBudgetRunId] = useState(null),
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
    const run = state.data?.run
    if (run?.snapshot_locked && run.id !== budgetRunId) {
      setInitializationBudget(Number(run.token_budget))
      setBudgetRunId(run.id)
    }
  }, [state.data?.run, budgetRunId])
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
          : await adminApi.retrievalAction(token, action,
            ['backfill', 'backfill-budget'].includes(action) ? { tokenBudget: initializationBudget } : {})
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
                日常增量 token 预算 / 天
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
              <small>今日增量已预留 token（UTC）</small>
              <strong>{data.reservedTokensToday.toLocaleString('zh-CN')}</strong>
            </div>
          </div>
          <p className="mih-browser-note">
            每日预算只用于增量，北京时间每天 08:00 进入新预算日；初始化使用下方独立额度，不占用每日预算。
            状态最多缓存 30 秒。预算是调用前的预估计数，包含失败尝试，实际供应商计费以供应商记录为准。并发还受
            Worker 副本数、HanLP 与模型服务容量约束。
          </p>
          <div className="mih-advanced-notice">
            <strong>历史初始化 · 固定范围、独立额度</strong>
            <p>启动时锁定当前可检索文本的记录与版本。后续新增或更新进入日常增量，不延长本次范围；已有向量会复用。</p>
            <label className="qp-field">
              本次初始化 token 总额度（0 = 不限额）
              <input className="qp-input" type="number" min={0} max={1000000000} step={1}
                value={initializationBudget}
                onChange={(e) => setInitializationBudget(Number(e.target.value))} />
            </label>
            <p className="mih-browser-note">不限额仍受供应商限流、Worker 并发和暂停设置约束，模型调用可能产生费用。任务结束后自然只剩每日增量，无需改回预算。</p>
            {active && data.run?.snapshot_locked ? <button className="qp-button qp-button--secondary"
              disabled={busy || !Number.isInteger(initializationBudget) || initializationBudget < 0 || initializationBudget > 1000000000}
              onClick={() => execute('backfill-budget')}>更新本次额度并继续</button> : null}
          </div>
          <div className="mih-retrieval-actions">
            <button
              className="qp-button qp-button--secondary"
              disabled={busy || active || !data.ready || !data.settings.enabled || data.settings.paused || !Number.isInteger(initializationBudget) || initializationBudget < 0 || initializationBudget > 1000000000}
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
              <strong>锁定当前范围并开始历史初始化</strong>
              <p>
                此操作会调用已配置的 Embedding
                服务，可能产生费用。历史记录分批入队，新数据优先；已有同版本向量复用。不会删除现有全文索引，也不会重新采集。短于
                24 字符的记录保留全文检索。
              </p>
              <p>本次总额度：{initializationBudget === 0 ? '不限额' : `${initializationBudget.toLocaleString('zh-CN')} token`}；每日增量预算保持 {Number(data.settings.daily_token_budget).toLocaleString('zh-CN')} token。</p>
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
          {data.run?.snapshot_locked ? <div className="mih-retrieval-progress">
            <div><small>锁定范围</small><strong>{Number(data.run.target_count).toLocaleString('zh-CN')} 条</strong></div>
            <div><small>已处理</small><strong>{Number(data.run.progress?.completed || 0).toLocaleString('zh-CN')}</strong></div>
            <div><small>版本变化 · 转增量</small><strong>{Number(data.run.progress?.superseded || 0).toLocaleString('zh-CN')}</strong></div>
            <div><small>初始化剩余</small><strong>{Number(data.run.progress?.pending || 0).toLocaleString('zh-CN')}</strong></div>
            <div><small>本次已预留 / 总额度</small><strong>{Number(data.run.reserved_tokens).toLocaleString('zh-CN')} / {Number(data.run.token_budget) === 0 ? '不限额' : Number(data.run.token_budget).toLocaleString('zh-CN')}</strong></div>
          </div> : data.run ? <p className="mih-browser-note">此为升级前任务，沿用原每日预算。新启动的初始化任务才使用固定范围与独立额度。</p> : null}
          <IndexingObservation data={data.observation} kind="vector" />
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
