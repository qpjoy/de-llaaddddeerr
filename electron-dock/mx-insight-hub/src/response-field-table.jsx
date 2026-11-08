import { useMemo, useState } from 'react'
import { schemaFieldRows, compareResponseFields } from '../shared/response-fields.mjs'

const STATUS = { returned: '已返回', empty: '返回为空', missing: '本次未返回' }
const display = value => value === undefined ? '' : value === null ? 'null' : typeof value === 'string' ? value : JSON.stringify(value)
export const successResponseSchema = endpoint => ['200', '201', '202']
  .map(status => endpoint?.responses?.[status]?.content?.['application/json']?.schema).find(Boolean) || null

// Documented response fields of one endpoint. After a call, each row shows
// whether this response returned it and its value, and fields the response
// returned without documentation are listed separately.
export function ResponseFieldTable({ document, endpoint, payload = null }) {
  const schema = successResponseSchema(endpoint)
  const rows = useMemo(() => schema && document ? schemaFieldRows(document, schema) : [], [document, schema])
  const comparison = useMemo(() => payload && rows.length ? compareResponseFields(rows, payload) : null, [rows, payload])
  const [filter, setFilter] = useState(''), [returnedOnly, setReturnedOnly] = useState(false)
  if (!rows.length) return <details className="mih-response-fields"><summary>返回字段</summary><p>此接口未声明结构化返回字段，请以下方 JSON 响应为准。</p></details>
  const needle = filter.trim().toLowerCase()
  const shown = (comparison?.rows || rows).filter(row => (!needle || row.path.toLowerCase().includes(needle) || row.description?.toLowerCase().includes(needle))
    && (!returnedOnly || row.status && row.status !== 'missing'))
  const returned = comparison?.rows.filter(row => row.status !== 'missing').length
  return <details className="mih-response-fields" open={Boolean(comparison)}>
    <summary>返回字段 · 文档 {rows.length} 项{comparison ? ` · 本次返回 ${returned} 项${comparison.undocumented.length ? ` · 未登记 ${comparison.undocumented.length} 项` : ''}` : ' · 发送后对照实际响应'}</summary>
    <div className="mih-response-fields-tools">
      <label className="qp-field">筛选字段或说明<input className="qp-input" value={filter} onChange={event => setFilter(event.target.value)} placeholder="例如 author、nextCursor、点赞" /></label>
      {comparison ? <label className="mih-response-fields-toggle"><input type="checkbox" checked={returnedOnly} onChange={event => setReturnedOnly(event.target.checked)} />只看本次返回的字段</label> : null}
    </div>
    <p className="qp-muted">路径中 <code>[]</code> 表示数组中的每一项；带 * 的字段总会返回。未提供的指标返回 null，不等于 0。</p>
    <div className="qp-table-wrap"><table className="qp-table mih-response-fields-table"><thead><tr><th>字段 · 类型 · 说明</th>{comparison ? <><th>本次</th><th>本次值（示例）</th></> : null}</tr></thead>
      <tbody>{shown.map(row => <tr key={row.path} data-status={row.status || undefined}>
        <td><code>{row.path}</code>{row.required ? ' *' : ''} <small className="mih-response-field-type">{row.type}{row.enum ? ` · ${row.enum.join(' | ')}` : ''}</small>
          <span className="mih-response-field-description">{row.description || '暂无说明'}</span></td>
        {comparison ? <><td>{STATUS[row.status]}</td><td><code>{display(row.sample)}</code></td></> : null}
      </tr>)}</tbody></table></div>
    {comparison?.undocumented.length ? <div className="mih-response-fields-extra"><h4>响应中有、文档未登记的字段</h4>
      <p>通常是平台特有的附加字段；接入时不要依赖未登记字段，如需使用请反馈补充文档。</p>
      <ul>{comparison.undocumented.map(row => <li key={row.path}><code>{row.path}</code> <span className="qp-muted">{display(row.sample)}</span></li>)}</ul></div> : null}
  </details>
}
