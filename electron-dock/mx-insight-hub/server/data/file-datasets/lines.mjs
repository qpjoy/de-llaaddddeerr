// Incremental reader for "one record per line" text files (\n or \r\n).
//
// Same window contract as readPairWindows: each window yields its complete
// records with the absolute byte offset after each line (`endOffset`), which
// is a durable resume point. A trailing partial line is carried into the next
// window; at end of file a last line without newline is still a record.
// Text PostgreSQL cannot store, or that is not valid UTF-8, is reported as an
// issue instead of being repaired.

const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d
const MAX_LINE_BYTES = 64 * 1024

const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export class LineRecordsError extends Error {
  constructor(code, offset) {
    super(`Malformed source lines (${code}) at byte ${offset}`)
    this.name = 'LineRecordsError'
    this.code = code
    this.offset = offset
  }
}

function decodeLine(buf, start, stop) {
  let end = stop
  if (end > start && buf[end - 1] === CARRIAGE_RETURN) end -= 1
  const bytes = buf.subarray(start, end)
  if (bytes.includes(0)) return { text: null, issue: 'nul_character' }
  try {
    return { text: fatalDecoder.decode(bytes), issue: null }
  } catch {
    return { text: null, issue: 'invalid_text' }
  }
}

/**
 * Async iterator over a file region. `read(position, length)` returns a
 * Buffer (shorter at EOF). Records are { text, issue, start, stop, endOffset }
 * where start/stop index the window buffer (raw bytes for quarantine).
 */
export async function* readLineWindows({ read, size, offset = 0, state = 'start', chunkBytes = 8 * 1024 * 1024 }) {
  if (state === 'end') return
  let carry = Buffer.alloc(0)
  let carryOffset = offset
  let atFileStart = offset === 0
  while (true) {
    const position = carryOffset + carry.length
    const remaining = size - position
    const chunk = remaining > 0 ? await read(position, Math.min(chunkBytes, remaining)) : Buffer.alloc(0)
    if (remaining > 0 && chunk.length === 0) throw new LineRecordsError('short_read', position)
    const final = position + chunk.length >= size
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
    let start = 0
    // A UTF-8 byte order mark is not part of the first record.
    if (atFileStart && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3
    atFileStart = false
    const records = []
    while (true) {
      const newline = buf.indexOf(NEWLINE, start)
      if (newline < 0) break
      records.push({ ...decodeLine(buf, start, newline), start, stop: newline, endOffset: carryOffset + newline + 1 })
      start = newline + 1
    }
    if (final && start < buf.length) {
      records.push({ ...decodeLine(buf, start, buf.length), start, stop: buf.length, endOffset: carryOffset + buf.length })
      start = buf.length
    }
    if (buf.length - start > MAX_LINE_BYTES) throw new LineRecordsError('line_too_long', carryOffset + start)
    yield { pairs: records, buf, baseOffset: carryOffset, boundaryOffset: carryOffset + start, state: final ? 'end' : 'after_pair' }
    if (final) return
    carry = buf.subarray(start)
    carryOffset += start
  }
}
