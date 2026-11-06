// Source of a file dataset: a plain server file, or one file inside a .zip
// on the server (read as a stream; nothing is extracted to disk).
//
// The SHA-256 fingerprint, identity (dev:ino) and mtime always describe the
// file on disk (the archive). The byte checkpoint counts the bytes of the
// content being parsed (the archive entry when there is one).
import { extname } from 'node:path'
import { AppError } from '../../core/errors.mjs'
import { ArchiveError, assertReadableEntry, describeEntry, openZipEntry, readZipDirectory } from './zip.mjs'

export const ARCHIVE_EXTENSIONS = Object.freeze(['.zip'])
export const isArchivePath = path => ARCHIVE_EXTENSIONS.includes(extname(String(path || '')).toLowerCase())

async function readExact(fileHandle, position, length) {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await fileHandle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

function adminError(error) {
  return error instanceof ArchiveError ? new AppError(400, error.code, error.message) : error
}

/**
 * Choose the archive entry to parse: the requested name, else the dataset's
 * default entry, else the only entry with an accepted extension.
 */
export function chooseEntry(entries, { requested, preferred, extensions }) {
  const accepted = entry => !entry.directory && extensions.includes(extname(entry.name).toLowerCase())
  const candidates = entries.filter(accepted)
  let entry = null
  if (requested) {
    entry = entries.find(row => row.name === requested)
    if (!entry) throw new AppError(400, 'archive_entry_not_found', `${requested} is not in the archive`, { entries: candidates.map(describeEntry) })
    if (!accepted(entry)) throw new AppError(400, 'unsupported_file_type', `Archive entry must use ${extensions.join(', ')}`)
  } else {
    entry = (preferred && candidates.find(row => row.name === preferred)) || (candidates.length === 1 ? candidates[0] : null)
    if (!entry) {
      throw new AppError(409, 'archive_entry_required', candidates.length
        ? 'The archive holds several candidate files; choose one'
        : `The archive holds no ${extensions.join(' / ')} file`, { entries: candidates.map(describeEntry) })
    }
  }
  try { assertReadableEntry(entry) } catch (error) { throw adminError(error) }
  return entry
}

/**
 * Admin plane: validate a locator (plain file or .zip + entry) without
 * reading the content. Returns the file description, the chosen entry and,
 * for archives, the candidate entries.
 */
export async function inspectSource(reader, locator, { extensions, entry: requested = null, preferredEntry = null }) {
  if (!isArchivePath(locator.relativePath ?? locator.serverPath)) {
    if (requested) throw new AppError(400, 'invalid_request', 'entry applies only to .zip sources')
    return { file: await reader.inspectLargeLocator(locator, { extensions }), entry: null, entries: null }
  }
  const opened = await reader.openLargeLocator(locator, { extensions: ARCHIVE_EXTENSIONS })
  try {
    const entries = await readZipDirectory(opened.fileHandle, opened.bytes).catch(error => { throw adminError(error) })
    const entry = chooseEntry(entries, { requested, preferred: preferredEntry, extensions })
    const { fileHandle: _closed, ...file } = opened
    return { file, entry: describeEntry(entry), entries: entries.filter(row => !row.directory).map(describeEntry) }
  } finally {
    await opened.fileHandle.close().catch(() => {})
  }
}

/**
 * Worker: open a version's source. `content` is what the record reader
 * parses: { bytes, read(position, length) }. The caller closes `fileHandle`.
 */
export async function openVersionSource(reader, version, { extensions }) {
  const locator = { rootId: version.source_root_id, relativePath: version.source_relative_path }
  const archive = Boolean(version.source_entry)
  const file = await reader.openLargeLocator(locator, { extensions: archive ? ARCHIVE_EXTENSIONS : extensions })
  try {
    if (!archive) return { ...file, content: { bytes: file.bytes, read: (position, length) => readExact(file.fileHandle, position, length) } }
    const entries = await readZipDirectory(file.fileHandle, file.bytes)
    const entry = entries.find(row => row.name === version.source_entry)
    if (!entry || entry.size !== Number(version.source_entry_bytes)) {
      throw new ArchiveError('source_changed', `${version.source_entry} changed inside the archive; discard this version and start again`)
    }
    const stream = await openZipEntry(file.fileHandle, entry)
    return { ...file, content: { bytes: entry.size, read: stream.read, close: stream.close } }
  } catch (error) {
    await file.fileHandle.close().catch(() => {})
    throw error
  }
}
