import { useCallback, useEffect, useRef, useState } from 'react'
import { Package } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { DropdownField, Field } from './components.jsx'
import { productMediaLoader } from './product-media-loader.js'

const platforms = [{ value: 'all', label: '全部平台' }, { value: 'taobao', label: '淘宝' }, { value: 'tmall', label: '天猫' }, { value: 'jd', label: '京东' }, { value: 'xianyu', label: '闲鱼' }, { value: 'xiaohongshu_ec', label: '小红书店铺' }]
function StoredImage({ token, row }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    setUrl(null)
    if (!row.product.images?.length) return
    const controller = new AbortController()
    let objectUrl
    productMediaLoader.load(() => adminApi.ecommerceImage(token, { requestId: row.requestId, ordinal: row.ordinal }, controller.signal), { signal: controller.signal })
      .then(blob => { if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) } }).catch(() => {})
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [token, row.requestId, row.ordinal, row.revision])
  return url ? <img src={url} alt="" loading="lazy" /> : <Package size={32} aria-label="暂无预览" />
}

export function EcommerceDataList({ token, notify, AcquisitionPanel }) {
  const [marketplace, setMarketplace] = useState('all')
  const [query, setQuery] = useState('')
  const [pageSize, setPageSize] = useState('100')
  const [rows, setRows] = useState([])
  const [pageInfo, setPageInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const [editor, setEditor] = useState(null)
  const [saving, setSaving] = useState(false)
  const [pull, setPull] = useState(0)
  const controller = useRef(null)
  const viewport = useRef(null)
  const epoch = useRef(0)
  const inFlight = useRef(false)
  const gesture = useRef(null)
  const lastPull = useRef(0)
  const wheelPull = useRef(0)
  const settings = useRef(null)
  const reload = useCallback(() => setRefresh(value => value + 1), [])
  const scope = `${token}|${marketplace}|${query}|${pageSize}`
  const activeScope = useRef(scope)
  activeScope.current = scope

  const load = useCallback(async (cursor = null) => {
    if (inFlight.current) return
    const ownEpoch = epoch.current
    const ownScope = activeScope.current
    inFlight.current = true
    setLoading(true)
    setError(null)
    try {
      const result = await adminApi.ecommerceItems(token, { marketplace, query: query.trim(), pageSize, ...(cursor ? { cursor } : {}) })
      if (ownEpoch !== epoch.current || ownScope !== activeScope.current) return
      if (!Array.isArray(result?.items) || !result?.pageInfo) throw new Error('列表响应格式不正确，请确认前后端部署版本一致。')
      setRows(previous => cursor ? [...previous, ...result.items] : result.items)
      setPageInfo(result.pageInfo)
    } catch (failure) {
      if (ownEpoch === epoch.current && ownScope === activeScope.current) setError(failure)
    } finally {
      if (ownEpoch === epoch.current) { inFlight.current = false; setLoading(false) }
    }
  }, [token, marketplace, query, pageSize])

  useEffect(() => {
    epoch.current += 1
    inFlight.current = false
    setRows([])
    setPageInfo(null)
    const timer = setTimeout(() => void load(), query ? 250 : 0)
    return () => { clearTimeout(timer); epoch.current += 1; inFlight.current = false }
  }, [load, refresh])

  const more = () => { if (pageInfo?.nextCursor && !loading && !error) void load(pageInfo.nextCursor) }
  const acquireNext = () => {
    if (marketplace === 'all') { notify?.('请选择一个平台后下拉采集；全部平台只浏览 Hub 历史记录。', 'error'); return }
    if (!controller.current?.hasKey) { if (settings.current) settings.current.open = true; notify?.('请在采集设置中填入 Public API Key；浏览历史无需此 Key。', 'error'); return }
    if (Date.now() - lastPull.current < 1200 || controller.current?.busy) return
    lastPull.current = Date.now()
    controller.current?.pullNext()
  }
  const save = async event => {
    event.preventDefault()
    setSaving(true)
    try {
      await adminApi.saveEcommerceItem(token, { ...(editor.row ? { requestId: editor.row.requestId, ordinal: editor.row.ordinal, revision: editor.row.revision } : { marketplace: editor.marketplace }), title: editor.title, price: editor.price })
      setEditor(null); reload(); notify?.('商品已保存，原始采集证据保持不变。', 'success')
    } catch (failure) { setEditor(current => ({ ...current, error: failure.message })) }
    finally { setSaving(false) }
  }
  const remove = async row => {
    setSaving(true)
    try {
      await adminApi.deleteEcommerceItem(token, { requestId: row.requestId, ordinal: row.ordinal, revision: row.revision })
      setEditor(null); reload(); notify?.('已从管理列表移除；原始响应和审计记录保留。', 'success')
    } catch (failure) { setEditor(current => ({ ...current, error: failure.message })) }
    finally { setSaving(false) }
  }

  return <section className="mih-commerce-manager">
    <aside className="qp-panel mih-commerce-filters">
      <h2>已存商品</h2><p>使用当前管理会话，自动读取 Hub 中各调用身份已提交的商品数据。</p>
      <DropdownField label="平台" value={marketplace} options={platforms} onChange={value => { if (!controller.current?.busy) setMarketplace(value) }} />
      <Field label="查找已存商品"><input className="qp-input" value={query} onChange={event => setQuery(event.target.value)} maxLength={200} placeholder="全部商品；输入标题筛选" /></Field>
      <Field label="每页记录数（1–100）"><input className="qp-input" type="number" min={1} max={100} defaultValue={100} key={pageSize} onBlur={event => { const size = Number(event.target.value); if (Number.isInteger(size) && size >= 1 && size <= 100) setPageSize(String(size)); else event.target.value = pageSize }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></Field>
      <button className="qp-button qp-button--primary" onClick={() => setEditor({ title: '', price: '', marketplace: marketplace === 'all' ? 'taobao' : marketplace })}>新增商品</button>
      <button className="qp-button qp-button--outline" onClick={reload} disabled={loading}>刷新已存列表</button>
      <details ref={settings} className="mih-commerce-settings"><summary>单平台采集设置</summary>
        <p>选择平台并填入采集 Key 后，可在手机面板下拉获取下一数据页。这里的搜索词不影响历史列表筛选。</p>
        <AcquisitionPanel compact forcedMarketplace={marketplace} controllerRef={controller} onDelivered={reload} notify={notify} />
      </details>
    </aside>
    <div className="mih-commerce-phone-wrap">
      <div className="mih-commerce-phone">
        <header><span>MX · 电商数据</span><strong>{platforms.find(item => item.value === marketplace)?.label}</strong><small>{rows.length} 条已加载</small></header>
        <div className="mih-commerce-phone-actions"><button className="qp-button qp-button--ghost qp-button--sm" disabled={marketplace === 'all'} onClick={acquireNext}>下拉采集下一页</button><span>上划浏览历史</span></div>
        <div ref={viewport} className="mih-commerce-phone-feed" tabIndex={0} aria-label="手机商品瀑布流"
          onScroll={() => { const node = viewport.current; if (node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight < 180) more() }}
          onWheel={event => { if (event.deltaY < 0 && viewport.current.scrollTop <= 0) { wheelPull.current += -event.deltaY; if (wheelPull.current >= 120) { wheelPull.current = 0; acquireNext() } } else wheelPull.current = 0 }}
          onTouchStart={event => { gesture.current = viewport.current.scrollTop <= 0 ? event.touches[0].clientY : null }}
          onTouchMove={event => { if (gesture.current != null) setPull(Math.max(0, Math.min(100, event.touches[0].clientY - gesture.current))) }}
          onTouchEnd={() => { if (pull >= 70) acquireNext(); setPull(0); gesture.current = null }}
          onTouchCancel={() => { setPull(0); gesture.current = null }}>
          {pull > 0 ? <p role="status">{pull >= 70 ? '松开后采集下一页' : '继续下拉采集'}</p> : null}
          {error ? <div className="mih-commerce-message" role="alert"><strong>读取失败，未显示为空结果</strong><p>{error.status ? `HTTP ${error.status} · ` : ''}{error.message}</p><button className="qp-button" onClick={reload}>重试读取</button></div> : null}
          <div className="mih-commerce-grid">{rows.map(row => <article className="mih-commerce-card" key={`${row.requestId}:${row.ordinal}`}>
            <button className="mih-commerce-card-open" onClick={() => setEditor({ row, title: row.product.title, price: row.product.pricing?.current || '', marketplace: row.product.marketplace })}>
              <div className="mih-commerce-card-image"><StoredImage row={row} token={token} /></div>
              <small>{platforms.find(item => item.value === row.product.marketplace)?.label}{row.manual ? ' · 手动录入' : ''}</small>
              <strong>{row.product.title}</strong><b>¥ {row.product.pricing?.current ?? '—'}</b>
              <time>{new Date(row.capturedAt || row.recordedAt).toLocaleString()}</time>
            </button>
            <button className="qp-button qp-button--ghost qp-button--sm" onClick={() => setEditor({ row, title: row.product.title, price: row.product.pricing?.current || '', marketplace: row.product.marketplace })}>查看 / 编辑</button>
          </article>)}</div>
          {loading ? <p role="status">正在读取 Hub 数据…</p> : null}
          {!loading && !error && !rows.length ? <p className="mih-commerce-message">{query ? '没有匹配此标题的已存商品。' : '该范围暂无已存商品；可选择平台后采集。'}</p> : null}
          {pageInfo?.nextCursor ? <button className="qp-button qp-button--outline" disabled={loading} onClick={more}>加载更多历史记录</button> : rows.length ? <p>已到本次历史记录末尾</p> : null}
        </div>
      </div>
      <p>下拉只采集所选平台；上划只读取 Hub 历史。全部平台不会批量采集。</p>
    </div>
    {editor ? <div className="mih-commerce-modal" role="dialog" aria-modal="true" aria-label={editor.row ? '编辑商品' : '新增商品'}><form className="qp-panel" onSubmit={save}>
      <h2>{editor.row ? '商品详情与编辑' : '新增商品'}</h2>
      <DropdownField label="商品平台" value={editor.marketplace} options={platforms.slice(1)} disabled={Boolean(editor.row) || saving} onChange={value => setEditor({ ...editor, marketplace: value })} />
      <Field label="商品标题"><input autoFocus className="qp-input" required maxLength={1000} value={editor.title} disabled={saving} onChange={event => setEditor({ ...editor, title: event.target.value })} /></Field>
      <Field label="价格（元）"><input className="qp-input" required type="number" min="0" step="0.01" value={editor.price} disabled={saving} onChange={event => setEditor({ ...editor, price: event.target.value })} /></Field>
      {editor.row ? <small>原请求：{editor.row.requestId}<br />商品序号：{editor.row.ordinal} · 修订：{editor.row.revision}<br />调用身份：{editor.row.consumerId || '手动录入'}<br />修改仅作用于管理视图，保留原始采集响应。</small> : null}
      {editor.error ? <p role="alert">{editor.error}</p> : null}
      <div className="mih-commerce-toolbar"><button className="qp-button qp-button--primary" disabled={saving}>保存</button><button type="button" className="qp-button" disabled={saving} onClick={() => setEditor(null)}>关闭</button>
      {editor.row ? <button type="button" className="qp-button qp-button--outline" disabled={saving} onClick={() => { if (editor.confirmDelete) void remove(editor.row); else setEditor({ ...editor, confirmDelete: true }) }}>{editor.confirmDelete ? '确认移除（保留原始记录）' : '删除'}</button> : null}</div>
    </form></div> : null}
  </section>
}
