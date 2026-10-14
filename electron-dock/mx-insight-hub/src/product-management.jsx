import { publicDocsHref } from './api.js'
import { isProductAdmin, productManagementLinks } from '../shared/product-management.mjs'

export function ProductViewTabs({ label, value, onChange, session, debug = 'debug', product = 'product', guide = 'guide', management = 'management' }) {
  return <nav className="mih-source-section-tabs" aria-label={`${label}视图`}>
    {[[debug, '接口调试'], [product, '产品展示'], [guide, '接入指南'], ...(isProductAdmin(session) ? [[management, '管理']] : [])].map(([id, title]) => <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>{title}</button>)}
  </nav>
}

export function ProductIntegrationGuide({ label, docs, children }) {
  return <section className="qp-panel mih-panel">
    <h2>接入 {label}</h2><p>使用已授权的 Hub Live Key，在接口调试中查看参数、响应和调用示例。服务端按当前权限、限额与套餐价格检查每次请求。</p>
    <p>新查询与下一页分别使用新的请求标识；结果未知时先核对使用记录。游标原样传回，不自动补页。页面打开、筛选和切换标签不会发起数据查询。</p>
    {children}<a href={publicDocsHref(`/docs/${docs}`)}>查看完整接口、分页与响应说明 ↗</a>
  </section>
}

export function ProductManagement({ session, path, label }) {
  if (!isProductAdmin(session)) return null
  return <section className="qp-panel mih-panel mih-product-management" aria-label={`${label}管理`}>
    <h2>{label}管理</h2><p>从产品进入现有管理工具，查看配置与调用证据；每项修改沿用对应工具的权限和审核流程。</p>
    <div className="mih-product-management-links">{productManagementLinks(path).map(link => <a key={link.label} className="qp-panel" href={link.href}><strong>{link.label} →</strong><span>{link.description}</span></a>)}</div>
  </section>
}
