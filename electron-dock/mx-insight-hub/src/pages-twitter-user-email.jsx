// Data product "Twitter 用户邮箱": 接口调试 · 产品展示 · 接入指南 · 管理.
import { useCallback, useEffect, useState } from 'react'
import { Database, LockKey, MagnifyingGlass, Warning } from '@phosphor-icons/react'
import { adminApi, publicDataApi, publicDocsHref } from './api.js'
import { ErrorState, StatusBadge, formatDate, useRemoteData } from './components.jsx'
import { DemoCredentialRecheck, useDemoAccessSnapshot, useDemoApiKey } from './demo-credentials.jsx'
import { ProductApiConsole } from './product-workbench.jsx'
import { ProductIntegrationGuide, ProductManagement, ProductViewTabs } from './product-management.jsx'
import { productForPath } from '../shared/product-workbenches.mjs'
import { TwitterUserEmailPipelineModal, formatBytes, pipelineStatus } from './twitter-user-email-pipeline.jsx'
import './twitter-user-email.css'

const PATH = '/data-products/twitter-user-email'
const exact = value => new Intl.NumberFormat('zh-CN').format(Number(value || 0))
const MODES = [
  ['username', '用户名查邮箱', '输入完整用户名，例如 JohnSmith'],
  ['email', '邮箱查用户名', '输入完整邮箱，例如 name@example.com'],
  ['prefix', '前缀', '至少 3 个字符'],
  ['contains', '片段', '至少 4 个字符'],
  ['fuzzy', '近似拼写', '4–64 个字符，按相似度排序'],
]
const MATCH_LABELS = { exact: '原样相等', case_insensitive: '忽略大小写', prefix: '前缀', contains: '片段', similar: '近似' }

function missingGrant(consumerScopes, scope, label) {
  const caller = consumerScopes?.includes(scope) ? '调用者已开通此权限。'
    : '请平台管理员先在“开放能力 → 调用者配置”中核对该调用者的授权。'
  return `当前 Key 缺少${label}（${scope}）。${caller}请在“API Keys → 调整 Key 权限”中保留原有范围，勾选此项并应用到原 Key。`
}

function friendlyError(error, access) {
  switch (error?.code) {
    case 'query_too_broad': return error.message
    case 'snapshot_key_required': return '当前 Key 使用历史动态范围。请在“API Keys → 调整 Key 权限”中保留原有范围，勾选 Twitter 用户邮箱数据域和查询权限，并应用到原 Key。'
    case 'platform_not_granted': return missingGrant(access?.consumerPlatforms, 'twitter_user_email', 'Twitter 用户邮箱数据域')
    case 'capability_not_granted': return missingGrant(access?.consumerCapabilities, 'twitter.user_email.search', 'Twitter 用户邮箱查询权限')
    case 'twitter_user_email_not_published': return '字典还没有发布版本。请先在“清洗任务计划 → Twitter 用户清洗计划”完成清洗并发布。'
    case 'twitter_user_email_busy': return '片段 / 近似查询正忙，请稍后再试。'
    default: return null
  }
}

function Experience({ apiKey }) {
  const access = useDemoAccessSnapshot()
  const [metadata, setMetadata] = useState(null), [metaError, setMetaError] = useState(null)
  const [mode, setMode] = useState('username'), [query, setQuery] = useState(''), [field, setField] = useState('username')
  const [domain, setDomain] = useState(''), [maskEmail, setMaskEmail] = useState(false)
  const [busy, setBusy] = useState(false), [result, setResult] = useState(null), [error, setError] = useState(null)
  useEffect(() => {
    let active = true
    setMetadata(null); setMetaError(null); setMaskEmail(false)
    if (apiKey) publicDataApi.twitterUserEmailMetadata(apiKey)
      .then(response => { if (active) setMetadata(response.payload?.data) })
      .catch(failure => { if (active) setMetaError(failure) })
    return () => { active = false }
  }, [apiKey])
  const partial = ['prefix', 'contains', 'fuzzy'].includes(mode)
  const submit = async event => {
    event.preventDefault()
    if (!apiKey || !query.trim()) return
    setBusy(true); setError(null)
    try {
      const body = { mode, query: query.trim(), limit: 20, ...(partial ? { field } : {}), ...(domain.trim() && mode !== 'email' ? { domain: domain.trim() } : {}), ...(maskEmail ? { reveal: false } : {}) }
      const response = await publicDataApi.twitterUserEmailSearch(apiKey, body)
      setResult(response.payload?.data)
    } catch (failure) {
      setResult(null); setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const version = metadata?.version
  const failure = error || (!result && metaError)
  const message = friendlyError(failure, access)
  return <div className="mih-tue">
    <section className="qp-panel">
      <div className="mih-tue-row" style={{ justifyContent: 'space-between' }}>
        <div><h2>查找用户名与邮箱</h2>{!metaError ? <p className="mih-tue-muted">{!apiKey ? '请先在页面顶部选择调用 Key。'
          : version ? `数据版本 v${version.id} · ${exact(version.mappings)} 条映射 · 发布于 ${formatDate(version.publishedAt)}`
            : metadata ? '字典尚未发布版本。' : '正在读取数据版本…'}</p> : null}</div>
      </div>
      <form className="mih-tue-composer" onSubmit={submit}>
        <div className="mih-tue-segment" role="group" aria-label="查询方式">
          {MODES.map(([key, label]) => <button key={key} type="button" aria-pressed={mode === key} onClick={() => { setMode(key); setResult(null); setError(null) }}>{label}</button>)}
        </div>
        <div className="mih-tue-row">
          <label className="qp-field mih-tue-query"><span className="qp-field__label">{MODES.find(([key]) => key === mode)[1]}</span>
            <input className="qp-input" value={query} maxLength={320} autoComplete="off" spellCheck={false}
              placeholder={MODES.find(([key]) => key === mode)[2]} onChange={event => setQuery(event.target.value)} /></label>
          {partial ? <label className="qp-field"><span className="qp-field__label">匹配字段</span>
            <select className="qp-input" value={field} onChange={event => setField(event.target.value)}>
              <option value="username">用户名</option><option value="email_local">邮箱 @ 前部分</option>
            </select></label> : null}
          {mode !== 'email' ? <label className="qp-field"><span className="qp-field__label">邮箱域名（可选）</span>
            <input className="qp-input" value={domain} placeholder="gmail.com" onChange={event => setDomain(event.target.value)} /></label> : null}
          <label className="qp-field" style={{ flex: '0 0 auto' }}><span className="qp-field__label">邮箱显示</span>
            <span><input type="checkbox" checked={maskEmail} disabled={!apiKey || busy}
              onChange={event => { setMaskEmail(event.target.checked); setResult(null); setError(null) }} /> 隐藏部分邮箱</span></label>
          <button className="qp-button qp-button--primary" type="submit" disabled={!apiKey || busy || !query.trim()}>
            <MagnifyingGlass size={16} aria-hidden="true" />{busy ? '查询中…' : '查询'}</button>
        </div>
        <p className="mih-tue-muted">精确与前缀查询毫秒级返回；片段与近似查询范围太宽时会直接提示补充条件，不会长时间等待。每次查询按 Key 计量，查询内容不留存明文。</p>
      </form>
    </section>
    {failure ? (message
      ? <div className="mih-tue-notice mih-tue-warning" role="status"><Warning size={16} aria-hidden="true" /><div>{message}
        {failure.status === 403 ? <DemoCredentialRecheck /> : null}</div></div>
      : <ErrorState error={failure} />) : null}
    {result ? <section className="qp-panel">
      <div className="mih-tue-row" style={{ justifyContent: 'space-between' }}>
        <h3>{result.items.length ? `${result.items.length} 条结果${result.meta.truncated ? '（已达上限，可补充条件缩小范围）' : ''}` : '没有找到匹配'}</h3>
        <span className="mih-tue-muted">v{result.meta.datasetVersion} · {result.meta.tookMs} ms{result.meta.revealed ? ' · 已显示完整邮箱' : ' · 邮箱已脱敏'}</span>
      </div>
      {result.items.length ? <div className="mih-tue-scroll"><table className="mih-tue-table"><thead><tr>
        <th>用户名</th><th>邮箱</th><th>匹配</th><th className="num">来源记录</th>
      </tr></thead><tbody>
        {result.items.map((item, index) => <tr key={`${item.username}-${item.email}-${index}`}>
          <td><code>{item.username}</code></td><td><code>{item.email}</code></td>
          <td><span className="mih-tue-match" data-type={item.matchType}>{MATCH_LABELS[item.matchType] || item.matchType}{item.similarity !== undefined ? ` ${item.similarity}` : ''}</span></td>
          <td className="num">{item.sourceRecords}</td>
        </tr>)}
      </tbody></table></div> : null}
      <p className="mih-tue-muted">{result.meta.note}</p>
    </section> : null}
  </div>
}

function Management({ token, session, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.twitterUserEmailPipeline(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  const loadAccess = useCallback(() => adminApi.twitterUserEmailAccess(token), [token])
  const access = useRemoteData(loadAccess, onUnauthorized)
  const [open, setOpen] = useState(false)
  const pipeline = state.data
  const status = pipelineStatus(pipeline)
  return <div className="mih-tue">
    <section className="qp-panel">
      <div className="mih-tue-row" style={{ justifyContent: 'space-between' }}>
        <div><h2>数据版本与清洗</h2><p className="mih-tue-muted">数据只在 PostgreSQL（account_dictionary），不进入数据中心、ES 或向量检索。</p></div>
        <div className="mih-page-actions">
          <StatusBadge status={status.status} label={status.label} />
          <button className="qp-button qp-button--ghost" type="button" disabled={!pipeline} onClick={() => setOpen(true)}><Database size={16} />打开 Twitter 用户清洗计划</button>
        </div>
      </div>
      {state.error && !pipeline ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      {pipeline ? <dl className="mih-tue-metrics">
        <div><dt>当前发布</dt><dd>{pipeline.active ? `v${pipeline.active.id}` : '—'}<small>{pipeline.active ? ` · ${formatDate(pipeline.active.publishedAt)}` : ''}</small></dd></div>
        <div><dt>唯一映射</dt><dd>{pipeline.active ? exact(pipeline.active.uniqueMappings) : '—'}</dd></div>
        <div><dt>表 / 索引</dt><dd>{pipeline.active ? `${formatBytes(pipeline.active.tableBytes)} / ${formatBytes(pipeline.active.indexBytes)}` : '—'}</dd></div>
        <div><dt>可回退版本</dt><dd>{pipeline.previous && !pipeline.previous.dataDroppedAt ? `v${pipeline.previous.id}` : '—'}</dd></div>
        <div><dt>进行中</dt><dd>{pipeline.open ? `v${pipeline.open.id} · ${pipeline.open.stageLabel}` : '—'}</dd></div>
      </dl> : null}
    </section>
    <section className="qp-panel">
      <h3><LockKey size={16} aria-hidden="true" /> 最近访问审计</h3>
      <p className="mih-tue-muted">只记录方式、结果数、明文查看数和耗时；查询内容以不可逆摘要保存。</p>
      {access.error ? <ErrorState error={access.error} onRetry={access.refresh} /> : <div className="mih-tue-scroll"><table className="mih-tue-table"><thead><tr>
        <th>时间</th><th>方式</th><th>结果</th><th className="num">结果数</th><th className="num">明文</th><th className="num">耗时</th><th>调用者 / Key</th>
      </tr></thead><tbody>
        {(access.data || []).map((row, index) => <tr key={`${row.createdAt}-${index}`}>
          <td>{formatDate(row.createdAt)}</td><td>{row.mode}{row.field ? ` · ${row.field}` : ''}</td><td>{row.outcome}</td>
          <td className="num">{row.resultCount}</td><td className="num">{row.revealedCount}</td><td className="num">{row.tookMs ?? '—'} ms</td>
          <td><code>{row.consumerId?.slice(0, 8) || '—'}</code> / <code>{row.apiKeyId?.slice(0, 8) || '—'}</code></td>
        </tr>)}
        {!access.data?.length ? <tr><td colSpan={7} className="mih-tue-muted">{access.loading ? '正在加载…' : '暂无访问记录'}</td></tr> : null}
      </tbody></table></div>}
    </section>
    <ProductManagement {...{ token, session, onUnauthorized, notify }} path={PATH} label="Twitter 用户邮箱" />
    {open && pipeline ? <TwitterUserEmailPipelineModal token={token} pipeline={pipeline} onUnauthorized={onUnauthorized} notify={notify}
      onRefresh={state.refresh} onClose={() => { setOpen(false); state.refresh() }} /> : null}
  </div>
}

export function TwitterUserEmailPage({ token, session, onUnauthorized, notify }) {
  const [key] = useDemoApiKey()
  const [tab, setTab] = useState('product')
  const admin = session?.kind === 'admin-token' && session.platformAdmin
  return <div className="mih-page mih-product-workbench">
    <header className="mih-page-header"><div><h1>Twitter 用户邮箱</h1><p>按用户名查邮箱、按邮箱反查用户名，或用片段与近似拼写找候选。数据来自已发布的字典版本，查询不触发实时采集。</p></div>
      <a className="qp-button qp-button--outline" href={publicDocsHref('/docs/twitter-user-email')}>接口文档 ↗</a></header>
    <ProductViewTabs label="Twitter 用户邮箱" value={tab} onChange={setTab} session={session} />
    <div hidden={tab !== 'debug'}><ProductApiConsole token={token} product={productForPath(PATH)} /></div>
    <div hidden={tab !== 'product'}><Experience key={key ? 'selected' : 'empty'} apiKey={key} /></div>
    <div hidden={tab !== 'guide'}>
      <ProductIntegrationGuide label="Twitter 用户邮箱" docs="twitter-user-email">
        <p>在调用者和 Key 上开通数据域 <code>twitter_user_email</code> 和查询权限 <code>twitter.user_email.search</code> 后即可查询完整邮箱。历史动态范围 Key 需先在 API Keys 中调整权限。</p>
        <p>调用：<code>POST /api/v1/data/twitter-user-email/search</code>，mode 为 username / email / prefix / contains / fuzzy。前缀至少 3 个字符，片段与近似至少 4 个字符；范围太宽返回 <code>422 query_too_broad</code>，忙时返回 <code>503 twitter_user_email_busy</code>。本接口没有分页游标，单次最多 50 条，请用更具体的条件缩小范围。</p>
        <p>省略 <code>reveal</code> 默认返回完整邮箱。传 <code>reveal: false</code> 可获取脱敏结果。完整邮箱查看计入访问审计。</p>
        <p>结果是来源文件记录的关联。近似命中只表示候选关联。</p>
      </ProductIntegrationGuide>
    </div>
    {admin && tab === 'management' ? <Management {...{ token, session, onUnauthorized, notify }} /> : null}
  </div>
}
