// Structured page observation for the Agent: Playwright's accessibility
// snapshot, with a stable reference on every element it can act on.
//
// Only public Playwright API is used. `locator.ariaSnapshot()` lists elements by
// role and accessible name in document order, which is the same order
// `page.getByRole(role).nth(i)` walks. So a reference is just "the i-th element
// of this role", and before any action the element found that way is checked
// against the role and name the model was shown. A page that changed underneath
// the model fails that check instead of receiving a click meant for something
// else.

/** Roles the Agent may address by reference. Everything else is context. */
export const ACTIONABLE_ROLES = Object.freeze(
  new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'option',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'switch',
    'slider',
    'spinbutton',
    'treeitem'
  ])
)

export const SNAPSHOT_LIMIT = 16_000
const REF_PATTERN = /^e[1-9][0-9]{0,4}$/

export function isRef(value) {
  return typeof value === 'string' && REF_PATTERN.test(value)
}

/**
 * Split one snapshot line into indentation, role, name, attributes and the
 * remainder (`: text`, `:` or nothing). Returns null for lines that are not an
 * element (`- /url: …`, continuation text, anything unexpected).
 */
export function parseLine(line) {
  const match = /^(\s*)- (.*)$/.exec(line)
  if (!match) return null
  const [, indent, node] = match
  let key
  let rest
  if (node.startsWith("'")) {
    // YAML single-quoted key: '' is an escaped quote, the first lone ' closes it.
    let index = 1
    let value = ''
    while (index < node.length) {
      if (node[index] === "'") {
        if (node[index + 1] === "'") {
          value += "'"
          index += 2
          continue
        }
        break
      }
      value += node[index]
      index += 1
    }
    if (index >= node.length) return null
    key = value
    rest = node.slice(index + 1)
  } else if (node.startsWith('"')) {
    const close = closingQuote(node, 0)
    if (close < 0) return null
    try {
      key = JSON.parse(node.slice(0, close + 1))
    } catch {
      return null
    }
    rest = node.slice(close + 1)
  } else {
    // An unquoted key cannot contain ': ' — YAML would have quoted it.
    const split = node.indexOf(': ')
    if (split >= 0) {
      key = node.slice(0, split)
      rest = node.slice(split)
    } else if (node.endsWith(':')) {
      key = node.slice(0, -1)
      rest = ':'
    } else {
      key = node
      rest = ''
    }
  }
  const parts = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)$/.exec(key)
  if (!parts) return null
  let name = ''
  if (parts[2] !== undefined) {
    try {
      name = JSON.parse(`"${parts[2]}"`)
    } catch {
      return null
    }
  }
  return { indent, role: parts[1], name, attrs: parts[3] ?? '', rest }
}

function closingQuote(text, open) {
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1
      continue
    }
    if (text[index] === '"') return index
  }
  return -1
}

/**
 * Annotate a snapshot with `[ref=eN]` on every actionable element.
 *
 * Returns the text the model reads and the table the tools resolve against.
 * The text is rebuilt rather than patched, so the model never sees YAML
 * quoting it would have to undo.
 */
export function annotateSnapshot(yaml, { limit = SNAPSHOT_LIMIT } = {}) {
  const counts = new Map()
  const refs = new Map()
  const lines = []
  for (const line of String(yaml ?? '').split('\n')) {
    const parsed = parseLine(line)
    if (!parsed) {
      lines.push(line)
      continue
    }
    const { indent, role, name, attrs, rest } = parsed
    const index = counts.get(role) ?? 0
    counts.set(role, index + 1)
    const label = `${indent}- ${role}${name ? ` ${JSON.stringify(name)}` : ''}${attrs}`
    if (!ACTIONABLE_ROLES.has(role)) {
      lines.push(`${label}${rest}`)
      continue
    }
    const ref = `e${refs.size + 1}`
    refs.set(ref, { role, name, index })
    lines.push(`${label} [ref=${ref}]${rest}`)
  }
  let text = lines.join('\n')
  const truncated = text.length > limit
  if (truncated)
    text = `${text.slice(0, limit)}\n… 快照已截断；元素过多时请先缩小页面范围或滚动后重新观察。`
  return { text, refs, truncated }
}

/** Does the element found by position still look like what the model was shown? */
export function sameElement(expected, snapshotOfElement) {
  const first = String(snapshotOfElement ?? '').split('\n')[0]
  const parsed = parseLine(first)
  return Boolean(parsed && parsed.role === expected.role && parsed.name === expected.name)
}
