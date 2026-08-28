import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Brain,
  CheckCircle,
  DotsSixVertical,
  FloppyDisk,
  Globe,
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
  model: string
  protocol?: string
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
    if (!providerById.has(providerId) || draft.providerIds.includes(providerId)) return
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
    try {
      const saved = await adminApi.saveAgentSequence(token, draft.sequenceKey, {
        expectedRevision: draft.revision,
        displayName: draft.displayName.trim(),
        kind: draft.kind,
        providerIds: draft.providerIds,
        enabled: draft.enabled,
      })
      if (setDefault) {
        await adminApi.setDefaultAgentSequence(token, draft.sequenceKey, {
          kind: draft.kind,
          expectedRevision: defaultBinding?.revision || 0,
        })
      }
      setCreating(false)
      setSelectedKey(saved.sequenceKey)
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
    } finally {
      setBusy('')
    }
  }

  const sayHi = async () => {
    setBusy('test')
    setError(null)
    try {
      const result = await adminApi.testAgentSequence(token, draft.sequenceKey, draft.kind)
      setSample(result)
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
          actions={canEdit ? <button className="qp-button qp-button--outline" type="button" onClick={startNew}><Plus size={16} />新建</button> : null}>
          <div className="mih-agent-center-list">
            {sequences.map((sequence) => {
              const selected = sequence.sequenceKey === selectedKey
              const isDefault = bindings.some((binding: any) => binding.kind === sequence.kind && binding.sequenceKey === sequence.sequenceKey)
              return <button key={sequence.sequenceKey} type="button"
                className={`mih-agent-center-list__item${selected ? ' is-selected' : ''}`}
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
              disabled={!canEdit || draft.revision > 0} placeholder="my-llm-sequence"
              onChange={(event) => setDraft({ ...draft, sequenceKey: event.target.value })} /></Field>
            <Field label="显示名称" hint=""><input className="qp-input" value={draft.displayName} disabled={!canEdit}
              placeholder="My LLM Sequence" onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
            <DropdownField label="能力" value={draft.kind}
              onChange={(kind: string) => setDraft({ ...draft, kind: kind as 'chat' | 'embedding', providerIds: [], revision: 0, sequenceKey: draft.revision ? '' : draft.sequenceKey })}
              options={[{ value: 'chat', label: 'Chat / Agent' }, { value: 'embedding', label: 'Embedding' }] as never[]}
              disabled={!canEdit || draft.revision > 0} />
            <label className="mih-agent-center-check"><input type="checkbox" checked={draft.enabled} disabled={!canEdit}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用 Sequence</label>
          </div>

          <div className="mih-sequence-builder">
            <section>
              <h3>已保存 Provider</h3>
              <div className="mih-sequence-palette">
                {providers.map((provider) => (
                  <article key={provider.id} className="mih-sequence-provider">
                    <span className="mih-sequence-drag-handle" draggable={canEdit}
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
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
              onDrop={(event) => { event.preventDefault(); addProvider(event.dataTransfer.getData(PROVIDER_MIME)) }}>
              <h3>请求顺序</h3>
              {draft.providerIds.map((providerId, index) => {
                const provider = providerById.get(providerId)
                return <article key={providerId} className="mih-sequence-step">
                  <strong>{index + 1}</strong>
                  <span><b>{provider?.displayName || providerId}</b><code>{providerId}</code></span>
                  <div>
                    <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label="上移" disabled={!canEdit || index === 0}
                      onClick={() => setDraft({ ...draft, providerIds: move(draft.providerIds, index, index - 1) })}><ArrowUp size={15} /></button>
                    <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label="下移" disabled={!canEdit || index === draft.providerIds.length - 1}
                      onClick={() => setDraft({ ...draft, providerIds: move(draft.providerIds, index, index + 1) })}><ArrowDown size={15} /></button>
                    <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label="移除" disabled={!canEdit}
                      onClick={() => setDraft({ ...draft, providerIds: draft.providerIds.filter((id) => id !== providerId) })}><Trash size={15} /></button>
                  </div>
                </article>
              })}
              {draft.providerIds.length === 0 ? <p>把 Provider 的手柄拖到这里；也可使用下方按钮添加。</p> : null}
              <div className="mih-sequence-quick-add">
                {providers.filter((provider) => !draft.providerIds.includes(provider.id)).map((provider) => (
                  <button className="qp-button qp-button--ghost" type="button" key={provider.id} disabled={!canEdit}
                    onClick={() => addProvider(provider.id)}><Plus size={14} />{provider.displayName || provider.id}</button>
                ))}
              </div>
            </section>
          </div>

          {error ? <ErrorState error={error} onRetry={undefined} /> : null}
          {sample ? <div className="mih-agent-sequence-sample"><CheckCircle size={18} /><div><strong>say hi 返回示例</strong><p>{sample.sample || `${sample.dimensions} dimensions`}</p><small>{sample.providerId} · {sample.model} · {sample.latencyMs} ms</small></div></div> : null}
          <div className="mih-agent-center-actions">
            <button className="qp-button qp-button--primary" type="button" disabled={!canEdit || Boolean(busy)} onClick={() => save(false)}><FloppyDisk size={16} />{busy === 'save' ? '验证中' : '验证并保存'}</button>
            <button className="qp-button qp-button--outline" type="button" disabled={!canEdit || Boolean(busy)} onClick={() => save(true)}><CheckCircle size={16} />{busy === 'default' ? '验证中' : '保存并设为默认'}</button>
            <button className="qp-button qp-button--ghost" type="button" disabled={!canEdit || !draft.revision || Boolean(busy)} onClick={sayHi}><Play size={16} />{busy === 'test' ? '测试中' : 'say hi'}</button>
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
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<any>(null)
  const canEdit = session?.kind === 'admin-token'
  const proxy = state.data?.control?.proxy || { endpoints: [], sequences: [], globalSequenceKey: null, revision: 0 }
  const endpoints = proxy.endpoints as ProxyEndpoint[]
  const sequences = proxy.sequences as ProxySequence[]
  const endpointById = useMemo(() => new Map(endpoints.map((endpoint) => [endpoint.proxyKey, endpoint])), [endpoints])

  const saveEndpoint = async () => {
    if (!keyValid(endpointDraft.proxyKey) || !endpointDraft.displayName.trim() || !endpointDraft.proxyUrl.trim()) {
      setError(new Error('请填写合法 Proxy Key、名称和 URL。'))
      return
    }
    setBusy('endpoint')
    setError(null)
    try {
      await adminApi.saveAgentProxyEndpoint(token, endpointDraft.proxyKey, {
        expectedRevision: endpointDraft.revision,
        displayName: endpointDraft.displayName.trim(),
        proxyUrl: endpointDraft.proxyUrl.trim(),
        enabled: endpointDraft.enabled,
      })
      notify?.('Proxy endpoint 已保存', 'success')
      setEndpointDraft({ proxyKey: '', displayName: '', proxyUrl: '', enabled: true, revision: 0 })
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally { setBusy('') }
  }

  const saveProxySequence = async (setGlobal: boolean) => {
    if (!keyValid(sequenceDraft.sequenceKey) || !sequenceDraft.displayName.trim()
      || (sequenceDraft.proxyKeys.length === 0 && !sequenceDraft.directFallback)) {
      setError(new Error('请填写合法 Sequence，并至少保留一个 Proxy 或直连 fallback。'))
      return
    }
    setBusy(setGlobal ? 'global' : 'sequence')
    setError(null)
    try {
      const saved = await adminApi.saveAgentProxySequence(token, sequenceDraft.sequenceKey, {
        expectedRevision: sequenceDraft.revision,
        displayName: sequenceDraft.displayName.trim(),
        proxyKeys: sequenceDraft.proxyKeys,
        directFallback: sequenceDraft.directFallback,
        enabled: sequenceDraft.enabled,
      })
      if (setGlobal) {
        await adminApi.setDefaultAgentProxySequence(token, {
          sequenceKey: saved.sequenceKey,
          expectedRevision: proxy.revision || 0,
        })
      }
      notify?.(setGlobal ? 'Proxy Sequence 已设为 Hub 全局默认' : 'Proxy Sequence 已保存', 'success')
      setSequenceDraft({ ...sequenceDraft, revision: saved.revision })
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally { setBusy('') }
  }

  const addProxy = (proxyKey: string) => {
    if (!endpointById.has(proxyKey) || sequenceDraft.proxyKeys.includes(proxyKey)) return
    setSequenceDraft({ ...sequenceDraft, proxyKeys: [...sequenceDraft.proxyKeys, proxyKey] })
  }

  if (state.loading && !state.data) return <LoadingState label="正在读取 LLM Proxy" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  return (
    <>
      <PageHeading eyebrow="AGENT CENTER / PROXY SEQUENCES" title="LLM Proxy"
        description="Provider 可覆盖 Hub 全局 Proxy Sequence；每条代理链按序尝试，最后是否直连由显式开关决定。"
        loading={state.loading} onRefresh={state.refresh}><></></PageHeading>
      <div className="mih-inline-warning"><Warning size={17} />K8s 内的 127.0.0.1 指当前 Pod 网络命名空间。生产已让使用 Agent 的 worker 与 Admin 统一 hostNetwork；Compose 请使用 host.docker.internal。</div>
      <div className="mih-agent-center-grid mih-agent-center-grid--proxy">
        <Panel title="Proxy endpoints" subtitle="URL 不允许携带账号密码；密钥型代理后续使用独立凭据表。">
          <div className="mih-agent-center-list">
            {endpoints.map((endpoint) => <button type="button" key={endpoint.proxyKey} className="mih-agent-center-list__item"
              onClick={() => setEndpointDraft({ ...endpoint })}>
              <span><strong>{endpoint.displayName}</strong><code>{endpoint.proxyKey}</code><small>{endpoint.proxyUrl}</small></span>
              <StatusBadge status={endpoint.enabled ? 'active' : 'disabled'} label={endpoint.enabled ? '启用' : '停用'} />
            </button>)}
          </div>
          <div className="mih-agent-center-form-grid">
            <Field label="Proxy Key" hint=""><input className="qp-input" value={endpointDraft.proxyKey} disabled={!canEdit || endpointDraft.revision > 0} placeholder="host-7890" onChange={(event) => setEndpointDraft({ ...endpointDraft, proxyKey: event.target.value })} /></Field>
            <Field label="显示名称" hint=""><input className="qp-input" value={endpointDraft.displayName} disabled={!canEdit} placeholder="Host Proxy 7890" onChange={(event) => setEndpointDraft({ ...endpointDraft, displayName: event.target.value })} /></Field>
            <Field label="Proxy URL" hint=""><input className="qp-input" value={endpointDraft.proxyUrl} disabled={!canEdit} placeholder="http://127.0.0.1:7890" onChange={(event) => setEndpointDraft({ ...endpointDraft, proxyUrl: event.target.value })} /></Field>
            <label className="mih-agent-center-check"><input type="checkbox" checked={endpointDraft.enabled} disabled={!canEdit} onChange={(event) => setEndpointDraft({ ...endpointDraft, enabled: event.target.checked })} />启用 endpoint</label>
          </div>
          <button className="qp-button qp-button--primary" type="button" disabled={!canEdit || Boolean(busy)} onClick={saveEndpoint}><FloppyDisk size={16} />保存 endpoint</button>
        </Panel>

        <Panel title="Proxy Sequence" subtitle="Provider 未指定代理链时使用全局默认；指定后优先使用自己的链。">
          <div className="mih-agent-center-list mih-proxy-sequence-list">
            {sequences.map((sequence) => <button type="button" key={sequence.sequenceKey} className="mih-agent-center-list__item"
              onClick={() => setSequenceDraft({ ...sequence })}>
              <span><strong>{sequence.displayName}</strong><code>{sequence.sequenceKey}</code></span>
              <span>{proxy.globalSequenceKey === sequence.sequenceKey ? <StatusBadge status="active" label="全局" /> : null}<small>{sequence.proxyKeys.length} proxies{sequence.directFallback ? ' + direct' : ''}</small></span>
            </button>)}
          </div>
          <div className="mih-agent-center-form-grid">
            <Field label="Sequence Key" hint=""><input className="qp-input" value={sequenceDraft.sequenceKey} disabled={!canEdit || sequenceDraft.revision > 0} placeholder="agent-proxy-primary" onChange={(event) => setSequenceDraft({ ...sequenceDraft, sequenceKey: event.target.value })} /></Field>
            <Field label="显示名称" hint=""><input className="qp-input" value={sequenceDraft.displayName} disabled={!canEdit} placeholder="Agent Proxy Sequence" onChange={(event) => setSequenceDraft({ ...sequenceDraft, displayName: event.target.value })} /></Field>
            <label className="mih-agent-center-check"><input type="checkbox" checked={sequenceDraft.directFallback} disabled={!canEdit} onChange={(event) => setSequenceDraft({ ...sequenceDraft, directFallback: event.target.checked })} />末尾允许直连 fallback</label>
            <label className="mih-agent-center-check"><input type="checkbox" checked={sequenceDraft.enabled} disabled={!canEdit} onChange={(event) => setSequenceDraft({ ...sequenceDraft, enabled: event.target.checked })} />启用 Sequence</label>
          </div>
          <div className="mih-proxy-builder">
            <div className="mih-sequence-palette">
              {endpoints.filter((endpoint) => endpoint.enabled).map((endpoint) => <article key={endpoint.proxyKey} className="mih-sequence-provider">
                <span className="mih-sequence-drag-handle" draggable={canEdit} aria-hidden="true" title="拖入 Proxy Sequence"
                  onDragStart={(event: DragEvent<HTMLElement>) => { event.dataTransfer.setData(PROXY_MIME, endpoint.proxyKey); event.dataTransfer.effectAllowed = 'copy' }}><DotsSixVertical size={19} /></span>
                <span><strong>{endpoint.displayName}</strong><code>{endpoint.proxyKey}</code><small>{endpoint.proxyUrl}</small></span>
                <button className="qp-button qp-button--ghost" type="button" disabled={!canEdit || sequenceDraft.proxyKeys.includes(endpoint.proxyKey)} onClick={() => addProxy(endpoint.proxyKey)}><Plus size={14} />加入</button>
              </article>)}
            </div>
            <div className="mih-sequence-dropzone" onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); addProxy(event.dataTransfer.getData(PROXY_MIME)) }}>
              {sequenceDraft.proxyKeys.map((proxyKey, index) => <article className="mih-sequence-step" key={proxyKey}>
                <strong>{index + 1}</strong><span><b>{endpointById.get(proxyKey)?.displayName || proxyKey}</b><code>{proxyKey}</code></span>
                <div><button className="qp-button qp-button--ghost qp-icon-button" type="button" disabled={!canEdit || index === 0} onClick={() => setSequenceDraft({ ...sequenceDraft, proxyKeys: move(sequenceDraft.proxyKeys, index, index - 1) })}><ArrowUp size={15} /></button>
                  <button className="qp-button qp-button--ghost qp-icon-button" type="button" disabled={!canEdit || index === sequenceDraft.proxyKeys.length - 1} onClick={() => setSequenceDraft({ ...sequenceDraft, proxyKeys: move(sequenceDraft.proxyKeys, index, index + 1) })}><ArrowDown size={15} /></button>
                  <button className="qp-button qp-button--ghost qp-icon-button" type="button" disabled={!canEdit} onClick={() => setSequenceDraft({ ...sequenceDraft, proxyKeys: sequenceDraft.proxyKeys.filter((key) => key !== proxyKey) })}><Trash size={15} /></button></div>
              </article>)}
              {sequenceDraft.proxyKeys.length === 0 ? <p>拖入一个或多个代理；若只需要直连，可保留 direct fallback。</p> : null}
            </div>
          </div>
          {error ? <ErrorState error={error} onRetry={undefined} /> : null}
          <div className="mih-agent-center-actions">
            <button className="qp-button qp-button--primary" type="button" disabled={!canEdit || Boolean(busy)} onClick={() => saveProxySequence(false)}><FloppyDisk size={16} />保存 Sequence</button>
            <button className="qp-button qp-button--outline" type="button" disabled={!canEdit || Boolean(busy)} onClick={() => saveProxySequence(true)}><Globe size={16} />保存并设为全局</button>
          </div>
        </Panel>
      </div>
    </>
  )
}
