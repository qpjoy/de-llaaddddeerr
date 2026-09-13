import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field } from './components.jsx'
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
  const secret = custom ? manual : credential?.secret || ''
  return <DemoContext.Provider value={{ credential, secret, select, custom, setCustom, setManual,
    manual, error, busy, identity: custom ? `custom:${manual}` : credential?.keyId || 'none' }}>{children}</DemoContext.Provider>
}
export function DemoProductPage({ Page, pageProps, enabled, admin }) {
  const state = useContext(DemoContext)
  const requested = useRef(false)
  const [expanded, setExpanded] = useState(!admin)
  useEffect(() => {
    if (enabled && admin && !state.credential && !requested.current) {
      requested.current = true
      state.select()
    }
  }, [enabled, admin, state.credential])
  return <>
    {enabled ? <details className="qp-panel mih-panel" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>数据产品演示身份 · {state.secret ? (state.custom ? '自有 API Key' : state.credential?.name) : '请选择或输入 Key'}</summary>
      <p>所有数据产品共用当前选择；按所选 Key 的授权、额度和费率调用。演示成功调用同样可能扣费。</p>
      {admin ? <DropdownField label="演示 Key" value={state.custom ? 'custom' : state.credential?.keyId || ''}
        disabled={state.busy} onChange={value => {
          if (value === 'custom') state.setCustom(true)
          else state.select(value || undefined)
        }} options={[
          { value: '', label: '默认 · LCY-delta' },
          ...(state.credential?.choices || []).map(key => ({value:key.id,label:`${key.name} · ${key.environment} · ${key.id.slice(0,8)}`})),
          {value:'custom',label:'手动输入其他 Key'},
        ]} /> : null}
      {state.custom || !admin ? <Field label="我的 Hub API Key" hint="在 API Keys 页面获取已授权的 Live Key。Key 不会解除服务暂停或未开通限制。"><input className="qp-input" type="password" autoComplete="off"
        value={state.manual} onChange={e=>{state.setCustom(true);state.setManual(e.target.value)}} /></Field> : null}
      {admin ? <button className="qp-button qp-button--outline" type="button" disabled={state.busy}
        onClick={()=>state.select(state.credential?.keyId)}>{state.busy ? '正在加载演示身份…' : '刷新演示凭据'}</button> : null}
      {state.credential?.reason ? <p>{state.credential.reason}</p> : null}
      {state.error ? <ErrorState error={state.error} /> : null}
      <p>{admin && !state.custom ? '演示凭据仅保存在当前页面会话中，有效期一小时；过期后点击刷新。' : 'Key 仅保存在当前页面内存中，刷新页面后需重新输入。服务不可用时请联系管理员开通，切换 Key 不会绕过运行限制。'}</p>
    </details> : null}
    <Page key={state.identity} {...pageProps} />
  </>
}
