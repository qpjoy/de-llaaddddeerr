import { useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, EmptyState, ErrorState, Field, LoadingState, PageHeading } from './components.jsx'
import './news-discovery.css'

const STATUS = { running: '处理中；不会重复调用', proposed: '待审核', unmatched: '未找到确定来源', accepted: '已采用', rejected: '未采用', unknown: '结果未知；原请求不会再次调用' }
export function CatalogClassifierPage({ token }) {
  const [data, setData] = useState(null), [query, setQuery] = useState(''), [binding, setBinding] = useState('unmapped')
  const [page, setPage] = useState(1), [error, setError] = useState(null), [busy, setBusy] = useState(false)
  const locked = useRef(false), requests = useRef(new Map()), epoch = useRef(0)
  async function load(nextPage = page) {
    const current = ++epoch.current
    try {
      const response = await adminApi.classificationRecords(token, { query, binding, page: nextPage })
      if (current === epoch.current) { setData(response); setPage(nextPage) }
    } catch (error) { if (current === epoch.current) setError(error) }
  }
  useEffect(() => { void load(1); return () => { epoch.current++ } }, [token])
  async function classify(row, useAgent) {
    if (locked.current) return
    const signature = `${row.id}:${row.current_revision}:${useAgent}`
    if (!requests.current.has(signature)) requests.current.set(signature, crypto.randomUUID())
    locked.current = true; setBusy(true); setError(null)
    try {
      const result = await adminApi.classifyRecord(token, { recordId: row.id, recordRevision: row.current_revision,
        useAgent, requestKey: requests.current.get(signature) })
      if (!['running', 'unknown'].includes(result.status)) requests.current.delete(signature)
      await load()
    } catch (error) { setError(error); await load() }
    finally { locked.current = false; setBusy(false) }
  }
  async function review(row, decision) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(null)
    try { await adminApi.reviewClassification(token, row.run_id, { decision, expectedBindingRevision: row.binding_revision }); await load() }
    catch (error) { setError(error) }
    finally { locked.current = false; setBusy(false) }
  }
  return <div className="mih-news">
    <PageHeading eyebrow="AGENT / DATA CLASSIFICATION" title="数据归类" description="内置来源归类 Agent：先匹配确定规则，再为未匹配记录提供目录建议。审核后绑定，不改变原始数据或公开权限。">
      <a href="#/source-catalog" className="qp-button qp-button--outline">管理数据源目录</a>
      <a href="#/agent/sequences" className="qp-button qp-button--outline">查看 LLM Sequence</a>
    </PageHeading>
    <section className="qp-panel mih-news-debug"><p>规则归类不调用模型。“Agent 建议”仅在规则未命中时，使用已配置的默认 Chat Sequence 及其代理策略，提交结构化来源和有界正文片段。每次只处理一条，可能产生模型费用。</p>
      <p>此工作台覆盖全部 canonical 数据。目录缺少来源时，可先新增目录项或补充别名；无法确定的记录保留为待归类。建议不自动发布数据、改授权或修改清洗水位。</p></section>
    <form className="qp-panel mih-news-filters" onSubmit={event => { event.preventDefault(); setError(null); void load(1) }}>
      <Field label="标题关键词"><input className="qp-input" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /></Field>
      <DropdownField label="归类状态" value={binding} onChange={setBinding} options={[{ value: 'unmapped', label: '待归类' }, { value: 'mapped', label: '已绑定目录' }, { value: 'all', label: '全部记录' }]} />
      <div className="mih-news-actions"><button className="qp-button qp-button--primary" disabled={busy}>查询记录</button></div>
    </form>
    {error ? <ErrorState error={error} /> : null}
    {!data && !error ? <LoadingState label="正在读取待归类记录" /> : null}
    {data?.items.length ? <div className="mih-classifier-list">{data.items.map(row => <article className="qp-panel" key={row.id}>
      <small>{row.platform} · {row.object_type} · 版本 {row.current_revision}</small><h3>{row.title || '无标题记录'}</h3><p>{row.excerpt || '无正文片段'}</p>
      <p>当前目录：{row.entry_name || '尚未绑定'}</p>
      {row.run_id ? <div className="mih-classifier-proposal"><strong>{STATUS[row.run_status] || row.run_status}{row.proposed_entry_name ? ` · ${row.proposed_entry_name}` : ''}</strong><p>{row.explanation}</p>{row.confidence != null ? <small>建议置信度 {Math.round(row.confidence * 100)}% · {row.method === 'rule' ? '确定规则' : 'Agent 请求'}（不等于正确率）</small> : null}</div> : null}
      <div className="mih-news-actions"><button className="qp-button qp-button--outline" disabled={busy || row.run_status === 'running'} onClick={() => void classify(row, false)}>规则归类</button>
        <button className="qp-button qp-button--outline" disabled={busy || row.run_status === 'running'} onClick={() => void classify(row, true)}>Agent 建议</button>
        {row.run_status === 'proposed' ? <><button className="qp-button qp-button--primary" disabled={busy} onClick={() => void review(row, 'accept')}>采用并绑定目录</button><button className="qp-button qp-button--ghost" disabled={busy} onClick={() => void review(row, 'reject')}>不采用</button></> : null}</div>
    </article>)}</div> : data ? <EmptyState title="当前范围没有记录" description="可查看全部记录，或等待清洗计划完成入库。" /> : null}
    {data ? <div className="mih-news-actions"><button className="qp-button qp-button--outline" disabled={busy || page <= 1} onClick={() => void load(page - 1)}>上一页</button><span>第 {page} 页</span><button className="qp-button qp-button--outline" disabled={busy || !data.hasMore} onClick={() => void load(page + 1)}>下一页</button></div> : null}
  </div>
}
