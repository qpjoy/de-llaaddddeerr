import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RigError, TOOL_NAMES, key, text } from '../../packages/contracts/index.mjs'
import { AGENT_CATEGORIES, BUILTIN_AGENTS } from './agent-presets.mjs'
import { BUILTIN_ORCHESTRATIONS } from './orchestration-presets.mjs'
import {
  OrchestrationError,
  orchestrationSpec,
  validateOrchestration,
  withoutDerived
} from '../../packages/graph/orchestration.mjs'
import { compileOrchestration } from '../../packages/runtime/orchestration-graph.mjs'
import { DEFINITIONS } from '../../packages/runtime/tools.mjs'
import { nextFireAt, readSchedule } from './orchestration-schedule.mjs'

const WRITE_TOOLS = DEFINITIONS.filter((tool) => tool.effect === 'write').map((tool) => tool.name)

export const MAX_PROVIDERS = 8
export const MAX_AGENTS = 24
export const MAX_ORCHESTRATIONS = 24
const SURFACES = ['any', 'desktop']

const DEFAULT_PROVIDER = Object.freeze({
  id: 'primary',
  displayName: '主模型',
  baseUrl: '',
  model: '',
  apiKeyEnv: 'MX_RIG_MODEL_API_KEY',
  timeoutMs: 60_000,
  enabled: true
})

function providerUrl(raw) {
  if (!raw) return ''
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new RigError('invalid_model_url', '模型地址不是合法 URL')
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new RigError('invalid_model_url', '模型地址需要 HTTPS，本地网关可用 HTTP')
  return raw.replace(/\/+$/, '')
}

function readProvider(input) {
  if (!input || typeof input !== 'object') throw new RigError('invalid_model', '模型配置无效')
  if (typeof input.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,100}$/.test(input.apiKeyEnv))
    throw new RigError('invalid_model', '凭据环境变量名只能是大写字母、数字和下划线')
  const baseUrl = providerUrl(typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '')
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (baseUrl) text(model, '模型名称', 200)
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROVIDER.timeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 120_000)
    throw new RigError('invalid_model', '单次模型请求超时必须在 5–120 秒之间')
  return {
    id: key(input.id ?? DEFAULT_PROVIDER.id, 'Provider ID'),
    displayName: text(input.displayName || input.id || DEFAULT_PROVIDER.displayName, '名称', 60),
    baseUrl,
    model,
    apiKeyEnv: input.apiKeyEnv,
    timeoutMs,
    enabled: input.enabled !== false
  }
}

function readTools(list, label) {
  if (!Array.isArray(list) || list.length > TOOL_NAMES.length)
    throw new RigError('invalid_tools', `${label} 无效`)
  for (const name of list)
    if (!TOOL_NAMES.includes(name)) throw new RigError('invalid_tools', `${label} 含未知工具`)
  return [...new Set(list)]
}

function readAgent(input, builtinKeys) {
  if (!input || typeof input !== 'object') throw new RigError('invalid_agent', 'Agent 配置无效')
  const agentKey = key(input.key, 'Agent Key')
  if (!Object.hasOwn(AGENT_CATEGORIES, input.category))
    throw new RigError('invalid_agent', 'Agent 分类无效')
  if (!SURFACES.includes(input.surface ?? 'any'))
    throw new RigError('invalid_agent', 'Agent 执行面无效')
  return {
    key: agentKey,
    displayName: text(input.displayName, 'Agent 名称', 60),
    summary: text(input.summary, 'Agent 说明', 240),
    category: input.category,
    surface: input.surface ?? 'any',
    tools: readTools(input.tools, 'Agent 工具'),
    persona: text(input.persona, 'Agent 角色说明', 4000),
    starter:
      typeof input.starter === 'string' && input.starter.trim()
        ? text(input.starter, 'Agent 示例问题', 400)
        : '',
    enabled: input.enabled !== false,
    // Built-in status comes from the registry, never from the request body:
    // otherwise a caller could mark its own Agent undeletable, or delete ours.
    builtin: builtinKeys.has(agentKey)
  }
}

/** Newly shipped built-ins appear after an upgrade; edited ones are kept. */
function mergeBuiltins(stored, registry) {
  const known = new Set(stored.map((entry) => entry.key))
  const merged = [...stored]
  for (const builtin of registry)
    if (!known.has(builtin.key)) merged.push({ ...builtin, enabled: true, builtin: true })
  return merged.map((entry) => ({
    ...entry,
    builtin: registry.some((builtin) => builtin.key === entry.key)
  }))
}

// A no-op handler set: compiling with it proves the wiring is sound without
// running anything. Storing a spec that cannot compile would turn an author's
// typo into an operator's failed run.
const COMPILE_PROBE = {
  prepareTool: async () => ({}),
  branch: async () => {},
  fanout: async () => {},
  subflow: async () => ({}),
  checkpoint: async () => {},
  analyze: async () => ({}),
  finish: async () => '',
  act: async () => ({}),
  rejected: async () => {},
  conclude: async () => {}
}

function readOrchestration(input, builtinKeys, { toolNames, agentKeys, resolve }) {
  let checked
  try {
    checked = validateOrchestration(input, { toolNames, agentKeys, resolve })
  } catch (error) {
    if (error instanceof OrchestrationError)
      throw new RigError('invalid_orchestration', error.message)
    throw new RigError(
      'invalid_orchestration',
      `编排结构无效（${error?.issues?.[0]?.path?.join('.') ?? ''}${error?.issues?.[0]?.message ?? '格式不符'}）`
    )
  }
  try {
    compileOrchestration(checked.expanded, COMPILE_PROBE)
  } catch (error) {
    throw new RigError('invalid_orchestration', `编排无法编译：${error.message}`)
  }
  // A schedule is only accepted on an orchestration that can finish without
  // anyone present; the check needs the tool registry, which is why it lives
  // here rather than in the spec schema.
  const schedule = readSchedule(
    checked.spec.schedule,
    // Inputs come from what the author declared; nodes from the expanded
    // graph, so a write tool hidden inside a subflow is still caught.
    { inputs: checked.spec.inputs, nodes: checked.expanded.nodes },
    { writeTools: WRITE_TOOLS }
  )
  // Only the spec is stored. `warnings` is derived, and persisting it would
  // come straight back as an unrecognised key on the next round trip.
  return { ...checked.spec, schedule, builtin: builtinKeys.has(checked.spec.key) }
}

export class Settings {
  constructor(file) {
    this.file = file
    this.value = {
      revision: randomUUID(),
      maxTurns: 12,
      allowedTools: [
        'tests_apps',
        'tests_list',
        'tests_runs',
        'tests_run',
        'tests_result',
        'tests_cases',
        'tests_case_results',
        'tests_artifacts',
        'tests_runners'
      ],
      browserOrigins: [],
      providers: [{ ...DEFAULT_PROVIDER }],
      sequence: [DEFAULT_PROVIDER.id],
      agents: mergeBuiltins([], BUILTIN_AGENTS),
      orchestrations: mergeBuiltins([], BUILTIN_ORCHESTRATIONS)
    }
    this.queue = Promise.resolve()
  }
  async init() {
    try {
      this.value = this.#upgrade(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    return this
  }
  /**
   * 0.1 stored exactly one model as `model`. Read it forward into the provider
   * list instead of asking an existing deployment to retype its gateway.
   */
  #upgrade(stored) {
    const providers =
      Array.isArray(stored.providers) && stored.providers.length
        ? stored.providers
        : [{ ...DEFAULT_PROVIDER, ...(stored.model || {}), model: stored.model?.name ?? '' }]
    const sequence =
      Array.isArray(stored.sequence) && stored.sequence.length
        ? stored.sequence.filter((id) => providers.some((provider) => provider.id === id))
        : providers.map((provider) => provider.id)
    return {
      ...stored,
      allowedTools: (stored.allowedTools || []).filter((name) => TOOL_NAMES.includes(name)),
      providers,
      sequence,
      agents: mergeBuiltins(Array.isArray(stored.agents) ? stored.agents : [], BUILTIN_AGENTS),
      orchestrations: mergeBuiltins(
        Array.isArray(stored.orchestrations) ? stored.orchestrations : [],
        BUILTIN_ORCHESTRATIONS
      ),
      model: head(providers, sequence)
    }
  }

  /** The chat chain, in order, skipping disabled and unconfigured providers. */
  chain() {
    return this.value.sequence
      .map((id) => this.value.providers.find((provider) => provider.id === id))
      .filter((provider) => provider?.enabled && provider.baseUrl && provider.model)
  }
  agent(agentKey) {
    if (!agentKey) return null
    const found = this.value.agents.find((entry) => entry.key === agentKey)
    if (!found || !found.enabled) throw new RigError('agent_unknown', 'Agent 不存在或已停用', 404)
    return found
  }
  orchestration(key) {
    const found = (this.value.orchestrations || []).find((entry) => entry.key === key)
    if (!found || !found.enabled)
      throw new RigError('orchestration_unknown', '编排不存在或已停用', 404)
    return found
  }
  /** Resolver for subflow inlining: only enabled orchestrations are reachable. */
  resolver() {
    return (key) =>
      (this.value.orchestrations || []).find((entry) => entry.key === key && entry.enabled) ?? null
  }
  /** The flat graph a spec turns into once its subflows are inlined. */
  expanded(key) {
    return validateOrchestration(this.orchestration(key), { resolve: this.resolver() }).expanded
  }
  /** Tools an Agent may actually reach: its own intent ∩ the Internal allow-list. */
  agentTools(agentKey) {
    const allowed = this.value.allowedTools
    if (!agentKey) return [...allowed]
    return this.agent(agentKey).tools.filter((name) => allowed.includes(name))
  }
  public() {
    const { revision, maxTurns, allowedTools, browserOrigins } = this.value
    const chain = this.chain()
    return {
      policy: { revision, maxTurns, allowedTools, browserOrigins },
      model: {
        name: chain[0]?.model ?? '',
        configured: chain.length > 0,
        // Operators need to know a fallback exists without seeing endpoints.
        providers: chain.map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          model: provider.model
        }))
      },
      agents: this.value.agents
        .filter((agent) => agent.enabled)
        .map((agent) => ({
          key: agent.key,
          displayName: agent.displayName,
          summary: agent.summary,
          category: agent.category,
          surface: agent.surface,
          starter: agent.starter,
          builtin: agent.builtin,
          // Read-only transparency: an operator can see what the Agent was told
          // and exactly which tools remain after the Internal allow-list.
          persona: agent.persona,
          tools: agent.tools,
          effectiveTools: agent.tools.filter((name) => allowedTools.includes(name))
        })),
      orchestrations: (this.value.orchestrations || [])
        .filter((entry) => entry.enabled)
        .map((entry) => ({
          ...entry,
          // Which tools this orchestration needs but Internal has not allowed.
          // An operator should see that before starting it, not after.
          missingTools: [
            ...new Set(
              entry.nodes
                .filter((node) => node.type === 'tool' && !allowedTools.includes(node.tool))
                .map((node) => node.tool)
            )
          ],
          nextFireAt: nextFireAt(entry.schedule)
        }))
    }
  }
  async update(input) {
    const allowedTools = readTools(input.allowedTools, '工具列表')
    if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 30)
      throw new RigError('invalid_budget', '任务步数必须为 1–30')
    if (!Array.isArray(input.browserOrigins) || input.browserOrigins.length > 30)
      throw new RigError('invalid_origins', '浏览器 origin 列表无效')
    const origins = input.browserOrigins.map((raw) => {
      let url
      try {
        url = new URL(raw)
      } catch {
        throw new RigError('invalid_origin', '请填写完整 origin，例如 https://test.example.com')
      }
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.origin !== raw ||
        url.username ||
        url.password
      )
        throw new RigError('invalid_origin', '请填写完整 origin，例如 https://test.example.com')
      return raw
    })

    const rawProviders =
      Array.isArray(input.providers) && input.providers.length
        ? input.providers
        : [{ ...DEFAULT_PROVIDER, ...(input.model || {}), model: input.model?.name ?? '' }]
    if (rawProviders.length > MAX_PROVIDERS)
      throw new RigError('invalid_model', `最多配置 ${MAX_PROVIDERS} 个 Provider`)
    const providers = rawProviders.map(readProvider)
    if (new Set(providers.map((provider) => provider.id)).size !== providers.length)
      throw new RigError('invalid_model', 'Provider ID 重复')

    const rawSequence = Array.isArray(input.sequence)
      ? input.sequence
      : providers.map((provider) => provider.id)
    const sequence = [...new Set(rawSequence)]
    for (const id of sequence)
      if (!providers.some((provider) => provider.id === id))
        throw new RigError('invalid_sequence', `调用序列引用了不存在的 Provider ${id}`)

    const builtinKeys = new Set(BUILTIN_AGENTS.map((agent) => agent.key))
    const rawAgents = Array.isArray(input.agents) ? input.agents : this.value.agents
    if (rawAgents.length > MAX_AGENTS)
      throw new RigError('invalid_agent', `最多配置 ${MAX_AGENTS} 个 Agent`)
    const agents = rawAgents.map((agent) => readAgent(agent, builtinKeys))
    if (new Set(agents.map((agent) => agent.key)).size !== agents.length)
      throw new RigError('invalid_agent', 'Agent Key 重复')
    for (const builtin of BUILTIN_AGENTS)
      if (!agents.some((agent) => agent.key === builtin.key))
        throw new RigError('invalid_agent', `内置 Agent ${builtin.key} 不能删除，只能停用`)

    const orchestrationKeys = new Set(BUILTIN_ORCHESTRATIONS.map((entry) => entry.key))
    const rawOrchestrations = Array.isArray(input.orchestrations)
      ? input.orchestrations
      : this.value.orchestrations
    if (rawOrchestrations.length > MAX_ORCHESTRATIONS)
      throw new RigError('invalid_orchestration', `最多配置 ${MAX_ORCHESTRATIONS} 条编排`)
    const agentKeys = agents.map((agent) => agent.key)
    // Two passes: a subflow may reference any orchestration in the same save,
    // so the resolver has to see the incoming list, not the stored one.
    // This pass only builds the lookup. Anything that fails to parse is left
    // out of it and reported properly by readOrchestration below, with the
    // product's own error shape rather than a raw schema throw.
    const incoming = new Map()
    for (const entry of rawOrchestrations) {
      const parsed = orchestrationSpec.safeParse(withoutDerived(entry))
      if (parsed.success) incoming.set(parsed.data.key, parsed.data)
    }
    const resolve = (key) => {
      const found = incoming.get(key)
      return found?.enabled === false ? null : (found ?? null)
    }
    const orchestrations = rawOrchestrations.map((entry) =>
      readOrchestration(entry, orchestrationKeys, { toolNames: TOOL_NAMES, agentKeys, resolve })
    )
    if (new Set(orchestrations.map((entry) => entry.key)).size !== orchestrations.length)
      throw new RigError('invalid_orchestration', '编排 Key 重复')
    for (const builtin of BUILTIN_ORCHESTRATIONS)
      if (!orchestrations.some((entry) => entry.key === builtin.key))
        throw new RigError('invalid_orchestration', `内置编排 ${builtin.key} 不能删除，只能停用`)

    const value = {
      revision: randomUUID(),
      maxTurns: input.maxTurns,
      allowedTools,
      browserOrigins: [...new Set(origins)],
      providers,
      sequence,
      agents,
      orchestrations,
      model: head(providers, sequence)
    }
    const operation = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
      await rename(temp, this.file)
      this.value = value
    })
    this.queue = operation.catch(() => {})
    await operation
    return this.public()
  }
}

/** Legacy single-model view, kept so 0.1 readers and tests keep working. */
function head(providers, sequence) {
  const first =
    providers.find((provider) => provider.id === sequence[0]) ?? providers[0] ?? DEFAULT_PROVIDER
  return { baseUrl: first.baseUrl, name: first.model, apiKeyEnv: first.apiKeyEnv }
}
