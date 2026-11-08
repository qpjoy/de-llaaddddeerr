// Documented response fields versus an actual response, for API docs and the
// interface debugger. Paths use dots for objects and `[]` for array items,
// e.g. `data.items[].author.name`.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const typeName = schema => Array.isArray(schema?.type) ? schema.type.join(' | ') : schema?.type
  || (schema?.const !== undefined ? typeof schema.const : schema?.enum ? 'enum' : schema?.oneOf || schema?.anyOf ? 'mixed' : 'any')

export function resolveSchema(document, schema) {
  let current = schema, guard = 0
  while (current?.$ref && guard++ < 20) current = current.$ref.split('/').slice(1).reduce((value, key) => value?.[key], document)
  return current || {}
}

// Flatten an OpenAPI/JSON schema into ordered field rows. Composite schemas
// contribute every variant's fields once, in declaration order.
export function schemaFieldRows(document, schema, { maxDepth = 8 } = {}) {
  const rows = [], seen = new Map()
  const add = row => {
    const existing = seen.get(row.path)
    if (existing) { if (!existing.description && row.description) existing.description = row.description; return }
    seen.set(row.path, row); rows.push(row)
  }
  const visit = (node, prefix, depth, required = []) => {
    node = resolveSchema(document, node)
    if (depth > maxDepth || !object(node)) return
    for (const key of ['allOf', 'oneOf', 'anyOf']) for (const variant of node[key] || []) visit(variant, prefix, depth + 1, required)
    for (const [name, child] of Object.entries(node.properties || {})) {
      const resolved = resolveSchema(document, child), path = prefix ? `${prefix}.${name}` : name
      add({ path, type: typeName(resolved), description: resolved.description || '', required: (node.required || required).includes(name),
        ...(resolved.enum ? { enum: resolved.enum } : {}), ...(resolved.example !== undefined ? { example: resolved.example } : {}) })
      visit(resolved, path, depth + 1)
      if (resolved.items) visit(resolved.items, `${path}[]`, depth + 1)
    }
  }
  visit(schema, '', 0)
  return rows
}

// Every field path present in a JSON value. Array items merge into `[]`.
export function payloadFieldPaths(payload, { maxDepth = 10, maxPaths = 2000 } = {}) {
  const paths = new Map()
  const visit = (value, prefix, depth) => {
    if (depth > maxDepth || paths.size >= maxPaths) return
    if (Array.isArray(value)) { for (const item of value.slice(0, 50)) visit(item, `${prefix}[]`, depth + 1); return }
    if (!object(value)) return
    for (const [name, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${name}` : name
      const previous = paths.get(path)
      const empty = child === null || child === '' || Array.isArray(child) && !child.length
      paths.set(path, { present: true, nonEmpty: Boolean(previous?.nonEmpty) || !empty,
        sample: previous?.nonEmpty ? previous.sample : sampleOf(child) })
      visit(child, path, depth + 1)
    }
  }
  visit(payload, '', 0)
  return paths
}
const sampleOf = value => value === null ? null : Array.isArray(value) ? `[${value.length}]`
  : object(value) ? '{…}' : typeof value === 'string' && value.length > 80 ? `${value.slice(0, 77)}…` : value

// Documented rows annotated with what this response returned, plus fields the
// response returned that the documentation does not describe.
export function compareResponseFields(rows, payload) {
  const actual = payloadFieldPaths(payload)
  const documented = new Set(rows.map(row => row.path))
  const under = (path, parent) => path.startsWith(`${parent}.`) || path.startsWith(`${parent}[]`)
  // Inside a documented free-form value (one whose own fields are not listed,
  // such as `raw` or `metadata`), nested keys are not separate omissions.
  const isDescendantOfDocumentedLeaf = path => {
    const parent = rows.filter(row => under(path, row.path)).sort((a, b) => b.path.length - a.path.length)[0]
    return Boolean(parent) && !rows.some(row => under(row.path, parent.path))
  }
  return {
    rows: rows.map(row => {
      const seen = actual.get(row.path)
      return { ...row, status: !seen ? 'missing' : seen.nonEmpty ? 'returned' : 'empty', sample: seen?.sample }
    }),
    undocumented: [...actual.entries()].filter(([path]) => !documented.has(path) && !isDescendantOfDocumentedLeaf(path))
      .map(([path, value]) => ({ path, sample: value.sample })),
  }
}
