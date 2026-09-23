// Only the known image CDNs have HTTP → HTTPS equivalents. Keep signed paths
// and queries byte-for-byte; never proxy or probe arbitrary returned URLs.
export function xiaohongshuImageUrl(value) {
  if (typeof value !== 'string') return null
  const source = value.trim()
  try {
    const parsed = new URL(source)
    if (parsed.username || parsed.password) return null
    if (parsed.protocol === 'https:') return source
    if (parsed.protocol === 'http:' && /^http:\/\/(?:ci\.xiaohongshu\.com|[^/:?#]+\.xhscdn\.com)(?:[/?#]|$)/i.test(source)) {
      return source.replace(/^http:/i, 'https:')
    }
  } catch { /* absent or unusable image */ }
  return null
}
