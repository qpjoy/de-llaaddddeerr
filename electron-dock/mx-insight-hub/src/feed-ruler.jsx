import { useEffect, useState } from 'react'

// Pages describe the currently loaded list, never an upstream page/cursor.
export function FeedRuler({ viewport, count, pageSize, onNavigate }) {
  const pages = Math.max(1, Math.ceil(count / pageSize))
  const [current, setCurrent] = useState(1)
  const [input, setInput] = useState('1')
  useEffect(() => {
    const node = viewport.current
    if (!node) return
    let frame
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const top = node.getBoundingClientRect().top
        const cards = [...node.querySelectorAll('[data-feed-index]')]
        const first = cards.find(card => card.getBoundingClientRect().bottom > top + 12)
        const page = first ? Math.floor(Number(first.dataset.feedIndex) / pageSize) + 1 : 1
        setCurrent(page); setInput(String(page))
      })
    }
    node.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(node)
    if (node.firstElementChild) observer.observe(node.firstElementChild)
    update()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); node.removeEventListener('scroll', update) }
  }, [viewport, count, pageSize])
  const jump = value => {
    const page = Math.max(1, Math.min(pages, Math.trunc(Number(value) || 1)))
    const node = viewport.current
    const card = node?.querySelector(`[data-feed-index="${(page - 1) * pageSize}"]`)
    if (!card) return
    onNavigate()
    node.scrollTo({ top: node.scrollTop + card.getBoundingClientRect().top - node.getBoundingClientRect().top - 12, behavior: 'instant' })
    setCurrent(page); setInput(String(page))
  }
  const step = Math.max(1, Math.ceil((pages - 1) / 8))
  const marks = [...new Set([1, ...Array.from({ length: Math.floor((pages - 1) / step) }, (_, i) => 1 + (i + 1) * step), pages])]
  return <aside className="mih-feed-ruler" aria-label="已加载笔记位置">
    <strong>{count ? current : 0} / {count ? pages : 0}</strong>
    <div className="mih-feed-ruler-track">
      <input type="range" aria-label="跳转到已加载页" aria-orientation="vertical" min="1" max={pages} value={Math.min(current, pages)} disabled={!count || pages === 1} onChange={event => jump(event.target.value)} />
      <div>{marks.map(page => <button key={page} type="button" disabled={!count} style={{ top: `${pages === 1 ? 0 : (page - 1) / (pages - 1) * 100}%` }} onClick={() => jump(page)} aria-label={`跳转到第 ${page} 页`}>— {page}</button>)}</div>
    </div>
    <form onSubmit={event => { event.preventDefault(); jump(input) }}>
      <label>页码<input className="qp-input" aria-label="已加载页码" type="number" min="1" max={pages} value={input} disabled={!count} onChange={event => setInput(event.target.value)} /></label>
      <button className="qp-button qp-button--outline" disabled={!count}>跳转</button>
    </form>
    <small>每页 {pageSize} 篇<br />仅定位已加载内容</small>
  </aside>
}
