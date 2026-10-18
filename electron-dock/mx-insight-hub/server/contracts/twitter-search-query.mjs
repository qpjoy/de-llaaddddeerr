import { AppError } from '../core/errors.mjs'

export const TWITTER_QUERY_DIALECT = 'twitter.boolean.v1'
const MAX_INPUT = 500, MAX_OUTPUT = 512, MAX_TOKENS = 256, MAX_NODES = 192, MAX_DEPTH = 16
const invalid = reason => { throw new AppError(400, 'invalid_twitter_query',
  'Twitter search query cannot be converted without changing its conditions', { platform: 'twitter', reason }) }

// This is a bounded Boolean grammar, not a string replacement. Quoted text and
// native fields remain opaque atoms; only standalone uppercase SQL operators
// activate compatibility. Existing native searches pass through byte-for-byte.
function tokenize(query) {
  const tokens = []
  let index = 0, unterminatedQuote = false, attachedParenthesis = false
  while (index < query.length) {
    if (/\s/u.test(query[index])) { index++; continue }
    const character = query[index]
    if ('()-'.includes(character)) {
      tokens.push({ type: character }); index++
    } else {
      const start = index
      let quoted = false
      while (index < query.length) {
        const value = query[index]
        if (value === '\\' && quoted && index + 1 < query.length) { index += 2; continue }
        if (value === '"') { quoted = !quoted; index++; continue }
        if (!quoted && (/\s/u.test(value) || value === '(' || value === ')')) break
        index++
      }
      const value = query.slice(start, index)
      const type = ['AND', 'OR', 'NOT'].includes(value) ? value : 'atom'
      // Native fields may contain punctuation (e.g. url:.../a(b)). Without a
      // separator this is not proven to be a Boolean group. Preserve it by
      // declining compatibility instead of splitting or dropping punctuation.
      attachedParenthesis ||= type === 'atom' && query[index] === '('
      tokens.push({ type, value })
      unterminatedQuote ||= quoted
    }
    if (tokens.length > MAX_TOKENS) invalid('query_too_complex')
  }
  return { tokens, unterminatedQuote, attachedParenthesis }
}

function parse(tokens) {
  let index = 0, nodes = 0
  const node = value => { if (++nodes > MAX_NODES) invalid('query_too_complex'); return value }
  const startsUnary = token => token && ['atom', '(', 'NOT', '-'].includes(token.type)
  const unary = depth => {
    if (depth > MAX_DEPTH) invalid('query_too_deep')
    const token = tokens[index++]
    if (!token) invalid('missing_operand')
    if (token.type === 'NOT' || token.type === '-') return node({ type: 'not', child: unary(depth + 1) })
    if (token.type === 'atom') return node({ type: 'atom', value: token.value })
    if (token.type !== '(') invalid('unexpected_operator')
    const value = disjunction(depth + 1)
    if (tokens[index++]?.type !== ')') invalid('unbalanced_parentheses')
    return value
  }
  const conjunction = depth => {
    const children = [unary(depth)]
    while (index < tokens.length && tokens[index].type !== 'OR' && tokens[index].type !== ')') {
      if (tokens[index].type === 'AND') index++
      else if (!startsUnary(tokens[index])) invalid('unexpected_operator')
      children.push(unary(depth))
    }
    return children.length === 1 ? children[0] : node({ type: 'and', children })
  }
  const disjunction = depth => {
    const children = [conjunction(depth)]
    while (tokens[index]?.type === 'OR') { index++; children.push(conjunction(depth)) }
    return children.length === 1 ? children[0] : node({ type: 'or', children })
  }
  const result = disjunction(0)
  if (index !== tokens.length) invalid('unbalanced_parentheses')
  return result
}

function nativeTree(node, negative = false) {
  if (node.type === 'not') return nativeTree(node.child, !negative)
  if (node.type === 'atom') return { ...node, negative }
  // X supports excluding individual terms. NOT(a AND b) would require a
  // disjunction of negative-only branches, whose search semantics are not
  // established by the supplier contract; never silently broaden that query.
  if (negative && node.type === 'and') invalid('negated_conjunction_unsupported')
  const type = negative ? 'and' : node.type
  const children = node.children.map(child => nativeTree(child, negative))
    .flatMap(child => child.type === type ? child.children : [child])
  if (type === 'or' && children.some(child => !hasPositive(child))) invalid('negative_disjunction_unsupported')
  return { type, children }
}

function hasPositive(node) {
  return node.type === 'atom' ? !node.negative : node.children.some(hasPositive)
}
function render(node) {
  if (node.type === 'atom') return `${node.negative ? '-' : ''}${node.value}`
  const value = node.children.map(child => node.type === 'or' && child.type === 'and'
    ? `(${render(child)})` : render(child)).join(node.type === 'or' ? ' OR ' : ' ')
  return node.type === 'or' ? `(${value})` : value
}

export function compileTwitterSearchQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_INPUT) invalid('invalid_query_length')
  const { tokens, unterminatedQuote, attachedParenthesis } = tokenize(query)
  if (!tokens.some(token => token.type === 'AND' || token.type === 'NOT')) {
    return { query, providerQuery: query, changed: false, dialect: null }
  }
  if (unterminatedQuote) invalid('unterminated_quote')
  if (attachedParenthesis) invalid('ambiguous_atom_parenthesis')
  if (/[\u0000-\u001f\u007f]/u.test(query)) invalid('control_character')
  const tree = nativeTree(parse(tokens))
  if (!hasPositive(tree)) invalid('positive_term_required')
  const providerQuery = render(tree)
  if (providerQuery.length > MAX_OUTPUT) invalid('compiled_query_too_long')
  return { query, providerQuery, changed: providerQuery !== query,
    dialect: providerQuery !== query ? TWITTER_QUERY_DIALECT : null }
}
