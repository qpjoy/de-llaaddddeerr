// Internal consoles may use HTTP, where randomUUID is unavailable but
// getRandomValues still supplies cryptographically secure random bytes.
export function requestUuid(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID()
  if (typeof cryptoSource?.getRandomValues !== 'function') {
    throw new Error('浏览器无法生成安全请求 ID，请使用支持 Web Crypto 的浏览器')
  }
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
