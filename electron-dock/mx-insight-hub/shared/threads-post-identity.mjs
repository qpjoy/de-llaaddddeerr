const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// Accept the canonical username post path, including legacy threads.net and
// the standard HTTPS port, before ever sending the supplied URL to RapidAPI.
export function threadsScraperPostUrlParts(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\\]/u.test(value)) return null
  let url
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'https:' || !['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'].includes(url.hostname)
    || url.username || url.password || url.port) return null
  const match = /^\/@([A-Za-z0-9._]{1,64})\/post\/([A-Za-z0-9_-]{5,32})\/?$/u.exec(url.pathname)
  return match ? { username: match[1], code: match[2] } : null
}

export function threadsShortcodeFromId(id) {
  if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/u.test(id)) return null
  let value = BigInt(id)
  if (value > 18446744073709551615n) return null
  let code = ''
  while (value) {
    code = SHORTCODE_ALPHABET[Number(value % 64n)] + code
    value /= 64n
  }
  return code
}

// The provider's code field is always a shortcode, even if all its characters are digits.
export function threadsPostIdFromShortcode(input) {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/u.test(input)) return null
  let id = 0n
  for (const char of input) id = id * 64n + BigInt(SHORTCODE_ALPHABET.indexOf(char))
  return id > 0n && id <= 18446744073709551615n ? String(id) : null
}

// Digit-only contentId is an ID; digit-only shortcodes are unambiguous in a post URL.
export function threadsDetailCode(value) {
  if (typeof value !== 'string') return null
  const code = /^\d+$/u.test(value) ? threadsShortcodeFromId(value) : value
  return code && /^[A-Za-z0-9_-]{5,32}$/u.test(code) ? code : null
}
