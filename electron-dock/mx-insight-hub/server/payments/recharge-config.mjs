// Deployment validation must not load a database driver or contact dependencies.
export function parseRechargeSources(raw = '') {
  if (!raw) return []
  try {
    const entries = JSON.parse(raw), environments = new Set()
    if (!Array.isArray(entries) || entries.length > 2) throw Error()
    return entries.map(entry => {
      if (!entry || Object.keys(entry).some(k => !['environment','appId','channelId','baseUrl','token'].includes(k))
        || !['test','live'].includes(entry.environment) || environments.has(entry.environment)
        || !/^[a-zA-Z0-9._-]{1,80}$/.test(entry.appId || '') || !/^[a-zA-Z0-9._-]{1,80}$/.test(entry.channelId || '')
        || typeof entry.token !== 'string' || entry.token.length < 32) throw Error()
      const url = new URL(entry.baseUrl)
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error()
      environments.add(entry.environment)
      return { ...entry, baseUrl: url.origin }
    })
  } catch { throw Error('Invalid payment delivery sources (values hidden)') }
}
