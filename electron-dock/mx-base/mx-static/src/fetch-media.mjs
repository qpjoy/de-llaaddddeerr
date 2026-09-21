import { request } from 'node:https'
import { lookup as resolve } from 'node:dns/promises'
import { createWriteStream } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { assertPublicUrl, isPublicAddress } from './net-guard.mjs'
import { SIGNATURE_BYTES, TYPES, validateMedia } from './media-types.mjs'

const fail = (status, code) => Object.assign(new Error(code), { status, code })

// Connect to the address we validated, not to whatever the resolver returns on
// a second lookup. TLS servername stays the hostname, so the certificate is
// still verified against the real name and verification is never disabled.
const pin = (address, family) => (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {} }
  callback(null, options?.all ? [{ address, family }] : address, family)
}

async function publicAddress(hostname, allowHosts) {
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) }
  let entries
  try { entries = await resolve(hostname, { all: true }) } catch { throw fail(422, 'media_url_rejected') }
  // Reject the whole host if ANY answer is private: a split answer is the
  // classic rebinding shape, and we must not silently pick the good one.
  if (!entries.length || (!allowHosts.includes(hostname) && entries.some(entry => !isPublicAddress(entry.address)))) throw fail(422, 'media_url_rejected')
  return entries[0]
}

function hop(target, { address, family }, signal, timeoutMs, tls) {
  return new Promise((resolve, reject) => {
    const client = request(target, {
      ...tls, lookup: pin(address, family), signal, servername: target.hostname,
      headers: { accept: '*/*', 'user-agent': 'mx-static', host: target.host },
    }, response => resolve(response))
    client.setTimeout(timeoutMs, () => client.destroy(fail(504, 'source_timeout')))
    client.on('error', error => reject(error.status ? error : fail(502, 'source_unavailable')))
    client.end()
  })
}

// allowHosts and tls are TEST HOOKS: they are deliberately not wired to any
// environment variable, so a deployment cannot switch off SSRF protection by
// configuration. allowHosts exempts named hostnames only -- a redirect to any
// other private address is still rejected, on every hop.
export function createMediaFetcher({ stagingDir, maxBytes = 64 * 1024 * 1024, timeoutMs = 30_000, maxRedirects = 3, types = TYPES, allowHosts = [], tls = {} } = {}) {
  if (!stagingDir) throw new Error('createMediaFetcher requires a staging directory on the object filesystem')
  return async function fetchMedia(source, { signal } = {}) {
    // Resolved per call so the size limit can be changed without a restart.
    const limit = typeof maxBytes === 'function' ? maxBytes() : maxBytes
    let target = assertPublicUrl(source, allowHosts)
    let response
    for (let redirects = 0; ; redirects++) {
      response = await hop(target, await publicAddress(target.hostname, allowHosts), signal, timeoutMs, tls)
      const status = response.statusCode
      if (status < 300 || status >= 400) break
      response.resume() // Drain the redirect body; we only want the location.
      if (redirects >= maxRedirects || !response.headers.location) throw fail(502, 'source_unavailable')
      // Re-validate every hop: the first one being public says nothing about the next.
      target = assertPublicUrl(new URL(response.headers.location, target).href, allowHosts)
    }
    if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); throw fail(502, 'source_unavailable') }
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim()
    if (!types.has(contentType)) { response.destroy(); throw fail(415, 'media_content_invalid') }
    const declared = Number(response.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) { response.destroy(); throw fail(413, 'file_too_large') }

    const path = join(stagingDir, `${randomUUID()}.part`)
    const hash = createHash('sha256')
    let size = 0, head = Buffer.alloc(0), checked = false
    try {
      await pipeline(response, new Transform({
        transform(chunk, _, callback) {
          size += chunk.length
          if (size > limit) return callback(fail(413, 'file_too_large'))
          if (!checked) {
            // Reject a bad source from its first bytes instead of writing the
            // whole file and validating afterwards.
            head = head.length ? Buffer.concat([head, chunk]) : chunk
            if (head.length < SIGNATURE_BYTES) return callback(null, Buffer.alloc(0))
            try { validateMedia(head, contentType) } catch (error) { return callback(error) }
            checked = true
            hash.update(head)
            return callback(null, head)
          }
          hash.update(chunk)
          callback(null, chunk)
        },
        flush(callback) { callback(checked ? null : fail(415, 'media_content_invalid')) },
      }), createWriteStream(path, { flags: 'wx', mode: 0o640 }), { signal })
      const file = await open(path, 'r+')
      try { await file.sync() } finally { await file.close() }
      return { path, size, sha256: hash.digest('hex'), contentType }
    } catch (error) {
      await unlink(path).catch(() => {})
      throw error.status ? error : fail(502, 'source_unavailable')
    }
  }
}
