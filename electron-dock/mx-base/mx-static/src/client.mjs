// Consumer-side helper: hand it your own loader and it puts mx-static in front
// of it. Callers keep working when mx-static cannot serve the bytes.
const ABSOLUTE = /^https?:\/\//

export function createStaticClient({ baseUrl, token, project, timeoutMs = 10_000, pollMs = 200 } = {}) {
  if (!baseUrl || !token || !project) throw new Error('createStaticClient requires baseUrl, token and project')
  const root = `${baseUrl.replace(/\/$/, '')}/static/v1/projects/${project}`
  const auth = { authorization: `Bearer ${token}` }
  const post = (path, body, signal) => fetch(`${root}${path}`, {
    method: 'POST', signal, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  async function settle(result, deadline, signal) {
    // 202 means the object is being fetched; poll the job until it publishes.
    while (!result.key && result.statusUrl && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollMs))
      const url = ABSOLUTE.test(result.statusUrl) ? result.statusUrl : `${baseUrl.replace(/\/$/, '')}${result.statusUrl}`
      const response = await fetch(url, { headers: auth, signal })
      if (!response.ok && response.status !== 202) return null
      result = await response.json()
      if (result.state === 'failed') return null
    }
    return result.key ? result : null
  }
  async function read(key, signal) {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/static/files/${key}`, { headers: auth, signal })
    if (!response.ok) return null
    return { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') }
  }
  return {
    read,
    async archive(source, { cacheScope = '', mode = 'cache_first', signal } = {}) {
      const response = await post('/ingest', { url: source, scope: cacheScope, mode }, signal)
      if (!response.ok && response.status !== 202) return null
      return settle(await response.json(), Date.now() + timeoutMs, signal)
    },
    // One durable transaction and one round trip for a whole upstream page.
    async archiveBatch(sources, { scope = '', mode = 'cache_first', signal } = {}) {
      const response = await post('/ingest/batch', { scope, mode, items: sources.map(url => (typeof url === 'string' ? { url } : url)) }, signal)
      if (!response.ok) throw Object.assign(new Error('batch_rejected'), { status: response.status })
      return (await response.json()).results
    },
  }
}

export function withStaticArchive(fallback, options = {}) {
  const client = createStaticClient(options)
  return async function load(source, context = {}) {
    const archived = await client.archive(source, context).catch(() => null)
    const bytes = archived && await client.read(archived.key, context.signal).catch(() => null)
    return bytes || fallback(source, context)
  }
}
