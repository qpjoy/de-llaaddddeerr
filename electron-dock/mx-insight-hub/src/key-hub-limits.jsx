import { useCallback, useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { ErrorState, Field, LoadingState, Modal, formatDate } from './components.jsx'

// Presentation scope only. The Admin endpoint independently verifies the same
// immutable identity; a copied name or a replacement Key is never eligible.
export function canManageKeyHubLimits(session, key) {
  return session?.kind === 'admin-token'
    && key?.id === 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
    && key.tenantId === '277bf8a4-5ed5-414d-b429-d72fcd7d36b6'
    && key.consumerId === 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
}

export function KeyHubLimitsModal({ token, apiKey, onClose, onUnauthorized }) {
  const [data, setData] = useState(null), [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false)
  const [reason, setReason] = useState(''), [error, setError] = useState(null), [notice, setNotice] = useState('')
  const active = useRef(null), mounted = useRef(true)
  const refresh = useCallback(async () => {
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    setData(null); setError(null); setNotice(''); setReason(''); setLoading(true)
    try {
      const result = await adminApi.keyHubLimits(token, apiKey.id, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (result.policyVersion !== 2) throw new Error('请先发布支持预算与自动熔断豁免的 Hub 新版本，再设置此开关。')
      setData(result); setEnabled(result.effectiveExempt === true)
    } catch (failure) {
      if (controller.signal.aborted) return
      setError(failure); if (failure.status === 401) onUnauthorized?.(failure)
    } finally {
      if (active.current === controller && !controller.signal.aborted) { active.current = null; setLoading(false) }
    }
  }, [token, apiKey.id, onUnauthorized])
  useEffect(() => {
    mounted.current = true; refresh()
    return () => { mounted.current = false; active.current?.abort() }
  }, [refresh])
  const save = async event => {
    event.preventDefault()
    if (saving || !data || reason.trim().length < 3) return
    setSaving(true); setError(null); setNotice('')
    try {
      const result = await adminApi.saveKeyHubLimits(token, apiKey.id, {
        hubRateLimitExempt: enabled, revision: data.revision, reason: reason.trim(),
      })
      if (!mounted.current) return
      if (result.policyVersion !== 2) throw new Error('保存结果来自旧版 Hub；请完成发布后重新读取当前状态。')
      setData(result); setEnabled(result.effectiveExempt === true); setReason('')
      setNotice(result.effectiveExempt ? '已保存：Hub 次数、频率、并发与预算豁免已开启。' : '已保存：此 Key 恢复普通 Hub 限制。')
    } catch (failure) {
      if (!mounted.current) return
      // A lost response may follow a committed write. Never retry with a stale
      // revision or present the draft switch position as the saved state.
      setData(null); setError(failure)
      setNotice(failure.code === 'api_key_hub_limits_changed'
        ? '设置已被其他管理员修改。请重新读取后选择并保存。'
        : '本次保存未获确认。请重新读取当前状态；系统不会自动重复提交。')
      if (failure.status === 401) onUnauthorized?.(failure)
    } finally { if (mounted.current) setSaving(false) }
  }
  const unchanged = data?.source === 'explicit' && enabled === data.effectiveExempt
  return <Modal title={`${apiKey.name} · Hub 限制开关`} size="large" busy={saving} closeOnBackdrop={false} onClose={() => !saving && onClose()}
    description="仅管理这把原始 Key 的 Hub 次数、频率、并发与预算限制。读取和保存设置不发起业务查询。">
    <div className="mih-form">
      <p><strong>Key ID：</strong><code>{apiKey.id}</code></p>
      {loading ? <LoadingState label="正在读取 Hub 限制设置" /> : null}
      {error ? <ErrorState error={error} onRetry={refresh} /> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {data ? <form className="mih-form" onSubmit={save}>
        <section className="qp-card" aria-label="已保存的 Hub 限制状态">
          <p><strong>当前状态：</strong>{data.source === 'legacy' ? '沿用历史策略 · 尚未显式设置' : data.effectiveExempt ? '豁免已开启' : '豁免已关闭 · 普通 Hub 限制'}</p>
          {data.source === 'legacy' ? <p>{data.inheritedQuotaExempt ? '原有内部 Key 额度豁免继续生效；尚未显式开启本开关的次数、频率、并发与预算豁免。' : '尚未显式开启本开关的次数、频率、并发与预算豁免。'}</p> : null}
          <small>版本 {data.revision}{data.updatedAt ? ` · 更新于 ${formatDate(data.updatedAt)}` : ''}</small>
        </section>
        <Field label="豁免 Hub 次数、频率、并发与预算限制" hint="产品/API 资源限速始终适用，包括此 Key。开启后跳过 Hub 业务查询的请求次数配额、限频、普通执行并发门禁、月度采购/补贴预算及自动供应商熔断等待；关闭后恢复普通限制，并覆盖这把 Key 的历史额度豁免。">
          <label><input type="checkbox" role="switch" aria-label="豁免 Hub 次数、频率、并发与预算限制" checked={enabled} disabled={saving} onChange={event => { setEnabled(event.target.checked); setNotice('') }} /> {enabled ? '开启豁免' : '关闭豁免'}（{unchanged ? '已保存' : '待保存'}）</label>
        </Field>
        <p>上游实际限流仍会返回错误。认证、授权、管理员主动暂停、余额与计费、合同隔离、结果待核对和幂等保护继续生效。上游充值后，新请求不必等待 Hub 的自动供应商熔断到期。设置只影响后续准入，不清零用量、不改历史结果，也不重发请求。</p>
        <p>商品媒体传输限制、IP 订阅权益额度和供应商账本保护仍适用。</p>
        <Field label="变更原因" hint="将随本次设置写入管理审计记录。">
          <textarea className="qp-input" rows={3} minLength={3} maxLength={500} required value={reason} disabled={saving} onChange={event => setReason(event.target.value)} placeholder="例如：允许 LCY-delta 直接承接上游限流反馈" />
        </Field>
        <div className="mih-page-actions">
          <button className="qp-button qp-button--outline" type="button" disabled={saving} onClick={refresh}>重新读取</button>
          <button className="qp-button qp-button--primary" disabled={saving || unchanged || reason.trim().length < 3}>{saving ? '正在保存…' : enabled ? '保存并开启豁免' : '保存并关闭豁免'}</button>
        </div>
      </form> : null}
      <div className="mih-page-actions"><button className="qp-button qp-button--outline" type="button" disabled={saving} onClick={onClose}>关闭</button></div>
    </div>
  </Modal>
}
