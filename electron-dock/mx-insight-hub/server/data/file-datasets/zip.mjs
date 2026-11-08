// Read one file inside a ZIP archive as a resumable byte stream, without
// extracting it to disk.
//
// - Central directory parsing with ZIP64 (archives and entries over 4 GiB).
// - Methods 0 (stored) and 8 (deflate). Encrypted entries and other methods
//   (Deflate64, bzip2, LZMA, zstd) are refused with a clear error.
// - `read(position, length)` serves the uncompressed bytes sequentially, the
//   way the record readers consume a file. Reading behind the current point
//   (a resume from a checkpoint) re-inflates from the start of the entry and
//   skips ahead: inflate runs at several hundred MB/s, so a checkpoint never
//   needs extracted copies or saved inflater state.
// - The declared size and CRC-32 are verified when the last byte is produced;
//   output beyond the declared size stops immediately (no zip-bomb growth).
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { AppError } from '../../core/errors.mjs'

const EOCD = 0x06054b50
const ZIP64_EOCD = 0x06064b50
const ZIP64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX_COMMENT = 0xffff
const MAX_ENTRIES = 100_000
const SUPPORTED_METHODS = new Map([[0, 'stored'], [8, 'deflate']])
const METHOD_NAMES = { 9: 'Deflate64', 12: 'bzip2', 14: 'LZMA', 93: 'Zstandard', 95: 'XZ', 99: 'AES' }

export class ArchiveError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
  }
}

async function readAt(fileHandle, position, length) {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await fileHandle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

const u64 = (buffer, offset) => {
  const value = buffer.readBigUInt64LE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArchiveError('archive_invalid', 'ZIP value exceeds the supported range')
  return Number(value)
}

function zip64Extra(extra, wanted) {
  // wanted: which 32-bit fields were 0xFFFFFFFF, in spec order.
  let offset = 0
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset)
    const size = extra.readUInt16LE(offset + 2)
    if (id === 0x0001) {
      const values = {}
      let cursor = offset + 4
      for (const field of ['size', 'compressedSize', 'localHeaderOffset']) {
        if (!wanted[field]) continue
        if (cursor + 8 > offset + 4 + size) throw new ArchiveError('archive_invalid', 'Truncated ZIP64 extra field')
        values[field] = u64(extra, cursor)
        cursor += 8
      }
      return values
    }
    offset += 4 + size
  }
  throw new ArchiveError('archive_invalid', 'ZIP64 sizes are missing')
}

/** List the entries of a ZIP archive from its central directory. */
export async function readZipDirectory(fileHandle, archiveBytes) {
  if (archiveBytes < 22) throw new ArchiveError('archive_invalid', 'The file is not a ZIP archive')
  const tailLength = Math.min(archiveBytes, 22 + MAX_COMMENT + 20)
  const tailStart = archiveBytes - tailLength
  const tail = await readAt(fileHandle, tailStart, tailLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break }
  }
  if (eocd < 0) throw new ArchiveError('archive_invalid', 'The file is not a ZIP archive (no end of central directory)')
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) throw new ArchiveError('archive_multipart', 'Split / multi-part ZIP archives are not supported')
  let count = tail.readUInt16LE(eocd + 10)
  let directorySize = tail.readUInt32LE(eocd + 12)
  let directoryOffset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new ArchiveError('archive_invalid', 'ZIP64 locator is missing')
    const recordOffset = u64(tail, locator + 8)
    const record = await readAt(fileHandle, recordOffset, 56)
    if (record.length < 56 || record.readUInt32LE(0) !== ZIP64_EOCD) throw new ArchiveError('archive_invalid', 'ZIP64 end of central directory is missing')
    count = u64(record, 32)
    directorySize = u64(record, 40)
    directoryOffset = u64(record, 48)
  }
  if (count > MAX_ENTRIES) throw new ArchiveError('archive_too_many_entries', `ZIP archives with more than ${MAX_ENTRIES} entries are not supported`)
  if (directoryOffset + directorySize > archiveBytes) throw new ArchiveError('archive_invalid', 'The ZIP central directory lies outside the file')
  const directory = await readAt(fileHandle, directoryOffset, directorySize)
  const entries = []
  let offset = 0
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== CENTRAL) throw new ArchiveError('archive_invalid', 'Corrupt ZIP central directory')
    const flags = directory.readUInt16LE(offset + 8)
    const method = directory.readUInt16LE(offset + 10)
    const crc32 = directory.readUInt32LE(offset + 16)
    let compressedSize = directory.readUInt32LE(offset + 20)
    let size = directory.readUInt32LE(offset + 24)
    const nameLength = directory.readUInt16LE(offset + 28)
    const extraLength = directory.readUInt16LE(offset + 30)
    const commentLength = directory.readUInt16LE(offset + 32)
    let localHeaderOffset = directory.readUInt32LE(offset + 42)
    const nameBytes = directory.subarray(offset + 46, offset + 46 + nameLength)
    const extra = directory.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength)
    const wanted = { size: size === 0xffffffff, compressedSize: compressedSize === 0xffffffff, localHeaderOffset: localHeaderOffset === 0xffffffff }
    if (wanted.size || wanted.compressedSize || wanted.localHeaderOffset) {
      const values = zip64Extra(extra, wanted)
      size = values.size ?? size
      compressedSize = values.compressedSize ?? compressedSize
      localHeaderOffset = values.localHeaderOffset ?? localHeaderOffset
    }
    // Bit 11: UTF-8 names. Older tools write CP437; latin1 keeps ASCII names exact.
    const name = nameBytes.toString(flags & 0x0800 ? 'utf8' : 'latin1')
    const encrypted = (flags & 0x0001) !== 0
    const directoryEntry = name.endsWith('/')
    entries.push({
      name, method, methodName: SUPPORTED_METHODS.get(method) || METHOD_NAMES[method] || `method ${method}`,
      crc32, compressedSize, size, localHeaderOffset, encrypted, directory: directoryEntry,
      supported: !encrypted && !directoryEntry && SUPPORTED_METHODS.has(method),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export function describeEntry(entry) {
  return { name: entry.name, size: entry.size, compressedSize: entry.compressedSize, method: entry.methodName, supported: entry.supported }
}

/** Refuse entries the reader cannot serve, with an operator-readable reason. */
export function assertReadableEntry(entry) {
  if (entry.directory) throw new ArchiveError('archive_entry_invalid', `${entry.name} is a directory`)
  if (entry.encrypted) throw new ArchiveError('archive_entry_encrypted', `${entry.name} is encrypted; provide an unencrypted archive`)
  if (!SUPPORTED_METHODS.has(entry.method)) {
    throw new ArchiveError('archive_method_unsupported', `${entry.name} uses ${entry.methodName} compression; re-pack it with standard deflate or unpack it on the server`)
  }
  if (entry.size <= 0) throw new ArchiveError('archive_entry_empty', `${entry.name} is empty`)
}

async function entryDataOffset(fileHandle, entry) {
  const header = await readAt(fileHandle, entry.localHeaderOffset, 30)
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) throw new ArchiveError('archive_invalid', `Corrupt local header for ${entry.name}`)
  return entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
}

const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : (() => {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  return (data, value = 0) => {
    let c = (value ^ 0xffffffff) >>> 0
    for (let i = 0; i < data.length; i += 1) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
})()

/**
 * Sequential reader over one entry's uncompressed bytes. Returns
 * { bytes, read(position, length), close() }; `read` returns exactly `length`
 * bytes unless the entry ends.
 */
export async function openZipEntry(fileHandle, entry, { chunkBytes = 1024 * 1024 } = {}) {
  assertReadableEntry(entry)
  const dataOffset = await entryDataOffset(fileHandle, entry)
  let iterator = null
  let produced = 0 // uncompressed bytes pulled from the inflater
  let consumed = 0 // uncompressed position of `pending[0]`
  let pending = Buffer.alloc(0)
  let crc = 0

  async function* compressedChunks() {
    let position = dataOffset
    const end = dataOffset + entry.compressedSize
    while (position < end) {
      const chunk = await readAt(fileHandle, position, Math.min(chunkBytes, end - position))
      if (chunk.length === 0) throw new ArchiveError('archive_truncated', `${entry.name} ends before its compressed size`)
      position += chunk.length
      yield chunk
    }
  }

  const restart = () => {
    iterator?.return?.().catch(() => {})
    const source = Readable.from(compressedChunks(), { objectMode: false })
    const stream = entry.method === 8 ? source.pipe(zlib.createInflateRaw({ chunkSize: 256 * 1024 })) : source
    if (entry.method === 8) source.on('error', error => stream.destroy(error))
    iterator = stream[Symbol.asyncIterator]()
    produced = 0
    consumed = 0
    pending = Buffer.alloc(0)
    crc = 0
  }

  // Pull the next uncompressed chunk; null at the end of the entry.
  async function pull() {
    if (produced >= entry.size) return null
    let next
    try {
      next = await iterator.next()
    } catch (error) {
      if (error instanceof ArchiveError || error instanceof AppError) throw error
      throw new ArchiveError('archive_entry_corrupt', `${entry.name} cannot be decompressed (${error.code || error.message})`)
    }
    if (next.done) throw new ArchiveError('archive_entry_corrupt', `${entry.name} is shorter than its declared size`)
    const chunk = next.value
    if (produced + chunk.length > entry.size) throw new ArchiveError('archive_entry_corrupt', `${entry.name} is larger than its declared size`)
    produced += chunk.length
    crc = crc32(chunk, crc)
    if (produced === entry.size && (crc >>> 0) !== (entry.crc32 >>> 0)) {
      throw new ArchiveError('archive_entry_corrupt', `${entry.name} failed its CRC-32 check`)
    }
    return chunk
  }

  restart()
  return {
    bytes: entry.size,
    dataOffset,
    async read(position, length) {
      if (position < consumed) restart()
      // Skip forward (a resume) without keeping the skipped bytes.
      while (consumed + pending.length < position) {
        consumed += pending.length
        pending = Buffer.alloc(0)
        const chunk = await pull()
        if (!chunk) return Buffer.alloc(0)
        pending = chunk
      }
      if (position > consumed) {
        pending = pending.subarray(position - consumed)
        consumed = position
      }
      const parts = [pending]
      let have = pending.length
      while (have < length) {
        const chunk = await pull()
        if (!chunk) break
        parts.push(chunk)
        have += chunk.length
      }
      const joined = parts.length === 1 ? parts[0] : Buffer.concat(parts, have)
      const out = joined.subarray(0, Math.min(length, joined.length))
      pending = joined.subarray(out.length)
      consumed += out.length
      return Buffer.from(out)
    },
    close() {
      iterator?.return?.().catch(() => {})
    },
  }
}
