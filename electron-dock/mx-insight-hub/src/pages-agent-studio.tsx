import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  Archive,
  ArrowCounterClockwise,
  ArrowLeft,
  Brain,
  BracketsCurly,
  Check,
  CheckCircle,
  Clock,
  Database,
  DotsThreeVertical,
  FileCode,
  FlowArrow,
  GitBranch,
  Info,
  LockKey,
  MagnifyingGlass,
  NotePencil,
  Package,
  Play,
  Plus,
  RocketLaunch,
  ShieldCheck,
  Storefront,
  TreeStructure,
  Warning,
  Wrench,
} from '@phosphor-icons/react'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  ConfirmDialog,
  DropdownField,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  PageHeading,
  StatusBadge,
} from './components.jsx'
import './agent-studio.css'

export type AgentStudioView = 'portfolio' | 'detail'
export type StudioArtifactStatus = 'valid' | 'warnings' | 'failed'
export type StudioEvaluationStatus = 'not-run' | 'pending' | 'passed' | 'failed'
export type StudioReleaseStatus = 'candidate' | 'approved' | 'deprecated'
export type StudioDeploymentStatus = 'canary' | 'active' | 'paused' | 'rolled-back'

export type StudioProjectSummary = {
  agentKey: string
  name: string
  summary: string
  kind: 'custom' | 'template-derived' | 'migration'
  owner: string
  dataScope: string
  tags?: string[]
  archived?: boolean
  riskClass?: 'low' | 'medium' | 'high'
  revision?: number
  updatedAt?: string | null
  draft: {
    draftId: string
    revision: number
    saved: boolean
    updatedAt: string | null
    definition?: AgentStudioDefinition
  } | null
  artifact: {
    artifactId: string
    artifactHash?: string | null
    status: StudioArtifactStatus
    diagnosticCount: number
    compiledAt: string | null
  } | null
  evaluation: {
    status: StudioEvaluationStatus
    label?: string | null
  } | null
  release: {
    releaseId: string
    status: StudioReleaseStatus
  } | null
  deployment: {
    deploymentId: string
    environment: string
    status: StudioDeploymentStatus
    lastRunAt?: string | null
  } | null
  compatibilityNote?: string | null
}

export type StudioSequenceOption = {
  sequenceKey: string
  label: string
  description: string
  revision: number
  effectiveModel: string
  egressMode: 'inherit' | 'system-egress' | 'proxy-sequence'
  effectiveProxy: string
  routeProof: 'valid' | 'missing' | 'stale'
  verifiedAt?: string | null
}

export type StudioDiagnostic = {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  location?: string
}

export type StudioPort = {
  key: string
  type: string
  required: boolean
}

export type StudioNodeManifest = {
  nodeType: string
  nodeVersion: string
  displayName: string
  family: string
  effect: 'none' | 'read'
  determinism: 'deterministic' | 'external' | 'model'
  entry: boolean
  terminal: boolean
  inputPorts: StudioPort[]
  outputPorts: StudioPort[]
  configSpec?: {
    additionalProperties?: boolean
    fields?: Array<Record<string, unknown>>
  }
  availability: string
  runtimeAvailable: boolean
  availableFrom?: string
  manifestHash?: string
}

export type StudioNodeRegistry = {
  registryVersion: string
  items: StudioNodeManifest[]
  execution?: {
    status: string
    reason?: string
    availableFrom?: string
  }
}

export type AgentStudioDefinition = {
  contractVersion: 'mx-insight.agent-draft.v1'
  entryNodeId: string
  terminalNodeIds: string[]
  nodes: Array<{
    nodeId: string
    nodeType: string
    nodeVersion: string
    config: Record<string, unknown>
  }>
  edges: Array<{
    from: { nodeId: string, port: string }
    to: { nodeId: string, port: string }
  }>
  budgets?: {
    deadlineMs?: number
    maxNodeAttempts?: number
    maxModelCalls?: number
    maxToolCalls?: number
    maxLoopIterations?: number
    maxFanOut?: number
    maxInputTokens?: number
    maxOutputTokens?: number
    maxRetries?: number
  }
  ui?: {
    positions?: Record<string, { x: number, y: number }>
    viewport?: { x: number, y: number, zoom: number }
    groups?: Array<{ groupId: string, label: string, nodeIds: string[] }>
    annotations?: Array<{ annotationId: string, nodeId?: string, text: string }>
  }
}

export type StudioDraft = {
  draftId: string
  revision: number
  definition: AgentStudioDefinition
  updatedAt?: string | null
}

export type AgentStudioDraftPayload = {
  agentKey: string
  draftId: string
  expectedRevision: number
  definition: AgentStudioDefinition
}

export type AgentStudioCompilePayload = {
  agentKey: string
  draftId: string
  expectedRevision: number
}

export type AgentStudioCreateInput = {
  agentKey: string
  displayName: string
  summary: string
  owner?: string
  riskClass: 'low' | 'medium' | 'high'
  tags: string[]
  templateKey: string
}

export type AgentStudioCreateResult = {
  project: StudioProjectSummary
  draft?: StudioDraft | null
}

export type AgentStudioUpdateProjectInput = {
  agentKey: string
  expectedRevision: number
  displayName: string
  summary: string
  owner: string
  dataScope: string
  riskClass: 'low' | 'medium' | 'high'
  tags: string[]
  archived?: boolean
}

export type StudioTemplateOption = {
  templateKey: string
  label: string
  description: string
  availability?: string
  runtimeAvailable?: boolean
  definition?: AgentStudioDefinition
}

export type AgentStudioSaveResult = {
  revision?: number
  updatedAt?: string | null
}

export type StudioStaticAssuranceCheck = {
  key: string
  label: string
  mode: 'static'
  status: 'passed' | 'failed' | 'not-evaluated'
  evidenceCodes?: string[]
}

export type StudioStaticAssurance = {
  contractVersion: string
  owner: 'mx-insight-hub'
  mode: 'static'
  status: 'passed' | 'failed'
  checks: StudioStaticAssuranceCheck[]
  evidence?: { nodeCount?: number, edgeCount?: number, logicalRefCount?: number }
  limitations?: {
    runtimeEvents?: boolean
    evaluationResults?: boolean
    releaseDecision?: boolean
    runnable?: boolean
  }
}

export type AgentStudioCompileResult = {
  status?: StudioArtifactStatus
  artifactId?: string | null
  artifactHash?: string | null
  compiledAt?: string | null
  diagnostics?: StudioDiagnostic[]
  compilerVersion?: string
  nodeRegistryVersion?: string
  draftRevision?: number
  dependencyManifest?: {
    logicalRefs?: Array<{ kind: string, key: string }>
  }
  normalizedPlan?: {
    assurance?: StudioStaticAssurance
  }
  assurance?: StudioStaticAssurance
}

export type AgentStudioPageProps = {
  token?: string
  session?: { kind?: string, platformAdmin?: boolean } | null
  query?: URLSearchParams
  view?: AgentStudioView
  projectKey?: string | null
  draftId?: string | null
  preview?: boolean
  projects?: StudioProjectSummary[]
  project?: StudioProjectSummary | null
  draft?: StudioDraft | null
  nodeTypes?: StudioNodeRegistry | StudioNodeManifest[]
  sequences?: StudioSequenceOption[]
  templates?: StudioTemplateOption[]
  loading?: boolean
  error?: Error | null
  notify?: (message: string, tone?: string) => void
  onUnauthorized?: (error: unknown) => void
  onRefresh?: () => void | Promise<void>
  loadProjects?: () => Promise<StudioProjectSummary[]>
  loadProject?: (agentKey: string) => Promise<StudioProjectSummary>
  loadDraft?: (agentKey: string, draftId: string) => Promise<StudioDraft>
  loadArtifact?: (agentKey: string, artifactId: string) => Promise<AgentStudioCompileResult>
  loadNodeTypes?: () => Promise<StudioNodeRegistry>
  loadSequences?: () => Promise<StudioSequenceOption[]>
  loadTemplates?: () => Promise<StudioTemplateOption[]>
  onCreateProject?: (input: AgentStudioCreateInput) => Promise<AgentStudioCreateResult | StudioProjectSummary>
  onOpenProject?: (agentKey: string) => void
  onOpenDraft?: (agentKey: string, draftId: string) => void
  onBackToPortfolio?: () => void
  onManageProject?: (agentKey: string) => void
  onArchiveProject?: (agentKey: string) => void | Promise<void>
  updateProject?: (input: AgentStudioUpdateProjectInput) => Promise<StudioProjectSummary>
  saveDraft?: (payload: AgentStudioDraftPayload) => Promise<AgentStudioSaveResult | StudioDraft | void>
  compileDraft?: (payload: AgentStudioCompilePayload) => Promise<AgentStudioCompileResult | void>
}

type StudioNodeFamily = 'core' | 'data' | 'model' | 'control' | 'output'
type StudioNodeEffect = 'none' | 'read' | 'model'

type StudioNodeData = {
  label: string
  description: string
  nodeType: string
  version: string
  family: StudioNodeFamily
  effect: StudioNodeEffect
  determinism: StudioNodeManifest['determinism']
  available: boolean
  phase?: string
  systemPrompt?: string
  userPrompt?: string
  sequenceKey?: string
  schemaRef?: string
  inputRef?: string
  outputRef?: string
  inputPorts: StudioPort[]
  outputPorts: StudioPort[]
  config: Record<string, unknown>
  entry: boolean
  terminal: boolean
  onInspect?: (nodeId: string) => void
}

type StudioFlowNode = Node<StudioNodeData, 'studio'>
type StudioFlowEdge = Edge
type InspectorTab = 'prompt' | 'config' | 'io' | 'policy' | 'run'
type EvidenceTab = 'diagnostics' | 'assurance' | 'events' | 'references'

export const AGENT_STUDIO_PREVIEW_NODE_TYPES: StudioNodeRegistry = {
  registryVersion: 'mx-insight-agent-studio-p1-v1',
  execution: {
    status: 'unavailable',
    reason: 'P1 provides authoring and static compilation only',
    availableFrom: 'P2',
  },
  items: [
    {
      nodeType: 'core.input.source', nodeVersion: '1.0.0', displayName: 'Governed Source Input',
      family: 'input-output', effect: 'none', determinism: 'deterministic', entry: true, terminal: false,
      inputPorts: [], outputPorts: [{ key: 'source', type: 'source/ref', required: true }],
      availability: 'compile-only', runtimeAvailable: false, availableFrom: 'P2',
    },
    {
      nodeType: 'hub.source.describe', nodeVersion: '1.0.0', displayName: 'Describe Governed Source',
      family: 'read-only-tool', effect: 'read', determinism: 'external', entry: false, terminal: false,
      inputPorts: [{ key: 'source', type: 'source/ref', required: true }],
      outputPorts: [{ key: 'contract', type: 'source/contract', required: true }],
      availability: 'compile-only', runtimeAvailable: false, availableFrom: 'P2',
    },
    {
      nodeType: 'hub.schema.profile', nodeVersion: '1.0.0', displayName: 'Profile Source Schema',
      family: 'read-only-tool', effect: 'read', determinism: 'deterministic', entry: false, terminal: false,
      inputPorts: [
        { key: 'source', type: 'source/ref', required: false },
        { key: 'contract', type: 'source/contract', required: false },
      ],
      outputPorts: [{ key: 'profile', type: 'schema/profile', required: true }],
      availability: 'compile-only', runtimeAvailable: false, availableFrom: 'P2',
    },
    {
      nodeType: 'llm.mapping.propose', nodeVersion: '1.0.0', displayName: 'LLM Mapping Proposal',
      family: 'structured-llm', effect: 'none', determinism: 'model', entry: false, terminal: false,
      inputPorts: [{ key: 'profile', type: 'schema/profile', required: true }],
      outputPorts: [{ key: 'proposal', type: 'mapping/proposal', required: true }],
      availability: 'compile-only', runtimeAvailable: false, availableFrom: 'P2',
    },
    {
      nodeType: 'hub.mapping.validate', nodeVersion: '1.0.0', displayName: 'Validate Mapping Contract',
      family: 'transform', effect: 'none', determinism: 'deterministic', entry: false, terminal: false,
      inputPorts: [
        { key: 'profile', type: 'schema/profile', required: true },
        { key: 'proposal', type: 'mapping/proposal', required: true },
      ],
      outputPorts: [{ key: 'validated', type: 'mapping/proposal-validated', required: true }],
      availability: 'compile-only', runtimeAvailable: false, availableFrom: 'P2',
    },
    {
      nodeType: 'core.review.mapping-required', nodeVersion: '1.0.0', displayName: 'Human Mapping Review Boundary',
      family: 'human-review-boundary', effect: 'none', determinism: 'deterministic', entry: false, terminal: false,
      inputPorts: [{ key: 'validated', type: 'mapping/proposal-validated', required: true }],
      outputPorts: [{ key: 'candidate', type: 'mapping/proposal-reviewed', required: true }],
      availability: 'compile-only', runtimeAvailable: false, availableFrom: 'P2',
    },
    {
      nodeType: 'core.output.mapping', nodeVersion: '1.0.0', displayName: 'Mapping Validation Output',
      family: 'input-output', effect: 'none', determinism: 'deterministic', entry: false, terminal: true,
      inputPorts: [{ key: 'mappingProposal', type: 'mapping/proposal-reviewed', required: true }], outputPorts: [],
      availability: 'compile-only', runtimeAvailable: false, availableFrom: 'P2',
    },
  ],
}

export const AGENT_STUDIO_PREVIEW_DEFINITION: AgentStudioDefinition = {
  contractVersion: 'mx-insight.agent-draft.v1',
  entryNodeId: 'source_input',
  terminalNodeIds: ['mapping_output'],
  nodes: [
    {
      nodeId: 'source_input', nodeType: 'core.input.source', nodeVersion: '1.0.0',
      config: { sourceRef: 'source://hub/public-opinion.province.v1' },
    },
    { nodeId: 'source_describe', nodeType: 'hub.source.describe', nodeVersion: '1.0.0', config: {} },
    { nodeId: 'schema_profile', nodeType: 'hub.schema.profile', nodeVersion: '1.0.0', config: {} },
    {
      nodeId: 'mapping_proposal', nodeType: 'llm.mapping.propose', nodeVersion: '1.0.0',
      config: {
        sequenceKey: 'advanced-mapping-v2',
        systemPrompt: '你是 MX Insight Hub 的字段映射建议器。只根据已授权的结构画像与目标 Schema 生成 Mapping Proposal。不要编造来源字段，不要批准映射，也不要执行入库。',
        taskTemplate: '来源结构：{{schemaProfile}}\n目标 Schema：{{targetSchema}}\n字段样本：{{sampleFields}}\n请输出符合目标 JSON Schema 的 mapping proposal。',
        targetSchemaRef: 'schema://hub/canonical-content.v1',
        temperature: 0.2,
        maxOutputTokens: 2000,
      },
    },
    {
      nodeId: 'mapping_validate', nodeType: 'hub.mapping.validate', nodeVersion: '1.0.0',
      config: { requiredFields: ['externalId', 'title', 'body', 'eventTime', 'sourceUrl'] },
    },
    { nodeId: 'human_review', nodeType: 'core.review.mapping-required', nodeVersion: '1.0.0', config: {} },
    { nodeId: 'mapping_output', nodeType: 'core.output.mapping', nodeVersion: '1.0.0', config: {} },
  ],
  edges: [
    { from: { nodeId: 'source_input', port: 'source' }, to: { nodeId: 'source_describe', port: 'source' } },
    { from: { nodeId: 'source_describe', port: 'contract' }, to: { nodeId: 'schema_profile', port: 'contract' } },
    { from: { nodeId: 'schema_profile', port: 'profile' }, to: { nodeId: 'mapping_proposal', port: 'profile' } },
    { from: { nodeId: 'schema_profile', port: 'profile' }, to: { nodeId: 'mapping_validate', port: 'profile' } },
    { from: { nodeId: 'mapping_proposal', port: 'proposal' }, to: { nodeId: 'mapping_validate', port: 'proposal' } },
    { from: { nodeId: 'mapping_validate', port: 'validated' }, to: { nodeId: 'human_review', port: 'validated' } },
    { from: { nodeId: 'human_review', port: 'candidate' }, to: { nodeId: 'mapping_output', port: 'mappingProposal' } },
  ],
  budgets: {
    deadlineMs: 60000, maxNodeAttempts: 24, maxModelCalls: 4, maxToolCalls: 8,
    maxLoopIterations: 0, maxFanOut: 4, maxInputTokens: 32000, maxOutputTokens: 4000, maxRetries: 2,
  },
  ui: {
    positions: {
      source_input: { x: 20, y: 204 },
      source_describe: { x: 250, y: 204 },
      schema_profile: { x: 480, y: 204 },
      mapping_proposal: { x: 720, y: 76 },
      mapping_validate: { x: 960, y: 204 },
      human_review: { x: 1200, y: 204 },
      mapping_output: { x: 1440, y: 204 },
    },
    viewport: { x: 0, y: 0, zoom: 0.8 },
    groups: [],
    annotations: [],
  },
}

export const AGENT_STUDIO_PREVIEW_PROJECTS: StudioProjectSummary[] = [
  {
    agentKey: 'public-opinion-multi-source-mapping',
    name: '全国舆情多源接入与字段映射 Agent',
    summary: '从已注册的 sourceRef 解析结构，生成可审阅的字段映射建议与质量证据。',
    kind: 'custom',
    owner: '数据平台组',
    dataScope: 'public-opinion / province',
    tags: ['Data Cleaning', 'Mapping', 'Read-only'],
    draft: {
      draftId: 'draft-public-opinion-v1', revision: 12, saved: true,
      updatedAt: '2026-08-31T08:24:00.000Z', definition: AGENT_STUDIO_PREVIEW_DEFINITION,
    },
    artifact: null,
    evaluation: { status: 'not-run' },
    release: null,
    deployment: null,
  },
  {
    agentKey: 'knowledge-qa-draft',
    name: '知识问答 Agent',
    summary: '基于授权数据集检索证据并生成带引用的回答；当前仍是可编辑草稿。',
    kind: 'template-derived',
    owner: '数据智能组',
    dataScope: 'authorized datasets',
    tags: ['Knowledge QA', 'RAG'],
    draft: { draftId: 'draft-knowledge-qa-v1', revision: 4, saved: true, updatedAt: '2026-08-30T11:09:00.000Z' },
    artifact: null,
    evaluation: { status: 'not-run' },
    release: null,
    deployment: null,
  },
  {
    agentKey: 'advanced-search-parity-migration',
    name: '进阶搜索迁移草稿',
    summary: '为 fixed advanced-search adapter 准备通用图定义；尚未通过 parity gate。',
    kind: 'migration',
    owner: 'Agent 平台组',
    dataScope: 'canonical search / read-only',
    tags: ['Migration', 'Shadow'],
    draft: { draftId: 'draft-advanced-search-shadow', revision: 7, saved: true, updatedAt: '2026-08-29T15:40:00.000Z' },
    artifact: null,
    evaluation: { status: 'not-run' },
    release: null,
    deployment: null,
    compatibilityNote: '当前线上服务仍由 fixed-adapter 提供；Studio 尚未接管运行。',
  },
]

export const AGENT_STUDIO_PREVIEW_SEQUENCES: StudioSequenceOption[] = [
  {
    sequenceKey: 'advanced-mapping-v2',
    label: 'Advanced Mapping v2',
    description: '字段语义分析与结构化 Mapping Proposal。',
    revision: 17,
    effectiveModel: 'gpt-4o',
    egressMode: 'proxy-sequence',
    effectiveProxy: 'cn-llm-egress · rev 4',
    routeProof: 'valid',
    verifiedAt: '2026-08-31T06:03:00.000Z',
  },
  {
    sequenceKey: 'safe-structured-analysis',
    label: 'Safe Structured Analysis',
    description: '只读分析场景的结构化输出调用链。',
    revision: 9,
    effectiveModel: '由 Sequence Provider 顺序解析',
    egressMode: 'inherit',
    effectiveProxy: '继承部署默认（Docker daemon）',
    routeProof: 'valid',
    verifiedAt: '2026-08-30T09:12:00.000Z',
  },
]

const FUTURE_PALETTE_ITEMS = [
  { key: 'runtime.sandbox', label: 'Sandbox 调试', description: '事件回放与 checkpoint', family: 'control' as const, phase: 'P2', icon: Play },
  { key: 'hub.import.submit', label: '提交导入作业', description: '确定性 worker 承担批量入库', family: 'data' as const, phase: 'P3', icon: Package },
  { key: 'release.candidate', label: 'Release / Deploy', description: '评测门与不可变发布', family: 'control' as const, phase: 'P4', icon: RocketLaunch },
]

const EDGE_STYLE = {
  stroke: 'var(--qp-text-4)',
  strokeWidth: 1.5,
}

const EDGE_MARKER = {
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
  color: 'var(--qp-text-4)',
}

function formatDate(value: string | null | undefined) {
  if (!value) return '尚无时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function projectKindLabel(kind: StudioProjectSummary['kind']) {
  if (kind === 'template-derived') return '模板派生'
  if (kind === 'migration') return '迁移草稿'
  return '自定义'
}

function artifactLabel(project: StudioProjectSummary) {
  if (!project.artifact) return { status: 'disabled', label: '尚未编译', detail: '无 immutable artifact' }
  if (project.artifact.status === 'failed') return { status: 'down', label: '编译失败', detail: `${project.artifact.diagnosticCount} 个错误` }
  if (project.artifact.status === 'warnings') return { status: 'warning', label: `${project.artifact.diagnosticCount} 个警告`, detail: project.artifact.artifactId }
  return { status: 'active', label: '有效', detail: project.artifact.artifactId }
}

type StudioPortfolioTab = 'projects' | 'templates' | 'artifacts' | 'archived'

function projectCompileState(project: StudioProjectSummary): string {
  if (project.artifact?.status === 'failed') return 'compile-failed'
  if (project.artifact?.status === 'warnings') return 'warnings'
  if (project.artifact?.status === 'valid') return 'valid'
  return project.draft ? 'draft-only' : 'idea'
}

function uniqueOptions(values: string[], emptyLabel: string, labelFor: (value: string) => string = (value) => value) {
  return [
    { value: '', label: emptyLabel },
    ...[...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN'))
      .map((value) => ({ value, label: labelFor(value) })),
  ] as never[]
}

function StudioPortfolio({
  projects,
  templates,
  preview,
  canMutate,
  loading,
  error,
  onRefresh,
  onCreate,
  onOpen,
  onManage,
  onArchive,
  onRestore,
}: {
  projects: StudioProjectSummary[]
  templates: StudioTemplateOption[]
  preview: boolean
  canMutate: boolean
  loading: boolean
  error: Error | null
  onRefresh?: () => void | Promise<void>
  onCreate: (templateKey?: string) => void
  onOpen: (agentKey: string) => void
  onManage?: (project: StudioProjectSummary) => void
  onArchive?: (project: StudioProjectSummary) => void
  onRestore?: (project: StudioProjectSummary) => void | Promise<void>
}) {
  const [tab, setTab] = useState<StudioPortfolioTab>('projects')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [tagFilter, setTagFilter] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [compileFilter, setCompileFilter] = useState('')

  const nonArchivedProjects = useMemo(() => projects.filter((project) => !project.archived), [projects])
  const tagOptions = useMemo(() => uniqueOptions(nonArchivedProjects.flatMap((project) => project.tags || []), '全部标签'), [nonArchivedProjects])
  const ownerOptions = useMemo(() => uniqueOptions(nonArchivedProjects.map((project) => project.owner), '全部 Owner'), [nonArchivedProjects])
  const kindOptions = useMemo(() => uniqueOptions(nonArchivedProjects.map((project) => project.kind), '全部项目类型', (value) => ({
    custom: '自定义',
    'template-derived': '模板派生',
    migration: '迁移草稿',
  }[value] || value)), [nonArchivedProjects])
  const compileOptions = useMemo(() => uniqueOptions(nonArchivedProjects.map(projectCompileState), '全部编译状态', (value) => ({
    idea: 'Idea · 无 Draft',
    'draft-only': 'Draft · 尚未编译',
    valid: 'Artifact · 有效',
    warnings: 'Artifact · 有警告',
    'compile-failed': 'Artifact · 编译失败',
  }[value] || value)), [nonArchivedProjects])

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('zh-CN')
    const scoped = projects.filter((project) => {
      if (tab === 'projects' && project.archived) return false
      if (tab === 'artifacts' && (project.archived || !project.artifact)) return false
      if (tab === 'archived' && !project.archived) return false
      if (query && ![
        project.name, project.agentKey, project.owner, project.dataScope, ...(project.tags || []),
      ].join('\n').toLocaleLowerCase('zh-CN').includes(query)) return false
      if (statusFilter === 'attention' && !(project.artifact?.status === 'warnings'
        || project.artifact?.status === 'failed' || project.draft?.saved === false)) return false
      if (statusFilter === 'draft-only' && Boolean(project.artifact)) return false
      if (statusFilter === 'compiled' && !(project.artifact && project.artifact.status !== 'failed')) return false
      if (tagFilter && !(project.tags || []).includes(tagFilter)) return false
      if (ownerFilter && project.owner !== ownerFilter) return false
      if (kindFilter && project.kind !== kindFilter) return false
      if (compileFilter && projectCompileState(project) !== compileFilter) return false
      return true
    })
    return [...scoped].sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.draft?.updatedAt || '') || 0
      const rightTime = Date.parse(right.updatedAt || right.draft?.updatedAt || '') || 0
      return rightTime - leftTime || left.name.localeCompare(right.name, 'zh-CN')
    })
  }, [compileFilter, kindFilter, ownerFilter, projects, search, statusFilter, tab, tagFilter])

  const filteredTemplates = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('zh-CN')
    return templates.filter((template) => !query || [template.label, template.templateKey, template.description]
      .join('\n').toLocaleLowerCase('zh-CN').includes(query))
  }, [search, templates])

  const tabDescription = tab === 'artifacts'
    ? '只陈列当前 Draft revision 对应的真实 immutable Artifact。'
    : tab === 'archived'
        ? '归档只隐藏活跃资产，不删除 Draft 或 Artifact 历史。'
        : ''

  return (
    <div className="mih-studio-page mih-studio-portfolio-page">
      <PageHeading eyebrow="AGENT CENTER / AGENT STUDIO" title="Agent Studio"
        description="创建、编辑、静态编译并管理受治理的 Agent；Agent Market 只负责发现与复用。"
        loading={loading} onRefresh={onRefresh}>
        <button className="qp-button qp-button--primary" type="button" onClick={() => onCreate()}
          disabled={!canMutate} title={!canMutate ? '只读会话，需 Hub Admin Token 修改' : undefined}>
          <Plus size={16} aria-hidden="true" />新建 Agent
        </button>
      </PageHeading>

      <div className="mih-studio-notice mih-studio-notice--governance" role="status">
        <ShieldCheck size={17} aria-hidden="true" />
        <span><strong>Hub 原生控制面</strong>Agent、Prompt、DAG、编译证据与后续 Trace / Eval / Gate 均由 Hub 管理；本轮不接入外部管理平台。当前真实能力止于 Build 与 Compile。</span>
      </div>

      {preview ? (
        <div className="mih-studio-notice" role="status">
          <Info size={17} aria-hidden="true" />
          <span><strong>P1 前端预览</strong>当前记录是显式 fixture，不替代 Studio API 数据。</span>
        </div>
      ) : null}

      {!canMutate ? (
        <div className="mih-studio-notice mih-studio-notice--readonly" role="status">
          <LockKey size={17} aria-hidden="true" />
          <span><strong>只读会话</strong>需 Hub Admin Token 才能新建、编辑、编译或归档 Agent Draft。</span>
        </div>
      ) : null}

      <nav className="mih-studio-section-tabs" aria-label="Agent Studio 资产类型">
        {[
          ['projects', 'Agent 项目'],
          ['templates', '模板'],
          ['artifacts', 'Artifacts'],
          ['archived', '已归档'],
        ].map(([value, label]) => (
          <button key={value} type="button" className={tab === value ? 'is-active' : ''}
            aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value as StudioPortfolioTab)}>{label}</button>
        ))}
      </nav>

      <section className="mih-studio-toolbar" aria-label="Agent 产品筛选">
        <label className="mih-studio-search">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <span className="mih-studio-sr-only">搜索 Studio 资产</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder={tab === 'templates' ? '搜索模板名称、templateKey 或说明' : '搜索 Agent、agentKey、Owner 或标签'} />
        </label>
        {tab !== 'templates' ? (
          <div className="mih-studio-filter-chips" aria-label="快捷状态">
            {[
              ['all', '全部'],
              ['attention', '待修复'],
              ['draft-only', '仅 Draft'],
              ['compiled', '已编译'],
            ].map(([value, label]) => (
              <button key={value} className={statusFilter === value ? 'is-active' : ''} type="button"
                aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}>{label}</button>
            ))}
          </div>
        ) : <span className="mih-studio-template-truth">仅展示模板 API 返回的已审核模板</span>}
      </section>

      {tab !== 'templates' ? (
        <section className="mih-studio-dimension-filters" aria-label="多维筛选">
          <DropdownField label="标签" value={tagFilter} onChange={setTagFilter} options={tagOptions} />
          <DropdownField label="Owner" value={ownerFilter} onChange={setOwnerFilter} options={ownerOptions} />
          <DropdownField label="项目类型" value={kindFilter} onChange={setKindFilter} options={kindOptions} />
          <DropdownField label="编译状态" value={compileFilter} onChange={setCompileFilter} options={compileOptions} />
        </section>
      ) : null}

      {loading && !projects.length ? <LoadingState label="正在加载 Agent Studio 产品" /> : null}
      {error ? <ErrorState error={error} onRetry={onRefresh} /> : null}
      {!loading && !error && tab === 'templates' ? (
        <section className="qp-panel mih-studio-template-catalog" aria-label="Agent 模板目录">
          {filteredTemplates.map((template) => (
            <article key={template.templateKey}>
              <span><Package size={18} weight="duotone" aria-hidden="true" /></span>
              <div><strong>{template.label}</strong><code>{template.templateKey}</code><p>{template.description}</p>
                {template.definition ? <small>{template.definition.nodes.length} 节点 · {template.definition.edges.length} 边 · {template.definition.terminalNodeIds.length} 终点</small> : null}
              </div>
              <StatusBadge status={template.runtimeAvailable ? 'active' : 'disabled'} label={template.runtimeAvailable ? 'Runtime available' : 'Authoring only'} />
              {canMutate ? <button className="qp-button qp-button--outline qp-button--sm" type="button" onClick={() => onCreate(template.templateKey)}>基于模板新建</button> : null}
            </article>
          ))}
          {!filteredTemplates.length ? <EmptyState icon={Package} title="没有匹配的真实模板"
            description="模板目录不会以 fixture 或 Agent 项目代替。" action={undefined} /> : null}
        </section>
      ) : null}
      {!loading && !error && tab !== 'templates' ? (
        <section className="qp-panel mih-studio-products" aria-label="Agent Studio 产品列表">
          <header className="mih-studio-product-columns" aria-hidden="true">
            <span>Agent 产品</span><span>Data scope / Tags</span><span>Draft</span><span>Compile Evidence</span><span>操作</span>
          </header>
          <div className="mih-studio-product-list">
            {filteredProjects.map((project) => {
              const artifact = artifactLabel(project)
              return (
                <article className="mih-studio-product-row" key={project.agentKey}>
                  <button className="mih-studio-product-identity" type="button" onClick={() => onOpen(project.agentKey)}>
                    <span className="mih-studio-product-icon"><Brain size={21} weight="duotone" aria-hidden="true" /></span>
                    <span className="mih-studio-product-copy">
                      <span><strong>{project.name}</strong><em>{projectKindLabel(project.kind)}</em></span>
                      <code>{project.agentKey}</code>
                      <small>{project.summary}</small>
                      <span className="mih-studio-product-owner">{project.owner} · Owner</span>
                    </span>
                  </button>
                  <div className="mih-studio-business-cell" data-column="Data scope / Tags">
                    <div>{(project.tags || []).slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div>
                    <small>Data scope</small><strong>{project.dataScope}</strong>
                  </div>
                  <div className="mih-studio-lifecycle-cell" data-column="Draft">
                    <span>Draft</span>
                    {project.draft ? <StatusBadge status={project.draft.saved ? 'active' : 'warning'}
                      label={`rev ${project.draft.revision} · ${project.draft.saved ? '已保存' : '待保存'}`} />
                      : <StatusBadge status="disabled" label="Idea · 无 Draft" />}
                    <small>{formatDate(project.draft?.updatedAt || project.updatedAt)}</small>
                  </div>
                  <div className="mih-studio-combined-cell" data-column="Compile Evidence">
                    <StatusBadge status={artifact.status} label={artifact.label} /><small>{artifact.detail}</small>
                    <code>{project.artifact?.artifactHash ? project.artifact.artifactHash.slice(0, 12) : '尚无 artifact hash'}</code>
                  </div>
                  <div className="mih-studio-product-actions">
                    <button className="qp-button qp-button--outline qp-button--sm" type="button"
                      onClick={() => onOpen(project.agentKey)}>{project.artifact?.status === 'failed' ? '修复编译' : project.draft ? '继续编辑' : '打开项目'}</button>
                    {onManage ? <button className="qp-button qp-button--ghost qp-icon-button qp-button--sm" type="button"
                      aria-label={`管理 ${project.name}`} title="管理 Agent 产品" onClick={() => onManage(project)}>
                      <DotsThreeVertical size={16} aria-hidden="true" />
                    </button> : null}
                    {!project.archived && onArchive ? <button className="qp-button qp-button--ghost qp-icon-button qp-button--sm" type="button"
                      aria-label={`归档 ${project.name}`} title="归档" onClick={() => onArchive(project)}>
                      <Archive size={15} aria-hidden="true" />
                    </button> : null}
                    {project.archived && onRestore ? <button className="qp-button qp-button--ghost qp-icon-button qp-button--sm" type="button"
                      aria-label={`恢复 ${project.name}`} title="恢复到活跃项目" onClick={() => void onRestore(project)}>
                      <ArrowCounterClockwise size={15} aria-hidden="true" />
                    </button> : null}
                  </div>
                </article>
              )
            })}
          </div>
          {!filteredProjects.length ? (
            <EmptyState icon={tab === 'artifacts' ? FileCode : Brain}
              title={tab === 'artifacts' ? '没有真实 Artifact' : tab === 'archived' ? '没有已归档项目' : '没有匹配的 Agent 产品'}
              description={tabDescription || (projects.length ? '调整搜索或多维筛选条件。' : '从已审核模板创建第一个 Draft。')}
              action={!projects.length && canMutate ? <button className="qp-button qp-button--primary" type="button" onClick={() => onCreate()}><Plus size={16} aria-hidden="true" />新建 Agent</button> : undefined} />
          ) : null}
          <footer className="mih-studio-products-footer">
            <span>显示 {filteredProjects.length} / {projects.length} 个服务端项目</span>
            <span>只按服务端 Draft 与 Artifact 事实计算；不推断运行、评测或发布状态。</span>
          </footer>
        </section>
      ) : null}

      <section className="mih-studio-native-lifecycle" aria-label="Hub 原生 Agent 能力链">
        <div data-state="available"><NotePencil size={16} aria-hidden="true" /><span><strong>Build</strong><small>Draft、Prompt、DAG · 可用</small></span></div>
        <div data-state="available"><ShieldCheck size={16} aria-hidden="true" /><span><strong>Compile Evidence</strong><small>类型、策略、预算 · 可用</small></span></div>
        <div data-state="future"><LockKey size={15} aria-hidden="true" /><span><strong>Run Trace</strong><small>Hub Event Ledger · P2</small></span></div>
        <div data-state="future"><LockKey size={15} aria-hidden="true" /><span><strong>Eval Dataset</strong><small>Suite、Cases、Dataset · 规划中</small></span></div>
        <div data-state="future"><LockKey size={15} aria-hidden="true" /><span><strong>Gate & Release</strong><small>审批、部署、Market · 规划中</small></span></div>
      </section>
    </div>
  )
}

function studioFamily(manifest: StudioNodeManifest | undefined): StudioNodeFamily {
  if (!manifest) return 'core'
  if (manifest.terminal) return 'output'
  if (manifest.determinism === 'model' || manifest.family === 'structured-llm') return 'model'
  if (manifest.family === 'read-only-tool') return 'data'
  if (manifest.family === 'route' || manifest.family === 'human-review-boundary') return 'control'
  return 'core'
}

function businessNodeLabel(nodeId: string, fallback: string): string {
  const labels: Record<string, string> = {
    source_input: '省级舆情来源契约',
    source_describe: '授权来源结构解析',
    schema_profile: '舆情字段结构画像',
    mapping_proposal: '舆情字段映射建议',
    mapping_validate: '字段映射确定性校验',
    human_review: '人工复核边界',
    mapping_output: '可审阅 Mapping 输出',
  }
  return labels[nodeId] || fallback
}

function nodeDescription(manifest: StudioNodeManifest | undefined, config: Record<string, unknown>): string {
  if (!manifest) return '当前 Registry 未提供该节点类型。'
  if (manifest.nodeType === 'core.input.source') return String(config.sourceRef || '需要配置已注册 sourceRef')
  if (manifest.nodeType === 'hub.source.describe') return '读取来源契约，不复制全量数据'
  if (manifest.nodeType === 'hub.schema.profile') return '生成有界 schema/profile 引用'
  if (manifest.nodeType === 'llm.mapping.propose') return '生成 proposal，不自动批准或入库'
  if (manifest.nodeType === 'hub.mapping.validate') return '按目标字段与 typed ports 复验'
  if (manifest.nodeType === 'core.review.mapping-required') return '强制人工复核，不能由模型绕过'
  if (manifest.nodeType === 'core.output.mapping') return '输出经复核的映射候选'
  return `${manifest.determinism} · ${manifest.effect === 'read' ? '只读' : '无写入副作用'}`
}

function manifestMap(manifests: StudioNodeManifest[]): Map<string, StudioNodeManifest> {
  return new Map(manifests.map((item) => [`${item.nodeType}@${item.nodeVersion}`, item]))
}

const COMPACT_MAPPING_TEMPLATE_POSITIONS: Record<string, { x: number, y: number }> = {
  source: { x: 20, y: 60 },
  source_route: { x: 250, y: 60 },
  schema_profile: { x: 480, y: 60 },
  mapping_proposal: { x: 20, y: 270 },
  mapping_validation: { x: 250, y: 270 },
  human_review: { x: 480, y: 270 },
  mapping_output: { x: 250, y: 480 },
}

function visiblePositions(definition: AgentStudioDefinition): Record<string, { x: number, y: number }> {
  const positions = definition.ui?.positions || {}
  const templateNodeIds = Object.keys(COMPACT_MAPPING_TEMPLATE_POSITIONS)
  const isWideSeedLayout = templateNodeIds.every((nodeId) => definition.nodes.some((node) => node.nodeId === nodeId))
    && Math.max(...templateNodeIds.map((nodeId) => positions[nodeId]?.x || 0)) >= 1200
    && Math.max(...templateNodeIds.map((nodeId) => positions[nodeId]?.y || 0))
      - Math.min(...templateNodeIds.map((nodeId) => positions[nodeId]?.y || 0)) <= 200
  return isWideSeedLayout ? { ...positions, ...COMPACT_MAPPING_TEMPLATE_POSITIONS } : positions
}

function makeNodeFromDefinition(
  node: AgentStudioDefinition['nodes'][number],
  position: { x: number, y: number },
  manifest: StudioNodeManifest | undefined,
  onInspect: (nodeId: string) => void,
): StudioFlowNode {
  const config = structuredClone(node.config)
  const family = studioFamily(manifest)
  const data: StudioNodeData = {
    label: businessNodeLabel(node.nodeId, manifest?.displayName || node.nodeType),
    description: nodeDescription(manifest, config),
    nodeType: node.nodeType,
    version: node.nodeVersion,
    family,
    effect: manifest?.determinism === 'model' ? 'model' : manifest?.effect || 'none',
    determinism: manifest?.determinism || 'deterministic',
    available: Boolean(manifest),
    phase: manifest?.availableFrom,
    systemPrompt: typeof config.systemPrompt === 'string' ? config.systemPrompt : undefined,
    userPrompt: typeof config.taskTemplate === 'string'
      ? config.taskTemplate
      : typeof config.promptTemplate === 'string' ? config.promptTemplate : undefined,
    sequenceKey: typeof config.sequenceKey === 'string' ? config.sequenceKey : undefined,
    schemaRef: typeof config.targetSchemaRef === 'string'
      ? config.targetSchemaRef
      : typeof config.outputSchemaRef === 'string' ? config.outputSchemaRef : undefined,
    inputRef: manifest?.inputPorts.map((port) => port.key).join(' · ') || undefined,
    outputRef: manifest?.outputPorts.map((port) => port.key).join(' · ') || undefined,
    inputPorts: manifest?.inputPorts || [],
    outputPorts: manifest?.outputPorts || [],
    config,
    entry: manifest?.entry || false,
    terminal: manifest?.terminal || false,
    onInspect,
  }
  return {
    id: node.nodeId,
    type: 'studio',
    position,
    data,
    ariaLabel: `${data.label}，${data.nodeType}`,
  }
}

function graphFromDefinition(
  definition: AgentStudioDefinition,
  manifests: StudioNodeManifest[],
  onInspect: (nodeId: string) => void,
): { nodes: StudioFlowNode[], edges: StudioFlowEdge[] } {
  const byKey = manifestMap(manifests)
  const positions = visiblePositions(definition)
  const nodes = definition.nodes.map((node, index) => makeNodeFromDefinition(
    node,
    positions[node.nodeId] || { x: 40 + (index % 5) * 238, y: 80 + Math.floor(index / 5) * 210 },
    byKey.get(`${node.nodeType}@${node.nodeVersion}`),
    onInspect,
  ))
  const edges = definition.edges.map((edge, index): StudioFlowEdge => ({
    id: `edge-${index}-${edge.from.nodeId}-${edge.from.port}-${edge.to.nodeId}-${edge.to.port}`,
    source: edge.from.nodeId,
    sourceHandle: edge.from.port,
    target: edge.to.nodeId,
    targetHandle: edge.to.port,
    type: 'smoothstep',
    label: edge.from.port,
    animated: false,
    style: EDGE_STYLE,
    markerEnd: EDGE_MARKER,
    labelStyle: { fill: 'var(--qp-text-3)', fontSize: 9 },
    labelBgStyle: { fill: 'var(--qp-bg-3)', fillOpacity: 0.92 },
    labelBgPadding: [5, 3] as [number, number],
    labelBgBorderRadius: 4,
  }))
  return { nodes, edges }
}

function StudioNodeCard({ id, data, selected }: NodeProps<StudioFlowNode>) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      data.onInspect?.(id)
    }
  }
  return (
    <article className={`mih-studio-node is-${data.family}${selected ? ' is-selected' : ''}`}
      role="button" tabIndex={0} aria-pressed={selected} onClick={() => data.onInspect?.(id)} onKeyDown={onKeyDown}>
      {data.inputPorts.map((port, index) => (
        <Handle key={port.key} id={port.key} className="mih-studio-handle mih-studio-handle--input"
          type="target" position={Position.Left} title={`${port.key} · ${port.type}`}
          style={{ top: `${((index + 1) / (data.inputPorts.length + 1)) * 100}%` }} />
      ))}
      <header><span><NodeFamilyIcon family={data.family} /></span><small>{data.nodeType}</small></header>
      <strong>{data.label}</strong>
      <p>{data.description}</p>
      <footer>
        <span>{data.effect === 'model' ? 'MODEL' : data.effect === 'read' ? 'READ' : 'NONE'}</span>
        <code>{data.inputPorts.length} in · {data.outputPorts.length} out</code>
      </footer>
      {data.outputPorts.map((port, index) => (
        <Handle key={port.key} id={port.key} className="mih-studio-handle mih-studio-handle--output"
          type="source" position={Position.Right} title={`${port.key} · ${port.type}`}
          style={{ top: `${((index + 1) / (data.outputPorts.length + 1)) * 100}%` }} />
      ))}
    </article>
  )
}

function NodeFamilyIcon({ family }: { family: StudioNodeFamily }) {
  if (family === 'data') return <Database size={15} aria-hidden="true" />
  if (family === 'model') return <Brain size={15} aria-hidden="true" />
  if (family === 'control') return <GitBranch size={15} aria-hidden="true" />
  if (family === 'output') return <FlowArrow size={15} aria-hidden="true" />
  return <BracketsCurly size={15} aria-hidden="true" />
}

const NODE_TYPES = { studio: StudioNodeCard }

function draftPayload(
  project: StudioProjectSummary,
  draftId: string,
  revision: number,
  nodes: StudioFlowNode[],
  edges: StudioFlowEdge[],
  baseDefinition: AgentStudioDefinition,
): AgentStudioDraftPayload {
  const terminalNodeIds = nodes.filter((node) => node.data.terminal).map((node) => node.id)
  const entryNodeId = nodes.find((node) => node.id === baseDefinition.entryNodeId && node.data.entry)?.id
    || nodes.find((node) => node.data.entry)?.id
    || baseDefinition.entryNodeId
  return {
    agentKey: project.agentKey,
    draftId,
    expectedRevision: revision,
    definition: {
      contractVersion: 'mx-insight.agent-draft.v1',
      entryNodeId,
      terminalNodeIds: terminalNodeIds.length ? terminalNodeIds : baseDefinition.terminalNodeIds,
      nodes: nodes.map((node) => ({
        nodeId: node.id,
        nodeType: node.data.nodeType,
        nodeVersion: node.data.version,
        config: structuredClone(node.data.config),
      })),
      edges: edges.map((edge) => ({
        from: { nodeId: edge.source, port: String(edge.sourceHandle || '') },
        to: { nodeId: edge.target, port: String(edge.targetHandle || '') },
      })),
      ...(baseDefinition.budgets ? { budgets: structuredClone(baseDefinition.budgets) } : {}),
      ui: {
        positions: Object.fromEntries(nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }])),
        ...(baseDefinition.ui?.viewport ? { viewport: structuredClone(baseDefinition.ui.viewport) } : {}),
        groups: structuredClone(baseDefinition.ui?.groups || []),
        annotations: structuredClone(baseDefinition.ui?.annotations || []),
      },
    },
  }
}

function validateDraft(nodes: StudioFlowNode[], edges: StudioFlowEdge[]): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = []
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  for (const edge of edges) {
    outgoing.set(edge.source, (outgoing.get(edge.source) || 0) + 1)
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1)
  }
  for (const node of nodes) {
    if (!node.data.available) diagnostics.push({
      code: 'CAPABILITY-001', severity: 'error', location: node.data.label,
      message: `${node.data.nodeType} 属于 ${node.data.phase || '未来'} 能力，不能进入 P1 artifact。`,
    })
    if (node.data.determinism === 'model') {
      if (!node.data.sequenceKey) diagnostics.push({
        code: 'MODEL-001', severity: 'error', location: node.data.label,
        message: '模型节点必须显式选择一个 LLM Sequence。',
      })
      if (!node.data.systemPrompt?.trim() || !node.data.userPrompt?.trim()) diagnostics.push({
        code: 'PROMPT-001', severity: 'error', location: node.data.label,
        message: 'System Prompt 与 User Template 均不能为空。',
      })
    }
    if (!node.data.entry && !incoming.get(node.id)) diagnostics.push({
      code: 'TOPOLOGY-001', severity: 'warning', location: node.data.label,
      message: '节点没有入边；请连接兼容 typed port 或移除孤立节点。',
    })
    if (!node.data.terminal && !outgoing.get(node.id)) diagnostics.push({
      code: 'TOPOLOGY-002', severity: 'warning', location: node.data.label,
      message: '节点没有出边；当前路径不能到达终点。',
    })
  }
  if (!diagnostics.length) diagnostics.push({
    code: 'P1-BOUNDARY', severity: 'info', location: 'Compile',
    message: 'P1 静态定义通过本地前置检查；Sandbox、Eval、Release、Deploy 与 Market 发布仍未启用。',
  })
  return diagnostics
}

function paletteGroup(manifest: StudioNodeManifest): string {
  if (manifest.determinism === 'model') return 'AI · Structured LLM'
  if (manifest.family === 'read-only-tool') return 'Hub 数据 · 只读'
  if (manifest.family === 'route' || manifest.family === 'human-review-boundary') return '控制与复核'
  return '通用'
}

function Palette({ manifests, canMutate, onAdd }: {
  manifests: StudioNodeManifest[]
  canMutate: boolean
  onAdd: (key: string, position?: { x: number, y: number }) => void
}) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLocaleLowerCase('zh-CN')
  const groups = useMemo(() => {
    const installed = new Map<string, StudioNodeManifest[]>()
    for (const manifest of manifests) {
      const group = paletteGroup(manifest)
      installed.set(group, [...(installed.get(group) || []), manifest])
    }
    return [...installed.entries()]
  }, [manifests])
  return (
    <aside className="mih-studio-palette" aria-label="受治理节点目录">
      <header><div><p className="qp-kicker">GOVERNED PALETTE</p><h2>节点目录</h2></div><StatusBadge status="active" label="P1" /></header>
      <label className="mih-studio-palette-search">
        <MagnifyingGlass size={15} aria-hidden="true" />
        <span className="mih-studio-sr-only">搜索节点</span>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索节点类型" />
      </label>
      <div className="mih-studio-palette-groups">
        {groups.map(([group, manifestsInGroup]) => {
          const items = manifestsInGroup.filter((item) => !query || [item.displayName, item.nodeType, item.family]
            .join('\n').toLocaleLowerCase('zh-CN').includes(query))
          if (!items.length) return null
          return (
            <section key={group}>
              <h3>{group}</h3>
              {items.map((item) => {
                const family = studioFamily(item)
                return (
                  <button key={`${item.nodeType}@${item.nodeVersion}`} type="button" draggable={canMutate}
                    disabled={!canMutate}
                    title={canMutate ? '点击添加，或拖到画布' : '只读会话，需 Hub Admin Token 修改'}
                    onClick={() => onAdd(`${item.nodeType}@${item.nodeVersion}`)}
                    onDragStart={(event) => {
                      if (!canMutate) return
                      event.dataTransfer.setData('application/x-mih-studio-node', `${item.nodeType}@${item.nodeVersion}`)
                      event.dataTransfer.effectAllowed = 'copy'
                    }}>
                    <span className={`is-${family}`}><NodeFamilyIcon family={family} /></span>
                    <span><strong>{item.displayName}</strong><small>{item.effect === 'read' ? '只读 Hub capability' : `${item.determinism} · 无业务写入`}</small><code>{item.nodeType}</code></span>
                    <Plus size={14} aria-hidden="true" />
                  </button>
                )
              })}
            </section>
          )
        })}
        <section>
          <h3>未来能力</h3>
          {FUTURE_PALETTE_ITEMS.filter((item) => !query || [item.label, item.description, item.key]
            .join('\n').toLocaleLowerCase('zh-CN').includes(query)).map((item) => {
            const Icon = item.icon
            return (
              <button key={item.key} type="button" disabled title={`${item.phase} 未来能力`}>
                <span className={`is-${item.family}`}><Icon size={16} aria-hidden="true" /></span>
                <span><strong>{item.label}</strong><small>{item.description}</small><code>{item.key}</code></span>
                <span className="mih-studio-phase"><LockKey size={11} aria-hidden="true" />{item.phase}</span>
              </button>
            )
          })}
        </section>
      </div>
      <footer><Info size={14} aria-hidden="true" /><span>点击添加或拖入画布。浏览器连接校验不替代服务端 Compiler。</span></footer>
    </aside>
  )
}

function Inspector({
  node,
  tab,
  sequences,
  canMutate,
  onTab,
  onChange,
}: {
  node: StudioFlowNode | null
  tab: InspectorTab
  sequences: StudioSequenceOption[]
  canMutate: boolean
  onTab: (tab: InspectorTab) => void
  onChange: (patch: Partial<StudioNodeData>) => void
}) {
  if (!node) return (
    <aside className="mih-studio-inspector mih-studio-inspector--empty">
      <FlowArrow size={30} weight="duotone" aria-hidden="true" /><strong>节点检查器</strong><p>点击画布节点查看配置。</p>
    </aside>
  )
  const supportsPrompt = node.data.determinism === 'model'
  const sequence = sequences.find((item) => item.sequenceKey === node.data.sequenceKey) || null
  const promptVariables = node.data.nodeType === 'llm.mapping.propose'
    ? ['{{schemaProfile}}', '{{sampleFields}}', '{{targetSchema}}']
    : ['{{query}}', '{{evidence}}', '{{outputSchema}}']
  const tabs: Array<{ id: InspectorTab, label: string, disabled?: boolean }> = [
    { id: 'prompt', label: 'Prompt', disabled: !supportsPrompt },
    { id: 'config', label: '配置' },
    { id: 'io', label: 'I/O' },
    { id: 'policy', label: '策略' },
    { id: 'run', label: '运行' },
  ]
  return (
    <aside className="mih-studio-inspector" aria-label={`${node.data.label} 节点检查器`}>
      <header>
        <div><p className="qp-kicker">NODE INSPECTOR</p><h2>{node.data.label}</h2><code>{node.data.nodeType} · {node.data.version}</code></div>
        <StatusBadge status={node.data.available ? 'active' : 'disabled'} label={node.data.effect === 'model' ? 'Model' : node.data.effect === 'read' ? 'Read-only' : 'No effect'} />
      </header>
      <div className="qp-panel-tabs mih-studio-inspector-tabs" role="tablist" aria-label="节点详情">
        {tabs.map((item) => (
          <button key={item.id} className={`qp-panel-tab${tab === item.id ? ' is-active' : ''}`} type="button"
            role="tab" aria-selected={tab === item.id} disabled={item.disabled} onClick={() => onTab(item.id)}>{item.label}</button>
        ))}
      </div>
      <div className="mih-studio-inspector-body">
        {tab === 'prompt' && supportsPrompt ? (
          <div className="mih-studio-prompt-editor">
            {Object.hasOwn(node.data.config, 'systemPrompt') ? (
              <Field label="System Prompt" hint="保存到 Draft；不会覆盖 code-owned policy。">
                <textarea className="qp-input" value={node.data.systemPrompt || ''}
                  disabled={!canMutate}
                  onChange={(event) => onChange({ systemPrompt: event.target.value })} />
              </Field>
            ) : null}
            <Field label={Object.hasOwn(node.data.config, 'taskTemplate') ? 'Task Template' : 'Prompt Template'}
              hint="可用变量由 code-owned node manifest 约束。">
              <textarea className="qp-input" value={node.data.userPrompt || ''}
                disabled={!canMutate}
                onChange={(event) => onChange({ userPrompt: event.target.value })} />
            </Field>
            <div className="mih-studio-variable-list" aria-label="可用 Prompt 变量">
              {promptVariables.map((variable) => <span key={variable}>{variable}</span>)}
            </div>
            <DropdownField label="LLM Sequence" value={node.data.sequenceKey || ''}
              disabled={!canMutate}
              onChange={(sequenceKey: string) => onChange({ sequenceKey })}
              options={sequences.map((item) => ({
                value: item.sequenceKey,
                label: `${item.label} · rev ${item.revision}`,
                description: item.description,
              })) as never[]} placeholder="显式选择 Sequence" />
            <section className="mih-studio-execution-route" aria-label="模型执行路径">
              <header><span><ShieldCheck size={16} aria-hidden="true" />模型执行路径</span><small>只读解析</small></header>
              <dl>
                <div><dt>Resolved model</dt><dd>{sequence?.effectiveModel || '尚未解析'}</dd></div>
                <div><dt>Egress</dt><dd>{sequence ? sequence.egressMode : '尚未选择 Sequence'}</dd></div>
                <div><dt>Effective Proxy</dt><dd>{sequence?.effectiveProxy || '尚未解析'}</dd></div>
                <div><dt>Route proof</dt><dd><StatusBadge status={sequence?.routeProof === 'valid' ? 'active' : 'warning'}
                  label={sequence?.routeProof === 'valid' ? `有效 · ${formatDate(sequence.verifiedAt)}` : sequence ? '需重新验证' : '缺少'} /></dd></div>
              </dl>
              <p>Provider、Proxy 和模型密钥由 Hub control plane 解析，不作为业务流程节点或明文 Draft 配置。</p>
            </section>
          </div>
        ) : null}
        {tab === 'config' ? (
          <div className="mih-studio-inspector-stack">
            <div className="mih-studio-readonly-grid">
              <div><span>Node ID</span><code>{node.id}</code></div>
              <div><span>Node type</span><code>{node.data.nodeType}</code></div>
              <div><span>Version</span><code>{node.data.version}</code></div>
              <div><span>Determinism</span><code>{node.data.determinism}</code></div>
              <div><span>Effect</span><code>{node.data.effect === 'model' ? 'none · model call' : node.data.effect}</code></div>
              <div><span>Availability</span><code>{node.data.available ? 'installed' : node.data.phase || 'future'}</code></div>
            </div>
            <section className="mih-studio-config-facts">
              <header><strong>Definition config</strong><small>只保存 Registry 允许的字段</small></header>
              {Object.entries(node.data.config).length ? Object.entries(node.data.config).map(([key, value]) => (
                <div key={key}><code>{key}</code><span>{Array.isArray(value) ? value.join('、') : String(value)}</span></div>
              )) : <p>该节点没有可配置字段。</p>}
            </section>
          </div>
        ) : null}
        {tab === 'io' ? (
          <div className="mih-studio-inspector-stack">
            <section className="mih-studio-port-card"><span>INPUT</span>
              {node.data.inputPorts.length ? node.data.inputPorts.map((port) => <div key={port.key}><strong>{port.key}</strong><code>{port.type}</code><small>{port.required ? 'required' : 'optional'}</small></div>) : <strong>无输入端口</strong>}
              <small>连接仍由服务端按 manifest hash 与 port type 复验。</small>
            </section>
            <section className="mih-studio-port-card"><span>OUTPUT</span>
              {node.data.outputPorts.length ? node.data.outputPorts.map((port) => <div key={port.key}><strong>{port.key}</strong><code>{port.type}</code><small>{port.required ? 'required' : 'optional'}</small></div>) : <strong>无输出端口</strong>}
              <small>大 payload 只传 artifact reference。</small>
            </section>
            {node.data.schemaRef ? <section className="mih-studio-port-card"><span>SCHEMA</span><strong>{node.data.schemaRef}</strong><small>发布时 pin 到 immutable 版本。</small></section> : null}
          </div>
        ) : null}
        {tab === 'policy' ? (
          <div className="mih-studio-policy-list">
            <div><ShieldCheck size={17} aria-hidden="true" /><span><strong>P1 effect</strong><small>{node.data.effect === 'read' ? '只读 Hub capability' : node.data.effect === 'model' ? '受预算的模型调用' : '无业务写入'}</small></span></div>
            <div><LockKey size={17} aria-hidden="true" /><span><strong>Secrets</strong><small>Draft 不保存 Provider、Proxy 凭据或 Launcher token。</small></span></div>
            <div><Database size={17} aria-hidden="true" /><span><strong>Data scope</strong><small>每次执行仍需 row / column / tenant policy。</small></span></div>
          </div>
        ) : null}
        {tab === 'run' ? (
          <EmptyState icon={Play} title="暂无运行事件"
            description="Sandbox runtime 属于 P2。P1 不按计时器模拟节点执行、Provider、Proxy 或边状态。" action={undefined} />
        ) : null}
      </div>
    </aside>
  )
}

type StudioEvidenceReference = {
  kind: string
  value: string
  source: 'draft' | 'artifact'
}

function evidenceReferences(nodes: StudioFlowNode[], compileResult: AgentStudioCompileResult | null): StudioEvidenceReference[] {
  const keys: Record<string, string> = {
    sourceRef: 'source',
    datasetRef: 'dataset',
    profileRef: 'search-profile',
    targetSchemaRef: 'schema',
    outputSchemaRef: 'schema',
    sequenceKey: 'llm-sequence',
  }
  const values = new Map<string, StudioEvidenceReference>()
  for (const node of nodes) {
    for (const [configKey, kind] of Object.entries(keys)) {
      const value = node.data.config[configKey]
      if (typeof value !== 'string' || !value.trim()) continue
      values.set(`${kind}:${value}`, { kind, value, source: 'draft' })
    }
  }
  for (const ref of compileResult?.dependencyManifest?.logicalRefs || []) {
    if (!ref?.kind || !ref?.key) continue
    values.set(`${ref.kind}:${ref.key}`, { kind: ref.kind, value: ref.key, source: 'artifact' })
  }
  return [...values.values()].sort((left, right) => `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`))
}

function EvidenceDrawer({
  tab,
  diagnostics,
  compileResult,
  references,
  compiling,
  onTab,
}: {
  tab: EvidenceTab
  diagnostics: StudioDiagnostic[]
  compileResult: AgentStudioCompileResult | null
  references: StudioEvidenceReference[]
  compiling: boolean
  onTab: (tab: EvidenceTab) => void
}) {
  const errors = diagnostics.filter((item) => item.severity === 'error').length
  const warnings = diagnostics.filter((item) => item.severity === 'warning').length
  const assurance = compileResult?.assurance || compileResult?.normalizedPlan?.assurance || null
  return (
    <section className="mih-studio-evidence" aria-label="编译与运行证据">
      <header>
        <div className="mih-studio-evidence-tabs" role="tablist">
          <button className={tab === 'diagnostics' ? 'is-active' : ''} type="button" role="tab"
            aria-selected={tab === 'diagnostics'} onClick={() => onTab('diagnostics')}>编译诊断 · {errors} 错误 / {warnings} 警告</button>
          <button className={tab === 'assurance' ? 'is-active' : ''} type="button" role="tab"
            aria-selected={tab === 'assurance'} onClick={() => onTab('assurance')}>Hub 验证 · {assurance?.checks.length || 0}</button>
          <button className={tab === 'events' ? 'is-active' : ''} type="button" role="tab"
            aria-selected={tab === 'events'} onClick={() => onTab('events')}>Run Trace · 未启用</button>
          <button className={tab === 'references' ? 'is-active' : ''} type="button" role="tab"
            aria-selected={tab === 'references'} onClick={() => onTab('references')}>受治理引用 · {references.length}</button>
        </div>
        <div className="mih-studio-artifact-facts">
          {compiling ? <span><Clock size={14} aria-hidden="true" />编译中</span> : null}
          <span>Artifact <code>{compileResult?.artifactId || '尚未由服务端生成'}</code></span>
          <span>Hash <code>{compileResult?.artifactHash || '—'}</code></span>
          {compileResult?.compilerVersion ? <span>Compiler <code>{compileResult.compilerVersion}</code></span> : null}
        </div>
      </header>
      <div className="mih-studio-evidence-body">
        {tab === 'diagnostics' ? (
          diagnostics.length ? <div className="mih-studio-diagnostics">
            {diagnostics.map((item, index) => (
              <article key={`${item.code}-${index}`} data-severity={item.severity}>
                {item.severity === 'error' ? <Warning size={16} aria-hidden="true" />
                  : item.severity === 'warning' ? <Warning size={16} aria-hidden="true" />
                    : <Info size={16} aria-hidden="true" />}
                <code>{item.code}</code><span>{item.message}</span><small>{item.location || 'Draft'}</small>
              </article>
            ))}
          </div> : <div className="mih-studio-evidence-empty"><CheckCircle size={20} aria-hidden="true" /><span>{compileResult?.artifactId
            ? '编译通过；已生成不可变 Artifact。P1 仍不可运行。'
            : '尚未编译；保存 Draft 后运行静态验证。'}</span></div>
        ) : null}
        {tab === 'assurance' ? (assurance ? (
          <div className="mih-studio-assurance-grid">
            {assurance.checks.map((check) => (
              <article key={check.key} data-status={check.status}>
                {check.status === 'passed' ? <CheckCircle size={16} aria-hidden="true" /> : check.status === 'failed' ? <Warning size={16} aria-hidden="true" /> : <Clock size={16} aria-hidden="true" />}
                <span><strong>{check.label}</strong><code>{check.key}</code></span>
                <StatusBadge status={check.status === 'passed' ? 'active' : check.status === 'failed' ? 'down' : 'disabled'}
                  label={check.status === 'passed' ? '通过' : check.status === 'failed' ? '失败' : '未执行'} />
              </article>
            ))}
            <p><ShieldCheck size={14} aria-hidden="true" />这是 Hub Compiler 的静态证据，不代表 Sandbox 已运行、Eval 已通过或 Agent 可发布。</p>
          </div>
        ) : <div className="mih-studio-evidence-empty"><ShieldCheck size={20} aria-hidden="true" /><span>{compileResult?.artifactId
          ? '该 Artifact 未包含 mx-insight.agent-static-assurance.v1；重新编译可生成 Hub 原生验证证据。'
          : '编译后由服务端生成 Hub 原生静态验证证据。'}</span></div>) : null}
        {tab === 'events' ? <div className="mih-studio-evidence-empty"><LockKey size={20} aria-hidden="true" /><span>Hub Run/Event Ledger 尚未启用。Build edge 保持中性，不模拟 running / succeeded / failed。</span></div> : null}
        {tab === 'references' ? (
          references.length ? <div className="mih-studio-reference-grid">
            {references.map((reference) => <div key={`${reference.kind}:${reference.value}`}><span>{reference.kind}</span><code title={reference.value}>{reference.value}</code><small>{reference.source === 'artifact' ? 'Artifact dependency manifest' : 'Draft node config'}</small></div>)}
          </div> : <div className="mih-studio-evidence-empty"><Database size={20} aria-hidden="true" /><span>当前 Draft 没有可解析的 source / dataset / schema / sequence 引用。</span></div>
        ) : null}
      </div>
    </section>
  )
}

function LifecycleRail({ onCompile, compileDisabled }: { onCompile: () => void, compileDisabled: boolean }) {
  const items: Array<{ label: string, hint: string, state: 'done' | 'active' | 'ready' | 'future', phase?: string }> = [
    { label: 'Idea', hint: '用途与边界', state: 'done' },
    { label: 'Template', hint: '已选择', state: 'done' },
    { label: 'Build', hint: '编辑 Draft', state: 'active' },
    { label: 'Compile', hint: '静态验证', state: 'ready' },
    { label: 'Sandbox', hint: '运行事件', state: 'future', phase: 'P2' },
    { label: 'Eval', hint: '评测门', state: 'future', phase: 'P4' },
    { label: 'Release', hint: '不可变版本', state: 'future', phase: 'P4' },
    { label: 'Deploy', hint: '环境指针', state: 'future', phase: 'P4' },
    { label: 'Market', hint: '产品发布', state: 'future', phase: 'P4' },
  ]
  return (
    <ol className="mih-studio-lifecycle" aria-label="Agent 生命周期">
      {items.map((item) => (
        <li key={item.label} data-state={item.state}>
          <button type="button" disabled={item.state === 'future' || (item.label === 'Compile' && compileDisabled)}
            onClick={item.label === 'Compile' ? onCompile : undefined}>
            <span>{item.state === 'done' ? <Check size={13} aria-hidden="true" />
              : item.state === 'future' ? <LockKey size={12} aria-hidden="true" />
                : item.label === 'Build' ? <NotePencil size={13} aria-hidden="true" />
                  : <FileCode size={13} aria-hidden="true" />}</span>
            <strong>{item.label}</strong><small>{item.hint}</small>{item.phase ? <em>{item.phase}</em> : null}
          </button>
        </li>
      ))}
    </ol>
  )
}

function defaultConfig(manifest: StudioNodeManifest, sequences: StudioSequenceOption[]): Record<string, unknown> {
  if (manifest.nodeType === 'core.input.source') {
    return { sourceRef: 'source://hub/public-opinion.province.v1' }
  }
  if (manifest.nodeType === 'core.route.source') return { sourceKind: 'postgresql' }
  if (manifest.nodeType === 'hub.mapping.validate') {
    return { requiredFields: ['externalId', 'title', 'body', 'eventTime', 'sourceUrl'] }
  }
  if (manifest.nodeType === 'llm.mapping.propose') {
    return {
      sequenceKey: sequences[0]?.sequenceKey || '',
      systemPrompt: '只根据已授权的结构画像与目标 Schema 生成 Mapping Proposal；不要编造来源字段、批准映射或执行入库。',
      taskTemplate: '来源结构：{{schemaProfile}}\n目标 Schema：{{targetSchema}}\n请输出结构化 mapping proposal。',
      targetSchemaRef: 'schema://hub/canonical-content.v1',
      temperature: 0.2,
      maxOutputTokens: 2000,
    }
  }
  if (manifest.nodeType === 'hub.retrieval.hybrid') {
    return {
      datasetRef: 'dataset://hub/canonical-content.v1',
      profileRef: 'search-profile://canonical.balanced.v1',
      topK: 12,
    }
  }
  if (manifest.nodeType === 'llm.structured.answer') {
    return {
      sequenceKey: sequences[0]?.sequenceKey || '',
      promptTemplate: '只根据授权证据回答，并保留 citations。',
      outputSchemaRef: 'schema://hub/agent-output/grounded-answer.v1',
      temperature: 0.2,
      maxOutputTokens: 2000,
    }
  }
  return {}
}

function nextNodeIdFor(manifest: StudioNodeManifest, nodes: StudioFlowNode[]): string {
  const base = manifest.nodeType.split('.').slice(-2).join('_').replace(/[^a-z0-9_]/gu, '_').slice(0, 52)
  const used = new Set(nodes.map((node) => node.id))
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}_${index}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}_${Date.now().toString(36)}`.slice(0, 63)
}

function compileResultFromProject(project: StudioProjectSummary): AgentStudioCompileResult | null {
  if (!project.artifact) return null
  return {
    status: project.artifact.status,
    artifactId: project.artifact.artifactId,
    artifactHash: project.artifact.artifactHash,
    compiledAt: project.artifact.compiledAt,
    diagnostics: [],
  }
}

function StudioWorkbench({
  project,
  draft,
  artifact,
  manifests,
  preview,
  canMutate,
  sequences,
  notify,
  onBack,
  saveDraft,
  compileDraft,
  onCompileComplete,
}: {
  project: StudioProjectSummary
  draft: StudioDraft
  artifact?: AgentStudioCompileResult | null
  manifests: StudioNodeManifest[]
  preview: boolean
  canMutate: boolean
  sequences: StudioSequenceOption[]
  notify?: (message: string, tone?: string) => void
  onBack: () => void
  saveDraft?: AgentStudioPageProps['saveDraft']
  compileDraft?: AgentStudioPageProps['compileDraft']
  onCompileComplete?: (result: AgentStudioCompileResult) => void
}) {
  const initialSelectedNodeId = draft.definition.nodes.find((node) => node.nodeType === 'llm.mapping.propose')?.nodeId
    || draft.definition.nodes.find((node) => node.nodeType.startsWith('llm.'))?.nodeId
    || draft.definition.nodes[0]?.nodeId
    || ''
  const [selectedNodeId, setSelectedNodeId] = useState(initialSelectedNodeId)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('prompt')
  const inspectNode = useCallback((nodeId: string) => setSelectedNodeId(nodeId), [])
  const graph = useMemo(
    () => graphFromDefinition(draft.definition, manifests, inspectNode),
    [draft.definition, inspectNode, manifests],
  )
  const [nodes, setNodes, applyNodeChanges] = useNodesState<StudioFlowNode>(graph.nodes)
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<StudioFlowEdge>(graph.edges)
  const [flow, setFlow] = useState<ReactFlowInstance<StudioFlowNode, StudioFlowEdge> | null>(null)
  const [baseDefinition, setBaseDefinition] = useState(draft.definition)
  const [revision, setRevision] = useState(draft.revision)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [compiling, setCompiling] = useState(false)
  const [diagnostics, setDiagnostics] = useState<StudioDiagnostic[]>([])
  const [compileResult, setCompileResult] = useState<AgentStudioCompileResult | null>(() => artifact || compileResultFromProject(project))
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTab>('diagnostics')

  useEffect(() => {
    const next = graphFromDefinition(draft.definition, manifests, inspectNode)
    setNodes(next.nodes)
    setEdges(next.edges)
    setSelectedNodeId(draft.definition.nodes.find((node) => node.nodeType === 'llm.mapping.propose')?.nodeId
      || draft.definition.nodes.find((node) => node.nodeType.startsWith('llm.'))?.nodeId
      || draft.definition.nodes[0]?.nodeId
      || '')
    setBaseDefinition(draft.definition)
    setRevision(draft.revision)
    setDirty(false)
    setDiagnostics([])
    setCompileResult(artifact || compileResultFromProject(project))
  }, [artifact, draft.definition, draft.draftId, draft.revision, inspectNode, manifests, project, setEdges, setNodes])

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) || null

  useEffect(() => {
    if (selectedNode?.data.determinism !== 'model' && inspectorTab === 'prompt') setInspectorTab('config')
  }, [inspectorTab, selectedNode?.data.determinism])

  const updateSelectedNode = (patch: Partial<StudioNodeData>) => {
    if (!canMutate) return
    setNodes((current) => current.map((node) => {
      if (node.id !== selectedNodeId) return node
      const config = { ...node.data.config }
      if (patch.sequenceKey !== undefined) config.sequenceKey = patch.sequenceKey
      if (patch.systemPrompt !== undefined) config.systemPrompt = patch.systemPrompt
      if (patch.userPrompt !== undefined) {
        if (Object.hasOwn(config, 'taskTemplate')) config.taskTemplate = patch.userPrompt
        else config.promptTemplate = patch.userPrompt
      }
      return { ...node, data: { ...node.data, ...patch, config } }
    }))
    setDirty(true)
    setCompileResult(null)
  }

  const addPaletteNode = (key: string, position?: { x: number, y: number }) => {
    if (!canMutate) return
    const item = manifests.find((candidate) => `${candidate.nodeType}@${candidate.nodeVersion}` === key)
    if (!item) return
    const id = nextNodeIdFor(item, nodes)
    const nextPosition = position || { x: 760 + nodes.length * 24, y: 420 + (nodes.length % 3) * 26 }
    const node = makeNodeFromDefinition({
      nodeId: id,
      nodeType: item.nodeType,
      nodeVersion: item.nodeVersion,
      config: defaultConfig(item, sequences),
    }, nextPosition, item, inspectNode)
    setNodes((current) => [...current, node])
    setSelectedNodeId(id)
    setInspectorTab(item.determinism === 'model' ? 'prompt' : 'config')
    setDirty(true)
    setCompileResult(null)
  }

  const validConnection = useCallback((connection: Connection | StudioFlowEdge) => {
    if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return false
    const sourceNode = nodes.find((node) => node.id === connection.source)
    const targetNode = nodes.find((node) => node.id === connection.target)
    const output = sourceNode?.data.outputPorts.find((port) => port.key === connection.sourceHandle)
    const input = targetNode?.data.inputPorts.find((port) => port.key === connection.targetHandle)
    return Boolean(output && input && output.type === input.type)
  }, [nodes])

  const connect = (connection: Connection) => {
    if (!canMutate) return
    if (!validConnection(connection)) {
      notify?.('只能连接类型兼容的显式 ports。', 'warning')
      return
    }
    setEdges((current) => addEdge({
      ...connection,
      id: `edge-${connection.source}-${connection.target}-${Date.now()}`,
      type: 'smoothstep', label: connection.sourceHandle, animated: false,
      style: EDGE_STYLE, markerEnd: EDGE_MARKER,
      labelStyle: { fill: 'var(--qp-text-3)', fontSize: 9 },
      labelBgStyle: { fill: 'var(--qp-bg-3)', fillOpacity: 0.92 },
      labelBgPadding: [5, 3] as [number, number],
      labelBgBorderRadius: 4,
    }, current))
    setDirty(true)
    setCompileResult(null)
  }

  const save = async () => {
    if (!canMutate) return
    if (!saveDraft && !preview) {
      notify?.('Draft 保存接口尚未接入。', 'error')
      return
    }
    setSaving(true)
    try {
      const payload = draftPayload(project, draft.draftId, revision, nodes, edges, baseDefinition)
      const result = await saveDraft?.(payload)
      const resultRevision = result && 'revision' in result ? result.revision : undefined
      setRevision(resultRevision ?? revision + (saveDraft ? 0 : 1))
      setBaseDefinition(payload.definition)
      setDirty(false)
      setCompileResult(null)
      notify?.(saveDraft ? 'Agent Studio Draft 已保存' : '预览草稿已在当前页面保存；未写入服务端', saveDraft ? 'success' : 'info')
    } catch (error) {
      notify?.(error instanceof Error ? error.message : '保存 Draft 失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const compile = async () => {
    if (!canMutate) return
    if (dirty) {
      notify?.('请先保存当前 Draft，再生成不可变编译产物。', 'warning')
      return
    }
    setCompiling(true)
    setEvidenceTab('diagnostics')
    try {
      const localDiagnostics = validateDraft(nodes, edges)
      const localErrors = localDiagnostics.some((item) => item.severity === 'error')
      if (localErrors) {
        setDiagnostics(localDiagnostics)
        setCompileResult({ status: 'failed', diagnostics: localDiagnostics })
        return
      }
      if (!compileDraft) {
        setDiagnostics(localDiagnostics)
        setCompileResult({ status: localDiagnostics.some((item) => item.severity === 'warning') ? 'warnings' : 'valid', diagnostics: localDiagnostics })
        notify?.('前端静态检查完成；未生成服务端 artifact', 'info')
        return
      }
      const result = await compileDraft({ agentKey: project.agentKey, draftId: draft.draftId, expectedRevision: revision })
      const finalResult: AgentStudioCompileResult = result || { status: 'valid', diagnostics: localDiagnostics }
      setDiagnostics(finalResult.diagnostics || localDiagnostics)
      setCompileResult(finalResult)
      setEvidenceTab(finalResult.status === 'failed' ? 'diagnostics' : 'assurance')
      onCompileComplete?.(finalResult)
      notify?.(finalResult.status === 'failed' ? 'Draft 编译失败' : 'Draft 已由服务端编译', finalResult.status === 'failed' ? 'error' : 'success')
    } catch (error) {
      const diagnostic = { code: 'COMPILE-REQUEST', severity: 'error' as const, message: error instanceof Error ? error.message : '编译请求失败', location: 'Compiler' }
      setDiagnostics([diagnostic])
      setCompileResult({ status: 'failed', diagnostics: [diagnostic] })
      notify?.(diagnostic.message, 'error')
    } finally {
      setCompiling(false)
    }
  }

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (!canMutate) return
    const key = event.dataTransfer.getData('application/x-mih-studio-node')
    if (!key || !flow) return
    addPaletteNode(key, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }

  const references = useMemo(() => evidenceReferences(nodes, compileResult), [compileResult, nodes])

  return (
    <div className="mih-studio-page mih-studio-detail-page">
      <PageHeading eyebrow="AGENT CENTER / AGENT STUDIO / DRAFT"
        title={project.name}
        description={`${project.summary || '在 Hub 中编排受治理的 Agent。'} 当前仅支持 Draft Build 与静态 Compile，不执行数据导入、Sandbox 或发布。`}
        loading={false} onRefresh={undefined}>
        <button className="qp-button qp-button--ghost" type="button" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />全部 Agent
        </button>
        <StatusBadge status={dirty ? 'warning' : 'active'} label={dirty ? `Draft rev ${revision} · 待保存` : `Draft rev ${revision} · 已保存`} />
        <button className="qp-button qp-button--outline" type="button"
          disabled={!canMutate || !dirty || saving || (!preview && !saveDraft)} onClick={save}
          title={!canMutate ? '只读会话，需 Hub Admin Token 修改' : !preview && !saveDraft ? 'Draft 保存接口尚未接入' : undefined}>
          <NotePencil size={16} aria-hidden="true" />{saving ? '保存中' : '保存草稿'}
        </button>
        <button className="qp-button qp-button--primary" type="button"
          disabled={!canMutate || dirty || compiling || (!preview && !compileDraft)} onClick={compile}
          title={!canMutate ? '只读会话，需 Hub Admin Token 修改' : !preview && !compileDraft ? 'Compiler 接口尚未接入' : undefined}>
          <FileCode size={16} aria-hidden="true" />{compiling ? '编译中' : '编译草稿'}
        </button>
        <button className="qp-button qp-button--ghost" type="button" disabled title="P2 未来能力">
          <Play size={16} aria-hidden="true" />Sandbox · P2
        </button>
      </PageHeading>

      {preview ? (
        <div className="mih-studio-notice" role="status">
          <Info size={17} aria-hidden="true" />
          <span><strong>前端预览</strong> Save 与 Compile callback 尚未接入时只更新当前页面，不声称生成服务端 artifact。</span>
        </div>
      ) : null}

      {!canMutate ? (
        <div className="mih-studio-notice mih-studio-notice--readonly" role="status">
          <LockKey size={17} aria-hidden="true" />
          <span><strong>只读会话</strong>需 Hub Admin Token 修改 Draft；节点、Prompt、保存与 Compile 均已锁定。</span>
        </div>
      ) : null}

      <LifecycleRail onCompile={compile} compileDisabled={!canMutate || dirty || compiling || (!preview && !compileDraft)} />

      <section className="mih-studio-workbench" aria-label="Agent Draft 编排工作台">
        <Palette manifests={manifests} canMutate={canMutate} onAdd={addPaletteNode} />
        <main className="mih-studio-canvas-panel">
          <header>
            <div><p className="qp-kicker">BUILD / TYPED PORTS</p><h2>{project.name} · Draft rev {revision}</h2></div>
            <div className="mih-studio-canvas-actions">
              <div className="mih-studio-mode-switch" role="group" aria-label="画布显示模式">
                <button className="is-active" type="button" aria-pressed="true">设计图</button>
                <button type="button" disabled title="Hub Run/Event Ledger 在 P2 交付">Run Trace · P2</button>
              </div>
              <span className="mih-studio-no-events"><Clock size={13} aria-hidden="true" />Build edge · 中性</span>
            </div>
          </header>
          <div className="mih-studio-flow" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={onDrop}>
            <ReactFlow<StudioFlowNode, StudioFlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onInit={setFlow}
              onNodesChange={(changes) => {
                applyNodeChanges(changes)
                if (changes.some((change) => change.type !== 'select' && change.type !== 'dimensions')) {
                  setDirty(true); setCompileResult(null)
                }
              }}
              onEdgesChange={(changes) => {
                applyEdgeChanges(changes)
                if (changes.some((change) => change.type !== 'select')) {
                  setDirty(true); setCompileResult(null)
                }
              }}
              onConnect={connect}
              isValidConnection={validConnection}
              nodesDraggable={canMutate}
              nodesConnectable={canMutate}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              fitView
              fitViewOptions={{ padding: 0.16, maxZoom: 0.92 }}
              minZoom={0.35}
              maxZoom={1.5}
              deleteKeyCode={canMutate ? ['Backspace', 'Delete'] : null}
              selectionOnDrag>
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--qp-grid-line)" />
              <Controls position="bottom-left" showInteractive={false} />
              <MiniMap position="bottom-right" pannable zoomable nodeStrokeWidth={2}
                nodeColor="var(--qp-bg-active)" maskColor="color-mix(in srgb, var(--qp-bg-1) 64%, transparent)" />
            </ReactFlow>
          </div>
        </main>
        <Inspector node={selectedNode} tab={inspectorTab} sequences={sequences} canMutate={canMutate}
          onTab={setInspectorTab} onChange={updateSelectedNode} />
        <EvidenceDrawer tab={evidenceTab} diagnostics={diagnostics} compileResult={compileResult} references={references}
          compiling={compiling} onTab={setEvidenceTab} />
      </section>

      <section className="mih-studio-future-boundary" aria-label="P1 交付边界">
        <div><Wrench size={16} aria-hidden="true" /><span><strong>P1.5 可用</strong><small>Draft、Prompt、typed DAG、Artifact 与 Hub 静态验证证据</small></span></div>
        <div><LockKey size={16} aria-hidden="true" /><span><strong>P2 / P4 未来</strong><small>Sandbox、Eval、Release、Deploy 与 Market 发布保持禁用</small></span></div>
        <div><Database size={16} aria-hidden="true" /><span><strong>来源事实</strong><small>只接受已注册 sourceRef；不声称目录所有来源都可导入</small></span></div>
        <div><Storefront size={16} aria-hidden="true" /><span><strong>Market 分离</strong><small>Studio 管创作，Market 管发现；当前 Draft 不会上架</small></span></div>
      </section>
    </div>
  )
}

export const AGENT_STUDIO_PREVIEW_TEMPLATES: StudioTemplateOption[] = [
  {
    templateKey: 'public-opinion-mapping',
    label: '全国舆情字段映射',
    description: '从已注册省级舆情 sourceRef 生成可人工复核的 Mapping Proposal。',
    availability: 'authoring-only',
    runtimeAvailable: false,
    definition: AGENT_STUDIO_PREVIEW_DEFINITION,
  },
  {
    templateKey: 'starter-governed-agent',
    label: 'Governed Agent Starter',
    description: 'P1 compile-only 模板；创建后继续配置授权数据引用与 Prompt。',
    availability: 'authoring-only',
    runtimeAvailable: false,
  },
]

function CreateAgentModal({
  templates,
  initialTemplateKey,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  templates: StudioTemplateOption[]
  initialTemplateKey?: string | null
  busy: boolean
  error: Error | null
  onClose: () => void
  onSubmit: (input: AgentStudioCreateInput) => void | Promise<void>
}) {
  const [agentKey, setAgentKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [summary, setSummary] = useState('')
  const [owner, setOwner] = useState('')
  const [riskClass, setRiskClass] = useState<AgentStudioCreateInput['riskClass']>('low')
  const [tags, setTags] = useState('')
  const [templateKey, setTemplateKey] = useState(
    initialTemplateKey && templates.some((item) => item.templateKey === initialTemplateKey)
      ? initialTemplateKey
      : templates[0]?.templateKey || '',
  )
  const keyValid = /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(agentKey)
  const valid = keyValid && displayName.trim().length > 0 && Boolean(templateKey)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!valid || busy) return
    void onSubmit({
      agentKey,
      displayName: displayName.trim(),
      summary: summary.trim(),
      ...(owner.trim() ? { owner: owner.trim() } : {}),
      riskClass,
      tags: [...new Set(tags.split(/[,，]/u).map((item) => item.trim()).filter(Boolean))].slice(0, 12),
      templateKey,
    })
  }

  return (
    <Modal title="新建 Agent" description="先创建稳定产品身份与初始 Draft；Release、Deploy 和 Market 发布不会自动发生。"
      onClose={onClose} busy={busy} size="large" initialFocusRef={undefined}
      footer={<>
        <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="qp-button qp-button--primary" type="submit" form="mih-studio-create-form" disabled={!valid || busy}>
          <Plus size={16} aria-hidden="true" />{busy ? '创建中' : '创建 Draft'}
        </button>
      </>}>
      <form id="mih-studio-create-form" className="mih-studio-create-form" onSubmit={submit}>
        <Field label="agentKey" hint={agentKey && !keyValid ? '仅支持小写字母、数字、点、下划线和连字符，最长 128 字符。' : '创建后作为稳定产品身份，不建议修改。'}>
          <input className="qp-input" value={agentKey} autoFocus required placeholder="public-opinion-mapping"
            onChange={(event) => setAgentKey(event.target.value.trim().toLowerCase())} />
        </Field>
        <Field label="名称" hint=""><input className="qp-input" value={displayName} required placeholder="全国舆情字段映射 Agent"
          onChange={(event) => setDisplayName(event.target.value)} /></Field>
        <Field label="说明" hint="" className="mih-studio-create-span-2"><textarea className="qp-input" value={summary}
          placeholder="说明业务目标、输入边界和可交付输出。" onChange={(event) => setSummary(event.target.value)} /></Field>
        <Field label="Owner" hint=""><input className="qp-input" value={owner} placeholder="数据平台组"
          onChange={(event) => setOwner(event.target.value)} /></Field>
        <DropdownField label="风险等级" value={riskClass} onChange={(value: AgentStudioCreateInput['riskClass']) => setRiskClass(value)}
          options={[
            { value: 'low', label: 'Low · 只读 / 无写入' },
            { value: 'medium', label: 'Medium · 需额外评审' },
            { value: 'high', label: 'High · 严格审批边界' },
          ] as never[]} />
        <Field label="标签" hint="用逗号分隔，最多 12 个。"><input className="qp-input" value={tags}
          placeholder="Data Cleaning, Mapping" onChange={(event) => setTags(event.target.value)} /></Field>
        <DropdownField label="初始模板" value={templateKey} onChange={setTemplateKey}
          options={templates.map((item) => ({ value: item.templateKey, label: item.label, description: item.description })) as never[]}
          placeholder="选择已审核模板" />
        {error ? <div className="mih-studio-create-error" role="alert"><Warning size={16} aria-hidden="true" />{error.message}</div> : null}
      </form>
    </Modal>
  )
}

function ManageAgentModal({
  project,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  project: StudioProjectSummary
  busy: boolean
  error: Error | null
  onClose: () => void
  onSubmit: (input: AgentStudioUpdateProjectInput) => void | Promise<void>
}) {
  const [displayName, setDisplayName] = useState(project.name)
  const [summary, setSummary] = useState(project.summary)
  const [owner, setOwner] = useState(project.owner)
  const [dataScope, setDataScope] = useState(project.dataScope)
  const [riskClass, setRiskClass] = useState<AgentStudioUpdateProjectInput['riskClass']>(project.riskClass || 'low')
  const [tags, setTags] = useState((project.tags || []).join(', '))
  const hasRevision = Number.isInteger(project.revision) && Number(project.revision) >= 1
  const valid = hasRevision && displayName.trim() && owner.trim() && dataScope.trim()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!valid || busy) return
    void onSubmit({
      agentKey: project.agentKey,
      expectedRevision: Number(project.revision),
      displayName: displayName.trim(),
      summary: summary.trim(),
      owner: owner.trim(),
      dataScope: dataScope.trim(),
      riskClass,
      tags: [...new Set(tags.split(/[,，]/u).map((item) => item.trim()).filter(Boolean))].slice(0, 12),
      archived: Boolean(project.archived),
    })
  }

  return (
    <Modal title={`管理 ${project.name}`} description="只更新 Agent 产品元数据；Draft、Artifact 与运行能力不会被隐式修改。"
      onClose={onClose} busy={busy} size="large" initialFocusRef={undefined}
      footer={<>
        <button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="qp-button qp-button--primary" type="submit" form="mih-studio-manage-form" disabled={!valid || busy}>
          <NotePencil size={16} aria-hidden="true" />{busy ? '保存中' : '保存元数据'}
        </button>
      </>}>
      <form id="mih-studio-manage-form" className="mih-studio-create-form" onSubmit={submit}>
        <Field label="agentKey" hint="稳定产品身份不可修改。"><input className="qp-input" value={project.agentKey} disabled /></Field>
        <Field label="名称" hint=""><input className="qp-input" value={displayName} required onChange={(event) => setDisplayName(event.target.value)} /></Field>
        <Field label="说明" hint="" className="mih-studio-create-span-2"><textarea className="qp-input" value={summary}
          onChange={(event) => setSummary(event.target.value)} /></Field>
        <Field label="Owner" hint=""><input className="qp-input" value={owner} required onChange={(event) => setOwner(event.target.value)} /></Field>
        <Field label="dataScope" hint="真实授权范围或规划边界。"><input className="qp-input" value={dataScope} required onChange={(event) => setDataScope(event.target.value)} /></Field>
        <DropdownField label="风险等级" value={riskClass} onChange={(value: AgentStudioUpdateProjectInput['riskClass']) => setRiskClass(value)}
          options={[
            { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
          ] as never[]} />
        <Field label="标签" hint="用逗号分隔，最多 12 个。"><input className="qp-input" value={tags} onChange={(event) => setTags(event.target.value)} /></Field>
        {!hasRevision ? <div className="mih-studio-create-error" role="alert"><Warning size={16} aria-hidden="true" />缺少项目 revision，无法安全提交乐观并发更新。</div> : null}
        {error ? <div className="mih-studio-create-error" role="alert"><Warning size={16} aria-hidden="true" />{error.message}</div> : null}
      </form>
    </Modal>
  )
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value || 'Agent Studio 请求失败'))
}

function isCreateResult(value: AgentStudioCreateResult | StudioProjectSummary): value is AgentStudioCreateResult {
  return Boolean(value && 'project' in value)
}

export function AgentStudioPage({
  session,
  query,
  view,
  projectKey,
  draftId,
  preview: previewMode = false,
  projects,
  project,
  draft,
  nodeTypes,
  sequences,
  templates,
  loading = false,
  error = null,
  notify,
  onUnauthorized,
  onRefresh,
  loadProjects,
  loadProject,
  loadDraft,
  loadArtifact,
  loadNodeTypes,
  loadSequences,
  loadTemplates,
  onCreateProject,
  onOpenProject,
  onOpenDraft,
  onBackToPortfolio,
  onManageProject,
  onArchiveProject,
  updateProject,
  saveDraft,
  compileDraft,
}: AgentStudioPageProps) {
  const canMutate = previewMode || session?.kind === 'admin-token'
  const [internalProjects, setInternalProjects] = useState<StudioProjectSummary[]>(
    previewMode ? AGENT_STUDIO_PREVIEW_PROJECTS : projects || [],
  )
  const [internalProjectKey, setInternalProjectKey] = useState<string | null>(null)
  const [internalDraftId, setInternalDraftId] = useState<string | null>(null)
  const [portfolioLoading, setPortfolioLoading] = useState(!previewMode && projects === undefined && Boolean(loadProjects))
  const [portfolioError, setPortfolioError] = useState<Error | null>(null)
  const [loadedProject, setLoadedProject] = useState<StudioProjectSummary | null>(null)
  const [loadedDraft, setLoadedDraft] = useState<StudioDraft | null>(null)
  const [loadedArtifact, setLoadedArtifact] = useState<AgentStudioCompileResult | null>(null)
  const [loadedRegistry, setLoadedRegistry] = useState<StudioNodeRegistry | null>(null)
  const [loadedSequences, setLoadedSequences] = useState<StudioSequenceOption[] | null>(null)
  const [loadedTemplates, setLoadedTemplates] = useState<StudioTemplateOption[]>(
    previewMode ? AGENT_STUDIO_PREVIEW_TEMPLATES : templates || [],
  )
  const [templateLoading, setTemplateLoading] = useState(!previewMode && templates === undefined && Boolean(loadTemplates))
  const [registryLoading, setRegistryLoading] = useState(!previewMode && nodeTypes === undefined && Boolean(loadNodeTypes))
  const [sequenceLoading, setSequenceLoading] = useState(!previewMode && sequences === undefined && Boolean(loadSequences))
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<Error | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createTemplateKey, setCreateTemplateKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<Error | null>(null)
  const [manageTarget, setManageTarget] = useState<StudioProjectSummary | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<StudioProjectSummary | null>(null)
  const [updatingProject, setUpdatingProject] = useState(false)
  const [updateError, setUpdateError] = useState<Error | null>(null)

  useEffect(() => {
    if (projects !== undefined) setInternalProjects(projects)
    else if (previewMode) setInternalProjects(AGENT_STUDIO_PREVIEW_PROJECTS)
  }, [previewMode, projects])

  useEffect(() => {
    if (templates !== undefined) setLoadedTemplates(templates)
    else if (previewMode) setLoadedTemplates(AGENT_STUDIO_PREVIEW_TEMPLATES)
  }, [previewMode, templates])

  const requestedProjectKey = projectKey || query?.get('project') || internalProjectKey
  const requestedDraftId = draftId || query?.get('draft') || internalDraftId
  const effectiveView = view ?? (requestedProjectKey ? 'detail' : 'portfolio')

  const handleRemoteError = useCallback((value: unknown) => {
    const nextError = asError(value)
    if ((value as { status?: number } | null)?.status === 401) onUnauthorized?.(value)
    return nextError
  }, [onUnauthorized])

  const refreshProjects = useCallback(async () => {
    if (previewMode) {
      setInternalProjects(AGENT_STUDIO_PREVIEW_PROJECTS)
      return
    }
    if (projects !== undefined) {
      await onRefresh?.()
      return
    }
    if (!loadProjects) {
      setInternalProjects([])
      setPortfolioLoading(false)
      return
    }
    setPortfolioLoading(true)
    setPortfolioError(null)
    try {
      setInternalProjects(await loadProjects())
    } catch (nextError) {
      setPortfolioError(handleRemoteError(nextError))
    } finally {
      setPortfolioLoading(false)
    }
  }, [handleRemoteError, loadProjects, onRefresh, previewMode, projects])

  const refreshTemplates = useCallback(async () => {
    if (previewMode) {
      setLoadedTemplates(AGENT_STUDIO_PREVIEW_TEMPLATES)
      return
    }
    if (templates !== undefined) return
    if (!loadTemplates) {
      setLoadedTemplates([])
      setTemplateLoading(false)
      return
    }
    setTemplateLoading(true)
    try {
      setLoadedTemplates(await loadTemplates())
    } catch (nextError) {
      setPortfolioError(handleRemoteError(nextError))
    } finally {
      setTemplateLoading(false)
    }
  }, [handleRemoteError, loadTemplates, previewMode, templates])

  const refreshPortfolio = useCallback(async () => {
    await Promise.all([refreshProjects(), refreshTemplates()])
  }, [refreshProjects, refreshTemplates])

  useEffect(() => {
    if (effectiveView === 'portfolio') void refreshPortfolio()
  }, [effectiveView, refreshPortfolio])

  useEffect(() => {
    if (effectiveView !== 'detail' || !requestedProjectKey) return undefined
    let active = true
    const localProject = project?.agentKey === requestedProjectKey
      ? project
      : internalProjects.find((item) => item.agentKey === requestedProjectKey) || null
    setLoadedProject(localProject)
    setLoadedDraft(null)
    setLoadedArtifact(null)
    setDetailError(null)

    const run = async () => {
      setDetailLoading(true)
      try {
        const nextProject = project?.agentKey === requestedProjectKey
          ? project
          : loadProject ? await loadProject(requestedProjectKey) : localProject
        if (!active) return
        setLoadedProject(nextProject || null)
        const exactDraftId = requestedDraftId || nextProject?.draft?.draftId || null
        const suppliedDraft = draft && (!exactDraftId || draft.draftId === exactDraftId) ? draft : null
        const embeddedDraft = nextProject?.draft?.definition && exactDraftId
          ? {
              draftId: exactDraftId,
              revision: nextProject.draft.revision,
              updatedAt: nextProject.draft.updatedAt,
              definition: nextProject.draft.definition,
            } satisfies StudioDraft
          : null
        const nextDraft = suppliedDraft || (exactDraftId && loadDraft
          ? await loadDraft(requestedProjectKey, exactDraftId)
          : embeddedDraft)
        if (active) setLoadedDraft(nextDraft || null)
        const artifactId = nextProject?.artifact?.artifactId
        if (artifactId && loadArtifact) {
          const nextArtifact = await loadArtifact(requestedProjectKey, artifactId)
          if (active) setLoadedArtifact(nextArtifact)
        }
      } catch (nextError) {
        if (active) setDetailError(handleRemoteError(nextError))
      } finally {
        if (active) setDetailLoading(false)
      }
    }
    void run()
    return () => { active = false }
  }, [draft, effectiveView, handleRemoteError, internalProjects, loadArtifact, loadDraft, loadProject, project, requestedDraftId, requestedProjectKey])

  useEffect(() => {
    if (effectiveView !== 'detail') return undefined
    let active = true
    const run = async () => {
      try {
        if (nodeTypes === undefined && !previewMode && loadNodeTypes) {
          setRegistryLoading(true)
          const registry = await loadNodeTypes()
          if (active) setLoadedRegistry(registry)
        }
        if (sequences === undefined && !previewMode && loadSequences) {
          setSequenceLoading(true)
          const options = await loadSequences()
          if (active) setLoadedSequences(options)
        }
      } catch (nextError) {
        if (active) setDetailError(handleRemoteError(nextError))
      } finally {
        if (active) {
          setRegistryLoading(false)
          setSequenceLoading(false)
        }
      }
    }
    void run()
    return () => { active = false }
  }, [effectiveView, handleRemoteError, loadNodeTypes, loadSequences, nodeTypes, previewMode, sequences])

  const visibleProjects = previewMode && projects === undefined ? internalProjects : projects ?? internalProjects
  const activeProject = project?.agentKey === requestedProjectKey
    ? project
    : loadedProject || visibleProjects.find((item) => item.agentKey === requestedProjectKey) || null
  const embeddedDraft = activeProject?.draft?.definition && activeProject.draft.draftId === (requestedDraftId || activeProject.draft.draftId)
    ? {
        draftId: activeProject.draft.draftId,
        revision: activeProject.draft.revision,
        updatedAt: activeProject.draft.updatedAt,
        definition: activeProject.draft.definition,
      } satisfies StudioDraft
    : null
  const activeDraft = draft && (!requestedDraftId || draft.draftId === requestedDraftId)
    ? draft
    : loadedDraft || embeddedDraft
  const manifests = Array.isArray(nodeTypes)
    ? nodeTypes
    : nodeTypes?.items || loadedRegistry?.items || (previewMode ? AGENT_STUDIO_PREVIEW_NODE_TYPES.items : [])
  const sequenceOptions = sequences || loadedSequences || (previewMode ? AGENT_STUDIO_PREVIEW_SEQUENCES : [])
  const templateOptions = templates || loadedTemplates || (previewMode ? AGENT_STUDIO_PREVIEW_TEMPLATES : [])

  const openProject = (agentKey: string, exactDraftId?: string | null) => {
    setInternalProjectKey(agentKey)
    setInternalDraftId(exactDraftId || visibleProjects.find((item) => item.agentKey === agentKey)?.draft?.draftId || null)
    const nextDraftId = exactDraftId || visibleProjects.find((item) => item.agentKey === agentKey)?.draft?.draftId
    if (nextDraftId && onOpenDraft) onOpenDraft(agentKey, nextDraftId)
    else onOpenProject?.(agentKey)
  }
  const back = () => {
    setInternalProjectKey(null)
    setInternalDraftId(null)
    if (onBackToPortfolio) onBackToPortfolio()
  }

  const createProject = async (input: AgentStudioCreateInput) => {
    if (!canMutate) return
    setCreating(true)
    setCreateError(null)
    try {
      let created: AgentStudioCreateResult
      if (onCreateProject) {
        const result = await onCreateProject(input)
        created = isCreateResult(result) ? result : { project: result }
      } else if (previewMode) {
        const nextDraft: StudioDraft = {
          draftId: `preview-${input.agentKey}`,
          revision: 1,
          definition: structuredClone(AGENT_STUDIO_PREVIEW_DEFINITION),
          updatedAt: new Date().toISOString(),
        }
        created = {
          project: {
            agentKey: input.agentKey, name: input.displayName, summary: input.summary,
            kind: 'template-derived', owner: input.owner || '未指定', dataScope: '待配置授权引用', tags: input.tags,
            draft: { draftId: nextDraft.draftId, revision: 1, saved: true, updatedAt: nextDraft.updatedAt || null, definition: nextDraft.definition },
            artifact: null, evaluation: { status: 'not-run' }, release: null, deployment: null,
          },
          draft: nextDraft,
        }
      } else {
        throw new Error('新建 Agent API 尚未接入')
      }
      setInternalProjects((current) => [created.project, ...current.filter((item) => item.agentKey !== created.project.agentKey)])
      setCreateOpen(false)
      notify?.('Agent 产品与初始 Draft 已创建', 'success')
      openProject(created.project.agentKey, created.draft?.draftId || created.project.draft?.draftId)
    } catch (nextError) {
      setCreateError(handleRemoteError(nextError))
    } finally {
      setCreating(false)
    }
  }

  const replaceProject = (nextProject: StudioProjectSummary) => {
    setInternalProjects((current) => current.map((item) => item.agentKey === nextProject.agentKey ? nextProject : item))
  }

  const manageProject = async (input: AgentStudioUpdateProjectInput) => {
    if (!canMutate || !updateProject) return
    setUpdatingProject(true)
    setUpdateError(null)
    try {
      const nextProject = await updateProject(input)
      replaceProject(nextProject)
      setManageTarget(null)
      notify?.('Agent 产品元数据已更新', 'success')
    } catch (nextError) {
      setUpdateError(handleRemoteError(nextError))
    } finally {
      setUpdatingProject(false)
    }
  }

  const confirmArchive = async () => {
    if (!canMutate || !archiveTarget) return
    setUpdatingProject(true)
    setUpdateError(null)
    try {
      if (updateProject) {
        const nextProject = await updateProject({
          agentKey: archiveTarget.agentKey,
          expectedRevision: Number(archiveTarget.revision),
          displayName: archiveTarget.name,
          summary: archiveTarget.summary,
          owner: archiveTarget.owner,
          dataScope: archiveTarget.dataScope,
          riskClass: archiveTarget.riskClass || 'low',
          tags: archiveTarget.tags || [],
          archived: true,
        })
        replaceProject(nextProject)
      } else {
        await onArchiveProject?.(archiveTarget.agentKey)
        setInternalProjects((current) => current.map((item) => item.agentKey === archiveTarget.agentKey
          ? { ...item, archived: true }
          : item))
      }
      notify?.('Agent 产品已归档；Draft 与 Artifact 历史保留', 'success')
      setArchiveTarget(null)
    } catch (nextError) {
      setUpdateError(handleRemoteError(nextError))
    } finally {
      setUpdatingProject(false)
    }
  }

  const manageAction = canMutate && (updateProject || onManageProject)
    ? (target: StudioProjectSummary) => {
        setUpdateError(null)
        if (updateProject) setManageTarget(target)
        else onManageProject?.(target.agentKey)
      }
    : undefined
  const archiveAction = canMutate && (updateProject || onArchiveProject)
    ? (target: StudioProjectSummary) => {
        if (updateProject && !(Number.isInteger(target.revision) && Number(target.revision) >= 1)) {
          notify?.('缺少项目 revision，无法安全归档。', 'warning')
          return
        }
        setUpdateError(null)
        setArchiveTarget(target)
      }
    : undefined
  const restoreAction = canMutate && updateProject
    ? async (target: StudioProjectSummary) => {
        if (updatingProject) return
        if (!(Number.isInteger(target.revision) && Number(target.revision) >= 1)) {
          notify?.('缺少项目 revision，无法安全恢复。', 'warning')
          return
        }
        setUpdatingProject(true)
        setUpdateError(null)
        try {
          const nextProject = await updateProject({
            agentKey: target.agentKey,
            expectedRevision: Number(target.revision),
            displayName: target.name,
            summary: target.summary,
            owner: target.owner,
            dataScope: target.dataScope,
            riskClass: target.riskClass || 'low',
            tags: target.tags || [],
            archived: false,
          })
          replaceProject(nextProject)
          notify?.('Agent 产品已恢复到活跃项目', 'success')
        } catch (nextError) {
          const next = handleRemoteError(nextError)
          setUpdateError(next)
          notify?.(next.message, 'warning')
        } finally {
          setUpdatingProject(false)
        }
      }
    : undefined

  const updateLocalArtifact = (result: AgentStudioCompileResult) => {
    if (!previewMode || !activeProject || !result.artifactId || !result.status) return
    setInternalProjects((current) => current.map((item) => item.agentKey === activeProject.agentKey
      ? {
          ...item,
          artifact: {
            artifactId: result.artifactId!,
            artifactHash: result.artifactHash,
            status: result.status!,
            diagnosticCount: (result.diagnostics || []).filter((entry) => entry.severity !== 'info').length,
            compiledAt: result.compiledAt || new Date().toISOString(),
          },
        }
      : item))
  }

  if (effectiveView === 'detail') {
    if (loading || detailLoading || registryLoading || sequenceLoading) return <div className="mih-studio-page"><LoadingState label="正在加载 Agent Draft、节点 Registry 与执行路由" /></div>
    if (error || detailError) return <div className="mih-studio-page"><ErrorState error={error || detailError} onRetry={() => { setLoadedProject(null); setLoadedDraft(null); setInternalProjectKey(requestedProjectKey || null) }} /></div>
    if (!requestedProjectKey || !activeProject) return <div className="mih-studio-page"><EmptyState icon={Brain} title="未找到 Agent 产品" description="返回 Agent Studio 选择一个真实项目。" action={<button className="qp-button qp-button--outline" type="button" onClick={back}>返回产品列表</button>} /></div>
    if (!activeDraft) return <div className="mih-studio-page"><EmptyState icon={FileCode} title="未找到指定 Draft" description="页面不会用其他 Draft 或 fixture 代替。" action={<button className="qp-button qp-button--outline" type="button" onClick={back}>返回产品列表</button>} /></div>
    if (!manifests.length) return <div className="mih-studio-page"><EmptyState icon={TreeStructure} title="节点 Registry 尚未加载" description="为避免将未知节点冒充可编译能力，工作台保持关闭。" action={<button className="qp-button qp-button--outline" type="button" onClick={back}>返回产品列表</button>} /></div>
    return (
      <StudioWorkbench project={activeProject} draft={activeDraft} artifact={loadedArtifact} manifests={manifests}
        preview={previewMode} canMutate={canMutate} sequences={sequenceOptions} notify={notify} onBack={back}
        saveDraft={saveDraft} compileDraft={compileDraft} onCompileComplete={updateLocalArtifact} />
    )
  }

  return (
    <>
      <StudioPortfolio projects={visibleProjects} templates={templateOptions} preview={previewMode} canMutate={canMutate}
        loading={loading || portfolioLoading || templateLoading} error={error || portfolioError}
        onRefresh={refreshPortfolio} onCreate={(templateKey) => { if (canMutate) { setCreateTemplateKey(templateKey || null); setCreateError(null); setCreateOpen(true) } }}
        onOpen={(agentKey) => openProject(agentKey)} onManage={manageAction} onArchive={archiveAction}
        onRestore={restoreAction} />
      {createOpen ? <CreateAgentModal templates={templateOptions} initialTemplateKey={createTemplateKey} busy={creating} error={createError}
        onClose={() => { if (!creating) setCreateOpen(false) }} onSubmit={createProject} /> : null}
      {manageTarget ? <ManageAgentModal project={manageTarget} busy={updatingProject} error={updateError}
        onClose={() => { if (!updatingProject) setManageTarget(null) }} onSubmit={manageProject} /> : null}
      {archiveTarget ? <ConfirmDialog title={`归档 ${archiveTarget.name}`}
        description="归档不会删除 Draft、Artifact 或历史版本，只会从活跃项目视图隐藏。"
        confirmLabel={updatingProject ? '归档中' : '确认归档'} busy={updatingProject}
        onConfirm={confirmArchive} onCancel={() => { if (!updatingProject) { setArchiveTarget(null); setUpdateError(null) } }}>
        <p className="mih-studio-confirm-copy">归档后可在“已归档”标签中继续查看该 Agent 产品。</p>
        {updateError ? <div className="mih-studio-create-error" role="alert"><Warning size={16} aria-hidden="true" />{updateError.message}</div> : null}
      </ConfirmDialog> : null}
    </>
  )
}

export default AgentStudioPage
