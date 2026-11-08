import { request } from 'node:http'
import { basename, extname } from 'node:path'
import { FILE_DATASETS, HOST_FILE_ROOT_ID } from '../../../shared/file-datasets.mjs'
import { AppError } from '../../core/errors.mjs'
import { ARCHIVE_EXTENSIONS } from './source.mjs'

export { HOST_FILE_ROOT_ID }
const MAX_RANGE = 4 * 1024 * 1024
const MAX_JSON = 16 * 1024
const DATASET_EXTENSIONS = [...new Set([...ARCHIVE_EXTENSIONS, ...FILE_DATASETS.flatMap(product => product.sourceExtensions)])]
const OUTSIDE_LOCAL_ROOTS = new Set(['server_file_path_not_allowed', 'server_file_import_disabled', 'server_file_roots_unconfigured'])
// Host OS errors can contain private paths. Only expose these protocol codes
// and our own messages, even if a broken service returns its exception text.
const ERRORS = new Map([
  ['invalid_server_file_path', [400, 'Invalid Internal source path']],
  ['invalid_request', [400, 'Invalid host file request']],
  ['server_file_symlink_rejected', [400, 'Symbolic links cannot be imported']],
  ['server_file_not_regular', [400, 'The source must be a regular file']],
  ['server_file_empty', [400, 'The source file is empty']],
  ['server_file_executable', [400, 'Executable files cannot be imported']],
  ['unsupported_file_type', [400, 'The source file type is not supported']],
  ['server_file_path_not_allowed', [403, 'The Internal source path is not allowed']],
  ['server_file_unreadable', [403, 'The Internal source file is not readable']],
  ['server_file_not_found', [404, 'The Internal source file was not found']],
  ['source_changed', [409, 'The source file changed after this version started']],
  ['server_file_too_large', [413, 'The Internal source file is too large']],
])

function unavailable() {
  return new AppError(503, 'server_file_host_unavailable', 'The Internal host file reader is unavailable')
}

async function post(socketPath, route, body, expectedBytes = null) {
  try {
    const response = await new Promise((resolve, reject) => {
      const req = request({ socketPath, path: route, method: 'POST', signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json' }, maxHeaderSize: 8192 }, resolve)
      req.once('error', reject)
      req.end(JSON.stringify(body))
    })
    const binary = response.statusCode === 200 && expectedBytes !== null
    const limit = binary ? expectedBytes : MAX_JSON
    const chunks = []
    let size = 0
    for await (const chunk of response) {
      size += chunk.length
      if (size > limit) throw unavailable()
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks, size)
    if (binary) {
      if (size !== expectedBytes || response.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw unavailable()
      return bytes
    }
    const json = JSON.parse(bytes.toString('utf8'))
    if (response.statusCode !== 200) {
      const mapped = ERRORS.get(json?.code)
      if (!mapped) throw unavailable()
      throw new AppError(mapped[0], json.code, mapped[1])
    }
    return json
  } catch (error) {
    if (error instanceof AppError) throw error
    throw unavailable()
  }
}

function validRef(ref) {
  return typeof ref === 'string' && /^[0-9a-f]{32}\/[^/\\]{1,255}$/u.test(ref) && !/[\x00-\x1f\x7f]/u.test(ref)
    && !['.', '..'].includes(basename(ref))
}

export function createFileDatasetReader(localReader, socketPath = process.env.MX_INSIGHT_HOST_FILE_READER_SOCKET) {
  if (!localReader || !socketPath) return localReader
  async function metadata(locator, { extensions }) {
    const { relativePath } = locator
    if (!validRef(relativePath)) throw new AppError(400, 'invalid_server_file_path', 'Invalid Internal file reference')
    const result = await post(socketPath, '/open', { relativePath, extensions })
    if (result?.rootId !== HOST_FILE_ROOT_ID || result.relativePath !== relativePath || result.filename !== basename(relativePath)
      || !extensions.includes(extname(result.filename).toLowerCase()) || !Number.isSafeInteger(result.bytes) || result.bytes <= 0
      || typeof result.identity !== 'string' || !/^\d+:\d+$/.test(result.identity)
      || typeof result.mtimeNs !== 'string' || !/^-?\d+$/.test(result.mtimeNs)
      || typeof result.mtime !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result.mtime)
      || !Number.isFinite(Date.parse(result.mtime))) throw unavailable()
    const { rootId, filename, bytes, identity, mtimeNs, mtime } = result
    return { rootId, relativePath, filename, bytes, identity, mtimeNs, mtime }
  }
  return {
    describeRoots() { return { ...localReader.describeRoots(), enabled: true, hostPaths: true } },
    async locatorForPath(path) {
      let local
      try { local = await localReader.locatorForPath(path) } catch (error) {
        if (!OUTSIDE_LOCAL_ROOTS.has(error?.code)) throw error
      }
      if (local) {
        try {
          // A root may contain only one host-mounted file. Its sibling can
          // exist at the same absolute path on the host but be absent here.
          await localReader.inspectLargeLocator(local, { extensions: DATASET_EXTENSIONS })
          return local
        } catch (error) {
          if (error?.code !== 'server_file_not_found') throw error
        }
      }
      const result = await post(socketPath, '/resolve', { path })
      if (result?.rootId !== HOST_FILE_ROOT_ID || !validRef(result.relativePath) || basename(result.relativePath) !== basename(path)) throw unavailable()
      return { rootId: HOST_FILE_ROOT_ID, relativePath: result.relativePath }
    },
    inspectLargeLocator(locator, options) {
      return locator.rootId === HOST_FILE_ROOT_ID ? metadata(locator, options) : localReader.inspectLargeLocator(locator, options)
    },
    async openLargeLocator(locator, options) {
      if (locator.rootId !== HOST_FILE_ROOT_ID) return localReader.openLargeLocator(locator, options)
      const file = await metadata(locator, options)
      const { relativePath, bytes, identity, mtimeNs } = file
      let closed = false
      const fileHandle = {
        async read(buffer, offset, length, position) {
          if (closed) throw new Error('File handle is closed')
          if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length)
            || length < 0 || length > buffer.length - offset || !Number.isSafeInteger(position) || position < 0) throw new RangeError('Invalid read range')
          // A FileHandle may return a partial read. All dataset readers loop
          // until the requested range is filled, including ZIP directory reads.
          const count = Math.min(length, MAX_RANGE, Math.max(0, bytes - position))
          if (count) {
            const data = await post(socketPath, '/read', { relativePath, identity, bytes, mtimeNs, position, length: count }, count)
            data.copy(buffer, offset)
          }
          return { buffer, bytesRead: count }
        },
        async close() { closed = true },
      }
      return { ...file, fileHandle }
    },
  }
}
