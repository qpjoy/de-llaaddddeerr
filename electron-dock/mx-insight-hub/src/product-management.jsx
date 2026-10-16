import { lazy, Suspense } from 'react'
import { LoadingState } from './components.jsx'
import './product-management.css'
import { publicDocsHref } from './api.js'
import { isProductAdmin, productManagementLinks } from '../shared/product-management.mjs'

const ManagementPanel = lazy(() => import('./product-management-panel.jsx').then(module => ({ default: module.ProductManagementPanel })))

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

export function ProductManagement({ token, session, path, label, onUnauthorized, notify, providerKey, onSaved }) {
  if (!isProductAdmin(session)) return null
  return <section className="qp-panel mih-panel mih-product-management" aria-label={`${label}管理`}>
    <h2>{label}管理</h2><p>按产品查看接口、价格与运行配置；每项修改沿用现有权限和审核流程。</p>
    {token ? <Suspense fallback={<LoadingState label="正在加载产品管理" />}><ManagementPanel key={`${token}:${path}`} {...{ token, path, label, onUnauthorized, notify, providerKey, onSaved }} /></Suspense> : <p>等待管理员身份后读取配置。</p>}
    <div className="mih-product-management-links">{productManagementLinks(path).map(link => <a key={link.label} className="qp-panel" href={link.href}><strong>{link.label} →</strong><span>{link.description}</span></a>)}</div>
  </section>
}
