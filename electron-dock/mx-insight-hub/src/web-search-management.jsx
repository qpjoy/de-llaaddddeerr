import { ProductManagement } from './product-management.jsx'
import { useCallback, useState } from 'react'
import { WEB_SEARCH_PROVIDERS } from '../shared/web-search.mjs'
import { adminApi } from './api.js'
import { ErrorState, LoadingState, useRemoteData } from './components.jsx'
import { StructuredCredentialPanel } from './structured-credential-panel.jsx'

// Management uses the Admin identity, independently of the selected search Key.
export function WebSearchManagement({ token, session, onUnauthorized, notify, onSaved }) {
  if (session?.kind !== 'admin-token' || !session.platformAdmin) return null
  return <SupplierManagement key={token} {...{ token, session, onUnauthorized, notify, onSaved }} />
}

function SupplierManagement({ token, session, onUnauthorized, notify, onSaved }) {
  const [providerKey, setProviderKey] = useState('baidu')
  const provider = WEB_SEARCH_PROVIDERS.find(item => item.key === providerKey)
  return <section className="mih-search-management" aria-label="Web Search 供应商管理">
    <header className="qp-panel mih-search-channels">
      <h2>供应商管理</h2>
      <p>在这里管理八家搜索供应商的 API Token。与“上游供应商”共用同一份配置，不受当前调用 Key 的渠道范围限制。</p>
      <p>选择供应商后可修改密钥，或重新验证 Admin Token 查看已有密钥。接口启停、采购价格和限速可在下方直接管理；租户和 Key 的使用权限单独配置。</p>
      <nav className="mih-search-supplier-tabs" aria-label="选择搜索供应商">{WEB_SEARCH_PROVIDERS.map(item =>
        <button key={item.key} type="button" className="qp-button qp-button--outline" aria-pressed={providerKey === item.key} onClick={() => setProviderKey(item.key)}>{item.label}</button>
      )}</nav>
    </header>
    <SupplierDetail key={providerKey} {...{ token, session, provider, onUnauthorized, notify, onSaved }} />
  </section>
}

function SupplierDetail({ token, session, provider, onUnauthorized, notify, onSaved }) {
  const load = useCallback(() => adminApi.externalPlatform(token, provider.key, { range: '24h' }), [token, provider.key])
  const remote = useRemoteData(load, onUnauthorized)
  if (remote.loading) return <LoadingState label={`正在读取 ${provider.label} 配置`} />
  if (remote.error) return <ErrorState error={remote.error} onRetry={remote.refresh} />
  const credential = remote.data?.credential
  const operation = remote.data?.operations?.find(item => item.operationKey === 'web.search')
  return <>
    <section className="qp-panel mih-search-channels" aria-label={`${provider.label} 管理入口`}>
      <header><div><h2>{provider.label}</h2><p>{credential?.credentialConfigured ? '已配置 API Token' : '尚未配置 API Token'}{operation ? ` · 运行状态：${({ active: '启用', paused: '暂停', disabled: '停用', shadow: '校验', canary: '灰度' })[operation.desiredState] || '请查看详情'}` : ''}</p></div>
        <button type="button" className="qp-button qp-button--ghost" onClick={remote.refresh}>刷新配置</button></header>
      <div className="mih-search-supplier-tabs">
        <a className="qp-button qp-button--outline" href={`#/external-platforms?provider=${provider.key}`}>运行开关、采购价格与出网代理 ↗</a>
        <a className="qp-button qp-button--ghost" href="#/platforms">租户授权 ↗</a>
        <a className="qp-button qp-button--ghost" href="#/api-keys">Key 权限与顺序 ↗</a>
      </div>
      <p>保存密钥不会发起搜索；凭据已配置也不代表渠道已可调用，请在供应商详情检查运行状态与阻断原因。</p>
    </section>
    <ProductManagement {...{ token, session, onUnauthorized, notify, onSaved }} path="/data-products/web-search" label="Web Search" providerKey={provider.key} />
    {credential?.fields?.length ? <StructuredCredentialPanel {...{ token, credential, onUnauthorized, notify }} provider={provider.key}
      onSaved={() => { remote.refresh(); onSaved?.() }} /> : <ErrorState error={new Error('当前服务未返回凭据字段，请更新 Hub 服务后重试。')} />}
  </>
}
