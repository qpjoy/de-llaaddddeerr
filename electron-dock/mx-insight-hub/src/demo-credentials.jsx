import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field } from './components.jsx'
import { demoAccessIssues } from './demo-access.js'
const DemoContext = createContext(null)
export function useDemoApiKey() {
  const context = useContext(DemoContext)
  return [context?.secret || '', context?.setManual || (() => {})]
}
export function DemoCredentialProvider({ token, children }) {
  const [credential, setCredential] = useState(null)
  const [manual, setManual] = useState('')
  const [custom, setCustom] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  async function select(keyId) {
    const version = ++generation.current
    setBusy(true); setError(null); setCustom(false)
    setCredential(current => current ? { ...current, secret: null } : null)
    try {
      const result = await adminApi.demoCredential(token, keyId)
      if (version === generation.current) setCredential(result)
    } catch (error) { if (version === generation.current) setError(error) }
    finally { if (version === generation.current) setBusy(false) }
  }
  useEffect(() => {
    if (!credential?.expiresAt || custom) return undefined
    const timer = setTimeout(() => select(credential.keyId), Math.max(1000, credential.expiresAt - Date.now() - 60_000))
    return () => clearTimeout(timer)
  }, [credential?.expiresAt, custom])
  const secret = custom ? manual : credential?.secret || ''
  return <DemoContext.Provider value={{ credential, secret, select, custom, setCustom, setManual,
    manual, error, busy, identity: custom ? `custom:${manual}` : credential?.keyId || 'none' }}>{children}</DemoContext.Provider>
}
export function DemoProductPage({ Page, pageProps, enabled, admin }) {
  const state = useContext(DemoContext)
  const requested = useRef(null)
  const [expanded, setExpanded] = useState(!admin)
  useEffect(() => {
    if (!enabled) { requested.current = null; return }
    if (!state.custom && requested.current !== Page) {
      requested.current = Page
      // Returning from grant/Key management must recheck the current snapshot.
      // Keep the selected Key; never silently choose a different consumer.
      state.select(state.credential?.keyId)
    }
  }, [enabled, Page, state.custom])
  return <>
    {enabled ? <details className="qp-panel mih-panel" open={expanded || !state.secret} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{admin ? '数据产品演示身份' : '当前调用身份'} · {state.busy ? '正在加载…' : state.secret ? (state.custom ? '自有 API Key' : state.credential?.name) : '请选择 Key'}</summary>
      <p>按当前账户的授权和套餐价格调用，消费记录可在账单中查看。</p>
      <DropdownField label={admin ? "演示 Key" : "我的 Key"} value={state.custom ? 'custom' : state.credential?.keyId || ''}
        disabled={state.busy} onChange={value => {
          if (value === 'custom') state.setCustom(true)
          else state.select(value || undefined)
        }} options={[
          { value: '', label: admin ? '默认 · LCY-delta' : '请选择我的 Key' },
          ...(state.credential?.choices || []).map(key => ({value:key.id,label:`${key.name} · ${key.environment} · ${key.id.slice(0,8)}`})),
          ...(admin ? [{value:'custom',label:'手动输入其他 Key'}] : []),
        ]} />
      {admin && state.custom ? <Field label="我的 Hub API Key" hint="在 API Keys 页面获取已授权的 Live Key。Key 不会解除服务暂停或未开通限制。"><input className="qp-input" type="password" autoComplete="off"
        value={state.manual} onChange={e=>{state.setCustom(true);state.setManual(e.target.value)}} /></Field> : null}
      <button className="qp-button qp-button--outline" type="button" disabled={state.busy}
        onClick={()=>state.select(state.credential?.keyId)}>{state.busy ? '正在加载演示身份…' : '刷新调用身份'}</button>
      {state.credential?.reason ? <p>{state.credential.reason}</p> : null}
      {state.error ? <ErrorState error={state.error} /> : null}
      {admin ? <p>临时调用凭据有效期一小时，仅保存在当前页面内存。</p> : null}
    </details> : null}
    <Page key={state.identity} {...pageProps} />
  </>
}

export function useDemoAccess(operation, compatibility = false) {
  const state = useContext(DemoContext)
  return demoAccessIssues(state?.custom ? null : state?.credential?.access, operation, compatibility)
}
export function DemoAccessNotice({ operation, compatibility = false }) {
  const state = useContext(DemoContext)
  const issues = useDemoAccess(operation, compatibility)
  if (!issues.length) return null
  return <div className="mih-inline-warning" role="status"><div>
    {issues.map(issue => <p key={`${issue.kind}:${issue.scope}`}>{issue.message}</p>)}
    <a className="qp-button qp-button--outline qp-button--sm" href={`#/api-keys?consumerId=${state?.credential?.consumerId || ''}`}>查看我的 Key 授权</a>
    <button className="qp-button qp-button--ghost qp-button--sm" disabled={state?.busy} onClick={() => state.select(state.credential?.keyId)}>重新检查</button>
  </div></div>
}

export function useDemoAccessSnapshot() {
  const state = useContext(DemoContext)
  return state?.custom ? null : state?.credential?.access
}

export function DemoCredentialRecheck() {
  const state = useContext(DemoContext)
  if (!state || state.custom) return null
  return <div className="mih-page-actions">
    <button type="button" className="qp-button qp-button--outline" disabled={state.busy}
      onClick={() => state.select(state.credential?.keyId)}>{state.busy ? '正在检查调用身份…' : '重新检查当前 Hub Key'}</button>
    <a className="qp-button qp-button--outline" href={`#/api-keys?consumerId=${state.credential?.consumerId || ''}`}>查看 Key 授权</a>
  </div>
}
