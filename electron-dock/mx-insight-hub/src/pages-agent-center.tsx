import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Brain,
  CheckCircle,
  DotsSixVertical,
  FloppyDisk,
  Globe,
  PencilSimple,
  Play,
  Plus,
  Trash,
  Warning,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  DropdownField,
  ErrorState,
  Field,
  LoadingState,
  PageHeading,
  StatusBadge,
  useRemoteData,
} from './components.jsx'
import './agent-center.css'

type PageProps = {
  token: string
  session: { kind?: string } | null
  onUnauthorized?: (error: unknown) => void
  notify?: (message: string, tone?: string) => void
}

type Provider = {
  id: string
  displayName?: string
  baseUrl: string
  model: string
  protocol?: string
  proxySequenceKey?: string | null
  timeoutMs?: number
  dimensions?: number
  priority?: number
  authMode?: 'bearer' | 'none'
  enabled?: boolean
  keyConfigured?: boolean
}

type LlmSequence = {
  sequenceKey: string
  displayName: string
  kind: 'chat' | 'embedding'
  providerIds: string[]
  enabled: boolean
  source: 'bootstrap' | 'database'
  providerRevision: number
  revision: number
  verifiedAt: string | null
}

type ProxyEndpoint = {
  proxyKey: string
  displayName: string
  proxyUrl: string
  enabled: boolean
  revision: number
}

type ProxySequence = {
  sequenceKey: string
  displayName: string
  proxyKeys: string[]
  directFallback: boolean
  enabled: boolean
  revision: number
}

const PROVIDER_MIME = 'application/x-mx-insight-provider'
const PROXY_MIME = 'application/x-mx-insight-proxy'

function Panel({ title, subtitle, actions, children, className = '' }: {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`qp-panel mih-panel mih-agent-center-panel ${className}`.trim()}>
      <header className="mih-panel__header">
        <div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
        {actions ? <div className="mih-page-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

function keyValid(value: string) {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
}

function formatDate(value: string | null | undefined) {
  if (!value) return '尚未验证'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function move<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

function sameOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function publicProviderPayload(provider: Provider) {
  return {
    id: provider.id,
    displayName: provider.displayName || provider.id,
    baseUrl: provider.baseUrl,
    model: provider.model,
    protocol: provider.protocol || 'openai-compatible',
    proxySequenceKey: provider.proxySequenceKey || null,
    timeoutMs: provider.timeoutMs || 60_000,
    ...(provider.dimensions ? { dimensions: provider.dimensions } : {}),
    enabled: provider.enabled !== false,
    priority: provider.priority ?? 0,
    authMode: provider.authMode || 'bearer',
  }
}

export function AgentSequencePage({ token, session, onUnauthorized, notify }: PageProps) {
  const load = useCallback(() => adminApi.agent(token), [token])
  const state = useRemoteData(load, onUnauthorized) as any
  const [selectedKey, setSelectedKey] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({
    sequenceKey: '', displayName: '', kind: 'chat' as 'chat' | 'embedding',
    providerIds: [] as string[], enabled: true, revision: 0,
  })
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<any>(null)
  const [sample, setSample] = useState<any>(null)
  const canEdit = session?.kind === 'admin-token'

  const sequences = (state.data?.control?.sequences || []) as LlmSequence[]
  const bindings = state.data?.control?.bindings || []
  const settings = state.data?.settings || {}
  const providers = useMemo<Provider[]>(() => (
    (settings[draft.kind]?.providers || [])
      .filter((provider: Provider) => provider.enabled !== false)
  ), [draft.kind, settings])
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers])
  const defaultBinding = bindings.find((binding: any) => binding.kind === draft.kind)
  const persistedSequence = sequences.find((sequence) => sequence.sequenceKey === draft.sequenceKey)
  const needsRevalidation = Boolean(persistedSequence)
    && persistedSequence?.providerRevision !== Number(settings[draft.kind]?.revision ?? 0)
  const draftChanged = !persistedSequence
    || needsRevalidation
    || persistedSequence.displayName !== draft.displayName.trim()
    || persistedSequence.kind !== draft.kind
    || persistedSequence.enabled !== draft.enabled
    || !sameOrder(persistedSequence.providerIds, draft.providerIds)
  const proxyControl = state.data?.control?.proxy || { endpoints: [], sequences: [], globalSequenceKey: null }
  const proxySequences = proxyControl.sequences || []
  const proxyEndpoints = new Map<string, ProxyEndpoint>((proxyControl.endpoints || []).map((endpoint: ProxyEndpoint) => [endpoint.proxyKey, endpoint]))
  const routeNotes = draft.providerIds.map((providerId) => {
    const provider = providerById.get(providerId)
    const sequenceKey = provider?.proxySequenceKey || proxyControl.globalSequenceKey || null
    if (!sequenceKey) return `${provider?.displayName || providerId}：直连（未绑定 Proxy）`
    const proxySequence = proxySequences.find((sequence: ProxySequence) => sequence.sequenceKey === sequenceKey)
    if (!proxySequence?.enabled) return `${provider?.displayName || providerId}：${sequenceKey} 缺失或停用，禁止直连`
    const routes = proxySequence.proxyKeys.flatMap((key: string) => {
      const endpoint = proxyEndpoints.get(key)
      return endpoint?.enabled ? [endpoint.proxyUrl] : []
    })
    if (routes.length === 0) {
      return `${provider?.displayName || providerId}：${sequenceKey} 没有已启用 endpoint，禁止直连`
    }
    if (proxySequence.directFallback) routes.push('direct')
    return `${provider?.displayName || providerId}：${sequenceKey} → ${routes.join(' → ')}`
  })

  useEffect(() => {
    if (selectedKey || creating) return
    const initial = sequences.find((sequence) => sequence.kind === 'chat') || sequences[0]
    if (initial) setSelectedKey(initial.sequenceKey)
  }, [creating, selectedKey, sequences])

  useEffect(() => {
    if (creating) return
    const selected = sequences.find((sequence) => sequence.sequenceKey === selectedKey)
    if (!selected) return
    setDraft({
      sequenceKey: selected.sequenceKey,
      displayName: selected.displayName,
      kind: selected.kind,
      providerIds: [...selected.providerIds],
      enabled: selected.enabled,
      revision: selected.revision,
    })
    setSample(null)
    setError(null)
  }, [creating, selectedKey, state.data])

  const startNew = () => {
    setCreating(true)
    setSelectedKey('')
    setDraft({ sequenceKey: '', displayName: '', kind: 'chat', providerIds: [], enabled: true, revision: 0 })
    setSample(null)
    setError(null)
  }

  const addProvider = (providerId: string, at = draft.providerIds.length) => {
    if (busy || !providerById.has(providerId) || draft.providerIds.includes(providerId)) return
    setDraft((current) => {
      const providerIds = [...current.providerIds]
      providerIds.splice(Math.max(0, Math.min(at, providerIds.length)), 0, providerId)
      return { ...current, providerIds }
    })
  }

  const save = async (setDefault: boolean) => {
    if (!keyValid(draft.sequenceKey) || !draft.displayName.trim() || draft.providerIds.length === 0) {
      setError(new Error('请填写合法 Sequence Key、名称，并至少加入一个 Provider。'))
      return
    }
    setBusy(setDefault ? 'default' : 'save')
    setError(null)
    setSample(null)
    const submitted = { ...draft, providerIds: [...draft.providerIds] }
    let saved: any = null
    try {
      saved = await adminApi.saveAgentSequence(token, submitted.sequenceKey, {
        expectedRevision: submitted.revision,
        displayName: submitted.displayName.trim(),
        kind: submitted.kind,
        providerIds: submitted.providerIds,
        enabled: submitted.enabled,
      })
      setCreating(false)
      setSelectedKey(saved.sequenceKey)
      setDraft((current) => current.sequenceKey === submitted.sequenceKey
        ? { ...current, revision: saved.revision }
        : current)
      if (setDefault) {
        const applied = await adminApi.setDefaultAgentSequence(token, submitted.sequenceKey, {
          kind: submitted.kind,
          expectedRevision: defaultBinding?.revision || 0,
        })
        if (applied?.sequence?.revision != null) {
          setDraft((current) => current.sequenceKey === submitted.sequenceKey
            ? { ...current, revision: applied.sequence.revision }
            : current)
        }
      }
      notify?.(
        setDefault
          ? `${saved.displayName} 已验证并设为全局默认 Sequence`
          : `${saved.displayName} 已验证并保存`,
        'success',
      )
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
      if (saved) state.refresh()
    } finally {
      setBusy('')
    }
  }

  const sayHi = async () => {
    if (!keyValid(draft.sequenceKey) || !draft.displayName.trim() || draft.providerIds.length === 0) {
      setError(new Error('请填写合法 Sequence Key、名称，并至少加入一个 Provider。'))
      return
    }
    setBusy('test')
    setError(null)
    setSample(null)
    const submitted = { ...draft, providerIds: [...draft.providerIds] }
    try {
      let expectedRevision = submitted.revision
      if (draftChanged) {
        const saved = await adminApi.saveAgentSequence(token, submitted.sequenceKey, {
          expectedRevision: submitted.revision,
          displayName: submitted.displayName.trim(),
          kind: submitted.kind,
          providerIds: submitted.providerIds,
          enabled: submitted.enabled,
        })
        setCreating(false)
        setSelectedKey(saved.sequenceKey)
        setDraft((current) => current.sequenceKey === submitted.sequenceKey
          ? { ...current, revision: saved.revision }
          : current)
        expectedRevision = saved.revision
        await state.refresh()
      }
      const result = await adminApi.testAgentSequence(token, submitted.sequenceKey, submitted.kind, expectedRevision)
      setSample({ sequenceKey: submitted.sequenceKey, result })
      notify?.(`Sequence 连接成功：${result.providerId} · ${result.latencyMs} ms`, 'success')
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally {
      setBusy('')
    }
  }

  if (state.loading && !state.data) return <LoadingState label="正在读取 LLM Sequence" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  return (
    <>
      <PageHeading
        eyebrow="AGENT CENTER / LLM SEQUENCES"
        title="LLM Sequence"
        description="Sequence 是 Agent 真正选择的服务：按顺序尝试已保存 Provider，至少一个；保存或设为默认前自动核对当前 revision 的连接测试。"
        loading={state.loading}
        onRefresh={state.refresh}
      ><></></PageHeading>
      {!canEdit ? <div className="mih-inline-warning"><Warning size={17} />Launcher 平台管理员可查看；编辑、测试和切换默认值仅限 Admin Token。</div> : null}
      <div className="mih-agent-center-grid">
        <Panel title="Sequence 列表" subtitle="bootstrap 是部署时从旧全局链生成的兼容默认。"
          actions={canEdit ? <button className="qp-button qp-button--outline" type="button" disabled={Boolean(busy)} onClick={startNew}><Plus size={16} />新建</button> : null}>
          <div className="mih-agent-center-list">
            {sequences.map((sequence) => {
              const selected = sequence.sequenceKey === selectedKey
              const isDefault = bindings.some((binding: any) => binding.kind === sequence.kind && binding.sequenceKey === sequence.sequenceKey)
              return <button key={sequence.sequenceKey} type="button"
                className={`mih-agent-center-list__item${selected ? ' is-selected' : ''}`}
                disabled={Boolean(busy)}
                onClick={() => { setCreating(false); setSelectedKey(sequence.sequenceKey) }}>
                <span><strong>{sequence.displayName}</strong><code>{sequence.sequenceKey}</code></span>
                <span>
                  <StatusBadge status={sequence.enabled ? 'active' : 'disabled'} label={sequence.kind} />
                  {sequence.providerRevision !== Number(settings[sequence.kind]?.revision ?? 0)
                    ? <StatusBadge status="suspended" label="需重验" /> : null}
                  {isDefault ? <StatusBadge status="active" label="默认" /> : null}
                </span>
              </button>
            })}
            {sequences.length === 0 ? <p className="mih-agent-center-empty">尚无 Sequence；旧 Provider catalog 顺序仍作为兼容链。</p> : null}
          </div>
        </Panel>

        <Panel title={draft.revision ? '编辑 Sequence' : '新建 Sequence'}
          subtitle="只有左侧拖拽手柄会启动拖动；输入框和滚动条不会移动卡片。">
          <div className="mih-agent-center-form-grid">
            <Field label="Sequence Key" hint=""><input className="qp-input" value={draft.sequenceKey}
              disabled={!canEdit || Boolean(busy) || draft.revision > 0} placeholder="my-llm-sequence"
              onChange={(event) => setDraft({ ...draft, sequenceKey: event.target.value })} /></Field>
            <Field label="显示名称" hint=""><input className="qp-input" value={draft.displayName} disabled={!canEdit || Boolean(busy)}
              placeholder="My LLM Sequence" onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
            <DropdownField label="能力" value={draft.kind}
              onChange={(kind: string) => setDraft({ ...draft, kind: kind as 'chat' | 'embedding', providerIds: [], revision: 0, sequenceKey: draft.revision ? '' : draft.sequenceKey })}
              options={[{ value: 'chat', label: 'Chat / Agent' }, { value: 'embedding', label: 'Embedding' }] as never[]}
              disabled={!canEdit || Boolean(busy) || draft.revision > 0} />
            <label className="mih-agent-center-check"><input type="checkbox" checked={draft.enabled} disabled={!canEdit || Boolean(busy)}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用 Sequence</label>
          </div>

          <div className="mih-sequence-builder">
            <section>
              <h3>已保存 Provider</h3>
              <div className="mih-sequence-palette">
                {providers.map((provider) => (
                  <article key={provider.id} className="mih-sequence-provider">
                    <span className="mih-sequence-drag-handle" draggable={canEdit && !busy}
                      aria-hidden="true" title="拖入 Sequence"
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'copy'
                        event.dataTransfer.setData(PROVIDER_MIME, provider.id)
                      }}><DotsSixVertical size={19} /></span>
                    <span><strong>{provider.displayName || provider.id}</strong><code>{provider.id}</code><small>{provider.model} · {provider.protocol || 'openai-compatible'}</small></span>
                    <StatusBadge status={provider.keyConfigured === false ? 'suspended' : 'active'} label={provider.keyConfigured === false ? '缺 Key' : '可测试'} />
                  </article>
                ))}
                {providers.length === 0 ? <p className="mih-agent-center-empty">请先在 LLM Provider 保存至少一个启用配置。</p> : null}
              </div>
            </section>
            <section className="mih-sequence-dropzone"
              onDragOver={(event) => { if (!busy) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
              onDrop={(event) => { if (!busy) { event.preventDefault(); addProvider(event.dataTransfer.getData(PROVIDER_MIME)) } }}>
              <h3>请求顺序</h3>
              {draft.providerIds.map((providerId, index) => {
                const provider = providerById.get(providerId)
                return <article key={providerId} className="mih-sequence-step">
                  <strong>{index + 1}</strong>
                  <span><b>{provider?.displayName || providerId}</b><code>{providerId}</code></span>
                  <div>
                    <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label="上移" disabled={!canEdit || Boolean(busy) || index === 0}
                      onClick={() => setDraft({ ...draft, providerIds: move(draft.providerIds, index, index - 1) })}><ArrowUp size={15} /></button>
                    <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label="下移" disabled={!canEdit || Boolean(busy) || index === draft.providerIds.length - 1}
                      onClick={() => setDraft({ ...draft, providerIds: move(draft.providerIds, index, index + 1) })}><ArrowDown size={15} /></button>
                    <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label="移除" disabled={!canEdit || Boolean(busy)}
                      onClick={() => setDraft({ ...draft, providerIds: draft.providerIds.filter((id) => id !== providerId) })}><Trash size={15} /></button>
                  </div>
                </article>
              })}
              {draft.providerIds.length === 0 ? <p>把 Provider 的手柄拖到这里；也可使用下方按钮添加。</p> : null}
              <div className="mih-sequence-quick-add">
                {providers.filter((provider) => !draft.providerIds.includes(provider.id)).map((provider) => (
                  <button className="qp-button qp-button--ghost" type="button" key={provider.id} disabled={!canEdit || Boolean(busy)}
                    onClick={() => addProvider(provider.id)}><Plus size={14} />{provider.displayName || provider.id}</button>
                ))}
              </div>
            </section>
          </div>

          {error ? <>
            <ErrorState error={error} onRetry={undefined} />
            {error?.code === 'agent_providers_unavailable' || error?.code === 'agent_sequence_unavailable' ? (
              <div className="mih-agent-route-diagnostic">
                <strong>当前配置推导路由</strong>
                <p>{error?.code === 'agent_providers_unavailable'
                  ? 'Sequence 已开始调用，但所有 Provider 均未成功；transport failure 表示网络或代理传输失败，不是 Prompt 错误。'
                  : '当前草稿或已保存 Sequence 与 Provider revision 不一致，请先重新验证保存。'}</p>
                <ul>{routeNotes.map((note, index) => <li key={draft.providerIds[index]}><code>{note}</code></li>)}</ul>
                <a className="qp-button qp-button--outline" href="#/agent/proxies"><Globe size={16} />检查 Proxy 绑定</a>
              </div>
            ) : null}
          </> : null}
          {sample?.sequenceKey === draft.sequenceKey ? <div className="mih-agent-sequence-sample"><CheckCircle size={18} /><div><strong>say hi 返回示例</strong><p>{sample.result.sample || `${sample.result.dimensions} dimensions`}</p><small>{sample.result.providerId} · {sample.result.model} · {sample.result.latencyMs} ms</small></div></div> : null}
          <div className="mih-agent-center-actions">
            <button className="qp-button qp-button--primary" type="button" disabled={!canEdit || Boolean(busy)} onClick={() => save(false)}><FloppyDisk size={16} />{busy === 'save' ? '验证中' : '验证并保存'}</button>
            <button className="qp-button qp-button--outline" type="button" disabled={!canEdit || Boolean(busy)} onClick={() => save(true)}><CheckCircle size={16} />{busy === 'default' ? '验证中' : '保存并设为默认'}</button>
            <button className="qp-button qp-button--ghost" type="button" disabled={!canEdit || Boolean(busy)} onClick={sayHi}><Play size={16} />{busy === 'test' ? '测试中' : draftChanged ? '保存并 say hi' : 'say hi'}</button>
          </div>
        </Panel>
      </div>
    </>
  )
}

export function AgentProxyPage({ token, session, onUnauthorized, notify }: PageProps) {
  const load = useCallback(() => adminApi.agent(token), [token])
  const state = useRemoteData(load, onUnauthorized) as any
  const [endpointDraft, setEndpointDraft] = useState({ proxyKey: '', displayName: '', proxyUrl: '', enabled: true, revision: 0 })
  const [sequenceDraft, setSequenceDraft] = useState({ sequenceKey: '', displayName: '', proxyKeys: [] as string[], directFallback: true, enabled: true, revision: 0 })
  const [globalDraft, setGlobalDraft] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<any>(null)
  const canEdit = session?.kind === 'admin-token'
  const proxy = state.data?.control?.proxy || { endpoints: [], sequences: [], globalSequenceKey: null, revision: 0 }
  const endpoints = proxy.endpoints as ProxyEndpoint[]
  const sequences = proxy.sequences as ProxySequence[]
  const endpointById = useMemo(() => new Map(endpoints.map((endpoint) => [endpoint.proxyKey, endpoint])), [endpoints])
  const enabledEndpointCount = (sequence: ProxySequence) => sequence.proxyKeys
    .filter((proxyKey) => endpointById.get(proxyKey)?.enabled).length
  const currentGlobalSequence = sequences.find((sequence) => sequence.sequenceKey === proxy.globalSequenceKey)
  const endpointDraftReferences = sequences.filter((sequence) => sequence.proxyKeys.includes(endpointDraft.proxyKey))
  const providerRows = useMemo(() => (['chat', 'embedding'] as const).flatMap((kind) => (
    (state.data?.settings?.[kind]?.providers || []).map((provider: Provider) => ({ kind, provider }))
  )), [state.data])
  const sequenceDraftProviderRefs = providerRows.filter(({ provider }) => provider.proxySequenceKey === sequenceDraft.sequenceKey)
  const sequenceDraftReferenceLabels = [
    ...(proxy.globalSequenceKey === sequenceDraft.sequenceKey ? ['Hub 全局'] : []),
    ...sequenceDraftProviderRefs.map(({ kind, provider }) => `${kind}:${provider.displayName || provider.id}`),
  ]

  useEffect(() => setGlobalDraft(proxy.globalSequenceKey || ''), [proxy.globalSequenceKey])

  const newEndpoint = () => {
    setEndpointDraft({ proxyKey: '', displayName: '', proxyUrl: '', enabled: true, revision: 0 })
    setError(null)
  }

  const newProxySequence = () => {
    setSequenceDraft({ sequenceKey: '', displayName: '', proxyKeys: [], directFallback: true, enabled: true, revision: 0 })
    setError(null)
  }

  const saveEndpoint = async () => {
    if (!keyValid(endpointDraft.proxyKey) || !endpointDraft.displayName.trim() || !endpointDraft.proxyUrl.trim()) {
      setError(new Error('请填写合法 Proxy Key、名称和 URL。'))
      return
    }
    setBusy('endpoint')
    setError(null)
    const submitted = { ...endpointDraft }
    try {
      const saved = await adminApi.saveAgentProxyEndpoint(token, submitted.proxyKey, {
        expectedRevision: submitted.revision,
        displayName: submitted.displayName.trim(),
        proxyUrl: submitted.proxyUrl.trim(),
        enabled: submitted.enabled,
      })
      notify?.(`Proxy endpoint ${submitted.revision ? '已更新' : '已创建'}`, 'success')
      setEndpointDraft({
        proxyKey: saved.proxyKey,
        displayName: saved.displayName,
        proxyUrl: saved.proxyUrl,
        enabled: saved.enabled,
        revision: saved.revision,
      })
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally { setBusy('') }
  }

  const saveProxySequence = async (setGlobal: boolean) => {
    if (!keyValid(sequenceDraft.sequenceKey) || !sequenceDraft.displayName.trim()
      || sequenceDraft.proxyKeys.length === 0) {
      setError(new Error('请填写合法 Sequence，并至少加入一个 Proxy endpoint；仅直连请清除全局/Provider 绑定。'))
      return
    }
    if (!sequenceDraft.enabled && sequenceDraftReferenceLabels.length > 0) {
      setError(new Error(`请先解除 Proxy Sequence 绑定再停用：${sequenceDraftReferenceLabels.join('、')}`))
      return
    }
    setBusy(setGlobal ? 'global' : 'sequence')
    setError(null)
    const submitted = { ...sequenceDraft, proxyKeys: [...sequenceDraft.proxyKeys] }
    let saved: any = null
    try {
      saved = await adminApi.saveAgentProxySequence(token, submitted.sequenceKey, {
        expectedRevision: submitted.revision,
        displayName: submitted.displayName.trim(),
        proxyKeys: submitted.proxyKeys,
        directFallback: submitted.directFallback,
        enabled: submitted.enabled,
      })
      setSequenceDraft((current) => current.sequenceKey === submitted.sequenceKey
        ? { ...current, revision: saved.revision }
        : current)
      if (setGlobal) {
        await adminApi.setDefaultAgentProxySequence(token, {
          sequenceKey: saved.sequenceKey,
          expectedRevision: proxy.revision || 0,
        })
      }
      notify?.(setGlobal ? 'Proxy Sequence 已设为 Hub 全局默认' : 'Proxy Sequence 已保存', 'success')
      if (setGlobal) setGlobalDraft(saved.sequenceKey)
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
      if (saved) state.refresh()
    } finally { setBusy('') }
  }

  const addProxy = (proxyKey: string) => {
    if (busy || !endpointById.has(proxyKey) || sequenceDraft.proxyKeys.includes(proxyKey)) return
    setSequenceDraft({ ...sequenceDraft, proxyKeys: [...sequenceDraft.proxyKeys, proxyKey] })
  }

  const removeEndpoint = async (endpoint: ProxyEndpoint) => {
    const usedBy = sequences.filter((sequence) => sequence.proxyKeys.includes(endpoint.proxyKey))
    if (usedBy.length > 0) {
      setError(new Error(`请先从 Proxy Sequence 移除 ${endpoint.displayName}：${usedBy.map((item) => item.displayName).join('、')}`))
      return
    }
    if (!window.confirm(`删除 Proxy endpoint “${endpoint.displayName}”？`)) return
    setBusy(`delete-endpoint:${endpoint.proxyKey}`)
    setError(null)
    try {
      await adminApi.deleteAgentProxyEndpoint(token, endpoint.proxyKey, endpoint.revision)
      if (endpointDraft.proxyKey === endpoint.proxyKey) newEndpoint()
      notify?.('Proxy endpoint 已删除', 'success')
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally { setBusy('') }
  }

  const removeProxySequence = async (sequence: ProxySequence) => {
    const providerRefs = providerRows.filter(({ provider }) => provider.proxySequenceKey === sequence.sequenceKey)
    if (proxy.globalSequenceKey === sequence.sequenceKey || providerRefs.length > 0) {
      const refs = [
        ...(proxy.globalSequenceKey === sequence.sequenceKey ? ['Hub 全局'] : []),
        ...providerRefs.map(({ kind, provider }) => `${kind}:${provider.displayName || provider.id}`),
      ]
      setError(new Error(`请先解除 Proxy Sequence 绑定：${refs.join('、')}`))
      return
    }
    if (!window.confirm(`删除 Proxy Sequence “${sequence.displayName}”？`)) return
    setBusy(`delete-sequence:${sequence.sequenceKey}`)
    setError(null)
    try {
      await adminApi.deleteAgentProxySequence(token, sequence.sequenceKey, sequence.revision)
      if (sequenceDraft.sequenceKey === sequence.sequenceKey) newProxySequence()
      notify?.('Proxy Sequence 已删除', 'success')
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally { setBusy('') }
  }

  const saveGlobalBinding = async (sequenceKey = globalDraft) => {
    setBusy('global-binding')
    setError(null)
    try {
      await adminApi.setDefaultAgentProxySequence(token, {
        sequenceKey: sequenceKey || null,
        expectedRevision: proxy.revision || 0,
      })
      setGlobalDraft(sequenceKey)
      notify?.(sequenceKey ? 'Hub 全局 Proxy 绑定已更新' : 'Hub 全局 Proxy 已清除，恢复历史直连', 'success')
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally { setBusy('') }
  }

  const bindProvider = async (kind: 'chat' | 'embedding', providerId: string, sequenceKey: string) => {
    const setting = state.data?.settings?.[kind]
    if (setting?.source !== 'database') {
      setError(new Error(`${kind} Provider 仍由环境变量管理，请先在 LLM Provider 迁移为数据库配置。`))
      return
    }
    setBusy(`provider:${kind}:${providerId}`)
    setError(null)
    try {
      await adminApi.updateAgentProviders(token, kind, {
        expectedRevision: setting.revision,
        source: 'database',
        providers: setting.providers.map((provider: Provider) => ({
          ...publicProviderPayload(provider),
          proxySequenceKey: provider.id === providerId ? sequenceKey || null : provider.proxySequenceKey || null,
        })),
      })
      notify?.('Provider Proxy 绑定已更新；相关 LLM Sequence 需要重新验证', 'success')
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally { setBusy('') }
  }

  if (state.loading && !state.data) return <LoadingState label="正在读取 LLM Proxy" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  return (
    <>
      <PageHeading eyebrow="AGENT CENTER / PROXY SEQUENCES" title="LLM Proxy"
        description="Provider 可覆盖 Hub 全局 Proxy Sequence；每条代理链按序尝试，最后是否直连由显式开关决定。"
        loading={state.loading} onRefresh={state.refresh}><></></PageHeading>
      <div className="mih-inline-warning"><Warning size={17} />K8s 内的 127.0.0.1 指当前 Pod 网络命名空间。生产已让使用 Agent 的 worker 与 Admin 统一 hostNetwork；Compose 请使用 host.docker.internal。</div>
      {proxy.globalSequenceKey && (!currentGlobalSequence || currentGlobalSequence.enabled === false) ? (
        <div className="mih-inline-warning"><Warning size={17} />当前全局链 <code>{proxy.globalSequenceKey}</code> 已停用或缺失。Agent 代理路由将 fail-closed，不会绕过配置直连；请先重新启用该 Sequence，或改绑其他可用链。</div>
      ) : currentGlobalSequence && enabledEndpointCount(currentGlobalSequence) === 0 ? (
        <div className="mih-inline-warning"><Warning size={17} />当前全局链 <code>{currentGlobalSequence.sequenceKey}</code> 没有已启用的代理，不会使用任何 endpoint，也不会直连。请在下方启用并加入 endpoint 后保存。</div>
      ) : null}
      {error ? <ErrorState error={error} onRetry={undefined} /> : null}

      <Panel title="Proxy 绑定" subtitle="先把 endpoint 编入 Proxy Sequence，再绑定为 Hub 全局默认或某个 Provider 的专属出口。">
        <div className="mih-proxy-bindings">
          <section>
            <h3>Hub 全局默认</h3>
            <div className="mih-proxy-binding-control">
              <DropdownField label="全局 Proxy Sequence" value={globalDraft} disabled={!canEdit || Boolean(busy)}
                onChange={setGlobalDraft} options={[
                  { value: '', label: '不绑定 · 历史直连' },
                  ...sequences.filter((sequence) => sequence.enabled).map((sequence) => ({
                    value: sequence.sequenceKey,
                    label: sequence.displayName,
                    description: enabledEndpointCount(sequence)
                      ? `${enabledEndpointCount(sequence)} 个已启用 endpoint${sequence.directFallback ? ' + direct' : ''}`
                      : '没有已启用 endpoint，不能绑定',
                    disabled: enabledEndpointCount(sequence) === 0,
                  })),
                ] as never[]} />
              <button className="qp-button qp-button--primary" type="button" disabled={!canEdit || Boolean(busy) || globalDraft === (proxy.globalSequenceKey || '')}
                onClick={() => saveGlobalBinding()}><Globe size={16} />保存全局绑定</button>
            </div>
          </section>
          <section>
            <h3>Provider 专属绑定</h3>
            <div className="mih-proxy-provider-bindings">
              {providerRows.map(({ kind, provider }) => (
                <div key={`${kind}:${provider.id}`}>
                  <span><strong>{provider.displayName || provider.id}</strong><small>{kind} · <code>{provider.id}</code></small></span>
                  <DropdownField label="Proxy Sequence" value={provider.proxySequenceKey || ''}
                    disabled={!canEdit || Boolean(busy) || state.data?.settings?.[kind]?.source !== 'database'}
                    onChange={(sequenceKey: string) => bindProvider(kind, provider.id, sequenceKey)}
                    options={[
                      { value: '', label: '继承 Hub 全局' },
                      ...sequences.filter((sequence) => sequence.enabled).map((sequence) => ({
                        value: sequence.sequenceKey,
                        label: sequence.displayName,
                        description: enabledEndpointCount(sequence)
                          ? `${enabledEndpointCount(sequence)} 个已启用 endpoint`
                          : '没有已启用 endpoint，不能绑定',
                        disabled: enabledEndpointCount(sequence) === 0,
                      })),
                    ] as never[]} />
                </div>
              ))}
              {providerRows.length === 0 ? <p className="mih-agent-center-empty">尚无 Provider；请先到 LLM Provider 新建。</p> : null}
            </div>
          </section>
        </div>
      </Panel>

      <div className="mih-agent-center-grid mih-agent-center-grid--proxy">
        <Panel title="Proxy endpoints" subtitle="URL 不允许携带账号密码；被 Sequence 引用时必须先解绑。"
          actions={canEdit ? <button className="qp-button qp-button--outline" type="button" disabled={Boolean(busy)} onClick={newEndpoint}><Plus size={16} />新建 endpoint</button> : null}>
          <div className="mih-agent-crud-list">
            {endpoints.map((endpoint) => {
              const usedBy = sequences.filter((sequence) => sequence.proxyKeys.includes(endpoint.proxyKey))
              return <article key={endpoint.proxyKey} className={`mih-agent-crud-row${endpointDraft.proxyKey === endpoint.proxyKey ? ' is-selected' : ''}`}>
                <span><strong>{endpoint.displayName}</strong><code>{endpoint.proxyKey}</code><small>{endpoint.proxyUrl}</small></span>
                <span><StatusBadge status={endpoint.enabled ? 'active' : 'disabled'} label={endpoint.enabled ? '启用' : '停用'} /><small>{usedBy.length ? `${usedBy.length} 个 Sequence 引用` : '未引用'}</small></span>
                <div>
                  <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`编辑 ${endpoint.displayName}`} disabled={!canEdit || Boolean(busy)} onClick={() => { setEndpointDraft({ ...endpoint }); setError(null) }}><PencilSimple size={16} /></button>
                  <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`删除 ${endpoint.displayName}`} disabled={!canEdit || Boolean(busy)} onClick={() => removeEndpoint(endpoint)}><Trash size={16} /></button>
                </div>
              </article>
            })}
            {endpoints.length === 0 ? <p className="mih-agent-center-empty">尚无 Proxy endpoint。</p> : null}
          </div>
          <div className="mih-agent-center-editor">
            <h3>{endpointDraft.revision ? `编辑 ${endpointDraft.displayName}` : '新建 Proxy endpoint'}</h3>
            <div className="mih-agent-center-form-grid">
            <Field label="Proxy Key" hint=""><input className="qp-input" value={endpointDraft.proxyKey} disabled={!canEdit || Boolean(busy) || endpointDraft.revision > 0} placeholder="host-7890" onChange={(event) => setEndpointDraft({ ...endpointDraft, proxyKey: event.target.value })} /></Field>
            <Field label="显示名称" hint=""><input className="qp-input" value={endpointDraft.displayName} disabled={!canEdit || Boolean(busy)} placeholder="Host Proxy 7890" onChange={(event) => setEndpointDraft({ ...endpointDraft, displayName: event.target.value })} /></Field>
            <Field label="Proxy URL" hint=""><input className="qp-input" value={endpointDraft.proxyUrl} disabled={!canEdit || Boolean(busy)} placeholder="http://127.0.0.1:7890" onChange={(event) => setEndpointDraft({ ...endpointDraft, proxyUrl: event.target.value })} /></Field>
            <label className="mih-agent-center-check"><input type="checkbox" checked={endpointDraft.enabled}
              disabled={!canEdit || Boolean(busy) || (endpointDraft.enabled && endpointDraftReferences.length > 0)}
              onChange={(event) => setEndpointDraft({ ...endpointDraft, enabled: event.target.checked })} />启用 endpoint</label>
            </div>
            {endpointDraft.enabled && endpointDraftReferences.length > 0 ? <p className="mih-agent-center-empty">该 endpoint 被 {endpointDraftReferences.map((sequence) => sequence.displayName).join('、')} 引用；请先从这些 Sequence 移除后再停用。</p> : null}
            <div className="mih-agent-center-actions">
              <button className="qp-button qp-button--primary" type="button" disabled={!canEdit || Boolean(busy)} onClick={saveEndpoint}><FloppyDisk size={16} />{endpointDraft.revision ? '保存修改' : '创建 endpoint'}</button>
              {endpointDraft.revision ? <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busy)} onClick={newEndpoint}>取消编辑</button> : null}
            </div>
          </div>
        </Panel>

        <Panel title="Proxy Sequence" subtitle="按序组合 endpoint；全局和 Provider 只绑定 Sequence。"
          actions={canEdit ? <button className="qp-button qp-button--outline" type="button" disabled={Boolean(busy)} onClick={newProxySequence}><Plus size={16} />新建 Sequence</button> : null}>
          <div className="mih-agent-crud-list mih-proxy-sequence-list">
            {sequences.map((sequence) => {
              const providerRefs = providerRows.filter(({ provider }) => provider.proxySequenceKey === sequence.sequenceKey)
              const isGlobal = proxy.globalSequenceKey === sequence.sequenceKey
              return <article key={sequence.sequenceKey} className={`mih-agent-crud-row${sequenceDraft.sequenceKey === sequence.sequenceKey ? ' is-selected' : ''}`}>
                <span><strong>{sequence.displayName}</strong><code>{sequence.sequenceKey}</code><small>{enabledEndpointCount(sequence)} enabled / {sequence.proxyKeys.length} total{sequence.directFallback ? ' + direct' : ''}</small></span>
                <span>{isGlobal ? <StatusBadge status="active" label="全局" /> : null}<StatusBadge status={sequence.enabled ? 'active' : 'disabled'} label={sequence.enabled ? '启用' : '停用'} /><small>{providerRefs.length ? `${providerRefs.length} 个 Provider 绑定` : '无专属绑定'}</small></span>
                <div>
                  <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`编辑 ${sequence.displayName}`} disabled={!canEdit || Boolean(busy)} onClick={() => { setSequenceDraft({ ...sequence }); setError(null) }}><PencilSimple size={16} /></button>
                  <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`删除 ${sequence.displayName}`} disabled={!canEdit || Boolean(busy)} onClick={() => removeProxySequence(sequence)}><Trash size={16} /></button>
                </div>
              </article>
            })}
            {sequences.length === 0 ? <p className="mih-agent-center-empty">尚无 Proxy Sequence。</p> : null}
          </div>
          <div className="mih-agent-center-editor">
            <h3>{sequenceDraft.revision ? `编辑 ${sequenceDraft.displayName}` : '新建 Proxy Sequence'}</h3>
            <div className="mih-agent-center-form-grid">
            <Field label="Sequence Key" hint=""><input className="qp-input" value={sequenceDraft.sequenceKey} disabled={!canEdit || Boolean(busy) || sequenceDraft.revision > 0} placeholder="agent-proxy-primary" onChange={(event) => setSequenceDraft({ ...sequenceDraft, sequenceKey: event.target.value })} /></Field>
            <Field label="显示名称" hint=""><input className="qp-input" value={sequenceDraft.displayName} disabled={!canEdit || Boolean(busy)} placeholder="Agent Proxy Sequence" onChange={(event) => setSequenceDraft({ ...sequenceDraft, displayName: event.target.value })} /></Field>
            <label className="mih-agent-center-check"><input type="checkbox" checked={sequenceDraft.directFallback} disabled={!canEdit || Boolean(busy)} onChange={(event) => setSequenceDraft({ ...sequenceDraft, directFallback: event.target.checked })} />末尾允许直连 fallback</label>
            <label className="mih-agent-center-check"><input type="checkbox" checked={sequenceDraft.enabled}
              disabled={!canEdit || Boolean(busy) || (sequenceDraft.enabled && sequenceDraftReferenceLabels.length > 0)}
              onChange={(event) => setSequenceDraft({ ...sequenceDraft, enabled: event.target.checked })} />启用 Sequence</label>
            </div>
            {sequenceDraft.enabled && sequenceDraftReferenceLabels.length > 0 ? <p className="mih-agent-center-empty">该 Sequence 被 {sequenceDraftReferenceLabels.join('、')} 引用；请先解除绑定后再停用。</p> : null}
            <div className="mih-proxy-builder">
            <div className="mih-sequence-palette">
              {endpoints.filter((endpoint) => endpoint.enabled).map((endpoint) => <article key={endpoint.proxyKey} className="mih-sequence-provider">
                <span className="mih-sequence-drag-handle" draggable={canEdit && !busy} aria-hidden="true" title="拖入 Proxy Sequence"
                  onDragStart={(event: DragEvent<HTMLElement>) => { event.dataTransfer.setData(PROXY_MIME, endpoint.proxyKey); event.dataTransfer.effectAllowed = 'copy' }}><DotsSixVertical size={19} /></span>
                <span><strong>{endpoint.displayName}</strong><code>{endpoint.proxyKey}</code><small>{endpoint.proxyUrl}</small></span>
                <button className="qp-button qp-button--ghost" type="button" disabled={!canEdit || Boolean(busy) || sequenceDraft.proxyKeys.includes(endpoint.proxyKey)} onClick={() => addProxy(endpoint.proxyKey)}><Plus size={14} />加入</button>
              </article>)}
            </div>
            <div className="mih-sequence-dropzone" onDragOver={(event) => { if (!busy) event.preventDefault() }}
              onDrop={(event) => { if (!busy) { event.preventDefault(); addProxy(event.dataTransfer.getData(PROXY_MIME)) } }}>
              {sequenceDraft.proxyKeys.map((proxyKey, index) => <article className="mih-sequence-step" key={proxyKey}>
                <strong>{index + 1}</strong><span><b>{endpointById.get(proxyKey)?.displayName || proxyKey}</b><code>{proxyKey}</code></span>
                <div><button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`上移 ${endpointById.get(proxyKey)?.displayName || proxyKey}`} disabled={!canEdit || Boolean(busy) || index === 0} onClick={() => setSequenceDraft({ ...sequenceDraft, proxyKeys: move(sequenceDraft.proxyKeys, index, index - 1) })}><ArrowUp size={15} /></button>
                  <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`下移 ${endpointById.get(proxyKey)?.displayName || proxyKey}`} disabled={!canEdit || Boolean(busy) || index === sequenceDraft.proxyKeys.length - 1} onClick={() => setSequenceDraft({ ...sequenceDraft, proxyKeys: move(sequenceDraft.proxyKeys, index, index + 1) })}><ArrowDown size={15} /></button>
                  <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`移除 ${endpointById.get(proxyKey)?.displayName || proxyKey}`} disabled={!canEdit || Boolean(busy)} onClick={() => setSequenceDraft({ ...sequenceDraft, proxyKeys: sequenceDraft.proxyKeys.filter((key) => key !== proxyKey) })}><Trash size={15} /></button></div>
              </article>)}
              {sequenceDraft.proxyKeys.length === 0 ? <p>拖入至少一个代理。只需要直连时不要创建 Proxy Sequence，清除绑定即可。</p> : null}
            </div>
            </div>
            <div className="mih-agent-center-actions">
              <button className="qp-button qp-button--primary" type="button" disabled={!canEdit || Boolean(busy)} onClick={() => saveProxySequence(false)}><FloppyDisk size={16} />{sequenceDraft.revision ? '保存修改' : '创建 Sequence'}</button>
              <button className="qp-button qp-button--outline" type="button" disabled={!canEdit || Boolean(busy)} onClick={() => saveProxySequence(true)}><Globe size={16} />保存并设为全局</button>
              {sequenceDraft.revision ? <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busy)} onClick={newProxySequence}>取消编辑</button> : null}
            </div>
          </div>
        </Panel>
      </div>
    </>
  )
}
