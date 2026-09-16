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
import { EMPTY_EGRESS, browserProxy, publicEgress, readEgress } from './egress-profiles.mjs'

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
  enabled: true,
  // Streaming is the default because waiting for a whole answer with no sign
  // of life is the worst part of using this. A gateway that cannot do it gets
  // switched off here rather than silently failing every turn.
  stream: true
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
    enabled: input.enabled !== false,
    stream: input.stream !== false
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
        'tests_runners',
        // Writes nothing outside the mission it is recorded on; without it an
        // Agent can only answer in prose. An existing deployment keeps its
        // stored list — widening someone's allow-list on upgrade is exactly
        // the kind of surprise this product refuses.
        'finding_submit'
      ],
      browserOrigins: [],
      providers: [{ ...DEFAULT_PROVIDER }],
      sequence: [DEFAULT_PROVIDER.id],
      agents: mergeBuiltins([], BUILTIN_AGENTS),
      orchestrations: mergeBuiltins([], BUILTIN_ORCHESTRATIONS),
      egress: { ...EMPTY_EGRESS }
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
    // Forgiving on read, strict on write: a profile shape this build no longer
    // accepts is dropped, not a reason the service refuses to start.
    let egress = { ...EMPTY_EGRESS }
    try {
      egress = readEgress(stored.egress)
    } catch {
      console.error('已存储的出网通道配置不被当前版本接受，已按未配置处理。')
    }
    return {
      ...stored,
      allowedTools: (stored.allowedTools || []).filter((name) => TOOL_NAMES.includes(name)),
      egress,
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
  /**
   * @param {object}  [options]
   * @param {boolean} [options.egressEndpoints] Include the proxy address the
   *   local Runtime needs to open its isolated browser. Only the operator-gated
   *   execution surface asks for it; `/config` is readable by viewers, and an
   *   internal proxy endpoint is not something a read-only member needs.
   */
  public({ egressEndpoints = false } = {}) {
    const { revision, maxTurns, allowedTools, browserOrigins } = this.value
    const chain = this.chain()
    const egress = publicEgress(this.value.egress, {})
    return {
      policy: {
        revision,
        maxTurns,
        allowedTools,
        browserOrigins,
        egress: {
          activeId: egress.activeId,
          model: egress.model,
          browser: egress.browser,
          ...(egressEndpoints ? { browserProxy: browserProxy(this.value.egress) } : {})
        }
      },
      model: {
        name: chain[0]?.model ?? '',
        configured: chain.length > 0,
        // Operators need to know a fallback exists without seeing endpoints.
        providers: chain.map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          model: provider.model,
          stream: provider.stream !== false
        })),
        // True when the first provider in the chain can stream; the workbench
        // uses it to explain why text arrives all at once.
        streaming: chain[0]?.stream !== false
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
  /** Profiles plus the credential check, for the egress page. */
  egress(environment = process.env) {
    return publicEgress(this.value.egress, environment)
  }
  /**
   * Switch the active channel.
   *
   * Goes through the ordinary update path, so it revalidates and issues a new
   * policy revision. That invalidates any pending approval — which is the
   * point: an approval was reviewed against the channel its action would have
   * gone out through, and that is no longer the one in force.
   */
  async activateEgress(activeId) {
    const profiles = this.value.egress?.profiles ?? []
    if (activeId && !profiles.some((profile) => profile.id === activeId))
      throw new RigError('invalid_egress', '出网通道不存在', 404)
    return this.update({ ...this.value, egress: { activeId: activeId ?? null, profiles } })
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

    // Same convention as agents and orchestrations: an absent key keeps what
    // is stored. Clearing every channel is `profiles: []`, said on purpose.
    const egress = readEgress(input.egress ?? this.value.egress ?? EMPTY_EGRESS)

    const value = {
      revision: randomUUID(),
      maxTurns: input.maxTurns,
      allowedTools,
      browserOrigins: [...new Set(origins)],
      providers,
      sequence,
      agents,
      orchestrations,
      egress,
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
