import {
  AGENT_STUDIO_ARTIFACT_CONTRACT,
  AgentDraftDefinitionSchema,
  canonicalizeJson,
  sha256Json,
  validationIssues,
} from './contracts.mjs'
import {
  NODE_REGISTRY_VERSION,
  nodeManifestDependency,
  resolveNodeType,
} from './registry.mjs'

export const AGENT_STUDIO_COMPILER_VERSION = 'agent-studio-compiler-p1-v1'

export const DEFAULT_BUDGETS = Object.freeze({
  deadlineMs: 60_000,
  maxNodeAttempts: 24,
  maxModelCalls: 4,
  maxToolCalls: 8,
  maxLoopIterations: 0,
  maxFanOut: 4,
  maxInputTokens: 32_000,
  maxOutputTokens: 4_000,
  maxRetries: 2,
})

const HARD_BUDGETS = Object.freeze({
  deadlineMs: 120_000,
  maxNodeAttempts: 64,
  maxModelCalls: 12,
  maxToolCalls: 24,
  maxLoopIterations: 0,
  maxFanOut: 8,
  maxInputTokens: 64_000,
  maxOutputTokens: 8_000,
  maxRetries: 3,
})

const FORBIDDEN_CONFIG_KEYS = new Set([
  'authorization', 'cmd', 'code', 'command', 'connectionstring', 'credential',
  'dsn', 'dsl', 'effect', 'endpoint', 'env', 'environment', 'header', 'headers',
  'healthy', 'import', 'javascript', 'mcp', 'module', 'package', 'password',
  'proxy', 'runnable', 'runtimefactoryid', 'script', 'secret', 'shell', 'sideeffect',
  'sql', 'token', 'typescript', 'uri', 'url',
])

function normalizedKey(value) {
  return String(value).replace(/[-_\s]/gu, '').toLowerCase()
}

function diagnostic(code, message, details = {}) {
  return { severity: 'error', code, message, ...details }
}

function forbiddenConfigDiagnostics(value, nodeId, path = 'config', seen = new Set()) {
  if (!value || typeof value !== 'object') return []
  if (seen.has(value)) return [diagnostic(
    'invalid_config_value',
    'Node config must be acyclic JSON',
    { nodeId, path },
  )]
  seen.add(value)
  const diagnostics = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => diagnostics.push(...forbiddenConfigDiagnostics(item, nodeId, `${path}.${index}`, seen)))
  } else {
    for (const [key, item] of Object.entries(value)) {
      const itemPath = `${path}.${key}`
      if (FORBIDDEN_CONFIG_KEYS.has(normalizedKey(key))) {
        diagnostics.push(diagnostic(
          'forbidden_definition_capability',
          `Agent Studio definitions cannot provide ${key}`,
          { nodeId, path: itemPath },
        ))
      }
      diagnostics.push(...forbiddenConfigDiagnostics(item, nodeId, itemPath, seen))
    }
  }
  seen.delete(value)
  return diagnostics
}

function sortDiagnostics(values) {
  return values.sort((left, right) => (
    left.code.localeCompare(right.code)
    || String(left.path || '').localeCompare(String(right.path || ''))
    || String(left.nodeId || '').localeCompare(String(right.nodeId || ''))
    || left.message.localeCompare(right.message)
  ))
}

function portByKey(ports, key) {
  return ports.find((port) => port.key === key) || null
}

function edgeKey(edge) {
  return `${edge.from.nodeId}.${edge.from.port}->${edge.to.nodeId}.${edge.to.port}`
}

function logicalDependencies(node, config) {
  if (node.nodeType === 'core.input.source') {
    return [{ kind: 'source', key: config.sourceRef }]
  }
  if (node.nodeType === 'hub.retrieval.hybrid') {
    return [
      { kind: 'dataset', key: config.datasetRef },
      { kind: 'search-profile', key: config.profileRef },
    ]
  }
  if (node.nodeType === 'llm.structured.answer') {
    return [
      { kind: 'llm-sequence', key: config.sequenceKey },
      { kind: 'schema', key: config.outputSchemaRef },
    ]
  }
  if (node.nodeType === 'llm.mapping.propose') {
    return [
      { kind: 'llm-sequence', key: config.sequenceKey },
      { kind: 'schema', key: config.targetSchemaRef },
    ]
  }
  return []
}

export function compileAgentDraft(input) {
  const parsed = AgentDraftDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return {
      valid: false,
      diagnostics: sortDiagnostics(validationIssues(parsed.error).map((issue) => diagnostic(
        'definition_schema_invalid',
        issue.message,
        { path: issue.path },
      ))),
      artifactHash: null,
      normalizedPlan: null,
      dependencyManifest: null,
    }
  }

  const definition = parsed.data
  const diagnostics = []
  const nodesById = new Map()
  const resolvedById = new Map()
  const normalizedNodes = []
  const manifestDependencies = new Map()
  const logicalRefs = new Map()

  for (const node of definition.nodes) {
    if (nodesById.has(node.nodeId)) {
      diagnostics.push(diagnostic('duplicate_node_id', `Duplicate node ID: ${node.nodeId}`, {
        nodeId: node.nodeId,
        path: 'nodes',
      }))
      continue
    }
    nodesById.set(node.nodeId, node)
    diagnostics.push(...forbiddenConfigDiagnostics(node.config, node.nodeId))
    const manifest = resolveNodeType(node.nodeType, node.nodeVersion)
    if (!manifest) {
      diagnostics.push(diagnostic(
        'unknown_node_type',
        `Unknown code-owned node type: ${node.nodeType}@${node.nodeVersion}`,
        { nodeId: node.nodeId, path: `nodes.${node.nodeId}.nodeType` },
      ))
      continue
    }
    if (!['none', 'read'].includes(manifest.effect)) {
      diagnostics.push(diagnostic(
        'node_effect_not_allowed',
        `P1 allows only none/read nodes: ${node.nodeType}`,
        { nodeId: node.nodeId },
      ))
      continue
    }
    const config = manifest.configSchema.safeParse(node.config)
    if (!config.success) {
      for (const issue of validationIssues(config.error)) {
        diagnostics.push(diagnostic('node_config_invalid', issue.message, {
          nodeId: node.nodeId,
          path: `nodes.${node.nodeId}.config${issue.path ? `.${issue.path}` : ''}`,
        }))
      }
      continue
    }
    resolvedById.set(node.nodeId, { node, manifest, config: config.data })
    const dependency = nodeManifestDependency(manifest)
    manifestDependencies.set(`${dependency.nodeType}@${dependency.nodeVersion}`, dependency)
    for (const ref of logicalDependencies(node, config.data)) logicalRefs.set(`${ref.kind}:${ref.key}`, ref)
    normalizedNodes.push({
      nodeId: node.nodeId,
      nodeType: node.nodeType,
      nodeVersion: node.nodeVersion,
      config: canonicalizeJson(config.data),
      inputPorts: manifest.inputPorts,
      outputPorts: manifest.outputPorts,
      effect: manifest.effect,
      determinism: manifest.determinism,
      approvalClass: manifest.approvalClass || null,
    })
  }

  if (new Set(definition.terminalNodeIds).size !== definition.terminalNodeIds.length) {
    diagnostics.push(diagnostic('duplicate_terminal_node', 'terminalNodeIds must not contain duplicates', {
      path: 'terminalNodeIds',
    }))
  }

  const entry = resolvedById.get(definition.entryNodeId)
  if (!entry) {
    diagnostics.push(diagnostic('entry_node_invalid', 'entryNodeId must resolve to a code-owned node', {
      path: 'entryNodeId',
    }))
  } else if (!entry.manifest.entry) {
    diagnostics.push(diagnostic('entry_node_type_invalid', 'The entry node must use an entry node type', {
      nodeId: definition.entryNodeId,
      path: 'entryNodeId',
    }))
  }

  const terminalSet = new Set(definition.terminalNodeIds)
  for (const terminalId of terminalSet) {
    const terminal = resolvedById.get(terminalId)
    if (!terminal) {
      diagnostics.push(diagnostic('terminal_node_invalid', `Terminal node does not resolve: ${terminalId}`, {
        nodeId: terminalId,
        path: 'terminalNodeIds',
      }))
    } else if (!terminal.manifest.terminal) {
      diagnostics.push(diagnostic('terminal_node_type_invalid', 'A declared terminal must use a terminal node type', {
        nodeId: terminalId,
      }))
    }
  }
  for (const [nodeId, resolved] of resolvedById) {
    if (resolved.manifest.terminal && !terminalSet.has(nodeId)) {
      diagnostics.push(diagnostic('undeclared_terminal_node', 'Terminal node types must be declared in terminalNodeIds', {
        nodeId,
      }))
    }
  }

  const adjacency = new Map([...nodesById.keys()].map((nodeId) => [nodeId, new Set()]))
  const reverse = new Map([...nodesById.keys()].map((nodeId) => [nodeId, new Set()]))
  const inboundByPort = new Map()
  const outboundByNode = new Map()
  const outboundPortsByNode = new Map()
  const seenEdges = new Set()
  const normalizedEdges = []

  definition.edges.forEach((edge, index) => {
    const key = edgeKey(edge)
    if (seenEdges.has(key)) {
      diagnostics.push(diagnostic('duplicate_edge', `Duplicate edge: ${key}`, { path: `edges.${index}` }))
      return
    }
    seenEdges.add(key)
    const from = resolvedById.get(edge.from.nodeId)
    const to = resolvedById.get(edge.to.nodeId)
    if (!from || !to) {
      diagnostics.push(diagnostic('edge_node_invalid', 'Edge endpoints must resolve to code-owned nodes', {
        path: `edges.${index}`,
      }))
      return
    }
    const output = portByKey(from.manifest.outputPorts, edge.from.port)
    const inputPort = portByKey(to.manifest.inputPorts, edge.to.port)
    if (!output) {
      diagnostics.push(diagnostic('edge_output_port_invalid', `Unknown output port: ${edge.from.port}`, {
        nodeId: edge.from.nodeId,
        path: `edges.${index}.from.port`,
      }))
    }
    if (!inputPort) {
      diagnostics.push(diagnostic('edge_input_port_invalid', `Unknown input port: ${edge.to.port}`, {
        nodeId: edge.to.nodeId,
        path: `edges.${index}.to.port`,
      }))
    }
    if (output && inputPort && output.type !== inputPort.type) {
      diagnostics.push(diagnostic(
        'port_type_mismatch',
        `Cannot connect ${output.type} to ${inputPort.type}`,
        { path: `edges.${index}`, fromType: output.type, toType: inputPort.type },
      ))
    }
    if (!output || !inputPort) return
    const inboundKey = `${edge.to.nodeId}.${edge.to.port}`
    inboundByPort.set(inboundKey, (inboundByPort.get(inboundKey) || 0) + 1)
    outboundByNode.set(edge.from.nodeId, (outboundByNode.get(edge.from.nodeId) || 0) + 1)
    const outboundPorts = outboundPortsByNode.get(edge.from.nodeId) || new Set()
    outboundPorts.add(edge.from.port)
    outboundPortsByNode.set(edge.from.nodeId, outboundPorts)
    adjacency.get(edge.from.nodeId)?.add(edge.to.nodeId)
    reverse.get(edge.to.nodeId)?.add(edge.from.nodeId)
    normalizedEdges.push(edge)
  })

  for (const [port, count] of inboundByPort) {
    if (count > 1) diagnostics.push(diagnostic('input_port_multiple_writers', `Input port has ${count} writers`, { path: port }))
  }
  if ((reverse.get(definition.entryNodeId)?.size || 0) > 0) {
    diagnostics.push(diagnostic('entry_node_has_input', 'The entry node cannot have incoming edges', {
      nodeId: definition.entryNodeId,
    }))
  }
  for (const terminalId of terminalSet) {
    if ((adjacency.get(terminalId)?.size || 0) > 0) {
      diagnostics.push(diagnostic('terminal_node_has_output', 'A terminal node cannot have outgoing edges', {
        nodeId: terminalId,
      }))
    }
  }
  for (const [nodeId, resolved] of resolvedById) {
    for (const port of resolved.manifest.inputPorts.filter((item) => item.required)) {
      if ((inboundByPort.get(`${nodeId}.${port.key}`) || 0) !== 1) {
        diagnostics.push(diagnostic('required_input_unconnected', `Required input is not connected: ${port.key}`, {
          nodeId,
          path: `nodes.${nodeId}.inputPorts.${port.key}`,
        }))
      }
    }
  }
  const sourceRoutePort = {
    postgresql: 'postgresql',
    file: 'file',
    'sqlite-api': 'sqliteApi',
  }
  for (const [nodeId, resolved] of resolvedById) {
    if (resolved.node.nodeType !== 'core.route.source') continue
    const expectedPort = sourceRoutePort[resolved.config.sourceKind]
    for (const actualPort of outboundPortsByNode.get(nodeId) || []) {
      if (actualPort !== expectedPort) diagnostics.push(diagnostic(
        'source_route_branch_mismatch',
        `sourceKind ${resolved.config.sourceKind} may only use the ${expectedPort} output`,
        { nodeId, path: `nodes.${nodeId}.config.sourceKind`, expectedPort, actualPort },
      ))
    }
  }

  const reachable = new Set()
  const pendingReachability = nodesById.has(definition.entryNodeId)
    ? [definition.entryNodeId]
    : []
  while (pendingReachability.length > 0) {
    const nodeId = pendingReachability.pop()
    if (reachable.has(nodeId)) continue
    reachable.add(nodeId)
    for (const next of adjacency.get(nodeId) || []) pendingReachability.push(next)
  }

  const visited = new Set()
  const visiting = new Set()
  let cycleFound = false
  function visit(nodeId) {
    if (visiting.has(nodeId)) {
      cycleFound = true
      return
    }
    if (visited.has(nodeId)) return
    visiting.add(nodeId)
    for (const next of adjacency.get(nodeId) || []) visit(next)
    visiting.delete(nodeId)
    visited.add(nodeId)
  }
  for (const nodeId of nodesById.keys()) visit(nodeId)
  if (cycleFound) diagnostics.push(diagnostic('graph_cycle_forbidden', 'P1 graphs must be acyclic', { path: 'edges' }))
  for (const nodeId of nodesById.keys()) {
    if (!reachable.has(nodeId)) diagnostics.push(diagnostic('node_unreachable', 'Node is not reachable from entryNodeId', { nodeId }))
  }
  for (const terminalId of terminalSet) {
    if (!reachable.has(terminalId)) diagnostics.push(diagnostic('terminal_unreachable', 'Terminal is not reachable from entryNodeId', { nodeId: terminalId }))
  }

  const canReachTerminal = new Set()
  const pending = [...terminalSet]
  while (pending.length > 0) {
    const nodeId = pending.pop()
    if (canReachTerminal.has(nodeId)) continue
    canReachTerminal.add(nodeId)
    for (const previous of reverse.get(nodeId) || []) pending.push(previous)
  }
  for (const nodeId of reachable) {
    if (!canReachTerminal.has(nodeId)) diagnostics.push(diagnostic(
      'terminal_path_missing',
      'Every reachable node must lead to a declared terminal',
      { nodeId },
    ))
  }

  const budgets = { ...DEFAULT_BUDGETS, ...(definition.budgets || {}) }
  for (const [key, hardLimit] of Object.entries(HARD_BUDGETS)) {
    if (budgets[key] > hardLimit) diagnostics.push(diagnostic(
      'budget_limit_exceeded',
      `${key} exceeds the P1 hard limit of ${hardLimit}`,
      { path: `budgets.${key}`, requested: budgets[key], hardLimit },
    ))
  }
  if (definition.nodes.length > budgets.maxNodeAttempts) diagnostics.push(diagnostic(
    'budget_insufficient',
    'maxNodeAttempts cannot cover every graph node',
    { path: 'budgets.maxNodeAttempts' },
  ))
  const modelNodes = [...resolvedById.values()].filter((item) => item.manifest.budgetClass === 'model')
  const toolNodes = [...resolvedById.values()].filter((item) => item.manifest.budgetClass === 'tool')
  if (modelNodes.length > budgets.maxModelCalls) diagnostics.push(diagnostic(
    'budget_insufficient',
    'maxModelCalls is lower than the static model-node count',
    { path: 'budgets.maxModelCalls' },
  ))
  if (toolNodes.length > budgets.maxToolCalls) diagnostics.push(diagnostic(
    'budget_insufficient',
    'maxToolCalls is lower than the static tool-node count',
    { path: 'budgets.maxToolCalls' },
  ))
  for (const [nodeId, count] of outboundByNode) {
    if (count > budgets.maxFanOut) diagnostics.push(diagnostic(
      'budget_insufficient',
      `Node fan-out ${count} exceeds maxFanOut`,
      { nodeId, path: 'budgets.maxFanOut' },
    ))
  }
  for (const item of modelNodes) {
    if (item.config.maxOutputTokens > budgets.maxOutputTokens) diagnostics.push(diagnostic(
      'budget_insufficient',
      'LLM node maxOutputTokens exceeds the graph output budget',
      { nodeId: item.node.nodeId, path: `nodes.${item.node.nodeId}.config.maxOutputTokens` },
    ))
  }

  if (diagnostics.length > 0) {
    return {
      valid: false,
      diagnostics: sortDiagnostics(diagnostics),
      artifactHash: null,
      normalizedPlan: null,
      dependencyManifest: null,
    }
  }

  normalizedNodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId))
  normalizedEdges.sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)))
  const normalizedPlan = canonicalizeJson({
    contractVersion: AGENT_STUDIO_ARTIFACT_CONTRACT,
    entryNodeId: definition.entryNodeId,
    terminalNodeIds: [...terminalSet].sort(),
    nodes: normalizedNodes,
    edges: normalizedEdges,
    budgets,
    policy: {
      allowedEffects: ['none', 'read'],
      customCode: false,
      arbitraryNetwork: false,
      arbitrarySql: false,
      runnable: false,
      phase: 'P1',
    },
  })
  const dependencyManifest = canonicalizeJson({
    compilerVersion: AGENT_STUDIO_COMPILER_VERSION,
    nodeRegistryVersion: NODE_REGISTRY_VERSION,
    nodes: [...manifestDependencies.values()].sort((left, right) => (
      `${left.nodeType}@${left.nodeVersion}`.localeCompare(`${right.nodeType}@${right.nodeVersion}`)
    )),
    logicalRefs: [...logicalRefs.values()].sort((left, right) => (
      `${left.kind}:${left.key}`.localeCompare(`${right.kind}:${right.key}`)
    )),
  })
  const artifactHash = sha256Json({ normalizedPlan, dependencyManifest })
  return {
    valid: true,
    diagnostics: [],
    artifactHash,
    normalizedPlan,
    dependencyManifest,
    summary: {
      nodeCount: normalizedNodes.length,
      edgeCount: normalizedEdges.length,
      terminalCount: terminalSet.size,
      modelNodeCount: modelNodes.length,
      readOnlyToolNodeCount: toolNodes.length,
      maximumEffect: toolNodes.length > 0 ? 'read' : 'none',
      runnable: false,
    },
  }
}
