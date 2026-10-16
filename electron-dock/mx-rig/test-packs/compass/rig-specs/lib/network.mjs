// The network a case runs in. The page under test gets its own static files
// and nothing else: every request to the Compass API is answered by the
// case's fake backend, and every other request — a CDN, an analytics beacon,
// a real API host — is refused and written down. A run on the snapshot can
// therefore never reach a real system, whatever the build was configured with.

/** The API host the snapshot build is pointed at: `.invalid` never resolves. */
export const FAKE_API_ORIGIN = 'http://compass-api.rig.invalid'

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify(body)
})

/**
 * A fake backend: `routes` maps "METHOD /api/path" (or a RegExp over the
 * same string) to a handler `(request, { state, body, url }) => answer`.
 * An answer is `{ json, status }`, `{ body, contentType, status }`, or a
 * plain object (sent as JSON).
 */
export function fakeBackend(routes, { state = {} } = {}) {
  const exact = new Map()
  const patterns = []
  for (const [key, handler] of routes) {
    if (key instanceof RegExp) patterns.push([key, handler])
    else exact.set(key, handler)
  }
  return {
    state,
    handlerFor(method, path) {
      const key = `${method} ${path}`
      if (exact.has(key)) return exact.get(key)
      return patterns.find(([pattern]) => pattern.test(key))?.[1] ?? null
    }
  }
}

/**
 * Route every request of `context`. Returns what the case's network did, for
 * the run log: API calls answered, API calls nobody faked, hosts refused.
 */
export async function guardNetwork(context, { appOrigin, backend }) {
  const seen = { answered: [], unanswered: new Set(), refused: new Set() }
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === appOrigin) return route.continue()
    if (url.origin === FAKE_API_ORIGIN) {
      const method = request.method()
      const handler = backend.handlerFor(method, url.pathname)
      if (!handler) {
        seen.unanswered.add(`${method} ${url.pathname}`)
        return route.fulfill(json({ code: 404, message: `rig-specs：未提供 ${method} ${url.pathname} 的假数据`, data: null }, 404))
      }
      let body = null
      try {
        body = request.postDataJSON()
      } catch {
        body = request.postData()
      }
      const answer = await handler(request, { state: backend.state, body, url })
      seen.answered.push(`${method} ${url.pathname}`)
      if (answer && (answer.body !== undefined || answer.json !== undefined)) {
        return route.fulfill(
          answer.json !== undefined
            ? json(answer.json, answer.status ?? 200)
            : { status: answer.status ?? 200, contentType: answer.contentType ?? 'text/plain', body: answer.body }
        )
      }
      return route.fulfill(json(answer ?? { code: 200, data: null }))
    }
    seen.refused.add(url.host || url.protocol)
    return route.abort('blockedbyclient')
  })
  return seen
}

export { json }
