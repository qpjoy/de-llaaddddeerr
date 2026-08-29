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
  ConfirmDialog,
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
  connectionReady?: boolean
  keyConfigured?: boolean
  connection?:
    | { mode: 'dedicated' }
    | { mode: 'inherit-chat', providerId: string }
  embeddingCapability?: {
    status: 'supported' | 'unsupported' | 'probe-required'
    reason?: string
  }
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
  egressMode?: EgressMode
  proxySequenceKey?: string | null
  verifiedProxyFingerprint?: string | null
  routeProofValid?: boolean
  needsRevalidation?: boolean
  routeProofStatus?: 'valid' | 'missing-proof' | 'provider-revision-changed' | 'provider-unavailable' | 'route-changed'
}

type EgressMode = 'inherit' | 'system-egress' | 'proxy-sequence'

type RuntimeProxyObservation = {
  configured?: boolean
  sourceKind?: string
  runtimeKind?: string
  httpProxy?: string | null
  httpsProxy?: string | null
  noProxy?: string | null
  httpProxyCredentials?: boolean
  httpsProxyCredentials?: boolean
  sourceLocations?: string[]
  nodeName?: string | null
  observedAt?: string | null
}

type RuntimeEgressPolicy = {
  egressMode?: EgressMode
  mode?: EgressMode
  sequenceKey?: string | null
  revision?: number
}

type RuntimeEgressEvidence = {
  observed?: RuntimeProxyObservation
  baseline?: RuntimeProxyObservation
  policy?: RuntimeEgressPolicy
  effective?: Record<string, unknown>
  precedence?: Array<Record<string, unknown>>
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

type ProxyDeleteTarget =
  | { kind: 'endpoint', item: ProxyEndpoint }
  | { kind: 'sequence', item: ProxySequence }

const PROVIDER_MIME = 'application/x-mx-insight-provider'
const PROXY_ENDPOINT_MIME = 'application/x-mx-insight-proxy-endpoint'
const PROXY_STEP_MIME = 'application/x-mx-insight-proxy-step'
const INHERIT_EGRESS_ROUTE = 'inherit:'
const SYSTEM_EGRESS_ROUTE = 'system-egress:'

function egressModeOf(value: { egressMode?: EgressMode, mode?: EgressMode, proxySequenceKey?: string | null } | null | undefined): EgressMode {
  const explicit = value?.egressMode || value?.mode
  if (explicit === 'inherit' || explicit === 'system-egress' || explicit === 'proxy-sequence') return explicit
  if (value?.proxySequenceKey) return 'proxy-sequence'
  return 'inherit'
}

function egressModeLabel(mode: EgressMode) {
  if (mode === 'system-egress') return 'Pod / Node 系统出网'
  if (mode === 'proxy-sequence') return 'Proxy Sequence'
  return '继承部署默认（Docker daemon）'
}

function evidenceText(value: unknown, fallback: unknown = '未报告') {
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : String(fallback)
  if (value == null || value === '') return String(fallback)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function proxyPairText(httpProxy: unknown, httpsProxy: unknown, fallback = '未配置') {
  const http = httpProxy == null || httpProxy === '' ? null : String(httpProxy)
  const https = httpsProxy == null || httpsProxy === '' ? null : String(httpsProxy)
  if (http && https && http === https) return `HTTP / HTTPS = ${http}`
  return [https ? `HTTPS = ${https}` : null, http ? `HTTP = ${http}` : null]
    .filter(Boolean)
    .join(' · ') || fallback
}

function hasDragType(event: DragEvent<HTMLElement>, mime: string) {
  return Array.from(event.dataTransfer.types).includes(mime)
}

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

function sequenceNeedsRevalidation(sequence: LlmSequence | undefined, settings: any) {
  if (!sequence) return false
  // The server evaluates the current effective egress route, including the
  // deployment-observed Docker daemon proxy. Prefer that authoritative result
  // over reconstructing a route fingerprint in the browser.
  if (typeof sequence.needsRevalidation === 'boolean') return sequence.needsRevalidation
  if (sequence.routeProofValid === false) return true
  return sequence.providerRevision !== Number(settings?.[sequence.kind]?.revision ?? 0)
    || !sequence.verifiedProxyFingerprint
}

function publicProviderPayload(provider: Provider) {
  if (provider.connection?.mode === 'inherit-chat') {
    return {
      id: provider.id,
      displayName: provider.displayName || provider.id,
      model: provider.model,
      ...(provider.dimensions ? { dimensions: provider.dimensions } : {}),
      enabled: provider.enabled !== false,
      priority: provider.priority ?? 0,
      connection: provider.connection,
    }
  }
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
    ...(provider.dimensions ? { connection: { mode: 'dedicated' as const } } : {}),
  }
}

function providerOwnsProxyBinding(provider: Provider) {
  return provider.connection?.mode !== 'inherit-chat'
}

export function AgentSequencePage({ token, session, onUnauthorized, notify }: PageProps) {
  const load = useCallback(() => adminApi.agent(token), [token])
  const state = useRemoteData(load, onUnauthorized) as any
  const [selectedKey, setSelectedKey] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({
    sequenceKey: '', displayName: '', kind: 'chat' as 'chat' | 'embedding',
    providerIds: [] as string[], egressMode: 'inherit' as EgressMode,
    proxySequenceKey: null as string | null, enabled: true, revision: 0,
  })
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<any>(null)
  const [sample, setSample] = useState<any>(null)
  const [clearDefaultKind, setClearDefaultKind] = useState<'chat' | 'embedding' | null>(null)
  const canEdit = session?.kind === 'admin-token'

  const sequences = (state.data?.control?.sequences || []) as LlmSequence[]
  const bindings = state.data?.control?.bindings || []
  const settings = state.data?.settings || {}
  const providers = useMemo<Provider[]>(() => (
    (settings[draft.kind]?.providers || [])
      .filter((provider: Provider) => provider.enabled !== false && provider.connectionReady !== false)
  ), [draft.kind, settings])
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers])
  const defaultBinding = bindings.find((binding: any) => binding.kind === draft.kind)
  const persistedSequence = sequences.find((sequence) => sequence.sequenceKey === draft.sequenceKey)
  const needsRevalidation = sequenceNeedsRevalidation(persistedSequence, settings)
  const draftChanged = !persistedSequence
    || needsRevalidation
    || persistedSequence.displayName !== draft.displayName.trim()
    || persistedSequence.kind !== draft.kind
    || persistedSequence.enabled !== draft.enabled
    || egressModeOf(persistedSequence) !== draft.egressMode
    || (egressModeOf(persistedSequence) === 'proxy-sequence' ? persistedSequence.proxySequenceKey || null : null)
      !== (draft.egressMode === 'proxy-sequence' ? draft.proxySequenceKey : null)
    || !sameOrder(persistedSequence.providerIds, draft.providerIds)
  const proxyControl = state.data?.control?.proxy || { endpoints: [], sequences: [], globalSequenceKey: null }
  const proxySequences = proxyControl.sequences || []
  const proxyEndpoints = new Map<string, ProxyEndpoint>((proxyControl.endpoints || []).map((endpoint: ProxyEndpoint) => [endpoint.proxyKey, endpoint]))
  const hubEgressMode = egressModeOf({
    egressMode: proxyControl.policy?.egressMode || proxyControl.policy?.mode,
    proxySequenceKey: proxyControl.policy?.sequenceKey ?? proxyControl.globalSequenceKey ?? null,
  })
  const proxySequenceOptions = [
    ...proxySequences.map((sequence: ProxySequence) => {
      const enabledCount = sequence.proxyKeys.filter((key) => proxyEndpoints.get(key)?.enabled).length
      return {
        value: sequence.sequenceKey,
        label: sequence.displayName,
        description: !sequence.enabled
          ? '已停用，不能选择'
          : enabledCount > 0
            ? `${enabledCount} 个已启用 endpoint${sequence.directFallback ? ' + Pod / Node 系统出网 fallback' : ''}`
            : '没有已启用 endpoint，不能选择',
        disabled: !sequence.enabled || enabledCount === 0,
      }
    }),
  ]
  const routeNotes = draft.providerIds.map((providerId) => {
    const provider = providerById.get(providerId)
    if (draft.egressMode === 'system-egress') return `${provider?.displayName || providerId}：Pod / Node 系统出网（Sequence 显式覆盖）`
    if (draft.egressMode === 'inherit' && !provider?.proxySequenceKey && hubEgressMode === 'system-egress') {
      return `${provider?.displayName || providerId}：Pod / Node 系统出网（Hub 应用策略）`
    }
    const sequenceKey = draft.egressMode === 'proxy-sequence'
      ? draft.proxySequenceKey
      : provider?.proxySequenceKey || proxyControl.globalSequenceKey || null
    if (!sequenceKey) return `${provider?.displayName || providerId}：继承部署默认（Docker daemon；未配置时为 Pod / Node 系统出网）`
    const proxySequence = proxySequences.find((sequence: ProxySequence) => sequence.sequenceKey === sequenceKey)
    if (!proxySequence?.enabled) return `${provider?.displayName || providerId}：${sequenceKey} 缺失或停用，禁止直连`
    const routes = proxySequence.proxyKeys.flatMap((key: string) => {
      const endpoint = proxyEndpoints.get(key)
      return endpoint?.enabled ? [endpoint.proxyUrl] : []
    })
    if (routes.length === 0) {
      return `${provider?.displayName || providerId}：${sequenceKey} 没有已启用 endpoint，禁止直连`
    }
    if (proxySequence.directFallback) routes.push('Pod / Node 系统出网')
    return `${provider?.displayName || providerId}：${sequenceKey} → ${routes.join(' → ')}`
  })

  useEffect(() => {
    if (creating) return
    const selected = sequences.find((sequence) => sequence.sequenceKey === selectedKey)
    if (!selected) return
    const selectedEgressMode = egressModeOf(selected)
    setDraft({
      sequenceKey: selected.sequenceKey,
      displayName: selected.displayName,
      kind: selected.kind,
      providerIds: [...selected.providerIds],
      egressMode: selectedEgressMode,
      proxySequenceKey: selectedEgressMode === 'proxy-sequence' ? selected.proxySequenceKey || null : null,
      enabled: selected.enabled,
      revision: selected.revision,
    })
    setSample(null)
    setError(null)
  }, [creating, selectedKey, state.data])

  const startNew = () => {
    setCreating(true)
    setSelectedKey('')
    setDraft({ sequenceKey: '', displayName: '', kind: 'chat', providerIds: [], egressMode: 'inherit', proxySequenceKey: null, enabled: true, revision: 0 })
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
    if (draft.egressMode === 'proxy-sequence' && !draft.proxySequenceKey) {
      setError(new Error('网络策略选择 Proxy Sequence 时，必须明确选择一条可用链。'))
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
        egressMode: submitted.egressMode,
        proxySequenceKey: submitted.egressMode === 'proxy-sequence' ? submitted.proxySequenceKey : null,
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
          ? `${saved.displayName} 已验证并设为业务默认 Sequence`
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
    if (draft.egressMode === 'proxy-sequence' && !draft.proxySequenceKey) {
      setError(new Error('网络策略选择 Proxy Sequence 时，必须明确选择一条可用链。'))
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
          egressMode: submitted.egressMode,
          proxySequenceKey: submitted.egressMode === 'proxy-sequence' ? submitted.proxySequenceKey : null,
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

  const confirmClearDefault = async () => {
    if (!clearDefaultKind) return
    const binding = bindings.find((candidate: any) => candidate.kind === clearDefaultKind)
    if (!binding?.sequenceKey) {
      setClearDefaultKind(null)
      return
    }
    setBusy('clear-default')
    setError(null)
    try {
      await adminApi.clearDefaultAgentSequence(token, {
        kind: clearDefaultKind,
        expectedRevision: binding.revision || 0,
      })
      notify?.(`${clearDefaultKind === 'chat' ? 'Chat / Agent' : 'Embedding'} 业务默认已清除`, 'success')
      setClearDefaultKind(null)
      await state.refresh()
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
        description="Sequence 是 Agent 真正选择的服务：按顺序尝试已保存 Provider。保存不会自动设为默认；只有显式设置的业务默认才承接未指定 Sequence 的调用。"
        loading={state.loading}
        onRefresh={state.refresh}
      ><></></PageHeading>
      {!canEdit ? <div className="mih-inline-warning"><Warning size={17} />Launcher 平台管理员可查看；编辑、测试和切换默认值仅限 Admin Token。</div> : null}
      <section className="mih-agent-defaults" aria-label="LLM 业务默认">
        {(['chat', 'embedding'] as const).map((kind) => {
          const binding = bindings.find((candidate: any) => candidate.kind === kind)
          const sequence = sequences.find((candidate) => candidate.sequenceKey === binding?.sequenceKey)
          const label = kind === 'chat' ? 'Chat / Agent' : 'Embedding'
          return <div key={kind}>
            <span><strong>{label} 业务默认</strong><small>{binding?.sequenceKey
              ? `${sequence?.displayName || binding.sequenceKey} · ${binding.sequenceKey}`
              : '未设置；不会自动使用 Catalog 第一条或第一个 Sequence'}</small></span>
            {binding?.sequenceKey ? <>
              <StatusBadge status="active" label="已显式设置" />
              {canEdit ? <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busy)}
                onClick={() => { setError(null); setClearDefaultKind(kind) }}>清除默认</button> : null}
            </> : <StatusBadge status="disabled" label="未设置" />}
          </div>
        })}
      </section>
      <div className="mih-agent-center-grid">
        <Panel title="Sequence 列表" subtitle="列表只是可选服务目录；兼容 Sequence 也不会自动成为业务默认。"
          actions={canEdit ? <button className="qp-button qp-button--outline" type="button" disabled={Boolean(busy)} onClick={startNew}><Plus size={16} />新建</button> : null}>
          <div className="mih-agent-center-list">
            {sequences.map((sequence) => {
              const selected = sequence.sequenceKey === selectedKey
              const isDefault = bindings.some((binding: any) => binding.kind === sequence.kind && binding.sequenceKey === sequence.sequenceKey)
              const sequenceEgressMode = egressModeOf(sequence)
              const networkLabel = sequenceEgressMode === 'proxy-sequence'
                ? `Sequence 专属 · ${proxySequences.find((candidate: ProxySequence) => candidate.sequenceKey === sequence.proxySequenceKey)?.displayName || sequence.proxySequenceKey}`
                : sequenceEgressMode === 'system-egress'
                  ? 'Pod / Node 系统出网（显式）'
                  : '继承 Provider / Hub / Docker daemon'
              return <button key={sequence.sequenceKey} type="button"
                className={`mih-agent-center-list__item${selected ? ' is-selected' : ''}`}
                disabled={Boolean(busy)}
                onClick={() => { setCreating(false); setSelectedKey(sequence.sequenceKey) }}>
                <span><strong>{sequence.displayName}</strong><code>{sequence.sequenceKey}</code><small>网络：{networkLabel}</small></span>
                <span>
                  <StatusBadge status={sequence.enabled ? 'active' : 'disabled'} label={sequence.kind} />
                  {sequenceNeedsRevalidation(sequence, settings)
                    ? <StatusBadge status="suspended" label="需重验" /> : null}
                  {isDefault ? <StatusBadge status="active" label="业务默认" /> : null}
                </span>
              </button>
            })}
            {sequences.length === 0 ? <p className="mih-agent-center-empty">尚无 Sequence。创建记录后仍需显式设置业务默认。</p> : null}
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
              hint={draft.kind === 'chat'
                ? '读取 system/user 提示词并生成文字或结构化结果，用于 Agent 阶段。'
                : '把文本编码为固定维度向量，用于向量索引和语义检索；不会生成回答。'}
              onChange={(kind: string) => setDraft({ ...draft, kind: kind as 'chat' | 'embedding', providerIds: [], revision: 0, sequenceKey: draft.revision ? '' : draft.sequenceKey })}
              options={[
                { value: 'chat', label: 'Chat / Agent', description: '提示词 → 文字、JSON 或工具决策' },
                { value: 'embedding', label: 'Embedding', description: '文本 → 固定维度向量，用于相似检索' },
              ] as never[]}
              disabled={!canEdit || Boolean(busy) || draft.revision > 0} />
            <DropdownField label="网络策略" value={draft.egressMode}
              hint="必须显式选择策略；新建时默认继承部署配置，不会自动选第一条 Proxy Sequence。"
              onChange={(egressMode: string) => setDraft((current) => ({
                ...current,
                egressMode: egressMode as EgressMode,
                ...(egressMode === 'proxy-sequence' ? {} : { proxySequenceKey: null }),
              }))}
              options={[
                { value: 'inherit', label: '继承部署默认（Docker daemon）', description: '继续按 Provider 兼容、Hub 策略与 Docker daemon 逐层解析' },
                { value: 'system-egress', label: 'Pod / Node 系统出网', description: '显式绕过应用 Proxy 与 Docker daemon proxy' },
                { value: 'proxy-sequence', label: '使用 Proxy Sequence', description: '只使用下方明确选择的有序代理链' },
              ] as never[]}
              disabled={!canEdit || Boolean(busy)} />
            {draft.egressMode === 'proxy-sequence' ? <DropdownField label="Sequence Proxy" value={draft.proxySequenceKey || ''}
              hint="不默认选择第一条；请选择经验证的 Proxy Sequence。"
              onChange={(sequenceKey: string) => setDraft((current) => ({ ...current, proxySequenceKey: sequenceKey || null }))}
              options={proxySequenceOptions as never[]}
              disabled={!canEdit || Boolean(busy)} /> : null}
            <label className="mih-agent-center-check"><input type="checkbox" checked={draft.enabled} disabled={!canEdit || Boolean(busy)}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用 Sequence</label>
          </div>

          <div className="mih-sequence-builder">
            <section>
              <h3>已保存 Provider</h3>
              <div className="mih-sequence-palette">
                {providers.map((provider) => (
                  <article key={provider.id} className="mih-sequence-provider">
                    <button className="mih-sequence-drag-handle" type="button"
                      draggable={canEdit && !busy}
                      disabled={!canEdit || Boolean(busy)}
                      aria-label={`添加或拖动 ${provider.displayName || provider.id} 到 LLM Sequence`}
                      title="单击添加，或从此手柄拖入 Sequence"
                      onClick={() => addProvider(provider.id)}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'copy'
                        event.dataTransfer.setData(PROVIDER_MIME, provider.id)
                      }}><DotsSixVertical size={19} /></button>
                    <span><strong>{provider.displayName || provider.id}</strong><code>{provider.id}</code><small>{provider.model} · {provider.protocol || 'openai-compatible'}{provider.connection?.mode === 'inherit-chat' ? ` · 继承 chat:${provider.connection.providerId}` : ''}</small></span>
                    <StatusBadge status={provider.keyConfigured === false ? 'suspended' : 'active'}
                      label={provider.keyConfigured === false ? '缺 Key' : provider.authMode === 'none' ? '无需 Key' : 'Key 已配置'} />
                  </article>
                ))}
                {providers.length === 0 ? <p className="mih-agent-center-empty">请先在 LLM Provider 保存至少一个启用配置。</p> : null}
              </div>
            </section>
            <section className="mih-sequence-dropzone"
              onDragOver={(event) => {
                if (!busy && canEdit && hasDragType(event, PROVIDER_MIME)) {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'copy'
                }
              }}
              onDrop={(event) => {
                if (!busy && canEdit && hasDragType(event, PROVIDER_MIME)) {
                  event.preventDefault()
                  addProvider(event.dataTransfer.getData(PROVIDER_MIME))
                }
              }}>
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
                  ? '当前操作未通过 Provider 验证；报错中的 Provider 发生了传输失败，后续 Provider 可能尚未测试。继承策略会使用服务端报告的 Docker daemon proxy；只有显式选择时才绕过代理走 Pod / Node 系统出网。这不是 Prompt 错误。'
                  : '当前草稿或已保存 Sequence 与 Provider revision 不一致，请先重新验证保存。'}</p>
                <ul>{routeNotes.map((note, index) => <li key={draft.providerIds[index]}><code>{note}</code></li>)}</ul>
                <a className="qp-button qp-button--outline" href="#/agent/proxies"><Globe size={16} />查看可选 Proxy 配置</a>
              </div>
            ) : null}
          </> : null}
          {sample?.sequenceKey === draft.sequenceKey ? <div className="mih-agent-sequence-sample"><CheckCircle size={18} /><div><strong>say hi 返回示例</strong><p>{sample.result.sample || `${sample.result.dimensions} dimensions`}</p><small>{sample.result.providerId} · {sample.result.model} · {sample.result.latencyMs} ms</small></div></div> : null}
          <div className="mih-agent-center-actions">
            <button className="qp-button qp-button--primary" type="button" disabled={!canEdit || Boolean(busy)} onClick={() => save(false)}><FloppyDisk size={16} />{busy === 'save' ? '验证中' : '验证并保存'}</button>
            <button className="qp-button qp-button--outline" type="button" disabled={!canEdit || Boolean(busy)} onClick={() => save(true)}><CheckCircle size={16} />{busy === 'default' ? '验证中' : '保存并设为业务默认'}</button>
            <button className="qp-button qp-button--ghost" type="button" disabled={!canEdit || Boolean(busy)} onClick={sayHi}><Play size={16} />{busy === 'test' ? '测试中' : draftChanged ? '保存并 say hi' : 'say hi'}</button>
          </div>
        </Panel>
      </div>
      {clearDefaultKind ? <ConfirmDialog
        title={`清除 ${clearDefaultKind === 'chat' ? 'Chat / Agent' : 'Embedding'} 业务默认`}
        description="清除后，未显式选择 Sequence 的调用不会自动改用第一个 Provider 或 Sequence；相关 Agent 将按各自的无模型降级策略处理。"
        confirmLabel="清除默认"
        busy={busy === 'clear-default'}
        onConfirm={confirmClearDefault}
        onCancel={() => { if (!busy) setClearDefaultKind(null) }}
      >{error ? <div className="mih-inline-warning"><Warning size={17} />{error.message}</div> : null}</ConfirmDialog> : null}
    </>
  )
}

export function AgentProxyPage({ token, session, onUnauthorized, notify }: PageProps) {
  const load = useCallback(() => adminApi.agent(token), [token])
  const state = useRemoteData(load, onUnauthorized) as any
  const [endpointDraft, setEndpointDraft] = useState({ proxyKey: '', displayName: '', proxyUrl: '', enabled: true, revision: 0 })
  const [sequenceDraft, setSequenceDraft] = useState({ sequenceKey: '', displayName: '', proxyKeys: [] as string[], directFallback: false, enabled: true, revision: 0 })
  const [policyDraft, setPolicyDraft] = useState({ egressMode: 'inherit' as EgressMode, sequenceKey: '', revision: 0 })
  const [policyEditing, setPolicyEditing] = useState(false)
  const [confirmPolicyEdit, setConfirmPolicyEdit] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<any>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProxyDeleteTarget | null>(null)
  const [proxyDrag, setProxyDrag] = useState<{ source: 'endpoint' | 'step', proxyKey: string } | null>(null)
  const [routeTestDraft, setRouteTestDraft] = useState({ providerRef: '', routeKey: '' })
  const [routeTestResult, setRouteTestResult] = useState<any>(null)
  const [routeTestError, setRouteTestError] = useState<any>(null)
  const canEdit = session?.kind === 'admin-token'
  const proxy = state.data?.control?.proxy || { endpoints: [], sequences: [], globalSequenceKey: null, revision: 0 }
  const runtimeEgress = (proxy.runtimeEgress || proxy) as RuntimeEgressEvidence
  const baseline = runtimeEgress.baseline || runtimeEgress.observed || {}
  const persistedPolicy = runtimeEgress.policy || {}
  const persistedPolicyMode = egressModeOf({
    egressMode: persistedPolicy.egressMode || persistedPolicy.mode,
    proxySequenceKey: persistedPolicy.sequenceKey ?? proxy.globalSequenceKey ?? null,
  })
  const persistedPolicySequenceKey = persistedPolicy.sequenceKey ?? proxy.globalSequenceKey ?? null
  const persistedPolicyRevision = Number(persistedPolicy.revision ?? proxy.revision ?? 0)
  const effectiveEgress = runtimeEgress.effective || {}
  const precedence = runtimeEgress.precedence || [
    { rank: 1, layer: 'request', label: '本次请求显式覆盖' },
    { rank: 2, layer: 'llm-sequence', label: 'LLM Sequence 网络策略' },
    { rank: 3, layer: 'provider-compat', label: 'Provider 兼容绑定' },
    { rank: 4, layer: 'hub-policy', label: 'Hub 应用策略' },
    { rank: 5, layer: 'docker-daemon', label: 'Docker daemon 部署默认' },
    { rank: 6, layer: 'system', label: 'Pod / Node 系统出网' },
  ]
  const endpoints = proxy.endpoints as ProxyEndpoint[]
  const sequences = proxy.sequences as ProxySequence[]
  const endpointById = useMemo(() => new Map(endpoints.map((endpoint) => [endpoint.proxyKey, endpoint])), [endpoints])
  const enabledEndpointCount = (sequence: ProxySequence) => sequence.proxyKeys
    .filter((proxyKey) => endpointById.get(proxyKey)?.enabled).length
  const currentGlobalSequence = sequences.find((sequence) => sequence.sequenceKey === persistedPolicySequenceKey)
  const endpointDraftReferences = sequences.filter((sequence) => sequence.proxyKeys.includes(endpointDraft.proxyKey))
  const providerRows = useMemo(() => (['chat', 'embedding'] as const).flatMap((kind) => (
    (state.data?.settings?.[kind]?.providers || []).map((provider: Provider) => ({ kind, provider }))
  )), [state.data])
  const llmSequences = (state.data?.control?.sequences || []) as LlmSequence[]
  const routeProviderOptions = providerRows.map(({ kind, provider }) => ({
    value: `${kind}:${provider.id}`,
    label: provider.displayName || provider.id,
    description: `${kind} · ${provider.model} · ${provider.id}${provider.connection?.mode === 'inherit-chat' ? ` · 跟随 chat:${provider.connection.providerId}` : ''}`,
    disabled: provider.enabled === false || provider.connectionReady === false
      || (provider.authMode !== 'none' && provider.keyConfigured === false),
  }))
  const routeOptions = [
    {
      value: INHERIT_EGRESS_ROUTE,
      label: '继承部署默认',
      description: '本次按 Provider、Hub 与 Docker daemon 的现有覆盖关系解析；不会保存绑定。',
    },
    {
      value: SYSTEM_EGRESS_ROUTE,
      label: 'Pod / Node 系统出网',
      description: '本次明确绕过应用 Proxy 与 Docker daemon proxy；仍受 Pod、容器和宿主网络策略影响。',
    },
    ...sequences.filter((sequence) => sequence.enabled && enabledEndpointCount(sequence) > 0).map((sequence) => ({
      value: sequence.sequenceKey,
      label: sequence.displayName,
      description: `${enabledEndpointCount(sequence)} 个已启用 endpoint · 本次严格走该 Proxy，不使用系统 fallback`,
    })),
  ]
  const selectedRouteProvider = routeProviderOptions.find((option) => option.value === routeTestDraft.providerRef)
  const selectedRoute = routeOptions.find((option) => option.value === routeTestDraft.routeKey)
  const routeTestReady = Boolean(selectedRouteProvider && !selectedRouteProvider.disabled && selectedRoute)
  const routeTestConfigSignature = JSON.stringify({
    providerRevisions: ['chat', 'embedding'].map((kind) => state.data?.settings?.[kind]?.revision || 0),
    endpoints: endpoints.map((endpoint) => [
      endpoint.proxyKey, endpoint.revision, endpoint.enabled, endpoint.proxyUrl,
    ]),
    sequences: sequences.map((sequence) => [
      sequence.sequenceKey, sequence.revision, sequence.enabled,
      sequence.directFallback, sequence.proxyKeys,
    ]),
    policy: [persistedPolicyMode, persistedPolicySequenceKey, persistedPolicyRevision],
    baseline,
  })
  const sequenceDraftProviderRefs = providerRows.filter(({ provider }) => (
    providerOwnsProxyBinding(provider) && provider.proxySequenceKey === sequenceDraft.sequenceKey
  ))
  const sequenceDraftLlmRefs = llmSequences.filter((sequence) => sequence.proxySequenceKey === sequenceDraft.sequenceKey)
  const sequenceDraftReferenceLabels = [
    ...(persistedPolicyMode === 'proxy-sequence' && persistedPolicySequenceKey === sequenceDraft.sequenceKey ? ['Hub 应用策略'] : []),
    ...sequenceDraftProviderRefs.map(({ kind, provider }) => `${kind}:${provider.displayName || provider.id}`),
    ...sequenceDraftLlmRefs.map((sequence) => `LLM Sequence:${sequence.displayName}`),
  ]

  useEffect(() => {
    if (policyEditing) return
    setPolicyDraft({
      egressMode: persistedPolicyMode,
      sequenceKey: persistedPolicySequenceKey || '',
      revision: persistedPolicyRevision,
    })
  }, [persistedPolicyMode, persistedPolicyRevision, persistedPolicySequenceKey, policyEditing])
  useEffect(() => {
    setRouteTestResult(null)
    setRouteTestError(null)
  }, [routeTestConfigSignature])

  const newEndpoint = () => {
    setEndpointDraft({ proxyKey: '', displayName: '', proxyUrl: '', enabled: true, revision: 0 })
    setError(null)
  }

  const newProxySequence = () => {
    setSequenceDraft({ sequenceKey: '', displayName: '', proxyKeys: [], directFallback: false, enabled: true, revision: 0 })
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

  const saveProxySequence = async () => {
    if (!keyValid(sequenceDraft.sequenceKey) || !sequenceDraft.displayName.trim()
      || sequenceDraft.proxyKeys.length === 0) {
      setError(new Error('请填写合法 Sequence，并至少加入一个 Proxy endpoint；继承 Docker daemon 或使用 Pod / Node 系统出网时无需创建 Proxy Sequence。'))
      return
    }
    if (!sequenceDraft.enabled && sequenceDraftReferenceLabels.length > 0) {
      setError(new Error(`请先解除 Proxy Sequence 绑定再停用：${sequenceDraftReferenceLabels.join('、')}`))
      return
    }
    setBusy('sequence')
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
      notify?.('Proxy Sequence 已保存；如需应用，请在顶部确认并编辑 Hub 策略或在 LLM Sequence 中明确选择', 'success')
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
      if (saved) state.refresh()
    } finally { setBusy('') }
  }

  const addProxy = (proxyKey: string) => {
    if (busy || !endpointById.get(proxyKey)?.enabled) return
    setSequenceDraft((current) => current.proxyKeys.includes(proxyKey)
      ? current
      : { ...current, proxyKeys: [...current.proxyKeys, proxyKey] })
  }

  const canAcceptProxyDrop = (event: DragEvent<HTMLElement>) => (
    hasDragType(event, PROXY_ENDPOINT_MIME) || hasDragType(event, PROXY_STEP_MIME)
  )

  const dropProxyBefore = (event: DragEvent<HTMLElement>, beforeKey: string | null) => {
    if (busy || !canEdit || !canAcceptProxyDrop(event)) return
    event.preventDefault()
    event.stopPropagation()
    const source = hasDragType(event, PROXY_STEP_MIME) ? 'step' : 'endpoint'
    const mime = source === 'step' ? PROXY_STEP_MIME : PROXY_ENDPOINT_MIME
    const proxyKey = event.dataTransfer.getData(mime)
    if (!proxyKey || !endpointById.get(proxyKey)?.enabled) return
    setSequenceDraft((current) => {
      if (source === 'endpoint' && current.proxyKeys.includes(proxyKey)) return current
      if (beforeKey === proxyKey) return current
      const proxyKeys = current.proxyKeys.filter((key) => key !== proxyKey)
      const insertionIndex = beforeKey == null ? proxyKeys.length : proxyKeys.indexOf(beforeKey)
      if (insertionIndex < 0) return current
      proxyKeys.splice(insertionIndex, 0, proxyKey)
      return sameOrder(proxyKeys, current.proxyKeys) ? current : { ...current, proxyKeys }
    })
    setProxyDrag(null)
  }

  const removeDroppedProxy = (event: DragEvent<HTMLElement>) => {
    if (busy || !canEdit || !hasDragType(event, PROXY_STEP_MIME)) return
    event.preventDefault()
    event.stopPropagation()
    const proxyKey = event.dataTransfer.getData(PROXY_STEP_MIME)
    if (!proxyKey) return
    setSequenceDraft((current) => ({
      ...current,
      proxyKeys: current.proxyKeys.filter((key) => key !== proxyKey),
    }))
    setProxyDrag(null)
  }

  const testProviderRoute = async () => {
    if (!routeTestReady) {
      setRouteTestError(new Error('请选择一个 Provider 和一个明确路由；本测试不会默认选择第一项。'))
      return
    }
    const separator = routeTestDraft.providerRef.indexOf(':')
    if (separator < 1) {
      setRouteTestError(new Error('Provider 选择无效，请重新选择。'))
      return
    }
    const kind = routeTestDraft.providerRef.slice(0, separator) as 'chat' | 'embedding'
    const providerId = routeTestDraft.providerRef.slice(separator + 1)
    const route = routeTestDraft.routeKey === INHERIT_EGRESS_ROUTE
      ? { mode: 'inherit' as const }
      : routeTestDraft.routeKey === SYSTEM_EGRESS_ROUTE
        ? { mode: 'system-egress' as const }
        : { mode: 'proxy-sequence' as const, sequenceKey: routeTestDraft.routeKey }
    setBusy('route-test')
    setRouteTestError(null)
    setRouteTestResult(null)
    try {
      const result = await adminApi.testAgentProvider(token, kind, providerId, { route })
      const routeConfirmed = route.mode === 'inherit'
        ? result.route?.mode === 'inherit'
        : route.mode === 'system-egress'
          ? result.route?.mode === 'system-egress'
          : result.route?.mode === 'proxy-sequence'
            && result.route?.sequenceKey === route.sequenceKey
      if (!routeConfirmed) {
        throw new Error('服务端没有确认本次明确选择的测试路由；结果未采信。')
      }
      const providerLabel = selectedRouteProvider?.label || providerId
      const routeLabel = selectedRoute?.label || routeTestDraft.routeKey
      setRouteTestResult({ ...result, providerLabel, routeLabel })
      notify?.(`${providerLabel} 经 ${routeLabel} 测试成功 · ${result.latencyMs} ms`, 'success')
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setRouteTestError(requestError)
    } finally {
      setBusy('')
    }
  }

  const removeEndpoint = (endpoint: ProxyEndpoint) => {
    const usedBy = sequences.filter((sequence) => sequence.proxyKeys.includes(endpoint.proxyKey))
    if (usedBy.length > 0) {
      setError(new Error(`请先从 Proxy Sequence 移除 ${endpoint.displayName}：${usedBy.map((item) => item.displayName).join('、')}`))
      return
    }
    setError(null)
    setDeleteTarget({ kind: 'endpoint', item: endpoint })
  }

  const removeProxySequence = (sequence: ProxySequence) => {
    const providerRefs = providerRows.filter(({ provider }) => (
      providerOwnsProxyBinding(provider) && provider.proxySequenceKey === sequence.sequenceKey
    ))
    const llmSequenceRefs = llmSequences.filter((candidate) => candidate.proxySequenceKey === sequence.sequenceKey)
    const usedByHubPolicy = persistedPolicyMode === 'proxy-sequence' && persistedPolicySequenceKey === sequence.sequenceKey
    if (usedByHubPolicy || providerRefs.length > 0 || llmSequenceRefs.length > 0) {
      const refs = [
        ...(usedByHubPolicy ? ['Hub 应用策略'] : []),
        ...providerRefs.map(({ kind, provider }) => `${kind}:${provider.displayName || provider.id}`),
        ...llmSequenceRefs.map((candidate) => `LLM Sequence:${candidate.displayName}`),
      ]
      setError(new Error(`请先解除 Proxy Sequence 绑定：${refs.join('、')}`))
      return
    }
    setError(null)
    setDeleteTarget({ kind: 'sequence', item: sequence })
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    const targetKey = target.kind === 'endpoint' ? target.item.proxyKey : target.item.sequenceKey
    setBusy(`delete-${target.kind}:${targetKey}`)
    setError(null)
    try {
      if (target.kind === 'endpoint') {
        await adminApi.deleteAgentProxyEndpoint(token, target.item.proxyKey, target.item.revision)
        if (endpointDraft.proxyKey === target.item.proxyKey) newEndpoint()
        notify?.('Proxy endpoint 已删除', 'success')
      } else {
        await adminApi.deleteAgentProxySequence(token, target.item.sequenceKey, target.item.revision)
        if (sequenceDraft.sequenceKey === target.item.sequenceKey) newProxySequence()
        notify?.('Proxy Sequence 已删除', 'success')
      }
      setDeleteTarget(null)
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally { setBusy('') }
  }

  const saveApplicationEgressPolicy = async () => {
    if (policyDraft.egressMode === 'proxy-sequence' && !policyDraft.sequenceKey) {
      setError(new Error('使用 Proxy Sequence 时必须明确选择一条可用链；不会自动选择第一条。'))
      return
    }
    setBusy('egress-policy')
    setError(null)
    try {
      await adminApi.saveAgentEgressPolicy(token, {
        egressMode: policyDraft.egressMode,
        sequenceKey: policyDraft.egressMode === 'proxy-sequence' ? policyDraft.sequenceKey : null,
        expectedRevision: policyDraft.revision,
      })
      setPolicyEditing(false)
      notify?.(`Hub 应用出网策略已更新：${egressModeLabel(policyDraft.egressMode)}；相关 LLM Sequence 需要重新验证`, 'success')
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
    const selectedProvider = setting.providers.find((provider: Provider) => provider.id === providerId)
    if (!selectedProvider || !providerOwnsProxyBinding(selectedProvider)) {
      setError(new Error('该 Embedding Provider 继承 Chat Provider 的 Proxy，不能单独设置兼容绑定。'))
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
      notify?.('Provider Proxy 兼容绑定已更新；相关 LLM Sequence 需要重新验证', 'success')
      await state.refresh()
    } catch (requestError: any) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally { setBusy('') }
  }

  const effectiveMode = evidenceText(effectiveEgress.egressMode, baseline.configured ? 'docker-daemon' : 'system-egress')
  const effectiveSource = evidenceText(effectiveEgress.source, baseline.configured ? 'docker-daemon' : 'system')
  const effectiveSequenceKey = typeof effectiveEgress.sequenceKey === 'string' ? effectiveEgress.sequenceKey : null
  const effectiveLabel = effectiveMode === 'proxy-sequence'
    ? `Proxy Sequence · ${sequences.find((sequence) => sequence.sequenceKey === effectiveSequenceKey)?.displayName || effectiveSequenceKey || '未报告'}`
    : effectiveMode === 'system-egress'
      ? 'Pod / Node 系统出网'
      : '继承部署默认（Docker daemon）'
  const policyDirty = policyDraft.egressMode !== persistedPolicyMode
    || (policyDraft.egressMode === 'proxy-sequence' ? policyDraft.sequenceKey : '') !== (persistedPolicyMode === 'proxy-sequence' ? persistedPolicySequenceKey || '' : '')
  const policySequenceOptions = sequences.map((sequence) => ({
    value: sequence.sequenceKey,
    label: sequence.displayName,
    description: !sequence.enabled
      ? '已停用，不能选择'
      : enabledEndpointCount(sequence) > 0
        ? `${enabledEndpointCount(sequence)} 个已启用 endpoint${sequence.directFallback ? ' + Pod / Node 系统出网 fallback' : ''}`
        : '没有已启用 endpoint，不能选择',
    disabled: !sequence.enabled || enabledEndpointCount(sequence) === 0,
  }))
  const precedenceDetail = (layer: unknown) => {
    if (layer === 'request' || layer === 'request-override') return '仅一次性测试或单次调用显式指定；不保存绑定'
    if (layer === 'llm-sequence') {
      const explicit = llmSequences.filter((sequence) => egressModeOf(sequence) !== 'inherit').length
      return `${explicit} 个 LLM Sequence 设置显式网络策略`
    }
    if (layer === 'provider-compat') {
      const bound = providerRows.filter(({ provider }) => providerOwnsProxyBinding(provider) && provider.proxySequenceKey).length
      return `${bound} 个 Provider 保留低优先级兼容绑定`
    }
    if (layer === 'hub-policy') return `${egressModeLabel(persistedPolicyMode)}${persistedPolicySequenceKey ? ` · ${persistedPolicySequenceKey}` : ''}`
    if (layer === 'docker-daemon') return baseline.configured
      ? `${proxyPairText(baseline.httpProxy, baseline.httpsProxy)} · ${evidenceText(baseline.runtimeKind)}`
      : '部署快照未配置有效 daemon proxy'
    if (layer === 'system') return '显式选择或更高层均无有效代理时使用'
    return '服务端未报告该层详情'
  }

  if (state.loading && !state.data) return <LoadingState label="正在读取 LLM Proxy" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  return (
    <>
      <PageHeading eyebrow="AGENT CENTER / PROXY SEQUENCES" title="LLM Proxy"
        description="Proxy 是显式出网覆盖：未绑定 Proxy Sequence 时默认继承部署侧 Docker daemon proxy，也可明确选择 Pod / Node 系统出网。"
        loading={state.loading} onRefresh={state.refresh}><></></PageHeading>
      <div className="mih-inline-warning"><Warning size={17} />K8s 内的 127.0.0.1 指当前 Pod 网络命名空间。生产已让使用 Agent 的 worker 与 Admin 统一 hostNetwork；Compose 请使用 host.docker.internal。</div>
      {persistedPolicyMode === 'proxy-sequence' && persistedPolicySequenceKey && (!currentGlobalSequence || currentGlobalSequence.enabled === false) ? (
        <div className="mih-inline-warning"><Warning size={17} />当前 Hub 策略链 <code>{persistedPolicySequenceKey}</code> 已停用或缺失。Agent 代理路由将 fail-closed，不会绕过配置直连；请先重新启用该 Sequence，或改用其他策略。</div>
      ) : currentGlobalSequence && enabledEndpointCount(currentGlobalSequence) === 0 ? (
        <div className="mih-inline-warning"><Warning size={17} />当前 Hub 策略链 <code>{currentGlobalSequence.sequenceKey}</code> 没有已启用的代理，不会使用任何 endpoint，也不会直连。请在下方启用并加入 endpoint 后保存。</div>
      ) : null}
      {error ? <ErrorState error={error} onRetry={undefined} /> : null}

      <Panel title="当前 Agent 出网解析"
        subtitle="只读显示服务端实际观测和覆盖顺序；Docker daemon 值由部署快照提供，浏览器不会自行推断。"
        className="mih-agent-egress-evidence"
        actions={canEdit && !policyEditing ? <button className="qp-button qp-button--outline" type="button"
          disabled={Boolean(busy)} onClick={() => setConfirmPolicyEdit(true)}><PencilSimple size={16} />确认并编辑策略</button> : null}>
        <div className="mih-agent-egress-summary">
          <section className="mih-agent-egress-effective" aria-live="polite">
            <span><strong>Hub fallback 当前生效</strong><small>更高优先级的请求、LLM Sequence 或 Provider 兼容覆盖仍可改变单次调用。</small></span>
            <span><StatusBadge status="active" label={effectiveLabel} />
              <code>{effectiveSequenceKey || proxyPairText(effectiveEgress.httpProxy, effectiveEgress.httpsProxy, '无应用 Proxy URL')}</code>
              <small>来源：{effectiveSource}</small></span>
          </section>
          <dl className="mih-agent-egress-facts">
            <div><dt>运行位置</dt><dd>{evidenceText(baseline.runtimeKind)}{baseline.nodeName ? ` · ${baseline.nodeName}` : ''}</dd></div>
            <div><dt>观测来源</dt><dd>{evidenceText(baseline.sourceKind)}<small>{evidenceText(baseline.sourceLocations)}</small></dd></div>
            <div><dt>HTTP_PROXY</dt><dd><code>{evidenceText(baseline.httpProxy, baseline.configured === false ? '未配置' : '未报告')}</code>{baseline.httpProxyCredentials ? <small>凭据已由服务端脱敏</small> : null}</dd></div>
            <div><dt>HTTPS_PROXY</dt><dd><code>{evidenceText(baseline.httpsProxy, baseline.configured === false ? '未配置' : '未报告')}</code>{baseline.httpsProxyCredentials ? <small>凭据已由服务端脱敏</small> : null}</dd></div>
            <div className="mih-agent-egress-facts__wide"><dt>NO_PROXY</dt><dd><code>{evidenceText(baseline.noProxy, baseline.configured === false ? '未配置' : '未报告')}</code></dd></div>
            <div><dt>观测时间</dt><dd>{baseline.observedAt ? formatDate(baseline.observedAt) : '未报告'}</dd></div>
          </dl>
        </div>
        <section className="mih-agent-egress-precedence" aria-labelledby="mih-egress-precedence-title">
          <h3 id="mih-egress-precedence-title">优先级覆盖关系</h3>
          <ol>{precedence.map((entry, index) => <li key={`${evidenceText(entry.layer)}-${index}`}>
            <span>{evidenceText(entry.rank, index + 1)}</span>
            <div><strong>{evidenceText(entry.label, evidenceText(entry.layer))}</strong><small>{precedenceDetail(entry.layer)}</small></div>
          </li>)}</ol>
        </section>
        {policyEditing ? <section className="mih-agent-egress-policy-editor" aria-labelledby="mih-egress-policy-editor-title">
          <header><h3 id="mih-egress-policy-editor-title">编辑 Hub 应用出网策略</h3><p>只保存 Hub 应用层覆盖，不会修改 Docker daemon 或宿主 systemd 文件。</p></header>
          <div className="mih-agent-egress-policy-editor__controls">
            <DropdownField label="策略" value={policyDraft.egressMode}
              hint="默认继承部署配置；不会自动选择第一条 Proxy Sequence。"
              onChange={(egressMode: string) => setPolicyDraft((current) => ({
                ...current,
                egressMode: egressMode as EgressMode,
                ...(egressMode === 'proxy-sequence' ? {} : { sequenceKey: '' }),
              }))}
              options={[
                { value: 'inherit', label: '继承部署默认（Docker daemon）', description: '使用部署快照中当前有效的 HTTP/HTTPS proxy；未配置时使用系统出网' },
                { value: 'system-egress', label: 'Pod / Node 系统出网', description: '显式绕过应用 Proxy 与 Docker daemon proxy' },
                { value: 'proxy-sequence', label: '使用 Proxy Sequence', description: '明确绑定下方选择的有序代理链' },
              ] as never[]} disabled={Boolean(busy)} />
            {policyDraft.egressMode === 'proxy-sequence' ? <DropdownField label="Proxy Sequence" value={policyDraft.sequenceKey}
              hint="必须明确选择；不默认第一条。"
              onChange={(sequenceKey: string) => setPolicyDraft((current) => ({ ...current, sequenceKey }))}
              options={policySequenceOptions as never[]} disabled={Boolean(busy)} /> : null}
          </div>
          <div className="mih-agent-center-actions">
            <button className="qp-button qp-button--primary" type="button"
              disabled={Boolean(busy) || !policyDirty || (policyDraft.egressMode === 'proxy-sequence' && !policyDraft.sequenceKey)}
              onClick={saveApplicationEgressPolicy}><FloppyDisk size={16} />{busy === 'egress-policy' ? '保存中' : '保存应用策略'}</button>
            <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busy)} onClick={() => {
              setPolicyDraft({ egressMode: persistedPolicyMode, sequenceKey: persistedPolicySequenceKey || '', revision: persistedPolicyRevision })
              setPolicyEditing(false)
              setError(null)
            }}>取消编辑</button>
          </div>
        </section> : null}
      </Panel>

      <Panel title="低优先级兼容覆盖（Provider / Hub）" subtitle="仅在请求和 LLM Sequence 都选择继承时继续解析；Provider 兼容层高于 Hub 策略，均不会改变优先级。">
        <div className="mih-proxy-bindings">
          <section>
            <h3>Hub 应用策略 · 第 4 层</h3>
            <div className="mih-proxy-compat-summary"><StatusBadge status="active" label={egressModeLabel(persistedPolicyMode)} />
              <p>{persistedPolicyMode === 'proxy-sequence'
                ? `当前链：${sequences.find((sequence) => sequence.sequenceKey === persistedPolicySequenceKey)?.displayName || persistedPolicySequenceKey}`
                : persistedPolicyMode === 'system-egress'
                  ? '显式绕过 Docker daemon proxy。'
                  : '默认继承服务端报告的 Docker daemon proxy。'}</p>
              <small>请在上方“当前 Agent 出网解析”确认后编辑。</small></div>
          </section>
          <section>
            <h3>Provider 兼容绑定</h3>
            <div className="mih-proxy-provider-bindings">
              {providerRows.map(({ kind, provider }) => (
                <div key={`${kind}:${provider.id}`}>
                  <span><strong>{provider.displayName || provider.id}</strong><small>{kind} · <code>{provider.id}</code>{provider.connection?.mode === 'inherit-chat' ? <> · 继承 <code>chat:{provider.connection.providerId}</code></> : null}</small></span>
                  {provider.connection?.mode === 'inherit-chat' ? (
                    <div className="mih-proxy-inherited-binding" role="status">
                      <strong>跟随 Chat Provider</strong>
                      <small>连接、凭据和 Proxy 均由 <code>{provider.connection.providerId}</code> 管理</small>
                    </div>
                  ) : <DropdownField label="兼容 Proxy Sequence" value={provider.proxySequenceKey || ''}
                      disabled={!canEdit || Boolean(busy) || state.data?.settings?.[kind]?.source !== 'database'}
                      onChange={(sequenceKey: string) => bindProvider(kind, provider.id, sequenceKey)}
                      options={[
                        { value: '', label: '不设兼容绑定 · 继承 Hub 应用策略', description: '继续按 Hub → Docker daemon → Pod / Node 系统出网解析。' },
                        ...sequences.filter((sequence) => sequence.enabled).map((sequence) => ({
                          value: sequence.sequenceKey,
                          label: sequence.displayName,
                          description: enabledEndpointCount(sequence)
                            ? `${enabledEndpointCount(sequence)} 个已启用 endpoint`
                            : '没有已启用 endpoint，不能绑定',
                          disabled: enabledEndpointCount(sequence) === 0,
                        })),
                      ] as never[]} />}
                </div>
              ))}
              {providerRows.length === 0 ? <p className="mih-agent-center-empty">尚无 Provider；请先到 LLM Provider 新建。</p> : null}
            </div>
          </section>
        </div>
        <section className="mih-proxy-route-test" aria-labelledby="mih-proxy-route-test-title">
          <header>
            <div><h3 id="mih-proxy-route-test-title">Provider × 路由一次性测试</h3>
              <p>严格按本次明确选择的路由测试 Provider；不会保存或修改 LLM Sequence、Provider、Hub 的任何绑定。</p></div>
          </header>
          <div className="mih-proxy-route-test__controls">
            <DropdownField label="Provider" value={routeTestDraft.providerRef}
              hint="不默认选择第一项。停用或缺少凭据的 Provider 不可测试。"
              onChange={(providerRef: string) => {
                setRouteTestDraft((current) => ({ ...current, providerRef }))
                setRouteTestResult(null)
                setRouteTestError(null)
              }}
              options={routeProviderOptions as never[]}
              disabled={!canEdit || Boolean(busy)} />
            <DropdownField label="本次路由" value={routeTestDraft.routeKey}
              hint="继承、系统出网与 Proxy Sequence 都是本次显式选择；测试结束即失效。"
              onChange={(routeKey: string) => {
                setRouteTestDraft((current) => ({ ...current, routeKey }))
                setRouteTestResult(null)
                setRouteTestError(null)
              }}
              options={routeOptions as never[]}
              disabled={!canEdit || Boolean(busy)} />
            <button className="qp-button qp-button--outline" type="button"
              disabled={!canEdit || Boolean(busy) || !routeTestReady}
              onClick={testProviderRoute}><Play size={16} />{busy === 'route-test' ? '严格测试中' : '执行一次性测试'}</button>
          </div>
          {routeTestError ? <ErrorState error={routeTestError} onRetry={undefined} /> : null}
          {routeTestResult ? <div className="mih-agent-sequence-sample"><CheckCircle size={18} /><div>
            <strong>{routeTestResult.providerLabel} × {routeTestResult.routeLabel}</strong>
            <p>{routeTestResult.kind === 'embedding'
              ? 'Embedding 向量响应结构验证通过'
              : 'Chat / Agent 消息响应结构验证通过'}</p>
            <small>{routeTestResult.model} · {routeTestResult.latencyMs} ms · 未保存绑定</small>
          </div></div> : null}
        </section>
      </Panel>

      <div className="mih-agent-center-grid mih-agent-center-grid--proxy">
        <Panel title="Proxy endpoints" subtitle="URL 不允许携带账号密码；被 Sequence 引用时必须先解绑。"
          actions={canEdit ? <button className="qp-button qp-button--outline" type="button" disabled={Boolean(busy)} onClick={newEndpoint}><Plus size={16} />新建 endpoint</button> : null}>
          <div className="mih-agent-crud-list">
            {endpoints.map((endpoint) => {
              const usedBy = sequences.filter((sequence) => sequence.proxyKeys.includes(endpoint.proxyKey))
              return <article key={endpoint.proxyKey} className={`mih-agent-crud-row mih-proxy-endpoint-row${endpointDraft.proxyKey === endpoint.proxyKey ? ' is-selected' : ''}`}>
                <span className="mih-proxy-endpoint-identity">
                  <button className="mih-proxy-endpoint-drag-handle" type="button"
                    draggable={canEdit && !busy && endpoint.enabled}
                    disabled={!canEdit || Boolean(busy) || !endpoint.enabled}
                    aria-label={`添加或拖动 ${endpoint.displayName} 到 Proxy Sequence`}
                    title={endpoint.enabled ? '单击添加，或从此手柄拖入 Proxy Sequence' : '停用的 endpoint 不能加入 Sequence'}
                    onClick={() => addProxy(endpoint.proxyKey)}
                    onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                      event.dataTransfer.effectAllowed = 'copy'
                      event.dataTransfer.setData(PROXY_ENDPOINT_MIME, endpoint.proxyKey)
                      setProxyDrag({ source: 'endpoint', proxyKey: endpoint.proxyKey })
                    }}
                    onDragEnd={() => setProxyDrag(null)}><DotsSixVertical size={18} /></button>
                  <span><strong>{endpoint.displayName}</strong><code>{endpoint.proxyKey}</code><small>{endpoint.proxyUrl}</small></span>
                </span>
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
              const providerRefs = providerRows.filter(({ provider }) => (
                providerOwnsProxyBinding(provider) && provider.proxySequenceKey === sequence.sequenceKey
              ))
              const llmSequenceRefs = llmSequences.filter((candidate) => candidate.proxySequenceKey === sequence.sequenceKey)
              const isGlobal = persistedPolicyMode === 'proxy-sequence' && persistedPolicySequenceKey === sequence.sequenceKey
              const enabledCount = enabledEndpointCount(sequence)
              const routeSummary = enabledCount === 0
                ? `${enabledCount} enabled / ${sequence.proxyKeys.length} total · 空链不可绑定`
                : `${enabledCount} enabled / ${sequence.proxyKeys.length} total${sequence.directFallback ? ' + Pod / Node system egress' : ''}`
              return <article key={sequence.sequenceKey} className={`mih-agent-crud-row${sequenceDraft.sequenceKey === sequence.sequenceKey ? ' is-selected' : ''}`}>
                <span><strong>{sequence.displayName}</strong><code>{sequence.sequenceKey}</code><small>{routeSummary}</small></span>
                <span>{isGlobal ? <StatusBadge status="active" label="Hub 应用策略" /> : null}<StatusBadge status={sequence.enabled ? 'active' : 'disabled'} label={sequence.enabled ? '启用' : '停用'} /><small>{llmSequenceRefs.length
                  ? `${llmSequenceRefs.length} 个 LLM Sequence 使用`
                  : providerRefs.length ? `${providerRefs.length} 个 Provider 兼容绑定` : '未绑定'}</small></span>
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
            <label className="mih-agent-center-check"><input type="checkbox" checked={sequenceDraft.directFallback} disabled={!canEdit || Boolean(busy)} onChange={(event) => setSequenceDraft({ ...sequenceDraft, directFallback: event.target.checked })} />代理传输均失败后允许 Pod / Node 系统出网</label>
            <label className="mih-agent-center-check"><input type="checkbox" checked={sequenceDraft.enabled}
              disabled={!canEdit || Boolean(busy) || (sequenceDraft.enabled && sequenceDraftReferenceLabels.length > 0)}
              onChange={(event) => setSequenceDraft({ ...sequenceDraft, enabled: event.target.checked })} />启用 Sequence</label>
            </div>
            {sequenceDraft.enabled && sequenceDraftReferenceLabels.length > 0 ? <p className="mih-agent-center-empty">该 Sequence 被 {sequenceDraftReferenceLabels.join('、')} 引用；请先解除绑定后再停用。</p> : null}
            <div className="mih-proxy-builder mih-proxy-builder--order">
              <div className={`mih-sequence-dropzone mih-proxy-order-dropzone${proxyDrag ? ' is-dragging' : ''}`}>
                <p className="mih-proxy-builder-help">从左侧 endpoint 列表的专用手柄拖入；Sequence 内也只能从步骤手柄排序。</p>
                {sequenceDraft.proxyKeys.map((proxyKey, index) => {
                  const displayName = endpointById.get(proxyKey)?.displayName || proxyKey
                  return <div className="mih-proxy-sequence-entry" key={proxyKey}>
                    <div className="mih-proxy-insert-slot" aria-hidden="true"
                      onDragOver={(event) => {
                        if (!busy && canAcceptProxyDrop(event)) {
                          event.preventDefault()
                          event.stopPropagation()
                          event.dataTransfer.dropEffect = hasDragType(event, PROXY_STEP_MIME) ? 'move' : 'copy'
                        }
                      }}
                      onDrop={(event) => dropProxyBefore(event, proxyKey)}><span>插入到此处</span></div>
                    <article className="mih-sequence-step">
                      <button className="mih-proxy-step-drag-handle" type="button"
                        draggable={canEdit && !busy}
                        disabled={!canEdit || Boolean(busy)}
                        aria-hidden="true"
                        tabIndex={-1}
                        title="仅从此手柄调整顺序；可拖到移除区"
                        onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData(PROXY_STEP_MIME, proxyKey)
                          setProxyDrag({ source: 'step', proxyKey })
                        }}
                        onDragEnd={() => setProxyDrag(null)}><DotsSixVertical size={18} /></button>
                      <strong>{index + 1}</strong><span><b>{displayName}</b><code>{proxyKey}</code></span>
                      <div><button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`上移 ${displayName}`} disabled={!canEdit || Boolean(busy) || index === 0}
                          onClick={() => setSequenceDraft((current) => ({ ...current, proxyKeys: move(current.proxyKeys, index, index - 1) }))}><ArrowUp size={15} /></button>
                        <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`下移 ${displayName}`} disabled={!canEdit || Boolean(busy) || index === sequenceDraft.proxyKeys.length - 1}
                          onClick={() => setSequenceDraft((current) => ({ ...current, proxyKeys: move(current.proxyKeys, index, index + 1) }))}><ArrowDown size={15} /></button>
                        <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`移除 ${displayName}`} disabled={!canEdit || Boolean(busy)}
                          onClick={() => setSequenceDraft((current) => ({ ...current, proxyKeys: current.proxyKeys.filter((key) => key !== proxyKey) }))}><Trash size={15} /></button></div>
                    </article>
                  </div>
                })}
                <div className={`mih-proxy-insert-slot mih-proxy-insert-slot--end${sequenceDraft.proxyKeys.length === 0 ? ' is-empty' : ''}`} aria-hidden="true"
                  onDragOver={(event) => {
                    if (!busy && canAcceptProxyDrop(event)) {
                      event.preventDefault()
                      event.stopPropagation()
                      event.dataTransfer.dropEffect = hasDragType(event, PROXY_STEP_MIME) ? 'move' : 'copy'
                    }
                  }}
                  onDrop={(event) => dropProxyBefore(event, null)}><span>{sequenceDraft.proxyKeys.length === 0 ? '拖入第一个 endpoint' : '插入到末尾'}</span></div>
                <div className="mih-sequence-quick-add" aria-label="不用拖动也可添加 endpoint">
                  {endpoints.filter((endpoint) => endpoint.enabled && !sequenceDraft.proxyKeys.includes(endpoint.proxyKey)).map((endpoint) => (
                    <button className="qp-button qp-button--ghost" type="button" key={endpoint.proxyKey}
                      disabled={!canEdit || Boolean(busy)} onClick={() => addProxy(endpoint.proxyKey)}><Plus size={14} />{endpoint.displayName}</button>
                  ))}
                </div>
              </div>
              <div className={`mih-proxy-remove-dropzone${proxyDrag?.source === 'step' ? ' is-active' : ''}`}
                aria-label="将 Proxy Sequence 步骤拖到这里移除"
                onDragOver={(event) => {
                  if (!busy && hasDragType(event, PROXY_STEP_MIME)) {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }
                }}
                onDrop={removeDroppedProxy}><Trash size={17} /><span>拖出到这里，从当前草稿移除</span></div>
            </div>
            <div className="mih-agent-center-actions">
              <button className="qp-button qp-button--primary" type="button" disabled={!canEdit || Boolean(busy)} onClick={saveProxySequence}><FloppyDisk size={16} />{sequenceDraft.revision ? '保存修改' : '创建 Sequence'}</button>
              {sequenceDraft.revision ? <button className="qp-button qp-button--ghost" type="button" disabled={Boolean(busy)} onClick={newProxySequence}>取消编辑</button> : null}
            </div>
          </div>
        </Panel>
      </div>
      {confirmPolicyEdit ? <ConfirmDialog
        title="编辑 Agent 出网策略"
        description="确认后只会解锁 Hub 应用层策略编辑；不会修改 Docker daemon 或宿主 systemd 文件。保存新策略会使相关 LLM Sequence 的验证证据需要重新生成。"
        confirmLabel="确认并编辑"
        tone="primary"
        busy={false}
        onConfirm={() => {
          setConfirmPolicyEdit(false)
          setPolicyDraft({ egressMode: persistedPolicyMode, sequenceKey: persistedPolicySequenceKey || '', revision: persistedPolicyRevision })
          setPolicyEditing(true)
          setError(null)
        }}
        onCancel={() => setConfirmPolicyEdit(false)}
      ><></></ConfirmDialog> : null}
      {deleteTarget ? <ConfirmDialog
        title={deleteTarget.kind === 'endpoint' ? '删除 Proxy endpoint' : '删除 Proxy Sequence'}
        description={`“${deleteTarget.item.displayName}” 删除后无法恢复；已被引用的记录仍会由服务端拒绝删除。`}
        confirmLabel="删除"
        busy={busy.startsWith('delete-')}
        onConfirm={confirmDelete}
        onCancel={() => { if (!busy) setDeleteTarget(null) }}
      >{error ? <div className="mih-inline-warning"><Warning size={17} />{error.message}</div> : null}</ConfirmDialog> : null}
    </>
  )
}
