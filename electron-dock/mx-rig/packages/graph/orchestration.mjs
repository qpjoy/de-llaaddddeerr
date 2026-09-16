import { z } from 'zod'

/**
 * A declarative orchestration: nodes an operator composes, not code they write.
 *
 * The palette is closed on purpose. Every node type here is executed by a
 * server-known handler, so "编排" can be authored in a browser without ever
 * turning saved configuration into something that runs arbitrary logic. What
 * an author controls is which known step runs next, with which arguments, and
 * where the result goes — never how the step is implemented.
 */
export const NODE_TYPES = Object.freeze({
  tool: { title: '调用工具', kind: 'tool', hint: '执行一个被允许的工具，结果可以取出存进变量' },
  branch: { title: '条件分支', kind: 'branch', hint: '按变量的值决定走哪条路；只判断，不做事' },
  fanout: {
    title: '分叉汇合',
    kind: 'fanout',
    hint: '几条互不依赖的分支都要跑，全部到达汇合节点后再继续；按顺序依次执行，不是并发'
  },
  approval: { title: '人工检查点', kind: 'human', hint: '在继续之前停下来，等人看过再放行' },
  analyze: {
    title: 'Agent 分析',
    kind: 'model',
    hint: '把已收集的证据交给一个 Agent，产出文字结论；不调用工具'
  },
  subflow: {
    title: '调用子编排',
    kind: 'subflow',
    hint: '把另一条已保存的编排整条嵌进来；它的变量带前缀，同一条子编排可以用多次'
  },
  finish: { title: '结束', kind: 'output', hint: '写下结论并结束这条编排' }
})

const nodeId = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, '节点 ID 只能是小写字母开头的字母、数字和下划线')

const varName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-zA-Z0-9_]*$/, '变量名只能是小写字母开头的字母、数字和下划线')

/** `{{name}}` reads a variable; everything else is a literal. */
const argValue = z.string().max(400)

/**
 * How a tool result becomes a variable.
 *
 * `from` is a dot path into the JSON the tool returned. `select: 'count'`
 * counts an array instead of reading a value, optionally only the entries
 * whose `where` field is truthy — which is how "有几台执行机在线" is expressed
 * without letting an author write a predicate.
 */
const captureSpec = z
  .object({
    from: z
      .string()
      .min(1)
      .max(120)
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/,
        '取值路径只能是点号分隔的字段名'
      ),
    select: z.enum(['value', 'count']).default('value'),
    where: varName.optional()
  })
  .strict()

const testSpec = z
  .object({
    var: varName,
    op: z.enum(['exists', 'missing', 'eq', 'ne', 'gt', 'lt', 'in']),
    value: z.string().max(200).optional(),
    values: z.array(z.string().max(200)).max(20).optional()
  })
  .strict()
  .refine((test) => !['eq', 'ne', 'gt', 'lt'].includes(test.op) || test.value !== undefined, {
    message: '该判断需要填写比较值',
    path: ['value']
  })
  .refine((test) => test.op !== 'in' || (test.values?.length ?? 0) > 0, {
    message: 'in 判断需要至少一个候选值',
    path: ['values']
  })

const baseNode = { id: nodeId, title: z.string().min(1).max(60) }

export const nodeSpec = z.discriminatedUnion('type', [
  z
    .object({
      ...baseNode,
      type: z.literal('tool'),
      tool: z.string().min(1).max(64),
      args: z.record(varName, argValue).default({}),
      capture: z.record(varName, captureSpec).default({}),
      next: nodeId.nullable().default(null)
    })
    .strict(),
  z
    .object({
      ...baseNode,
      type: z.literal('branch'),
      test: testSpec,
      then: nodeId.nullable().default(null),
      otherwise: nodeId.nullable().default(null)
    })
    .strict(),
  z
    .object({
      ...baseNode,
      type: z.literal('fanout'),
      branches: z.array(nodeId).min(2).max(4),
      join: nodeId
    })
    .strict(),
  z
    .object({
      ...baseNode,
      type: z.literal('approval'),
      message: z.string().min(1).max(400),
      next: nodeId.nullable().default(null)
    })
    .strict(),
  z
    .object({
      ...baseNode,
      type: z.literal('analyze'),
      agentKey: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9][a-z0-9_-]*$/),
      instruction: z.string().min(1).max(2000),
      next: nodeId.nullable().default(null)
    })
    .strict(),
  z
    .object({
      ...baseNode,
      type: z.literal('subflow'),
      orchestrationKey: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9][a-z0-9_-]*$/),
      // Child input name → a template evaluated in the parent's variables.
      inputs: z.record(varName, argValue).default({}),
      next: nodeId.nullable().default(null)
    })
    .strict(),
  z.object({ ...baseNode, type: z.literal('finish'), message: z.string().min(1).max(400) }).strict()
])

export const orchestrationSpec = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    displayName: z.string().min(1).max(60),
    summary: z.string().min(1).max(240),
    inputs: z
      .array(
        z
          .object({
            name: varName,
            label: z.string().min(1).max(60),
            kind: z.enum(['task', 'run', 'app', 'text']),
            required: z.boolean().default(true)
          })
          .strict()
      )
      .max(6)
      .default([]),
    entry: nodeId,
    nodes: z.array(nodeSpec).min(1).max(24),
    // Hand-placed node positions, keyed by the compiled node name. Absent
    // entries fall back to the automatic layout, so a spec never has to carry
    // a position for every node just because one was moved.
    layout: z
      .record(
        z.string().max(90),
        z.object({ x: z.number().min(0).max(20_000), y: z.number().min(0).max(20_000) }).strict()
      )
      .default({}),
    // Unattended execution. Whether this orchestration is *allowed* to run
    // unattended is decided in apps/server, which knows which tools write.
    schedule: z
      .object({
        cronExpr: z.string().min(1).max(120),
        timezone: z.string().min(1).max(64).default('Asia/Shanghai'),
        enabled: z.boolean().default(true)
      })
      .strict()
      .nullable()
      .default(null),
    enabled: z.boolean().default(true),
    builtin: z.boolean().optional()
  })
  .strict()

/**
 * Expand every `subflow` node by inlining the orchestration it names.
 *
 * Inlining rather than nesting keeps one flat graph, which means approval,
 * checkpointing, tracing and the step budget all keep working unchanged — a
 * nested runtime would have to reimplement each of them.
 *
 * Child nodes and child variables are both prefixed with the subflow node's
 * id, so the same child can be used twice in one parent without the two
 * copies writing over each other. The parent reads a child result as
 * `{{<subflow id>__<child variable>}}`.
 */
export function expandSubflows(spec, resolve, stack = []) {
  if (!spec.nodes.some((node) => node.type === 'subflow'))
    return { entry: spec.entry, nodes: spec.nodes, layout: spec.layout ?? {} }
  if (typeof resolve !== 'function')
    throw new OrchestrationError('这条编排引用了子编排，但没有提供查找函数')
  if (stack.length >= MAX_SUBFLOW_DEPTH)
    throw new OrchestrationError(`子编排嵌套超过 ${MAX_SUBFLOW_DEPTH} 层`)

  const nodes = []
  for (const node of spec.nodes) {
    if (node.type !== 'subflow') {
      nodes.push(node)
      continue
    }
    if (stack.includes(node.orchestrationKey) || node.orchestrationKey === spec.key)
      throw new OrchestrationError(
        `节点 ${node.id} 形成了子编排环：${[...stack, spec.key, node.orchestrationKey].join(' → ')}`,
        node.id
      )
    const child = resolve(node.orchestrationKey)
    if (!child)
      throw new OrchestrationError(
        `节点 ${node.id} 引用的子编排 ${node.orchestrationKey} 不存在或已停用`,
        node.id
      )
    const inner = expandSubflows(child, resolve, [...stack, spec.key])
    const prefix = `${node.id}__`
    const owned = new Set([
      ...(child.inputs ?? []).map((input) => input.name),
      ...inner.nodes.flatMap((entry) =>
        entry.type === 'tool' ? Object.keys(entry.capture ?? {}) : []
      )
    ])
    const renameVar = (name) => (owned.has(name) ? prefix + name : name)
    const renameTemplate = (value) =>
      String(value).replace(TEMPLATE, (match, name) =>
        owned.has(name) ? `{{${prefix}${name}}}` : match
      )
    const renameTarget = (target) => (target === null ? node.next : prefix + target)

    for (const entry of inner.nodes)
      nodes.push(rename(entry, prefix, renameVar, renameTemplate, renameTarget))
    // The subflow node survives as the step that seeds the child's inputs,
    // then hands over to the child's entry.
    nodes.push({
      ...node,
      seed: Object.fromEntries(
        Object.entries(node.inputs).map(([name, template]) => [prefix + name, template])
      ),
      next: prefix + inner.entry
    })
  }
  if (nodes.length > MAX_EXPANDED_NODES)
    throw new OrchestrationError(
      `展开子编排后共 ${nodes.length} 个节点，超过 ${MAX_EXPANDED_NODES} 的上限`
    )
  return { entry: spec.entry, nodes, layout: spec.layout ?? {} }
}

function rename(node, prefix, renameVar, renameTemplate, renameTarget) {
  const base = { ...node, id: prefix + node.id }
  if (node.type === 'tool')
    return {
      ...base,
      args: Object.fromEntries(
        Object.entries(node.args).map(([name, value]) => [name, renameTemplate(value)])
      ),
      capture: Object.fromEntries(
        Object.entries(node.capture).map(([name, rule]) => [renameVar(name), rule])
      ),
      next: renameTarget(node.next)
    }
  if (node.type === 'branch')
    return {
      ...base,
      test: { ...node.test, var: renameVar(node.test.var) },
      then: renameTarget(node.then),
      otherwise: renameTarget(node.otherwise)
    }
  if (node.type === 'fanout')
    return {
      ...base,
      branches: node.branches.map((branch) => prefix + branch),
      join: prefix + node.join
    }
  if (node.type === 'approval')
    return { ...base, message: renameTemplate(node.message), next: renameTarget(node.next) }
  if (node.type === 'analyze') return { ...base, next: renameTarget(node.next) }
  if (node.type === 'subflow')
    return {
      ...base,
      seed: Object.fromEntries(
        Object.entries(node.seed ?? {}).map(([name, value]) => [
          prefix + name,
          renameTemplate(value)
        ])
      ),
      next: renameTarget(node.next)
    }
  // finish: ends the whole run, on purpose. "结束" inside a child means the
  // orchestration is finished, not that the child returned.
  return { ...base, message: renameTemplate(node.message) }
}

export class OrchestrationError extends Error {
  constructor(message, path = null) {
    super(message)
    this.code = 'invalid_orchestration'
    this.path = path
  }
}

const outgoing = (node) =>
  node.type === 'branch'
    ? [node.then, node.otherwise]
    : node.type === 'fanout'
      ? [...node.branches, node.join]
      : node.type === 'finish'
        ? []
        : [node.next]

export const MAX_SUBFLOW_DEPTH = 3
export const MAX_EXPANDED_NODES = 80

/**
 * Structural checks the schema cannot express.
 *
 * These run before a spec is stored, so a saved orchestration is always one
 * that can be compiled — an author finds out about a dangling edge while they
 * are editing, not when an operator runs it.
 */
/**
 * Fields the server computes when it publishes a spec.
 *
 * They are dropped on the way back in rather than accepted: the admin view and
 * the runtime both read a published spec and hand it straight back, and a
 * strict schema would otherwise reject the shape it just produced.
 */
export const DERIVED_FIELDS = Object.freeze(['builtin', 'warnings', 'missingTools', 'nextFireAt'])

export function withoutDerived(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const copy = { ...input }
  for (const field of DERIVED_FIELDS) delete copy[field]
  return copy
}

export function validateOrchestration(input, { toolNames = [], agentKeys = [], resolve } = {}) {
  const spec = orchestrationSpec.parse(withoutDerived(input))
  // Structural checks run on the expanded graph: a dangling edge inside a
  // child is the parent author's problem too, and the parent reads child
  // results through the namespaced variables expansion produces.
  const expanded = expandSubflows(spec, resolve)
  const byId = new Map(expanded.nodes.map((node) => [node.id, node]))
  if (byId.size !== expanded.nodes.length) {
    const seen = new Set()
    for (const node of expanded.nodes) {
      if (seen.has(node.id)) throw new OrchestrationError(`节点 ID ${node.id} 重复`, node.id)
      seen.add(node.id)
    }
  }
  if (!byId.has(expanded.entry))
    throw new OrchestrationError(`入口节点 ${expanded.entry} 不存在`, 'entry')

  // Variables an author can read: the inputs, plus whatever earlier nodes
  // capture or a subflow seeds. Checked as a set rather than per-path because
  // a branch may legitimately read something captured across a loop.
  const known = new Set(spec.inputs.map((entry) => entry.name))
  for (const node of expanded.nodes) {
    if (node.type === 'tool') for (const name of Object.keys(node.capture)) known.add(name)
    if (node.type === 'subflow') for (const name of Object.keys(node.seed ?? {})) known.add(name)
  }

  for (const node of expanded.nodes) {
    for (const target of outgoing(node))
      if (target !== null && !byId.has(target))
        throw new OrchestrationError(`节点 ${node.id} 指向了不存在的节点 ${target}`, node.id)
    const templates =
      node.type === 'tool'
        ? Object.values(node.args)
        : node.type === 'subflow'
          ? Object.values(node.seed ?? {})
          : node.type === 'finish' || node.type === 'approval'
            ? [node.message]
            : []
    for (const value of templates)
      for (const name of references(value))
        if (!known.has(name))
          throw new OrchestrationError(`节点 ${node.id} 引用了未定义的变量 ${name}`, node.id)
    if (node.type === 'tool' && toolNames.length && !toolNames.includes(node.tool))
      throw new OrchestrationError(`节点 ${node.id} 使用了未知工具 ${node.tool}`, node.id)
    if (node.type === 'branch' && !known.has(node.test.var))
      throw new OrchestrationError(`节点 ${node.id} 判断了未定义的变量 ${node.test.var}`, node.id)
    if (node.type === 'analyze' && agentKeys.length && !agentKeys.includes(node.agentKey))
      throw new OrchestrationError(`节点 ${node.id} 引用了不存在的 Agent ${node.agentKey}`, node.id)
    if (node.type === 'fanout') {
      if (new Set(node.branches).size !== node.branches.length)
        throw new OrchestrationError(`节点 ${node.id} 的分支重复`, node.id)
      if (node.branches.includes(node.join))
        throw new OrchestrationError(`节点 ${node.id} 的汇合节点不能同时是一条分支`, node.id)
      if (node.branches.includes(node.id))
        throw new OrchestrationError(`节点 ${node.id} 不能把自己当成分支`, node.id)
    }
  }

  for (const fanout of expanded.nodes.filter((node) => node.type === 'fanout'))
    checkFanout(expanded, fanout)

  const reachable = new Set()
  const walk = (id) => {
    if (id === null || reachable.has(id)) return
    reachable.add(id)
    for (const target of outgoing(byId.get(id))) walk(target)
  }
  walk(expanded.entry)
  const orphans = expanded.nodes.filter((node) => !reachable.has(node.id)).map((node) => node.id)
  // Unreachable nodes are reported, not rejected: half-built branches are a
  // normal state while editing, and refusing to save them would lose work.
  return {
    spec,
    expanded,
    warnings: orphans.length ? [`以下节点从入口不可达：${orphans.join('、')}`] : []
  }
}

/**
 * A join only fires on its last arrival, so the shape has to guarantee that
 * the count is reachable and that nothing outside the fan-out can arrive and
 * spend one of the slots. Both mistakes would show up as an orchestration that
 * silently stops halfway.
 */
function checkFanout(spec, fanout) {
  const byId = new Map(spec.nodes.map((node) => [node.id, node]))
  const interiors = fanout.branches.map((entry) => {
    const seen = new Set()
    const walk = (id) => {
      if (id === null || id === fanout.join || seen.has(id)) return
      seen.add(id)
      for (const target of outgoing(byId.get(id))) walk(target)
    }
    walk(entry)
    return seen
  })
  for (const [index, interior] of interiors.entries()) {
    const reaches = [...interior].some((id) => outgoing(byId.get(id)).includes(fanout.join))
    if (!reaches)
      throw new OrchestrationError(
        `节点 ${fanout.id} 的第 ${index + 1} 条分支（${fanout.branches[index]}）走不到汇合节点 ${fanout.join}，汇合会永远等不齐`,
        fanout.id
      )
  }
  const allowed = new Set([fanout.id, ...interiors.flatMap((set) => [...set])])
  for (const node of spec.nodes)
    if (!allowed.has(node.id) && outgoing(node).includes(fanout.join))
      throw new OrchestrationError(
        `节点 ${node.id} 从分叉之外指向了汇合节点 ${fanout.join}；汇合只能由 ${fanout.id} 的分支到达`,
        node.id
      )
}

const TEMPLATE = /\{\{\s*([a-z][a-zA-Z0-9_]*)\s*\}\}/g

export function references(value) {
  return [...String(value).matchAll(TEMPLATE)].map((match) => match[1])
}

/** Substitute `{{name}}` from the variable bag. Missing values become ''. */
export function renderTemplate(value, vars) {
  return String(value).replace(TEMPLATE, (_match, name) => String(vars[name] ?? ''))
}

/** Safe dot-path read: own properties only, no prototype walking. */
export function readPath(source, path) {
  let current = source
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    if (!Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

export function applyCapture(result, capture) {
  const value = readPath(result, capture.from)
  if (capture.select === 'count') {
    if (!Array.isArray(value)) return '0'
    return String(
      capture.where ? value.filter((entry) => Boolean(entry?.[capture.where])).length : value.length
    )
  }
  if (value == null) return ''
  return typeof value === 'object' ? JSON.stringify(value).slice(0, 400) : String(value)
}

export function evaluateTest(test, vars) {
  const raw = vars[test.var]
  const present = raw !== undefined && raw !== ''
  switch (test.op) {
    case 'exists':
      return present
    case 'missing':
      return !present
    case 'eq':
      return raw === test.value
    case 'ne':
      return raw !== test.value
    case 'in':
      return (test.values ?? []).includes(raw)
    case 'gt':
    case 'lt': {
      const left = Number(raw)
      const right = Number(test.value)
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false
      return test.op === 'gt' ? left > right : left < right
    }
    default:
      return false
  }
}

/** Human-readable branch label, used on the edges in the orchestration view. */
export function describeTest(test) {
  const labels = {
    exists: `${test.var} 有值`,
    missing: `${test.var} 为空`,
    eq: `${test.var} = ${test.value}`,
    ne: `${test.var} ≠ ${test.value}`,
    gt: `${test.var} > ${test.value}`,
    lt: `${test.var} < ${test.value}`,
    in: `${test.var} ∈ ${(test.values ?? []).join(' / ')}`
  }
  return labels[test.op] ?? test.op
}
