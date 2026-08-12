import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { AppError } from '../../core/errors.mjs'
import { SUPPORTED_EXTENSIONS } from './parsers.mjs'

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024
const MAX_PATH_LENGTH = 4_096
const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const GLOB_META_PATTERN = /[*?\[\]{}]/
const SUPPORTED_EXTENSION_SET = new Set(SUPPORTED_EXTENSIONS)

function configurationError(message) {
  return new AppError(500, 'invalid_configuration', message)
}

function invalidPath(message = 'Server file path is invalid') {
  return new AppError(400, 'invalid_server_file_path', message)
}

function assertSafePathSyntax(value, { absolute, configuration = false } = {}) {
  const fail = (message) => {
    throw configuration ? configurationError(message) : invalidPath(message)
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    fail(configuration ? 'Server file root must be a non-empty path of at most 4096 characters' : undefined)
  }
  if (value.includes('\0')) fail(configuration ? 'Server file root contains an invalid character' : undefined)
  if (GLOB_META_PATTERN.test(value)) {
    fail(configuration ? 'Server file roots must not contain glob syntax' : 'Server file path must name one file, not a glob')
  }
  if (value.split(/[\\/]/).includes('..')) {
    fail(configuration ? 'Server file roots must not contain parent traversal' : 'Server file path must not contain parent traversal')
  }
  if (absolute && !isAbsolute(value)) {
    fail(configuration ? 'Server file roots must be absolute paths' : 'Server file path must be absolute')
  }
  if (!absolute && isAbsolute(value)) fail('Server file locator must use a relative path')
}

function normalizeRootEntries(roots) {
  if (roots == null) return []
  if (Array.isArray(roots)) return roots
  if (typeof roots === 'string' || (typeof roots === 'object' && roots !== null)) {
    return parseServerFileRoots(roots)
  }
  throw configurationError('MX_INSIGHT_SERVER_FILE_ROOTS must be a JSON object')
}

/**
 * Parse the deployment-owned root allowlist.
 *
 * The value is a JSON object so stable, non-sensitive root IDs can be stored in
 * lineage while absolute mount paths remain runtime configuration only:
 *
 *   {"internal-files":"/srv/mx-insight/import"}
 */
export function parseServerFileRoots(raw) {
  if (raw == null || raw === '') return []
  let parsed = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return []
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw configurationError('MX_INSIGHT_SERVER_FILE_ROOTS must be a JSON object')
    }
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(parsed))
  ) {
    throw configurationError('MX_INSIGHT_SERVER_FILE_ROOTS must be a JSON object')
  }

  const entries = []
  for (const [rootId, rootPath] of Object.entries(parsed)) {
    if (!ROOT_ID_PATTERN.test(rootId)) {
      throw configurationError('Server file root IDs must use lowercase letters, digits, dots, underscores, or hyphens')
    }
    assertSafePathSyntax(rootPath, { absolute: true, configuration: true })
    entries.push(Object.freeze({ rootId, path: resolve(rootPath) }))
  }
  return Object.freeze(entries)
}

function isWithin(rootPath, candidatePath) {
  const child = relative(rootPath, candidatePath)
  return child === '' || (
    child !== '..'
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child)
  )
}

function snapshotMatches(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function assertReadableFile(stat, maxBytes) {
  if (!stat.isFile()) {
    throw new AppError(400, 'server_file_not_regular', 'Server file path must identify one regular file')
  }
  if (stat.size === 0n) {
    throw new AppError(400, 'server_file_empty', 'Server file is empty')
  }
  if (stat.size > BigInt(maxBytes)) {
    throw new AppError(413, 'server_file_too_large', `Server file exceeds the ${maxBytes}-byte limit`)
  }
  if ((stat.mode & 0o111n) !== 0n) {
    throw new AppError(400, 'server_file_executable', 'Executable server files cannot be imported')
  }
}

function assertSupportedFile(candidatePath) {
  const extension = extname(candidatePath).toLowerCase()
  if (!SUPPORTED_EXTENSION_SET.has(extension)) {
    throw new AppError(400, 'unsupported_file_type', 'Server file type is not supported')
  }
}

function changedError() {
  return new AppError(409, 'server_file_changed', 'Server file changed while it was being read; preview it again')
}

function sanitizeFileSystemError(error) {
  if (error instanceof AppError) return error
  switch (error?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new AppError(404, 'server_file_not_found', 'Server file was not found')
    case 'EACCES':
    case 'EPERM':
      return new AppError(403, 'server_file_unreadable', 'Server file is not readable by the ingest service')
    case 'ELOOP':
      return new AppError(400, 'server_file_symlink_rejected', 'Symbolic links cannot be imported')
    case 'ENAMETOOLONG':
      return invalidPath()
    case 'EISDIR':
      return new AppError(400, 'server_file_not_regular', 'Server file path must identify one regular file')
    default:
      // Do not retain the original fs error as a cause: Node fs errors include
      // `path`, which would leak the absolute host layout through structured
      // request logging.
      return new AppError(500, 'server_file_unavailable', 'Server file could not be read')
  }
}

function sanitizeRootError(error, rootId) {
  if (error instanceof AppError && error.code === 'invalid_configuration') return error
  return configurationError(`Server file root ${rootId} is not an accessible canonical directory`)
}

async function canonicalizeRoot(entry) {
  if (!entry || typeof entry !== 'object' || !ROOT_ID_PATTERN.test(entry.rootId || '')) {
    throw configurationError('Server file roots must contain a valid rootId and path')
  }
  assertSafePathSyntax(entry.path, { absolute: true, configuration: true })
  const configuredPath = resolve(entry.path)
  try {
    const [rootStat, canonicalPath] = await Promise.all([
      lstat(configuredPath, { bigint: true }),
      realpath(configuredPath),
    ])
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || canonicalPath !== configuredPath) {
      throw configurationError(`Server file root ${entry.rootId} must be a canonical directory without symbolic links`)
    }
    return Object.freeze({ rootId: entry.rootId, path: canonicalPath })
  } catch (error) {
    throw sanitizeRootError(error, entry.rootId)
  }
}

async function readBounded(fileHandle, maxBytes) {
  const chunks = []
  let total = 0
  let position = 0
  while (true) {
    // One extra byte distinguishes an exactly-at-limit file from one that grew
    // after its initial fstat, without ever buffering unbounded input.
    const capacity = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total)
    if (capacity <= 0) {
      throw new AppError(413, 'server_file_too_large', `Server file exceeds the ${maxBytes}-byte limit`)
    }
    const chunk = Buffer.allocUnsafe(capacity)
    const { bytesRead } = await fileHandle.read(chunk, 0, capacity, position)
    if (bytesRead === 0) break
    total += bytesRead
    position += bytesRead
    if (total > maxBytes) {
      throw new AppError(413, 'server_file_too_large', `Server file exceeds the ${maxBytes}-byte limit`)
    }
    chunks.push(chunk.subarray(0, bytesRead))
  }
  return Buffer.concat(chunks, total)
}

export class ServerFileReader {
  #roots

  #maxBytes

  constructor(roots, maxBytes) {
    this.#roots = roots
    this.#maxBytes = maxBytes
  }

  static async create({ roots = [], maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_BYTES) {
      throw configurationError(`Server file maxBytes must be between 1 and ${DEFAULT_MAX_BYTES}`)
    }
    if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
      throw configurationError('Server file import requires operating-system no-follow support')
    }
    const entries = normalizeRootEntries(roots)
    const ids = new Set()
    for (const entry of entries) {
      if (ids.has(entry?.rootId)) throw configurationError('Server file root IDs must be unique')
      ids.add(entry?.rootId)
    }
    const canonicalRoots = await Promise.all(entries.map(canonicalizeRoot))
    const paths = new Set()
    for (const root of canonicalRoots) {
      if (paths.has(root.path)) throw configurationError('Server file roots must resolve to distinct directories')
      paths.add(root.path)
    }
    // Deepest root wins when a deployment intentionally registers nested
    // roots, so lineage receives the most specific configured identity.
    canonicalRoots.sort((left, right) => right.path.length - left.path.length)
    return new ServerFileReader(Object.freeze(canonicalRoots), maxBytes)
  }

  describeRoots() {
    return {
      enabled: this.#roots.length > 0,
      maxBytes: this.#maxBytes,
      roots: this.#roots.map(({ rootId }) => ({ rootId })),
    }
  }

  async readInput(serverPath) {
    this.#assertEnabled()
    assertSafePathSyntax(serverPath, { absolute: true })
    const candidatePath = resolve(serverPath)
    const root = this.#roots.find((entry) => isWithin(entry.path, candidatePath))
    if (!root) {
      throw new AppError(403, 'server_file_path_not_allowed', 'Server file path is outside the configured import roots')
    }
    return this.#read(root, candidatePath, relative(root.path, candidatePath))
  }

  async readLocator({ rootId, relativePath } = {}) {
    this.#assertEnabled()
    const root = this.#roots.find((entry) => entry.rootId === rootId)
    if (!root) {
      throw new AppError(403, 'server_file_path_not_allowed', 'Server file path is outside the configured import roots')
    }
    assertSafePathSyntax(relativePath, { absolute: false })
    const candidatePath = resolve(root.path, relativePath)
    if (!isWithin(root.path, candidatePath)) {
      throw new AppError(403, 'server_file_path_not_allowed', 'Server file path is outside the configured import roots')
    }
    return this.#read(root, candidatePath, relative(root.path, candidatePath))
  }

  #assertEnabled() {
    if (this.#roots.length === 0) {
      throw new AppError(503, 'server_file_roots_unconfigured', 'Server file import roots are not configured')
    }
  }

  async #read(root, candidatePath, relativePath) {
    assertSupportedFile(candidatePath)
    let fileHandle = null
    try {
      const canonicalPath = await realpath(candidatePath)
      // Equality, not merely containment, rejects both final and intermediate
      // symlinks, including links whose target remains inside the allowlist.
      if (canonicalPath !== candidatePath || !isWithin(root.path, canonicalPath)) {
        throw new AppError(400, 'server_file_symlink_rejected', 'Symbolic links cannot be imported')
      }

      const beforeOpen = await lstat(canonicalPath, { bigint: true })
      assertReadableFile(beforeOpen, this.#maxBytes)
      // Close the realpath -> lstat race for replaceable ancestor components.
      if (await realpath(candidatePath) !== canonicalPath) throw changedError()

      fileHandle = await open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const opened = await fileHandle.stat({ bigint: true })
      if (!snapshotMatches(beforeOpen, opened)) throw changedError()
      assertReadableFile(opened, this.#maxBytes)

      const buffer = await readBounded(fileHandle, this.#maxBytes)
      const afterRead = await fileHandle.stat({ bigint: true })
      if (!snapshotMatches(opened, afterRead)) throw changedError()

      // The descriptor is safe if the pathname is replaced after open, but the
      // observation would no longer describe the named source file. Reject that
      // race rather than publishing bytes under misleading lineage.
      if (await realpath(candidatePath) !== canonicalPath) throw changedError()
      const afterPath = await lstat(canonicalPath, { bigint: true })
      if (!snapshotMatches(opened, afterPath)) throw changedError()

      return {
        buffer,
        filename: basename(canonicalPath),
        rootId: root.rootId,
        relativePath,
        inputBytes: buffer.length,
        inputSha256: createHash('sha256').update(buffer).digest('hex'),
        mtime: new Date(Number(afterRead.mtimeMs)).toISOString(),
      }
    } catch (error) {
      throw sanitizeFileSystemError(error)
    } finally {
      await fileHandle?.close().catch(() => {})
    }
  }
}
