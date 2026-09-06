import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { Agent, request as undiciRequest } from 'undici'
import { AppError } from '../core/errors.mjs'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 4_096
const MAX_IMAGE_PIXELS = 8_000_000
const MAX_REDIRECTS = 2
const MAX_WEBP_CHUNKS = 4_096
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_CONCURRENCY = 16
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024
const DEFAULT_CACHE_ENTRIES = 64
const DEFAULT_CACHE_TTL_MS = 5 * 60_000
const IMAGE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])

const BLOCKED_ADDRESSES = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) BLOCKED_ADDRESSES.addSubnet(address, prefix, 'ipv4')

for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['fc00::', 7],
  ['fec0::', 10],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
]) BLOCKED_ADDRESSES.addSubnet(address, prefix, 'ipv6')

function imageError(status, code, message) {
  return new AppError(status, code, message)
}

export function externalImageAddressAllowed(address, family = isIP(address)) {
  const normalizedFamily = Number(family)
  if (![4, 6].includes(normalizedFamily)) return false
  // Reject mapped IPv4 literals rather than depending on platform-specific
  // BlockList normalization. Public DNS answers normally return family 4.
  if (normalizedFamily === 6 && String(address).toLowerCase().includes('::ffff:')) return false
  return !BLOCKED_ADDRESSES.check(address, normalizedFamily === 4 ? 'ipv4' : 'ipv6')
}

function imageUrl(value, base = null) {
  let parsed
  try {
    parsed = base ? new URL(value, base) : new URL(value)
  } catch {
    throw imageError(422, 'external_media_url_invalid', 'Product image URL is invalid')
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== '443')
    || !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.svc')
  ) {
    throw imageError(422, 'external_media_url_blocked', 'Product image URL is not allowed')
  }
  parsed.hash = ''
  return parsed
}

async function resolvePublicTarget(url, lookup, signal, abortError) {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  const literalFamily = isIP(hostname)
  let onAbort
  let answers
  if (literalFamily) {
    answers = [{ address: hostname, family: literalFamily }]
  } else {
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(abortError())
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      answers = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }).catch(() => []),
        aborted,
      ])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
  if (!answers.length || answers.some(({ address, family }) => !externalImageAddressAllowed(address, family))) {
    throw imageError(422, 'external_media_host_blocked', 'Product image host is unavailable or not public')
  }
  return answers.map(({ address, family }) => ({ address, family: Number(family) }))
}

function pinnedLookup(expectedHostname, answers) {
  return (hostname, options, callback) => {
    if (String(hostname).toLowerCase() !== expectedHostname.toLowerCase()) {
      callback(new Error('Unexpected media hostname'))
      return
    }
    const family = Number(options?.family)
    const eligible = family === 4 || family === 6
      ? answers.filter((answer) => answer.family === family)
      : answers
    if (!eligible.length) {
      callback(new Error('No validated address for requested family'))
      return
    }
    if (options?.all) callback(null, eligible)
    else callback(null, eligible[0].address, eligible[0].family)
  }
}

function normalizedContentType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase()
}

function detectedImageType(buffer) {
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  return null
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  let offset = 8
  while (offset + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset)
    const end = offset + 12 + chunkLength
    if (end > buffer.length) return null
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    if (chunkType === 'acTL') return null
    if (chunkType === 'IEND') break
    offset = end
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function jpegDimensions(buffer) {
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 4 <= buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1
    if (offset >= buffer.length) break
    const marker = buffer[offset]
    offset += 1
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > buffer.length) return null
    const segmentLength = buffer.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) return null
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      }
    }
    offset += segmentLength
  }
  return null
}

function webpDimensions(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(4) + 8 !== buffer.length) return null
  let offset = 12
  let chunkCount = 0
  let firstType = null
  let firstSize = 0
  let firstDataOffset = 0
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString('ascii')
    const size = buffer.readUInt32LE(offset + 4)
    const dataOffset = offset + 8
    const end = dataOffset + size
    if (end > buffer.length) return null
    chunkCount += 1
    if (chunkCount > MAX_WEBP_CHUNKS || type === 'ANIM' || type === 'ANMF') return null
    if (chunkCount === 1) {
      firstType = type
      firstSize = size
      firstDataOffset = dataOffset
    }
    offset = end + (size % 2)
  }
  if (offset !== buffer.length || !firstType) return null
  const chunkType = firstType
  const chunkSize = firstSize
  const dataOffset = firstDataOffset
  if (chunkType === 'VP8X') {
    if (chunkSize < 10 || (buffer[dataOffset] & 0x02) !== 0) return null
    return {
      width: 1 + buffer.readUIntLE(dataOffset + 4, 3),
      height: 1 + buffer.readUIntLE(dataOffset + 7, 3),
    }
  }
  if (chunkType === 'VP8 ') {
    if (chunkSize < 10 || !buffer.subarray(dataOffset + 3, dataOffset + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return null
    return {
      width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
      height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
    }
  }
  if (chunkType === 'VP8L') {
    if (chunkSize < 5 || buffer[dataOffset] !== 0x2f) return null
    const byte1 = buffer[dataOffset + 1]
    const byte2 = buffer[dataOffset + 2]
    const byte3 = buffer[dataOffset + 3]
    const byte4 = buffer[dataOffset + 4]
    return {
      width: 1 + byte1 + ((byte2 & 0x3f) << 8),
      height: 1 + ((byte2 & 0xc0) >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10),
    }
  }
  return null
}

function safeImageDimensions(buffer, contentType) {
  const dimensions = contentType === 'image/png'
    ? pngDimensions(buffer)
    : contentType === 'image/jpeg'
      ? jpegDimensions(buffer)
      : contentType === 'image/webp'
        ? webpDimensions(buffer)
        : null
  if (
    !dimensions
    || !Number.isInteger(dimensions.width)
    || !Number.isInteger(dimensions.height)
    || dimensions.width < 1
    || dimensions.height < 1
    || dimensions.width > MAX_IMAGE_DIMENSION
    || dimensions.height > MAX_IMAGE_DIMENSION
    || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
  ) {
    throw imageError(415, 'external_media_dimensions_rejected', 'Product image dimensions are not allowed')
  }
  return dimensions
}

async function boundedBody(body, maximum) {
  let output = Buffer.allocUnsafe(Math.min(maximum, 64 * 1024))
  let size = 0
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const nextSize = size + buffer.length
    if (nextSize > maximum) {
      body.destroy?.()
      throw imageError(413, 'external_media_too_large', 'Product image exceeds the preview size limit')
    }
    if (nextSize > output.length) {
      let capacity = Math.max(1, output.length)
      while (capacity < nextSize) capacity = Math.min(maximum, capacity * 2)
      const expanded = Buffer.allocUnsafe(capacity)
      output.copy(expanded, 0, 0, size)
      output = expanded
    }
    buffer.copy(output, size)
    size = nextSize
  }
  return size === output.length ? output : Buffer.from(output.subarray(0, size))
}

/**
 * Fetches only a URL already retained in a committed, consumer-scoped Hub
 * response. DNS is resolved once, every address is checked, and Undici is
 * pinned to that answer to prevent a second lookup from rebinding to an
 * internal service. Redirects repeat the same validation.
 */
export function createExternalImageLoader({
  lookup = dnsLookup,
  request = undiciRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_IMAGE_BYTES,
  maxRedirects = MAX_REDIRECTS,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  maxCacheBytes = DEFAULT_CACHE_BYTES,
  maxCacheEntries = DEFAULT_CACHE_ENTRIES,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  agentFactory = ({ hostname, answers }) => new Agent({
    connect: { lookup: pinnedLookup(hostname, answers) },
  }),
} = {}) {
  const concurrencyLimit = Math.max(1, Math.floor(Number(maxConcurrency) || DEFAULT_MAX_CONCURRENCY))
  const byteLimit = Math.max(1, Math.floor(Number(maxBytes) || MAX_IMAGE_BYTES))
  const cacheByteLimit = Math.max(0, Math.floor(Number(maxCacheBytes) || 0))
  const cacheEntryLimit = Math.max(0, Math.floor(Number(maxCacheEntries) || 0))
  const cacheLifetimeMs = Math.max(0, Math.floor(Number(cacheTtlMs) || 0))
  const cache = new Map()
  const inFlight = new Map()
  let cacheBytes = 0
  let active = 0

  function evict(key) {
    const existing = cache.get(key)
    if (!existing) return
    cache.delete(key)
    cacheBytes = Math.max(0, cacheBytes - existing.body.length)
  }

  function prune(now = Date.now()) {
    for (const [key, value] of cache) {
      if (value.expiresAt <= now) evict(key)
    }
    while (cache.size > cacheEntryLimit || cacheBytes > cacheByteLimit) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      evict(oldest)
    }
  }

  async function loadUncachedExternalImage(sourceUrl, signal) {
    if (active >= concurrencyLimit) {
      throw imageError(429, 'external_media_busy', 'Product image relay is busy')
    }
    active += 1
    const deadlineSignal = AbortSignal.timeout(timeoutMs)
    const operationSignal = signal
      ? AbortSignal.any([signal, deadlineSignal])
      : deadlineSignal
    const abortError = () => signal?.aborted
      ? imageError(499, 'external_media_cancelled', 'Product image request was cancelled')
      : imageError(504, 'external_media_timeout', 'Product image request timed out')
    try {
      let current = imageUrl(sourceUrl)
      for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
        if (operationSignal.aborted) throw abortError()
        const answers = await resolvePublicTarget(current, lookup, operationSignal, abortError)
        if (operationSignal.aborted) throw abortError()
        const dispatcher = agentFactory({ hostname: current.hostname.replace(/^\[|\]$/gu, ''), answers })
        let upstream
        try {
          upstream = await request(current, {
            method: 'GET',
            headers: {
              accept: 'image/webp,image/png,image/jpeg',
              'user-agent': 'MX-Insight-Hub-Media-Relay/1.0',
            },
            maxRedirections: 0,
            signal: operationSignal,
            ...(dispatcher ? { dispatcher } : {}),
          })
          if ([301, 302, 303, 307, 308].includes(upstream.statusCode)) {
            const location = upstream.headers?.location
            upstream.body.destroy?.()
            if (!location || redirect === maxRedirects) {
              throw imageError(502, 'external_media_redirect_rejected', 'Product image redirect could not be accepted')
            }
            current = imageUrl(Array.isArray(location) ? location[0] : location, current)
            continue
          }
          if (upstream.statusCode !== 200) {
            upstream.body.destroy?.()
            throw imageError(502, 'external_media_unavailable', 'Product image could not be loaded')
          }
          const contentLength = Number(upstream.headers?.['content-length'])
          if (Number.isFinite(contentLength) && contentLength > byteLimit) {
            upstream.body.destroy?.()
            throw imageError(413, 'external_media_too_large', 'Product image exceeds the preview size limit')
          }
          const declaredType = normalizedContentType(upstream.headers?.['content-type'])
          if (!IMAGE_CONTENT_TYPES.has(declaredType)) {
            upstream.body.destroy?.()
            throw imageError(415, 'external_media_type_rejected', 'Product image type is not allowed')
          }
          const body = await boundedBody(upstream.body, byteLimit)
          const detectedType = detectedImageType(body)
          if (!detectedType || detectedType !== declaredType) {
            throw imageError(415, 'external_media_content_invalid', 'Product image content does not match its declared type')
          }
          safeImageDimensions(body, detectedType)
          return { body, contentType: detectedType }
        } catch (error) {
          if (error instanceof AppError) throw error
          if (operationSignal.aborted) throw abortError()
          throw imageError(502, 'external_media_unavailable', 'Product image could not be loaded')
        } finally {
          try {
            await dispatcher?.close?.()
          } catch {
            // The response is already bounded and the dispatcher is per-request;
            // close failures must not expose upstream transport details.
          }
        }
      }
      throw imageError(502, 'external_media_redirect_rejected', 'Product image redirect could not be accepted')
    } finally {
      active = Math.max(0, active - 1)
    }
  }

  function waitForEntry(entry, signal) {
    if (!signal) return entry.promise
    if (signal.aborted) {
      return Promise.reject(imageError(499, 'external_media_cancelled', 'Product image request was cancelled'))
    }
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        signal.removeEventListener('abort', cancelled)
        reject(imageError(499, 'external_media_cancelled', 'Product image request was cancelled'))
      }
      signal.addEventListener('abort', cancelled, { once: true })
      entry.promise.then(
        (value) => {
          signal.removeEventListener('abort', cancelled)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', cancelled)
          reject(error)
        },
      )
    })
  }

  return async function loadExternalImage(sourceUrl, { signal, cacheScope = '' } = {}) {
    if (signal?.aborted) {
      throw imageError(499, 'external_media_cancelled', 'Product image request was cancelled')
    }
    const key = createHash('sha256')
      .update(String(cacheScope))
      .update('\0')
      .update(String(sourceUrl))
      .digest('hex')
    const now = Date.now()
    prune(now)
    const cached = cache.get(key)
    if (cached) {
      cache.delete(key)
      cache.set(key, cached)
      return { body: cached.body, contentType: cached.contentType }
    }
    let entry = inFlight.get(key)
    if (!entry) {
      const controller = new AbortController()
      const loading = loadUncachedExternalImage(sourceUrl, controller.signal)
        .then((result) => {
          if (
            !controller.signal.aborted
            && result.body.length <= cacheByteLimit
            && cacheEntryLimit > 0
            && cacheLifetimeMs > 0
          ) {
            evict(key)
            cache.set(key, { ...result, expiresAt: Date.now() + cacheLifetimeMs })
            cacheBytes += result.body.length
            prune()
          }
          return result
        })
      entry = { controller, promise: loading, waiters: 0 }
      loading.finally(() => {
        if (inFlight.get(key) === entry) inFlight.delete(key)
      }).catch(() => {})
      inFlight.set(key, entry)
    }
    entry.waiters += 1
    try {
      return await waitForEntry(entry, signal)
    } finally {
      entry.waiters = Math.max(0, entry.waiters - 1)
      if (entry.waiters === 0 && inFlight.get(key) === entry) {
        // Remove before aborting so a new caller cannot attach to a cancelled
        // generation while an uncooperative upstream is still settling.
        inFlight.delete(key)
        entry.controller.abort()
      }
    }
  }
}
