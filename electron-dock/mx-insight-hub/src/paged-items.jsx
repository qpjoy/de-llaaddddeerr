import { useEffect, useState } from 'react'
import { Field, Pagination } from './components.jsx'

// Keep original indices: editing a searched/page-two row must update that row,
// while publication still validates and submits the complete draft.
export function PagedItems({ items, text, children, label, pageSize = 10, revealItem = null }) {
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(1)
  useEffect(() => {
    if (!revealItem) return
    setFilter('')
    setPage(Math.floor(revealItem.index / pageSize) + 1)
  }, [revealItem, pageSize])
  const term = filter.trim().toLowerCase()
  const matches = items.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !term || text(entry).toLowerCase().includes(term))
  const pages = Math.max(1, Math.ceil(matches.length / pageSize))
  const current = Math.min(page, pages)
  return <div className="mih-paged-items">
    <Field label={`搜索${label}`}><input className="qp-input" type="search" value={filter}
      placeholder="输入名称或接口 ID" onChange={event => { setFilter(event.target.value); setPage(1) }} /></Field>
    {children(matches.slice((current - 1) * pageSize, current * pageSize))}
    {!matches.length ? <p role="status">没有匹配项</p> : null}
    <Pagination label={`${label}分页`} page={current} pageSize={pageSize} total={matches.length}
      totalPages={pages} hasMore={current < pages} onPageChange={setPage} />
  </div>
}
