import { z } from 'zod'
import { StateChannels } from './state.mjs'

export const START = '__start__'
export const END = '__end__'

export class GraphError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * Thrown by `context.interrupt(payload)` and caught by the runner.
 *
 * This is the whole human-in-the-loop mechanism: the graph stops, the caller
 * persists whatever it needs, and a later `run({ resume })` re-enters the same
 * node with the answer. Nothing between the pause and the resume is held in
 * memory, which is why a restart can refuse to replay instead of guessing.
 */
export class GraphInterrupt extends Error {
  constructor(node, value) {
    super('graph interrupted')
    this.code = 'graph_interrupt'
    this.node = node
    this.value = value
  }
}

const nodeName = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/, '节点名只能使用小写字母、数字和下划线')

export class StateGraph {
  constructor(channels, { contextSchema = null } = {}) {
    this.channels = new StateChannels(channels)
    this.contextSchema = contextSchema
    this.nodes = new Map()
    this.edges = new Map()
    this.branches = new Map()
    this.fanouts = new Map()
    this.joins = new Map()
  }
  addNode(name, run, meta = {}) {
    const key = nodeName.parse(name)
    if (this.nodes.has(key)) throw new GraphError('graph_duplicate_node', `节点 ${key} 已存在`)
    if (this.channels.definition[key])
      // A node that shares a name with a channel makes every trace ambiguous.
      throw new GraphError('graph_name_clash', `节点名 ${key} 与状态字段重名`)
    if (typeof run !== 'function') throw new GraphError('graph_invalid_node', '节点必须是函数')
    this.nodes.set(key, { name: key, run, meta })
    return this
  }
  addEdge(from, to) {
    if (from === END) throw new GraphError('graph_invalid_edge', 'END 之后没有节点')
    this.#assertTarget(to)
    if (from !== START && !this.nodes.has(from))
      throw new GraphError('graph_invalid_edge', `未知节点 ${from}`)
    if (this.edges.has(from) || this.branches.has(from) || this.fanouts.has(from))
      throw new GraphError('graph_invalid_edge', `${from} 已经有出边`)
    this.edges.set(from, to)
    return this
  }
  addConditionalEdges(from, router, candidates, meta = {}) {
    if (from !== START && !this.nodes.has(from))
      throw new GraphError('graph_invalid_edge', `未知节点 ${from}`)
    if (this.edges.has(from) || this.branches.has(from) || this.fanouts.has(from))
      throw new GraphError('graph_invalid_edge', `${from} 已经有出边`)
    if (typeof router !== 'function') throw new GraphError('graph_invalid_edge', '路由必须是函数')
    if (!Array.isArray(candidates) || candidates.length === 0)
      throw new GraphError('graph_invalid_edge', '条件边必须声明候选节点')
    for (const candidate of candidates) this.#assertTarget(candidate)
    this.branches.set(from, { router, candidates, meta })
    return this
  }
  /**
   * Split into several paths that all run, then meet again at `join`.
   *
   * The paths are taken one after another in the order given, not
   * concurrently: a mission owns one executor and one approval at a time, so
   * running them at the same time would buy nothing and would let two branches
   * race for the same pending tool call. What fan-out buys is structure — the
   * branches are independent, and `join` runs once, after all of them arrive.
   */
  addFanoutEdges(from, targets, join, meta = {}) {
    if (from !== START && !this.nodes.has(from))
      throw new GraphError('graph_invalid_edge', `未知节点 ${from}`)
    if (this.edges.has(from) || this.branches.has(from) || this.fanouts.has(from))
      throw new GraphError('graph_invalid_edge', `${from} 已经有出边`)
    if (!Array.isArray(targets) || targets.length < 2)
      throw new GraphError('graph_invalid_edge', '分叉至少需要两条分支')
    if (new Set(targets).size !== targets.length)
      throw new GraphError('graph_invalid_edge', '分叉的分支不能重复')
    for (const target of targets) this.#assertTarget(target)
    this.#assertTarget(join)
    if (targets.includes(join))
      throw new GraphError('graph_invalid_edge', '汇合节点不能同时是一条分支')
    this.fanouts.set(from, { targets, join, meta })
    // How many arrivals the join waits for. Counted here, at construction,
    // so the runner never has to work out the shape at run time.
    this.joins.set(join, (this.joins.get(join) ?? 0) + targets.length)
    return this
  }
  #assertTarget(target) {
    if (target !== END && !this.nodes.has(target))
      throw new GraphError('graph_invalid_edge', `未知节点 ${target}`)
  }
  compile({ maxSteps = 60, layout = {} } = {}) {
    if (!this.edges.has(START) && !this.branches.has(START) && !this.fanouts.has(START))
      throw new GraphError('graph_no_entry', '图没有入口边')
    for (const name of this.nodes.keys())
      if (!this.edges.has(name) && !this.branches.has(name) && !this.fanouts.has(name))
        throw new GraphError('graph_dangling_node', `节点 ${name} 没有出边`)
    return new CompiledGraph(this, maxSteps, layout)
  }
}

export class CompiledGraph {
  constructor(graph, maxSteps, layout = {}) {
    this.graph = graph
    this.maxSteps = maxSteps
    this.layout = layout
  }
  /**
   * The shape the orchestration centre draws. It is derived from the compiled
   * graph, so the picture cannot drift from what actually runs.
   */
  describe() {
    const edges = []
    for (const [from, to] of this.graph.edges) edges.push({ from, to, kind: 'direct' })
    for (const [from, branch] of this.graph.branches)
      for (const to of branch.candidates)
        edges.push({
          from,
          to,
          kind: 'conditional',
          label: branch.meta.labels?.[to] ?? null
        })
    for (const [from, fanout] of this.graph.fanouts)
      for (const [index, to] of fanout.targets.entries())
        edges.push({
          from,
          to,
          kind: 'fanout',
          label: fanout.meta.labels?.[to] ?? `分支 ${index + 1}`
        })
    return {
      joins: Object.fromEntries(this.graph.joins),
      layout: this.layout,
      entry: START,
      nodes: [...this.graph.nodes.values()].map((node) => ({
        name: node.name,
        title: node.meta.title ?? node.name,
        kind: node.meta.kind ?? 'step',
        description: node.meta.description ?? '',
        interrupts: node.meta.interrupts === true
      })),
      edges
    }
  }
  initialState(overrides) {
    return this.graph.channels.initial(overrides)
  }
  /**
   * Run until every path reaches END, or until a node interrupts.
   *
   * Paths are held in a queue rather than a single cursor so a fan-out can put
   * several of them in flight. They are still taken one at a time, in order:
   * the value of fan-out here is structure, not concurrency. `arrivals` counts
   * how many branches have reached each join so far, and is checkpointed with
   * everything else — a join half-reached before a pause is still half-reached
   * after the approval comes back.
   */
  async run({
    state,
    next = START,
    queue = [],
    arrivals = {},
    resume,
    context = {},
    onStep,
    signal
  } = {}) {
    if (this.graph.contextSchema) this.graph.contextSchema.parse(context)
    let value = state ?? this.initialState()
    const pending = [...(Array.isArray(next) ? next : [next]), ...queue]
    const seen = { ...arrivals }
    let pendingResume = resume
    let steps = 0
    const checkpoint = (extra) => ({
      ...extra,
      state: value,
      queue: [...pending],
      arrivals: { ...seen }
    })

    while (pending.length) {
      signal?.throwIfAborted()
      if (++steps > this.maxSteps)
        throw new GraphError('graph_step_budget', '编排步数超过上限，已停止以避免死循环')
      const current = pending.shift()
      if (current === END) continue
      if (current === START) {
        pending.unshift(...this.#next(START, value))
        continue
      }
      // A join runs once, on the last arrival. Earlier arrivals stop here;
      // the branch that completes the set is the one that carries on.
      const waitsFor = this.graph.joins.get(current)
      if (waitsFor !== undefined) {
        const arrived = (seen[current] ?? 0) + 1
        seen[current] = arrived
        if (arrived < waitsFor) continue
        seen[current] = 0
      }
      const node = this.graph.nodes.get(current)
      if (!node) throw new GraphError('graph_unknown_node', `未知节点 ${current}`)
      let consumed = false
      const nodeContext = {
        ...context,
        node: node.name,
        signal,
        interrupt(payload) {
          if (pendingResume !== undefined && !consumed) {
            consumed = true
            const answer = pendingResume
            pendingResume = undefined
            return answer
          }
          throw new GraphInterrupt(node.name, payload)
        }
      }
      let update
      try {
        update = await node.run(value, nodeContext)
      } catch (error) {
        if (error instanceof GraphInterrupt) {
          // The interrupted node re-runs on resume, so it goes back at the
          // head of the queue and its join arrival is not counted twice.
          if (waitsFor !== undefined) seen[node.name] = waitsFor - 1
          return {
            status: 'interrupted',
            node: error.node,
            value: error.value,
            steps,
            ...checkpoint({})
          }
        }
        throw error
      }
      value = this.graph.channels.apply(value, update, node.name)
      await onStep?.({ node: node.name, update: update ?? {}, state: value })
      // Depth first: a branch runs to its end before the next one starts, so
      // only one path is ever mid-flight through a shared execution node.
      pending.unshift(...this.#next(node.name, value))
    }
    return { status: 'completed', steps, ...checkpoint({}) }
  }

  /** Always an array: one successor for a plain edge, several for a fan-out. */
  #next(from, state) {
    const direct = this.graph.edges.get(from)
    if (direct) return [direct]
    const fanout = this.graph.fanouts.get(from)
    if (fanout) return [...fanout.targets]
    const branch = this.graph.branches.get(from)
    if (!branch) throw new GraphError('graph_dangling_node', `${from} 没有出边`)
    const target = branch.router(state)
    if (!branch.candidates.includes(target))
      throw new GraphError('graph_invalid_route', `${from} 的路由返回了未声明的目标 ${target}`)
    return [target]
  }
}
