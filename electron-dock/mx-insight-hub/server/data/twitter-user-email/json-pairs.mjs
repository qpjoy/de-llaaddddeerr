// Incremental scanner for one huge top-level JSON object of string pairs:
//   {"name":"a@example.com","other":"b@example.com", ...}
//
// The whole document is never parsed at once. The caller feeds byte windows;
// the scanner returns every complete pair plus the byte position of the last
// pair boundary, which is a durable resume point ("after_pair"). A window that
// ends inside a token simply stops early; the caller re-feeds from `boundary`.
//
// Strings keep their exact text. Text that PostgreSQL cannot store, or that
// is not valid Unicode, is reported as an issue instead of being repaired.

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COLON = 0x3a
const COMMA = 0x2c
const LBRACE = 0x7b
const RBRACE = 0x7d
const LBRACKET = 0x5b
const RBRACKET = 0x5d

const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export class JsonPairsError extends Error {
  constructor(code, offset) {
    super(`Malformed source JSON (${code}) at byte ${offset}`)
    this.name = 'JsonPairsError'
    this.code = code
    this.offset = offset
  }
}

function skipWhitespace(buf, i) {
  const n = buf.length
  while (i < n) {
    const b = buf[i]
    if (b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09) break
    i += 1
  }
  return i
}

const SIMPLE_ESCAPES = {
  0x22: '"', 0x5c: '\\', 0x2f: '/', 0x62: '\b', 0x66: '\f', 0x6e: '\n', 0x72: '\r', 0x74: '\t',
}

function hexValue(buf, at) {
  let value = 0
  for (let k = 0; k < 4; k += 1) {
    const c = buf[at + k]
    let digit
    if (c >= 0x30 && c <= 0x39) digit = c - 0x30
    else if (c >= 0x41 && c <= 0x46) digit = c - 0x37
    else if (c >= 0x61 && c <= 0x66) digit = c - 0x57
    else return -1
    value = value * 16 + digit
  }
  return value
}

function decodeRun(buf, start, stop) {
  return fatalDecoder.decode(buf.subarray(start, stop))
}

function decodeEscaped(buf, start, stop) {
  let out = ''
  let run = start
  let i = start
  let issue = null
  let sawSurrogate = false
  try {
    while (i < stop) {
      if (buf[i] !== BACKSLASH) { i += 1; continue }
      if (i > run) out += decodeRun(buf, run, i)
      const c = buf[i + 1]
      if (c === 0x75) {
        const code = i + 6 <= stop ? hexValue(buf, i + 2) : -1
        if (code < 0) return { text: null, issue: 'invalid_text' }
        if (code === 0) issue = 'nul_character'
        if (code >= 0xd800 && code <= 0xdfff) sawSurrogate = true
        out += String.fromCharCode(code)
        i += 6
      } else if (SIMPLE_ESCAPES[c] !== undefined) {
        out += SIMPLE_ESCAPES[c]
        i += 2
      } else {
        return { text: null, issue: 'invalid_text' }
      }
      run = i
    }
    if (stop > run) out += decodeRun(buf, run, stop)
  } catch {
    return { text: null, issue: 'invalid_text' }
  }
  if (issue) return { text: null, issue }
  if (sawSurrogate && LONE_SURROGATE.test(out)) return { text: null, issue: 'invalid_text' }
  return { text: out, issue: null }
}

/**
 * Read a JSON string whose opening quote is at `i`.
 * Returns null when the window ends before the closing quote.
 */
export function readString(buf, i) {
  const n = buf.length
  let j = i + 1
  let ascii = true
  let escaped = false
  let nul = false
  while (j < n) {
    const b = buf[j]
    if (b === QUOTE) break
    if (b === BACKSLASH) { escaped = true; j += 2; continue }
    if (b >= 0x80) ascii = false
    else if (b === 0) nul = true
    j += 1
  }
  if (j >= n) return null
  const start = i + 1
  let text = null
  let issue = null
  if (nul) {
    issue = 'nul_character'
  } else if (escaped) {
    ({ text, issue } = decodeEscaped(buf, start, j))
  } else if (ascii) {
    text = buf.latin1Slice ? buf.latin1Slice(start, j) : buf.toString('latin1', start, j)
  } else {
    try { text = decodeRun(buf, start, j) } catch { issue = 'invalid_text' }
  }
  return { text, issue, start, stop: j, end: j + 1 }
}

// Skip any non-string JSON value. Returns the end position, or -1 when more
// bytes are needed.
function skipValue(buf, i, final) {
  const n = buf.length
  const first = buf[i]
  if (first === LBRACE || first === LBRACKET) {
    let depth = 0
    let j = i
    while (j < n) {
      const b = buf[j]
      if (b === QUOTE) {
        const string = readString(buf, j)
        if (!string) return -1
        j = string.end
        continue
      }
      if (b === LBRACE || b === LBRACKET) depth += 1
      else if (b === RBRACE || b === RBRACKET) {
        depth -= 1
        if (depth === 0) return j + 1
      }
      j += 1
    }
    return -1
  }
  let j = i
  while (j < n) {
    const b = buf[j]
    if (b === COMMA || b === RBRACE || b === RBRACKET || b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09) break
    j += 1
  }
  if (j === i) throw new JsonPairsError('expected_value', i)
  if (j >= n && !final) return -1
  return j
}

/**
 * Scan complete pairs from `buf` starting at `start` in `state`
 * ('start' before the opening brace, 'after_pair', or 'end').
 *
 * Returns { pairs, boundary, state } where `boundary` is the position after
 * the last complete pair (or after the closing brace) and `state` is the
 * resumable state at that position. Each pair is { key, value, end }.
 */
export function scanPairs(buf, start, state, { final = false, maxPairs = Infinity } = {}) {
  const n = buf.length
  const pairs = []
  let i = start
  let current = state
  let boundary = start
  let boundaryState = state
  while (pairs.length < maxPairs) {
    i = skipWhitespace(buf, i)
    if (current === 'end') {
      if (i < n) throw new JsonPairsError('trailing_data', i)
      boundary = i
      boundaryState = 'end'
      break
    }
    if (i >= n) break
    if (current === 'start') {
      if (buf[i] !== LBRACE) throw new JsonPairsError('not_an_object', i)
      i = skipWhitespace(buf, i + 1)
      if (i >= n) break
      if (buf[i] === RBRACE) {
        i += 1
        current = 'end'
        boundary = i
        boundaryState = 'end'
        continue
      }
    } else {
      if (buf[i] === RBRACE) {
        i += 1
        current = 'end'
        boundary = i
        boundaryState = 'end'
        continue
      }
      if (buf[i] !== COMMA) throw new JsonPairsError('expected_comma', i)
      i = skipWhitespace(buf, i + 1)
      if (i >= n) break
    }
    if (buf[i] !== QUOTE) throw new JsonPairsError('expected_key', i)
    const key = readString(buf, i)
    if (!key) break
    i = skipWhitespace(buf, key.end)
    if (i >= n) break
    if (buf[i] !== COLON) throw new JsonPairsError('expected_colon', i)
    i = skipWhitespace(buf, i + 1)
    if (i >= n) break
    let value
    if (buf[i] === QUOTE) {
      value = readString(buf, i)
      if (!value) break
      i = value.end
    } else {
      const end = skipValue(buf, i, final)
      if (end < 0) break
      value = { nonString: true, start: i, stop: end, end }
      i = end
    }
    pairs.push({ key, value, end: i })
    current = 'after_pair'
    boundary = i
    boundaryState = 'after_pair'
  }
  return { pairs, boundary, state: boundaryState }
}

/**
 * Async iterator over a file region. Yields { pairs, boundaryOffset, state }
 * per window, with absolute offsets on each pair (`endOffset`). `read(position,
 * length)` returns a Buffer (shorter at EOF).
 */
export async function* readPairWindows({ read, size, offset = 0, state = 'start', chunkBytes = 8 * 1024 * 1024 }) {
  let carry = Buffer.alloc(0)
  let carryOffset = offset
  let current = state
  while (true) {
    const position = carryOffset + carry.length
    const remaining = size - position
    const chunk = remaining > 0 ? await read(position, Math.min(chunkBytes, remaining)) : Buffer.alloc(0)
    const final = position + chunk.length >= size
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
    const result = scanPairs(buf, 0, current, { final })
    for (const pair of result.pairs) pair.endOffset = carryOffset + pair.end
    const window = { pairs: result.pairs, buf, baseOffset: carryOffset, boundaryOffset: carryOffset + result.boundary, state: result.state }
    yield window
    carry = buf.subarray(result.boundary)
    carryOffset += result.boundary
    current = result.state
    if (final) {
      if (current === 'end') return
      if (result.pairs.length === 0) throw new JsonPairsError('truncated', carryOffset)
    }
    if (!final && chunk.length === 0) throw new JsonPairsError('short_read', position)
  }
}
