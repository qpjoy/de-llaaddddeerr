import { useCallback, useMemo, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, LoadingState, PageHeading, useRemoteData } from './components.jsx'
import './night-all-a-panel.css'

const EXAMPLE = JSON.stringify({ connector_id: 'china-news', capability: 'news.collect', parameters: { platforms: ['thepaper'], limit_per_platform: 20, max_pages: 2 }, persist_results: true, max_attempts: 1 }, null, 2)
const codeStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 480, overflow: 'auto' }
const KEY_STORAGE = 'mx-insight-hub.night-all-a-request-key'
function requestKey() {
  try { const stored = sessionStorage.getItem(KEY_STORAGE); if (stored) return stored } catch { /* memory-only fallback */ }
  return crypto.randomUUID()
}

function Schema({ value, schemas, depth = 0 }) {
  if (!value) return <p>上游未声明响应模型；参见业务指南及运行状态字段。</p>
  if (depth > 5) return <code>{value.$ref || '嵌套结构'}</code>
  if (value.$ref) {
    const name = value.$ref.split('/').at(-1)
    return <details><summary>{name}</summary><Schema value={schemas[name]} schemas={schemas} depth={depth + 1} /></details>
  }
  if (value.properties) return <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>字段</th><th>必填</th><th>类型、默认值与约束</th></tr></thead><tbody>
    {Object.entries(value.properties).map(([name, schema]) => <tr key={name}><td><code>{name}</code></td><td>{value.required?.includes(name) ? '是' : '否'}</td><td><Schema value={schema} schemas={schemas} depth={depth + 1} /></td></tr>)}
  </tbody></table></div>
  if (value.anyOf) return <>{value.anyOf.map((item, index) => <Schema key={index} value={item} schemas={schemas} depth={depth + 1} />)}</>
  return <><code style={codeStyle}>{JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'items')))}</code>{value.items ? <Schema value={value.items} schemas={schemas} depth={depth + 1} /> : null}</>
}

export function NightAllAPanel({ token, onUnauthorized }) {
  const load = useCallback(() => adminApi.externalPlatform(token, 'night-all-a'), [token])
  const remote = useRemoteData(load, onUnauthorized)
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState('all')
  const [operation, setOperation] = useState('health')
  const [id, setId] = useState('')
  const [query, setQuery] = useState('{}')
  const [body, setBody] = useState(EXAMPLE)
  const [reason, setReason] = useState('')
  const [key, updateKey] = useState(requestKey)
  const [dispatchId, setDispatchId] = useState('')
  function setKey(value) {
    updateKey(value)
    try { sessionStorage.setItem(KEY_STORAGE, value) } catch { /* memory-only fallback */ }
  }
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const data = remote.data
  const endpoints = useMemo(() => Object.entries(data?.catalog.openapi.paths || {}).flatMap(([path, methods]) => Object.entries(methods).map(([method, spec]) => ({ path, method: method.toUpperCase(), spec }))), [data])
  const selected = data?.operations.find(item => item.key === operation)
  const write = selected?.method === 'POST'
  const filtered = endpoints.filter(item => (group === 'all' || item.spec.tags?.includes(group)) && `${item.path} ${item.spec.summary} ${item.method}`.toLowerCase().includes(search.toLowerCase()))
  async function execute() {
    setBusy(true); setError(null); setResult(null)
    try {
      if (write) setKey(key)
      const input = { query: JSON.parse(query) }
      if (selected.path.includes('{id}')) input.id = id
      if (write) input.reason = reason
      if (operation === 'createTask') input.body = JSON.parse(body)
      const response = await adminApi.nightAllADispatch(token, operation, input, key)
      setResult(response)
      if (response.dispatchId) setDispatchId(response.dispatchId)
    } catch (failure) { setError(failure); if (failure.details?.dispatchId) setDispatchId(failure.details.dispatchId) } finally { setBusy(false) }
  }
  async function inspectDispatch() {
    setBusy(true); setError(null)
    try { setResult(await adminApi.nightAllADispatchStatus(token, dispatchId)) }
    catch (failure) { setError(failure) } finally { setBusy(false) }
  }
  return <>
    <PageHeading title="Night-All-A · 采集与数据接入" description="海外采集控制平台 / OpenVPN 私网接入 / Hub 异步触发与数据清洗" loading={remote.loading} onRefresh={remote.refresh}>
      <a className="qp-button qp-button--ghost" href="#/external-platforms">返回平台总览</a>
    </PageHeading>
    {remote.error ? <ErrorState error={remote.error} onRetry={remote.refresh} /> : null}
    {!data && remote.loading ? <LoadingState label="读取 Night-All-A 接口目录" /> : null}
    {data ? <div className="mih-night-all-a">
      <section className="qp-panel mih-panel"><h2>集成方案</h2>
        <p>Hub（100.127.0.6）→ OpenVPN → Night-All-A（100.127.0.1:8100）。现有 VPN 直连可用时无需增加 Nginx；若需要独立访问日志、来源 IP 限制与统一入口，可使用可选的 8101 代理。</p>
        <p>Night-All-A 负责发现连接器、异步采集、采集计划及写入内网数据库；Hub 负责受控触发、清洗映射、Canonical 入库、检索与对外数据合同。现有 Night-All 是另一条历史服务链路。</p>
        <p><a href="http://100.127.0.1:8100/collect" target="_blank" rel="noreferrer">打开采集平台</a> · <a href="http://100.127.0.1:8100/docs" target="_blank" rel="noreferrer">上游接口文档</a></p>
        <p>当前连接：<code>{data.connection.baseUrl || '配置无效'}</code> · 读取转发：{data.connection.enabled ? '已启用' : '未启用'} · 采集触发：{data.connection.writesEnabled ? '已启用' : '未启用'} · 实时健康：未知</p>
        <p>{data.connection.authentication}</p>{data.connection.configurationError ? <p>{data.connection.configurationError}</p> : null}
        <p>当前目录：{endpoints.length} 个接口，{data.catalog.reviewedAt} 从本地源码生成；未核对线上部署。调用量、费用与成功率没有统计证据时保持未知。</p>
      </section>
      <section className="qp-panel mih-panel"><h2>两条接入链路</h2>
        <h3>实时触发 → 异步结果</h3><p>查询 connectors 的能力与 inputSchema → createTask（默认 max_attempts=1、persist_results=true），或 runPlan → 保存 task.id / run.id → task / run 查询 → 检查 status、error_code、metrics.collection.complete 和 metrics.records → 清洗已入库数据。</p>
        <p>HTTP 202 仅表示接受任务；HTTP 200 仅表示查询成功。succeeded 仍可能部分完成。触发前先记录幂等键，超时、5xx 或连接中断标为结果未知；同一键不会再次派发，新的键代表另一次实际采集。</p>
        <h3>内网数据库 → Hub 清洗计划</h3><p>复用已有 saved_records 按 source_type 分区的只读接入。先核对数据库配置、表结构、Writer 契约和 (last_seen_at, id) 检查点，再启用清洗计划；不能仅因平台登记就自动连接、创建计划或重置游标。</p>
        <p>records API 使用 offset 分页，不是 CDC。news 重复条目可能直接跳过且不推进 last_seen_at；其他记录可能覆盖 run_id。运行记录、永久业务记录和历史指标分别核验，避免把采集成功等同于 Hub 已完成索引。</p>
        <a className="qp-button qp-button--outline" href="#/database-connections">数据库配置</a>{' '}
        <a className="qp-button qp-button--outline" href="#/sources">清洗任务计划</a>
      </section>
      <section className="qp-panel mih-panel"><h2>受控调用工作台</h2><p>仅 Hub Admin Token 管理会话可用。所有请求先到 Hub；不会将浏览器的 Hub Token 转交上游。此处不会自动请求上游，也不会开放租户/Public 转发。</p>
        <DropdownField label="对接操作" value={operation} options={data.operations.map(item => ({ value: item.key, label: `${item.key} · ${item.method} ${item.path}` }))} onChange={setOperation} />
        {selected?.path.includes('{id}') ? <label className="qp-field">对象 ID<input className="qp-input" value={id} onChange={event => setId(event.target.value)} /></label> : null}
        <label className="qp-field">query（JSON；仅上游声明的查询字段）<textarea className="qp-input" rows={3} value={query} onChange={event => setQuery(event.target.value)} /></label>
        {operation === 'createTask' ? <label className="qp-field">任务 body（参数按连接器 inputSchema 填写）<textarea className="qp-input" rows={12} value={body} onChange={event => setBody(event.target.value)} /></label> : null}
        {write ? <><label className="qp-field">操作原因<input className="qp-input" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} /></label><label className="qp-field">Idempotency-Key<input className="qp-input" value={key} onChange={event => setKey(event.target.value)} /></label><p>此键保留在当前浏览器会话。确认需要另一笔采集时才手动换键；结果不明确时先查询 dispatchId，不要换键重复触发。</p></> : null}
        <button className="qp-button qp-button--primary" disabled={busy || !data.connection.enabled || (write && (!data.connection.writesEnabled || !reason.trim()))} onClick={execute}>{busy ? '请求中…' : write ? '提交一次采集触发' : '查询上游'}</button>
        <p><code>POST /internal/v1/admin/external-platforms/night-all-a/dispatch/{operation}</code></p>
        <p>持久记录查询：<code>GET /internal/v1/admin/external-platforms/night-all-a/dispatches/&#123;dispatchId&#125;</code>。completed 表示 HTTP 结果已记录，不代表采集已完成。</p>
        <label className="qp-field">dispatchId<input className="qp-input" value={dispatchId} onChange={event => setDispatchId(event.target.value)} /></label>
        <button className="qp-button qp-button--outline" disabled={busy || !dispatchId.trim()} onClick={inspectDispatch}>查询持久记录（不触发采集）</button>
        {error ? <><ErrorState error={error} /><pre style={codeStyle}>{JSON.stringify(error.details || {}, null, 2)}</pre></> : null}
        {result ? <pre style={codeStyle}>{JSON.stringify(result, null, 2)}</pre> : null}
      </section>
      <section className="qp-panel mih-panel"><h2>完整接口目录与字段</h2><p>目录涵盖业务、管理和内部接口。标记“仅登记”的接口需在 Night-All-A 管理，不可通过工作台转发。上游未定义响应模型的接口不虚构字段保证。</p>
        <label className="qp-field">搜索接口<input className="qp-input" placeholder="路径、方法或接口名称" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <DropdownField label="接口分组" value={group} onChange={setGroup} options={[{ value: 'all', label: '全部接口' }, ...(data.catalog.openapi.tags || []).map(tag => ({ value: tag.name, label: `${tag.name} · ${tag.description}` }))]} />
        <p>显示 {filtered.length} / {endpoints.length} 个接口</p>
        {filtered.map(({ path, method, spec }) => {
          const mapped = data.operations.find(op => op.method === method && op.path.replace('{id}', '{}') === path.replace(/\{[^}]+\}/g, '{}'))
          return <details key={`${method} ${path}`} style={{ padding: '12px 0', borderBottom: '1px solid var(--qp-border, #64748b44)' }}><summary style={{ overflowWrap: 'anywhere' }}><code>{method} {path}</code> · {spec.summary} · {mapped ? `Hub：${mapped.key}` : '仅登记'}</summary>
            {spec.description ? <p>{spec.description}</p> : null}
            <h3>路径与查询字段</h3>{spec.parameters?.length ? <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>字段</th><th>位置 / 必填</th><th>类型与约束</th></tr></thead><tbody>{spec.parameters.map(p => <tr key={p.name}><td>{p.name}</td><td>{p.in} / {p.required ? '是' : '否'}</td><td><Schema value={p.schema} schemas={data.catalog.openapi.components.schemas} /></td></tr>)}</tbody></table></div> : <p>无声明字段</p>}
            {spec.requestBody ? <><h3>请求体</h3><Schema value={spec.requestBody.content?.['application/json']?.schema} schemas={data.catalog.openapi.components.schemas} /></> : null}
            <h3>响应</h3>{Object.entries(spec.responses || {}).map(([status, response]) => <div key={status}><strong>{status} · {response.description}</strong><Schema value={Object.keys(response.content?.['application/json']?.schema || {}).length ? response.content['application/json'].schema : null} schemas={data.catalog.openapi.components.schemas} /></div>)}
          </details>
        })}
      </section>
      <section className="qp-panel mih-panel"><h2>业务字段与接入指南</h2>{data.catalog.guides.map(guide => <details key={guide.key}><summary>{guide.text.split('\n')[0].replace(/^# /, '')}</summary><pre style={codeStyle}>{guide.text}</pre></details>)}</section>
    </div> : null}
  </>
}
