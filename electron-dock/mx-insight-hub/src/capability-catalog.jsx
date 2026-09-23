import { useCallback } from 'react'
import { adminApi } from './api.js'
import { ErrorState, LoadingState, useRemoteData } from './components.jsx'
import { PagedItems } from './paged-items.jsx'

export function CapabilityCatalog({ token, onUnauthorized }) {
  const load = useCallback(() => adminApi.capabilityCatalog(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  return <section className="qp-panel mih-panel mih-commercial-panel" aria-label="能力统一登记">
    <h2>能力统一登记</h2><p>从已实现合同自动登记平台、接口、产品和计费关联。分类与人工覆盖结论独立维护。</p>
    {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
    {!state.data && state.loading ? <LoadingState /> : null}
    {state.data ? <><p>{state.data.summary.routes} 条接口/清洗路径 · {state.data.summary.connectors} 个供应商操作 · {state.data.summary.products} 个可复用定价产品</p>
      <p role="status">{state.data.differences.length ? `${state.data.differences.length} 项登记差异待迁移同步` : '登记与当前实现一致'}。此处读取不改变账户、Key、价格或权限。</p>
      <details><summary>能力、接口与计费关联</summary><PagedItems items={state.data.entries} text={row => `${row.id} ${JSON.stringify(row.definition)}`} label="能力登记">{visible => <div className="qp-table-wrap mih-table-wrap"><table className="qp-table mih-table"><thead><tr><th>类型</th><th>能力 / 接口</th><th>关联</th></tr></thead><tbody>{visible.map(({entry: row}) => <tr key={row.id}>
        <td>{({ route: '业务路径', connector: '供应商操作', product: '产品模板' })[row.kind]}</td><td>{row.definition.label || row.definition.name || row.definition.product}<small>{row.definition.operation || row.id}</small></td>
        <td>{row.definition.path || row.definition.contractVersion || `${row.definition.pricing?.entries.length || 0} 项基础费率`}<small>{row.definition.platform || row.definition.platforms?.join(' / ') || row.definition.provider}</small></td>
      </tr>)}</tbody></table></div>}</PagedItems></details>
      {state.data.differences.length ? <details><summary>查看迁移差异（仅元数据）</summary><PagedItems items={state.data.differences} text={row => `${row.action} ${row.id}`} label="迁移差异">{visible => <ul>{visible.map(({entry: row}) => <li key={row.id}>{row.action} · {row.id}</li>)}</ul>}</PagedItems></details> : null}
    </> : null}
  </section>
}
