import { inflateRawSync } from 'node:zlib'

// Tabular parsers for external imports: CSV/TSV, JSON Lines, plain text, XLSX.
//
// XLSX is parsed here rather than through a spreadsheet library, and that is a
// security decision, not a dependency-minimalism one. These files arrive from
// outside and are untrusted. A general-purpose spreadsheet library parses
// formulas, external workbook links, defined names, DDE, and XML entities — a
// large surface for something whose only job is "read the cached cell values".
// This reader does exactly that, ignores formulas entirely, resolves no
// entities, and enforces explicit size limits so a zip bomb fails fast instead
// of consuming the pod.
//
// The tradeoff is real: no styles, no dates-as-formatted-strings, no multi-sheet
// selection beyond the first sheet. That is the right side of the trade for an
// ingest path.

const MAX_ROWS = 500_000
const MAX_CELL_LENGTH = 32_768
// Bounds the inflate of any single zip entry. sharedStrings.xml on a large
// workbook is legitimately tens of MB; a zip bomb is orders of magnitude more.
const MAX_ENTRY_BYTES = 256 * 1024 * 1024

export class ParseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ParseError'
  }
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 style CSV, with quoted fields, escaped quotes and embedded newlines.
 *
 * Hand-written rather than split(',') because embedded newlines inside quoted
 * fields are common in scraped text — a naive line split silently shreds every
 * such row into fragments that then fail mapping for the wrong reason.
 */
export function parseDelimited(text, { delimiter = ',', header = true } = {}) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let index = 0
  const input = stripBom(text)

  while (index < input.length) {
    const character = input[index]
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += character
      index += 1
      continue
    }
    if (character === '"' && field === '') {
      quoted = true
      index += 1
      continue
    }
    if (character === delimiter) {
      row.push(field)
      field = ''
      index += 1
      continue
    }
    if (character === '\n' || character === '\r') {
      // Consume CRLF as one terminator.
      if (character === '\r' && input[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      index += 1
      if (rows.length > MAX_ROWS) throw new ParseError(`more than ${MAX_ROWS} rows`)
      continue
    }
    field += character
    index += 1
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  if (quoted) throw new ParseError('unterminated quoted field')

  return toRecords(rows, header)
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function toRecords(rows, header) {
  if (rows.length === 0) return { columns: [], records: [] }
  if (!header) {
    const columns = rows[0].map((_, index) => `column_${index + 1}`)
    return { columns, records: rows.map((row) => zip(columns, row)) }
  }
  // Blank and duplicate headers are given stable synthetic names rather than
  // being dropped: a column with no header still carries data, and two columns
  // named "备注" must not overwrite each other.
  const seen = new Map()
  const columns = rows[0].map((raw, index) => {
    const name = String(raw ?? '').trim() || `column_${index + 1}`
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    return count === 0 ? name : `${name}_${count + 1}`
  })
  return { columns, records: rows.slice(1).map((row) => zip(columns, row)) }
}

function zip(columns, row) {
  const record = {}
  for (const [index, column] of columns.entries()) {
    const value = row[index]
    record[column] = value === undefined ? null : truncate(value)
  }
  return record
}

function truncate(value) {
  const text = String(value)
  return text.length > MAX_CELL_LENGTH ? text.slice(0, MAX_CELL_LENGTH) : text
}

// ---------------------------------------------------------------------------
// JSON Lines and plain text
// ---------------------------------------------------------------------------

export function parseJsonLines(text) {
  const records = []
  const columns = new Set()
  for (const [index, line] of stripBom(text).split('\n').entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new ParseError(`line ${index + 1} is not valid JSON: ${error.message}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ParseError(`line ${index + 1} is not a JSON object`)
    }
    for (const key of Object.keys(parsed)) columns.add(key)
    records.push(parsed)
    if (records.length > MAX_ROWS) throw new ParseError(`more than ${MAX_ROWS} rows`)
  }
  return { columns: [...columns], records }
}

/**
 * Plain text: one record per non-empty paragraph.
 *
 * `externalId` is a content hash rather than a line number, so re-importing a
 * file with a paragraph inserted at the top does not renumber — and therefore
 * duplicate — every paragraph after it.
 */
export function parseText(text, { hash }) {
  const records = stripBom(text)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((content, index) => ({
      lineNumber: index + 1,
      content: truncate(content),
      contentHash: hash(content),
    }))
  return { columns: ['lineNumber', 'content', 'contentHash'], records }
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/**
 * Read the first worksheet of an XLSX workbook.
 *
 * An .xlsx file is a ZIP of XML parts. Only three are read: the shared string
 * table, the workbook (to find the first sheet) and that sheet's data. Formulas
 * are ignored in favour of the cached `<v>` value Excel stores alongside them,
 * which is both what the user sees and the only part that cannot execute.
 */
export function parseXlsx(buffer) {
  const entries = readZipEntries(buffer)

  const sharedStrings = entries.has('xl/sharedStrings.xml')
    ? readSharedStrings(entries.get('xl/sharedStrings.xml').toString('utf8'))
    : []

  const sheetPath = findFirstSheetPath(entries)
  if (!sheetPath) throw new ParseError('workbook contains no readable worksheet')

  return readSheet(entries.get(sheetPath).toString('utf8'), sharedStrings)
}

// Minimal ZIP reader over the End of Central Directory record. Reading the
// central directory rather than scanning local headers means a truncated or
// deliberately malformed local header cannot walk us off the end of the buffer.
function readZipEntries(buffer) {
  const eocdOffset = findEocd(buffer)
  if (eocdOffset < 0) throw new ParseError('not a ZIP archive (no end-of-central-directory record)')

  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  let offset = buffer.readUInt32LE(eocdOffset + 16)
  const entries = new Map()

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    // Check the declared size before inflating: a zip bomb advertises its
    // expansion, and refusing here costs nothing.
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ParseError(`zip entry ${name} declares ${uncompressedSize} bytes, over the limit`)
    }
    if (name === 'xl/sharedStrings.xml' || name === 'xl/workbook.xml' || name.startsWith('xl/worksheets/')) {
      entries.set(name, inflateEntry(buffer, localOffset, method, compressedSize))
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findEocd(buffer) {
  // The EOCD is at the end, after a comment of up to 64KB.
  const start = Math.max(0, buffer.length - 66_000)
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

function inflateEntry(buffer, localOffset, method, compressedSize) {
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new ParseError('corrupt local file header')
  const nameLength = buffer.readUInt16LE(localOffset + 26)
  const extraLength = buffer.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + nameLength + extraLength
  const data = buffer.subarray(dataStart, dataStart + compressedSize)
  if (method === 0) return Buffer.from(data)
  if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES })
  throw new ParseError(`unsupported zip compression method ${method}`)
}

// Shared strings: <si> entries, each possibly split across several <t> runs
// when the cell has mixed formatting.
function readSharedStrings(xml) {
  const strings = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const runs = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((run) => decodeXml(run[1]))
    strings.push(runs.join(''))
  }
  return strings
}

function findFirstSheetPath(entries) {
  const candidates = [...entries.keys()].filter((name) => name.startsWith('xl/worksheets/sheet'))
  if (candidates.length === 0) return null
  // Numeric order: sheet10 must not sort before sheet2.
  candidates.sort((left, right) => sheetNumber(left) - sheetNumber(right))
  return candidates[0]
}

function sheetNumber(path) {
  const match = path.match(/sheet(\d+)\.xml$/)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function readSheet(xml, sharedStrings) {
  const rows = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = []
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1]
      const body = cellMatch[2]
      const reference = /r="([A-Z]+)\d+"/.exec(attributes)?.[1]
      const type = /t="([^"]+)"/.exec(attributes)?.[1]
      // `<v>` is the cached value. A cell with a formula also has `<f>`, which
      // is deliberately never read or evaluated.
      const rawValue = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      const inlineValue = /<is>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1]

      let value = null
      if (type === 's' && rawValue != null) value = sharedStrings[Number(rawValue)] ?? null
      else if (type === 'inlineStr' && inlineValue != null) value = decodeXml(inlineValue)
      else if (rawValue != null) value = decodeXml(rawValue)

      const columnIndex = reference ? columnToIndex(reference) : cells.length
      while (cells.length < columnIndex) cells.push(null)
      cells[columnIndex] = value === null ? null : truncate(value)
    }
    rows.push(cells)
    if (rows.length > MAX_ROWS) throw new ParseError(`more than ${MAX_ROWS} rows`)
  }
  // Empty trailing cells make rows ragged; pad so every record has every column.
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  for (const row of rows) while (row.length < width) row.push(null)
  return toRecords(rows.map((row) => row.map((cell) => (cell === null ? '' : cell))), true)
}

// "A" -> 0, "Z" -> 25, "AA" -> 26
function columnToIndex(reference) {
  let index = 0
  for (const character of reference) index = index * 26 + (character.charCodeAt(0) - 64)
  return index - 1
}

// Only the five predefined XML entities and numeric character references.
// General entity declarations are never resolved, which is what closes off
// XXE and billion-laughs through this path.
function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// ---------------------------------------------------------------------------

const EXTENSION_PARSERS = {
  '.csv': (buffer) => parseDelimited(buffer.toString('utf8'), { delimiter: ',' }),
  '.tsv': (buffer) => parseDelimited(buffer.toString('utf8'), { delimiter: '\t' }),
  '.jsonl': (buffer) => parseJsonLines(buffer.toString('utf8')),
  '.ndjson': (buffer) => parseJsonLines(buffer.toString('utf8')),
  '.xlsx': (buffer) => parseXlsx(buffer),
  '.xlsm': (buffer) => parseXlsx(buffer),
}

export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_PARSERS).concat('.txt')

/** Parse by filename extension. `hash` is required for plain text. */
export function parseFile(buffer, filename, { hash } = {}) {
  const extension = /\.[^.]+$/.exec(String(filename).toLowerCase())?.[0] ?? ''
  if (extension === '.txt' || extension === '.md') {
    if (!hash) throw new ParseError('text import requires a hash function')
    return parseText(buffer.toString('utf8'), { hash })
  }
  const parser = EXTENSION_PARSERS[extension]
  if (!parser) {
    throw new ParseError(`unsupported file type ${extension || '(none)'}; supported: ${SUPPORTED_EXTENSIONS.join(', ')}`)
  }
  return parser(buffer)
}
