import { useCallback, useRef, useState } from 'react'
import { MagnifyingGlass, DownloadSimple, Sparkle } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  DropdownField,
  ErrorState,
  LoadingState,
  EmptyState,
  useRemoteData,
  formatDate,
} from './components.jsx'
import { ContentDetail, platformName } from './data-browser-parts.jsx'
import './advanced-search.css'

const options = (pairs) => pairs.map(([value, label]) => ({ value, label }))
const initial = {
  query: '',
  mode: 'fulltext',
  operator: 'and',
  fuzzy: false,
  platform: '',
  objectType: '',
  contentType: '',
  tag: '',
  datasetId: '',
  account: '',
  from: '',
  to: '',
  topK: 30,
}
// ES markers become React text nodes. Source HTML is never interpreted.
export function SearchHighlight({ text = '' }) {
  return String(text)
    .split('\uE000')
    .map((part, i) => {
      const end = part.indexOf('\uE001')
      return i && end >= 0 ? (
        <span key={i}>
          <mark>{part.slice(0, end)}</mark>
          {part.slice(end + 1)}
        </span>
      ) : (
        <span key={i}>{part.replaceAll('\uE001', '')}</span>
      )
    })
}
export default function AdvancedSearchPanel({ token, onUnauthorized, onAccount, onTag }) {
  const load = useCallback(() => adminApi.advancedSearchCapabilities(token), [token])
  const capabilities = useRemoteData(load, onUnauthorized)
  const [draft, setDraft] = useState(initial),
    [result, setResult] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null)
  const [selected, setSelected] = useState([]),
    [answer, setAnswer] = useState(null),
    [answerBusy, setAnswerBusy] = useState(false),
    [answerError, setAnswerError] = useState(null),
    [detail, setDetail] = useState(null)
  const [group, setGroup] = useState('contents')
  const generation = useRef(0),
    inFlight = useRef(false)
  const change = (key, value) =>
    setDraft((v) => ({
      ...v,
      [key]: value,
      ...(key === 'operator' && value === 'phrase' ? { fuzzy: false } : {}),
    }))
  const report = (e, set) => {
    if (e.status === 401) onUnauthorized?.(e)
    set(e)
  }
  const search = async (event) => {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    const version = ++generation.current
    setBusy(true)
    setError(null)
    setAnswer(null)
    setAnswerError(null)
    setResult(null)
    setSelected([])
    try {
      const body = { ...draft }
      if (!body.from) delete body.from
      if (!body.to) delete body.to
      const data = await adminApi.advancedSearch(token, body)
      if (version === generation.current) {
        setResult(data)
      }
    } catch (e) {
      report(e, setError)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const summarize = async () => {
    if (answerBusy || !selected.length || !result) return
    const version = generation.current
    setAnswerBusy(true)
    setAnswerError(null)
    try {
      const data = await adminApi.advancedSearchAnswer(token, {
        snapshotId: result.snapshotId,
        ids: selected,
      })
      if (version === generation.current) setAnswer(data)
    } catch (e) {
      if (version === generation.current) report(e, setAnswerError)
    } finally {
      setAnswerBusy(false)
    }
  }
  const exportResults = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            scope: result.query,
            computedAt: result.computedAt,
            coverage: '本次排名候选，不是全库导出',
            items: result.items,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    )
    const url = URL.createObjectURL(blob),
      a = document.createElement('a')
    a.href = url
    a.download = 'hub-search-evidence.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  if (detail)
    return (
      <ContentDetail
        row={{ id: detail }}
        token={token}
        onUnauthorized={onUnauthorized}
        onClose={() => setDetail(null)}
        onDetail={(r) => setDetail(r.id)}
        onAccount={onAccount}
        onTag={onTag}
      />
    )
  return (
    <div className="mih-advanced-search">
      <section className="qp-panel mih-browser-panel">
        <div className="mih-advanced-intro">
          <div>
            <h2>高级搜索</h2>
            <p>按词项精确检索，或按含义发现相关内容。选择证据后，可生成带引用的回答。</p>
          </div>
          <span className="mih-advanced-badge">已入库数据 · 不触发采集</span>
        </div>
        {capabilities.error ? <ErrorState error={capabilities.error} onRetry={capabilities.refresh} /> : null}
        <form onSubmit={search}>
          <div className="mih-advanced-query">
            <label className="qp-field">
              搜索内容
              <input
                className="qp-input"
                value={draft.query}
                maxLength={500}
                required
                placeholder="例如：近期提到产品售后困难、退货被拒的内容"
                onChange={(e) => change('query', e.target.value)}
              />
            </label>
            <button className="qp-button qp-button--primary" disabled={busy || !draft.query.trim()}>
              <MagnifyingGlass />
              {busy ? '检索中…' : '搜索'}
            </button>
          </div>
          <div className="mih-advanced-options">
            <DropdownField
              label="搜索模式"
              value={draft.mode}
              options={options([
                ['fulltext', '全文检索'],
                ['hybrid', '语义 + 全文（RAG）'],
              ])}
              onChange={(v) => change('mode', v)}
            />
            <DropdownField
              label="词项关系"
              value={draft.operator}
              options={options([
                ['and', 'AND · 同时包含'],
                ['or', 'OR · 任一包含'],
                ['phrase', '连续短语'],
              ])}
              onChange={(v) => change('operator', v)}
            />
            <DropdownField
              label="候选数量"
              value={String(draft.topK)}
              options={options([
                ['10', '前 10 条'],
                ['30', '前 30 条'],
                ['100', '前 100 条'],
              ])}
              onChange={(v) => change('topK', Number(v))}
            />
            <label className="mih-advanced-check">
              <input
                type="checkbox"
                checked={draft.fuzzy}
                disabled={draft.operator === 'phrase'}
                onChange={(e) => change('fuzzy', e.target.checked)}
              />{' '}
              模糊纠错
            </label>
          </div>
          <details className="mih-browser-advanced-wrap">
            <summary>限定范围：平台、类型、账号、标签与日期</summary>
            <div className="mih-browser-advanced">
              {[
                ['platform', '平台标识', '例如 douyin'],
                ['objectType', '对象类型', 'post / product / comment'],
                ['contentType', '内容形态', 'video / image / text'],
                ['account', '账号 ID', '需同时指定平台'],
                ['datasetId', '数据集', '精确匹配数据集标识'],
                ['tag', '来源标签', '精确匹配来源标签'],
              ].map(([key, label, placeholder]) => (
                <label className="qp-field" key={key}>
                  {label}
                  <input
                    className="qp-input"
                    value={draft[key]}
                    maxLength={200}
                    placeholder={placeholder}
                    onChange={(e) => change(key, e.target.value)}
                  />
                </label>
              ))}
              {[
                ['from', '开始日期'],
                ['to', '结束日期'],
              ].map(([key, label]) => (
                <label className="qp-field" key={key}>
                  {label}
                  <input
                    className="qp-input"
                    type="date"
                    value={draft[key]}
                    onChange={(e) => change(key, e.target.value)}
                  />
                </label>
              ))}
            </div>
          </details>
          <p className="mih-browser-note">
            {draft.mode === 'hybrid'
              ? '语义召回按含义匹配；AND / OR 约束其中的全文分支。平台、类型、日期等范围同时约束两路结果。'
              : '全文检索支持词项 AND / OR、连续短语及模糊纠错。'}{' '}
            日期按北京时间的发布时间。高亮表示字面命中，语义命中可能没有高亮。
          </p>
          {draft.mode === 'hybrid' && !capabilities.loading && !capabilities.data?.semantic ? (
            <p className="mih-advanced-notice">
              语义检索尚未就绪：请在 Agent 中心配置 Embedding 业务默认，并在数据中心启用后台向量化。
            </p>
          ) : null}
        </form>
      </section>
      {error ? <ErrorState error={error} /> : null}
      {busy ? <LoadingState label="检索并核对当前来源…" /> : null}
      {result ? (
        <section className="qp-panel mih-browser-panel" aria-live="polite">
          <div className="mih-advanced-intro">
            <div>
              <h2>找到 {result.returned} 条相关证据</h2>
              <p>
                {result.mode === 'hybrid' ? '全文与语义融合排名' : '全文排名'} ·{' '}
                {formatDate(result.computedAt)} · 仅展示前 {result.query.topK} 条候选
              </p>
            </div>
            <button
              className="qp-button qp-button--secondary"
              onClick={exportResults}
              disabled={!result.items.length}
            >
              <DownloadSimple />
              导出本次结果
            </button>
          </div>
          {result.degraded ? (
            <p className="mih-advanced-notice" role="status">
              {result.degraded}
            </p>
          ) : null}
          <p className="mih-browser-note">
            {result.mode === 'hybrid'
              ? '语义相关性没有精确总页数。'
              : result.lexicalTotal?.value != null
                ? `全文索引匹配 ${result.lexicalTotal.value.toLocaleString('zh-CN')}${result.lexicalTotal.relation === 'gte' ? '+' : ''} 条（索引可能有延迟）。`
                : ''}
            此处是有限候选，完整总量、分页及批量筛选请使用账号 /
            内容大盘。已排除过期或删除的来源。向量覆盖范围取决于后台进度。
          </p>
          <div className="mih-browser-tabs" aria-label="结果视图">
            <button aria-pressed={group === 'contents'} onClick={() => setGroup('contents')}>
              内容证据
            </button>
            <button aria-pressed={group === 'accounts'} onClick={() => setGroup('accounts')}>
              关联账号 · {result.accounts.length}
            </button>
          </div>
          {group === 'accounts' ? (
            <>
              <p className="mih-browser-note">按本次命中内容的作者归组，不代表账号全部内容或 Agent 画像。</p>
              {result.accounts.map((a) => (
                <article className="mih-advanced-result" key={`${a.platform}:${a.id}`}>
                  <strong>{a.name || a.id}</strong>
                  <small>
                    {platformName(a.platform)} · {a.id} · 命中 {a.contents.length} 条
                  </small>
                  {a.contents.map((c) => (
                    <button className="qp-button qp-button--ghost" key={c.id} onClick={() => setDetail(c.id)}>
                      {c.title || '查看内容'}
                    </button>
                  ))}
                </article>
              ))}
            </>
          ) : (
            <div className="mih-advanced-results">
              {result.items.map((item, index) => (
                <article className="mih-advanced-result" key={item.id}>
                  <div className="mih-advanced-result-title">
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`选择证据 ${index + 1}`}
                        checked={selected.includes(item.id)}
                        disabled={answerBusy || (!selected.includes(item.id) && selected.length >= 10)}
                        onChange={(e) => {
                          setSelected((v) =>
                            e.target.checked ? [...v, item.id] : v.filter((id) => id !== item.id),
                          )
                          setAnswer(null)
                        }}
                      />{' '}
                      {index + 1}
                    </label>
                    <button onClick={() => setDetail(item.id)}>
                      <SearchHighlight text={item.highlight.title?.[0] || item.title || '无标题内容'} />
                    </button>
                  </div>
                  <small>
                    {platformName(item.platform)} · {item.author.name || item.author.id || '作者未采集'} ·{' '}
                    {formatDate(item.eventTime || item.collectedAt)} · {item.objectType || '未分类'}
                  </small>
                  <p>
                    <SearchHighlight
                      text={item.highlight.body?.join(' … ') || item.snippet || item.bodyPreview}
                    />
                  </p>
                  <div className="mih-advanced-evidence-label">
                    {item.retrievers.includes('lexical') ? '全文命中' : ''}
                    {item.retrievers.length > 1 ? ' + ' : ''}
                    {item.retrievers.includes('vector') ? '语义相关' : ''} · 来源修订 {item.revision}
                  </div>
                </article>
              ))}
            </div>
          )}
          {!result.items.length ? (
            <EmptyState
              title="没有匹配的当前记录"
              description="尝试减少范围限制，或检查数据中心的向量化进度。"
            />
          ) : null}
          {result.items.length ? (
            <div className="mih-advanced-answer">
              <div className="mih-advanced-intro">
                <div>
                  <h3>基于证据回答</h3>
                  <p>已选 {selected.length} / 10 条 · 仅在点击后调用 Chat Sequence</p>
                </div>
                <button
                  className="qp-button qp-button--primary"
                  disabled={!selected.length || answerBusy}
                  onClick={summarize}
                >
                  <Sparkle />
                  {answerBusy ? '正在生成…' : '生成引用回答'}
                </button>
              </div>
              {answerError ? <ErrorState error={answerError} /> : null}
              {answer ? (
                <>
                  <p className="mih-browser-note">{answer.notice}</p>
                  {answer.claims.map((claim, i) => (
                    <div key={i}>
                      <p>{claim.text}</p>
                      {claim.citations.map((id) => (
                        <button className="qp-button qp-button--ghost" key={id} onClick={() => setDetail(id)}>
                          证据 {result.items.findIndex((r) => r.id === id) + 1} ↗
                        </button>
                      ))}
                    </div>
                  ))}
                  <p>{answer.limitations}</p>
                </>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
