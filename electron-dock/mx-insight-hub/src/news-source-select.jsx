import { useEffect, useId, useRef, useState } from 'react'
import { CaretDown, MagnifyingGlass, X } from '@phosphor-icons/react'

export function NewsSourceSelect({ items, values, names, onChange, onLoad, loading, error, disabled }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('')
  const root = useRef(null), trigger = useRef(null), input = useRef(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const title = !values.length ? '全部新闻来源' : values.length === 1 ? names[values[0]] || '已选 1 个来源' : `已选 ${values.length} 个来源`
  const visible = items.filter(item => `${item.value} ${item.key}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  function toggle(key) { onChange(values.includes(key) ? values.filter(value => value !== key) : [...values, key].sort()) }
  return <div className="qp-field mih-news-source-field">
    <span id={`${id}-label`} className="qp-field__label">数据源目录（多选）</span>
    <div ref={root} className={`qp-dropdown mih-news-source-select${open ? ' is-open' : ''}`} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() }
    }}>
      <button ref={trigger} type="button" className="qp-dropdown__trigger" disabled={disabled} aria-expanded={open}
        aria-controls={id} aria-label={`数据源目录：${title}`} onClick={() => {
          setQuery(''); setOpen(!open); if (!open) onLoad()
        }}><span className="qp-dropdown__value">{title}</span><CaretDown className="qp-dropdown__chevron" /></button>
      {open ? <div id={id} className="qp-dropdown__menu mih-news-source-menu" role="group" aria-labelledby={`${id}-label`} aria-busy={loading}>
        <label className="qp-dropdown__search"><MagnifyingGlass /><input ref={input} aria-label="查找新闻来源" placeholder="搜索来源名称或 ID" value={query}
          onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} /></label>
        <button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => onChange([])}>清空选择 · 不限目录</button>
        {loading ? <p role="status">正在获取新闻来源…</p> : null}
        {error ? <p role="alert">{error.message || '新闻来源读取失败，请重试。'}</p> : null}
        <div className="mih-news-source-options qp-scrollbar">{visible.map(item => <label key={item.key} className={`qp-dropdown__option${values.includes(item.key) ? ' is-selected' : ''}`}>
          <input type="checkbox" checked={values.includes(item.key)} disabled={loading || (!values.includes(item.key) && values.length >= 50)} onChange={() => toggle(item.key)} /><span>{item.value}</span>
        </label>)}</div>
        {!loading && !error && !visible.length ? <p>{items.length ? '没有匹配的来源名称。' : '当前授权范围没有已绑定的新闻来源。仍可不限目录查询新闻。'}</p> : null}
        <footer><small>已选 {values.length} / 最多 50 个</small><button type="button" className="qp-button qp-button--ghost qp-button--sm" disabled={loading} onClick={() => onLoad(true)}>刷新来源</button>
          <button type="button" className="qp-button qp-button--outline qp-button--sm" onClick={() => { setOpen(false); trigger.current?.focus() }}>完成</button></footer>
      </div> : null}
    </div>
    {values.length ? <div className="mih-news-source-chips">{values.map(key => <button key={key} type="button" className="qp-button qp-button--ghost qp-button--sm" aria-label={`移除${names[key] || '来源'}`} onClick={() => toggle(key)}>{names[key] || '来源暂不可用'}<X size={12} /></button>)}</div> : null}
    <small className="qp-field__hint">展开读取已绑定且当前 Key 可检索的新闻来源；多选匹配任一来源。</small>
  </div>
}
