import { wechatProduct, wechatServices } from '../shared/wechat.mjs'

export function WechatOverview({ routePath }) {
  const product = wechatProduct(routePath?.split('/').at(-1))
  if (!product) return null
  return <section className="qp-panel mih-panel"><h2>{product.label}</h2><p>{product.description}。在接口调试中选择服务、填写参数并查看当前账户价格。</p>
    {product.group === 'mp' ? <p>阅读文章可优先选择“文章详情（H5）”。账号资料、文章列表、阅读互动、评论及回复分别查询；每次发送对应一个接口，不会自动查询关联内容。</p> : null}
    <p>本产品交付实时查询结果与调用记录。结果不会自动加入已收录数据搜索；数据源目录分别记录接口覆盖与入库状态。</p>
    <div className="mih-page-actions"><a href="#/source-catalog">数据源目录 →</a><a href="#/data-products/search">数据搜索 →</a></div>
    <ul>{wechatServices(product).map(row => <li key={row.key}><a href={`#/data-products/${product.key}?endpoint=${row.key}`}>{row.summary}</a></li>)}</ul>
  </section>
}

// Present documented business fields only. Never execute returned article HTML.
function articleText(html) {
  if (typeof html !== 'string') return ''
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll('script,style,iframe,object').forEach(node => node.remove())
  return template.content.textContent || ''
}
const text = value => ['string','number'].includes(typeof value) ? String(value) : ''
const safeLink = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null } }
export function WechatResult({ payload }) {
  const data = payload?.data
  if (!data || typeof data !== 'object') return null
  const article = data.content && typeof data.content === 'object' ? data.content : null
  const rows = ['articles', 'items', 'comments', 'replies', 'videos', 'collections'].map(key => data[key]).find(Array.isArray)
  return <section className="mih-wechat-result" aria-label="微信查询结果"><h3>微信查询结果</h3>
    {article ? <article><h2>{text(article.title) || '文章详情'}</h2><p>{[article.nick_name, article.author, article.create_time].map(text).filter(Boolean).join(' · ')}</p>
      {text(article.desc) ? <p>{text(article.desc)}</p> : null}{safeLink(article.link || data.url) ? <a href={safeLink(article.link || data.url)} target="_blank" rel="noreferrer">查看原文 ↗</a> : null}
      <div className="mih-wechat-article">{articleText(article.content_noencode || article.content) || '此结果没有提供正文，完整字段见 JSON 响应。'}</div></article>
      : rows ? <><p>本页返回 {rows.length} 条；下一页需按接口游标手动请求。</p>{rows.filter(row => row && typeof row === 'object').map((row, index) => <article key={index}><h4>{row.title ? articleText(String(row.title)) : text(row.nickname) || `结果 ${index + 1}`}</h4><p>{text(row.digest) || text(row.desc) || text(row.content)}</p><details><summary>完整业务字段</summary><pre className="mih-api-response">{JSON.stringify(row, null, 2)}</pre></details></article>)}</>
      : <p>{text(data.nickname) || text(data.nick_name) || text(data.biz_username) || '已返回业务数据；详细指标及字段见下方 JSON。'}</p>}
    {text(data.no_more) ? <p>{text(data.no_more)}</p> : null}
  </section>
}
