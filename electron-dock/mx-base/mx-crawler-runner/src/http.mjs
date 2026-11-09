import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { RunnerError } from './runner.mjs'

// Hub-only HTTP surface. Every route needs the shared bearer token; the
// listener binds to loopback by default (hostNetwork on the Hub node).
//
//   GET  /v1/health
//   POST /v1/invocations
//   GET  /v1/invocations/{dispatchId}
//   POST /v1/invocations/{dispatchId}/abort

const MAX_BODY_BYTES = 1024 * 1024
const digest = value => createHash('sha256').update(value).digest()

export function tokenMatcher(token) {
  if (typeof token !== 'string' || token.length < 24) throw Object.assign(new Error('runner token must be at least 24 characters'), { code: 'token_invalid' })
  const expected = digest(token)
  return header => {
    const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null
    return Boolean(match) && timingSafeEqual(digest(match[1]), expected)
  }
}

function send(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  response.end(text)
}

async function readJson(request) {
  const type = String(request.headers['content-type'] || '')
  if (!/^application\/json\b/i.test(type)) throw new RunnerError(415, 'unsupported_media_type', 'Content-Type must be application/json')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new RunnerError(413, 'body_too_large', 'Request body exceeds 1 MiB')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new RunnerError(400, 'invalid_json', 'Body is not valid JSON') }
}

export function createRunnerServer({ runner, token, logger = null }) {
  const authorized = tokenMatcher(token)
  const log = logger || (entry => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`))
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://runner.local')
    try {
      if (!authorized(request.headers.authorization)) throw new RunnerError(401, 'unauthorized', 'Missing or invalid bearer token')
      if (url.pathname === '/v1/health' && request.method === 'GET') return send(response, 200, { data: runner.health() })
      if (url.pathname === '/v1/invocations' && request.method === 'POST') {
        const { status, invocation } = await runner.submit(await readJson(request))
        return send(response, status, { data: invocation })
      }
      const match = /^\/v1\/invocations\/([^/]+)(\/abort)?$/.exec(url.pathname)
      if (match && request.method === (match[2] ? 'POST' : 'GET')) {
        const id = decodeURIComponent(match[1])
        return send(response, 200, { data: match[2] ? await runner.abort(id) : await runner.get(id) })
      }
      throw new RunnerError(404, 'not_found', 'Not found')
    } catch (error) {
      if (error instanceof RunnerError) return send(response, error.status, { error: { code: error.code, message: error.message } })
      log({ level: 'error', event: 'request_failed', path: url.pathname, error: error?.code || error?.message })
      return send(response, 500, { error: { code: 'internal_error', message: 'Runner failed to handle the request' } })
    }
  })
}
