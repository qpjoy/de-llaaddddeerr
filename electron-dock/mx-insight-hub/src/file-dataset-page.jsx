// Shared parts of the file-dataset product pages (文件数据集: Twitter 用户邮箱,
// 邮箱库, 手机号库): page shell with 接口调试 · 产品展示 · 接入指南 · 管理, the
// management tab and grant-aware error messages.
import { useCallback, useState } from 'react'
import { Database, LockKey, Warning } from '@phosphor-icons/react'
import { adminApi, publicDocsHref } from './api.js'
import { ErrorState, StatusBadge, formatDate, useRemoteData } from './components.jsx'
import { DemoCredentialRecheck, useDemoApiKey } from './demo-credentials.jsx'
import { ProductApiConsole } from './product-workbench.jsx'
import { ProductIntegrationGuide, ProductManagement, ProductViewTabs } from './product-management.jsx'
import { productForPath } from '../shared/product-workbenches.mjs'
import { fileDataset } from '../shared/file-datasets.mjs'
import { FileDatasetPipelineModal, formatBytes, pipelineStatus } from './file-dataset-pipeline.jsx'
import './file-datasets.css'

export const exact = value => new Intl.NumberFormat('zh-CN').format(Number(value || 0))

function missingGrant(consumerScopes, scope, label) {
  const caller = consumerScopes?.includes(scope) ? '调用者已开通此权限。'
    : '请平台管理员先在“开放能力 → 调用者配置”中核对该调用者的授权。'
  return `当前 Key 缺少${label}（${scope}）。${caller}请在“API Keys → 调整 Key 权限”中保留原有范围，勾选此项并应用到原 Key。`
}

/** A sentence the operator can act on, or null for the generic error view. */
export function fileDatasetErrorMessage(error, access, datasetKey) {
  const product = fileDataset(datasetKey)
  switch (error?.code) {
    case 'query_too_broad': return error.message
    case 'snapshot_key_required': return `当前 Key 使用历史动态范围。请在“API Keys → 调整 Key 权限”中保留原有范围，勾选${product.label}数据域和查询权限，并应用到原 Key。`
    case 'platform_not_granted': return missingGrant(access?.consumerPlatforms, product.platform, `${product.label}数据域`)
    case 'capability_not_granted': return missingGrant(access?.consumerCapabilities, product.searchCapability, `${product.label}查询权限`)
    case `${product.platform}_not_published`: return `${product.label}还没有发布版本。请先在“清洗任务计划 → ${product.pipelineLabel}”完成清洗并发布。`
    case `${product.platform}_busy`: return '片段 / 近似查询正忙，请稍后再试。'
    default: return null
  }
}

export function FileDatasetFailure({ failure, message }) {
  if (!failure) return null
  return message
    ? <div className="mih-tue-notice mih-tue-warning" role="status"><Warning size={16} aria-hidden="true" /><div>{message}
      {failure.status === 403 ? <DemoCredentialRecheck /> : null}</div></div>
    : <ErrorState error={failure} />
}

export function FileDatasetManagement({ datasetKey, token, session, onUnauthorized, notify }) {
  const product = fileDataset(datasetKey)
  const load = useCallback(() => adminApi.fileDatasetPipeline(token, datasetKey), [token, datasetKey])
  const state = useRemoteData(load, onUnauthorized)
  const loadAccess = useCallback(() => adminApi.fileDatasetAccess(token, datasetKey), [token, datasetKey])
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
          <button className="qp-button qp-button--ghost" type="button" disabled={!pipeline} onClick={() => setOpen(true)}><Database size={16} />打开{product.pipelineLabel}</button>
        </div>
      </div>
      {state.error && !pipeline ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      {pipeline ? <dl className="mih-tue-metrics">
        <div><dt>当前发布</dt><dd>{pipeline.active ? `v${pipeline.active.id}` : '—'}<small>{pipeline.active ? ` · ${formatDate(pipeline.active.publishedAt)}` : ''}</small></dd></div>
        <div><dt>{product.uniqueLabel}</dt><dd>{pipeline.active ? exact(pipeline.active.uniqueMappings) : '—'}</dd></div>
        <div><dt>表 / 索引</dt><dd>{pipeline.active ? `${formatBytes(pipeline.active.tableBytes)} / ${formatBytes(pipeline.active.indexBytes)}` : '—'}</dd></div>
        <div><dt>可回退版本</dt><dd>{pipeline.previous && !pipeline.previous.dataDroppedAt ? `v${pipeline.previous.id}` : '—'}</dd></div>
        <div><dt>进行中</dt><dd>{pipeline.open ? `v${pipeline.open.id} · ${pipeline.open.stageLabel}` : '—'}</dd></div>
      </dl> : null}
    </section>
    <section className="qp-panel">
      <h3><LockKey size={16} aria-hidden="true" /> 最近访问审计</h3>
      <p className="mih-tue-muted">只记录方式、结果数、明文返回数和耗时；查询内容以不可逆摘要保存。</p>
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
    <ProductManagement {...{ token, session, onUnauthorized, notify }} path={product.productPath} label={product.label} />
    {open && pipeline ? <FileDatasetPipelineModal datasetKey={datasetKey} token={token} pipeline={pipeline} onUnauthorized={onUnauthorized} notify={notify}
      onRefresh={state.refresh} onClose={() => { setOpen(false); state.refresh() }} /> : null}
  </div>
}

/**
 * Page shell: `Experience` renders 产品展示 for the selected demo Key; `guide`
 * is the dataset-specific part of 接入指南.
 */
export function FileDatasetPage({ datasetKey, intro, Experience, guide, token, session, onUnauthorized, notify }) {
  const product = fileDataset(datasetKey)
  const [key] = useDemoApiKey()
  const [tab, setTab] = useState('product')
  const admin = session?.kind === 'admin-token' && session.platformAdmin
  return <div className="mih-page mih-product-workbench">
    <header className="mih-page-header"><div><h1>{product.label}</h1><p>{intro}</p></div>
      <a className="qp-button qp-button--outline" href={publicDocsHref(`/docs/${product.docsKey}`)}>接口文档 ↗</a></header>
    <ProductViewTabs label={product.label} value={tab} onChange={setTab} session={session} />
    <div hidden={tab !== 'debug'}><ProductApiConsole token={token} product={productForPath(product.productPath)} /></div>
    <div hidden={tab !== 'product'}><Experience key={key ? 'selected' : 'empty'} apiKey={key} /></div>
    <div hidden={tab !== 'guide'}>
      <ProductIntegrationGuide label={product.label} docs={product.docsKey}>{guide}</ProductIntegrationGuide>
    </div>
    {admin && tab === 'management' ? <FileDatasetManagement datasetKey={datasetKey} {...{ token, session, onUnauthorized, notify }} /> : null}
  </div>
}
