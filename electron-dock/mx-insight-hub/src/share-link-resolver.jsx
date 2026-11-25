import { useRef, useState } from 'react'
import { publicDataApi } from './api.js'
import { DropdownField, ErrorState, Field } from './components.jsx'
import { useDemoAccessSnapshot, useDemoApiKey } from './demo-credentials.jsx'
import { copyText } from './open-capabilities.js'
import { shareLinkActions } from './share-link-actions.js'
import { SHARE_LINK_LIMITS, SHARE_LINK_RESOLVER } from '../shared/share-link-resolver.mjs'

const platforms = { douyin: '抖音', xiaohongshu: '小红书' }
const types = { video: '视频', note: '图文', slides: '图集', share_code: '纯口令' }
const methods = { direct: '链接中的 ID', redirect: '短链跳转', 'body-scan': '页面声明的作品链接' }

function linkLabel(row) {
  if (!row.link) return types[row.type] || '—'
  try {
    const link = new URL(row.link)
    return link.host + link.pathname
  } catch { return '分享链接' }
}

function ResultActions({ row, access, notify }) {
  const actions = shareLinkActions(row, access)
  if (!row.ok && !actions.length) return '—'
  return <div className="mih-page-actions">
    {row.ok ? <button type="button" className="qp-button qp-button--outline qp-button--sm" onClick={async () => {
      const copied = await copyText(row.postId)
      notify?.(copied ? '已复制作品 ID' : '复制失败，请选择作品 ID 后手动复制', copied ? 'success' : 'error')
    }}>复制 ID</button> : null}
    {actions.map(action => <span key={action.href}><a href={action.href}>{action.label}</a>{action.hint ? <small>{action.hint}</small> : null}</span>)}
  </div>
}

export function ShareLinkResolverPage({ notify }) {
  const [apiKey] = useDemoApiKey(), access = useDemoAccessSnapshot()
  const [text, setText] = useState(''), [platform, setPlatform] = useState('auto')
  const [data, setData] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const granted = access === null || (access?.platforms?.includes(SHARE_LINK_RESOLVER.platform) && access?.capabilities?.includes(SHARE_LINK_RESOLVER.capability))
  function clearResult() { setData(null); setError(null) }
  async function resolve(event) {
    event.preventDefault()
    if (lock.current || !apiKey || !granted || !text.trim()) return
    lock.current = true
    setBusy(true); clearResult()
    try {
      const { payload } = await publicDataApi.productRequest(apiKey, { method: 'POST', path: SHARE_LINK_RESOLVER.apiPath, body: { text, platform } })
      if (!Array.isArray(payload?.data?.results)) throw new Error('解析服务返回了无法读取的结果')
      setData(payload.data)
    } catch (failure) { setError(failure) }
    finally { lock.current = false; setBusy(false) }
  }
  return <section className="qp-panel mih-panel mih-share-links">
    <h2>从分享文本提取作品 ID</h2>
    <form onSubmit={resolve}>
      <Field label="分享文本或链接" hint={`支持抖音和小红书混合粘贴，每次最多 ${SHARE_LINK_LIMITS.maxTextLength.toLocaleString('zh-CN')} 个字符、${SHARE_LINK_LIMITS.maxLinks} 个不同链接。解析按次占用调用额度。`}>
        <textarea className="qp-input" rows={5} value={text} disabled={busy} required maxLength={SHARE_LINK_LIMITS.maxTextLength}
          placeholder="粘贴从抖音或小红书复制的分享内容" onChange={event => { setText(event.target.value); clearResult() }} />
      </Field>
      <div className="mih-share-links-controls">
        <DropdownField label="解析平台" value={platform} disabled={busy} onChange={value => { setPlatform(value); clearResult() }}
          options={[{ value: 'auto', label: '自动识别' }, ...Object.entries(platforms).map(([value, label]) => ({ value, label }))]} />
        <button className="qp-button qp-button--primary" disabled={busy || !apiKey || !granted || !text.trim()}>{busy ? '正在解析…' : '解析分享链接'}</button>
      </div>
      {access && !granted ? <p role="status">当前 Key 需要社媒数据平台的分享链接解析权限。</p> : null}
    </form>
    {error ? <ErrorState error={error} /> : null}
    {data ? <section aria-label="解析结果">
      <h3>解析结果</h3>
      {data.total ? <>
        <p role="status">共 {data.total} 条，成功 {data.succeeded} 条，失败 {data.failed} 条。打开查询表单后，可确认参数和费用再发送。</p>
        <div className="qp-table-wrap"><table className="qp-table"><thead><tr><th>平台与链接</th><th>作品 ID</th><th>识别结果</th><th>操作</th></tr></thead>
          <tbody>{data.results.map((row, index) => <tr key={index}>
            <td><strong>{platforms[row.platform]}</strong><br /><small>{linkLabel(row)}</small></td>
            <td>{row.ok ? <code>{row.postId}</code> : '—'}</td>
            <td>{row.ok ? <>{row.platform === 'xiaohongshu' ? '笔记' : types[row.type] || '作品'} · {methods[row.how] || row.how}
              {row.uncertain ? <small>建议核对原作品</small> : null}</> : row.error}</td>
            <td><ResultActions row={row} access={access} notify={notify} /></td>
          </tr>)}</tbody></table></div>
      </> : <p role="status">没有找到抖音或小红书链接，请粘贴含完整网址的分享文本。</p>}
    </section> : null}
  </section>
}
