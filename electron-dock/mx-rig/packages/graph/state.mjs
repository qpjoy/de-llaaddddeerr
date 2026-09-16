import { z } from 'zod'

/**
 * A state channel, in the LangGraph sense: a named slot plus the rule for
 * merging a node's return value into it.
 *
 * The reducer is what makes a node a pure "return the delta" function instead
 * of something that has to know the whole state. `schema` is not decoration —
 * every merged value is parsed, so a node that returns the wrong shape fails
 * at the node that produced it rather than three hops later in a router.
 */
export function channel(schema, { reducer, initial } = {}) {
  if (!schema || typeof schema.parse !== 'function')
    throw new TypeError('channel(schema) requires a zod schema')
  return {
    schema,
    reducer: reducer ?? ((_previous, next) => next),
    initial: initial ?? (() => undefined)
  }
}

/** Append-only channel: nodes contribute items, nobody rewrites history. */
export function appendChannel(itemSchema, { max = 500 } = {}) {
  return channel(z.array(itemSchema).max(max), {
    reducer: (previous = [], next = []) => previous.concat(next),
    initial: () => []
  })
}

export class StateSchemaError extends Error {
  constructor(channelName, issue) {
    super(`状态字段 ${channelName} 不符合定义：${issue}`)
    this.code = 'graph_state_invalid'
    this.channel = channelName
  }
}

export class StateChannels {
  constructor(definition) {
    this.definition = definition
    this.names = Object.keys(definition)
  }
  initial(overrides = {}) {
    const state = {}
    for (const [name, spec] of Object.entries(this.definition)) state[name] = spec.initial()
    return this.apply(state, overrides, 'initial')
  }
  /** Merge one node's delta. Unknown keys are refused, not ignored. */
  apply(state, update, source = 'node') {
    if (update == null) return state
    if (typeof update !== 'object' || Array.isArray(update))
      throw new StateSchemaError(source, '节点必须返回对象或 undefined')
    const next = { ...state }
    for (const [name, value] of Object.entries(update)) {
      const spec = this.definition[name]
      if (!spec) throw new StateSchemaError(name, `${source} 返回了未声明的状态字段`)
      const parsed = spec.schema.safeParse(spec.reducer(state[name], value))
      if (!parsed.success)
        throw new StateSchemaError(name, parsed.error.issues[0]?.message ?? '类型不匹配')
      next[name] = parsed.data
    }
    return next
  }
}
