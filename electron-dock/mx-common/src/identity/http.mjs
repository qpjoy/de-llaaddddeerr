import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'

export class SsoError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'SsoError'; this.status = status; this.code = code
  }
}
export const random = () => randomBytes(32).toString('base64url')
export const fingerprint = value => createHash('sha256').update(value).digest('hex')
export const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`
export const cookies = request => Object.fromEntries(String(request.headers.cookie || '').split(';').map(v => v.trim().split('=')))
export const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function readSsoJson(request, limitBytes = 8192, ErrorClass = SsoError) {
  const chunks = []; let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new ErrorClass(413, 'payload_too_large', 'Request body is too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Object required')
    return value
  } catch { throw new ErrorClass(400, 'invalid_json', 'Request body must be a JSON object') }
}
