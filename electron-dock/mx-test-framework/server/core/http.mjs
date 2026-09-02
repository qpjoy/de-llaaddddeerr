import { AppError } from './errors.mjs'

export async function readJson(request, limitBytes = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) {
      throw new AppError(413, 'payload_too_large', 'Request body is too large')
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AppError(400, 'invalid_json', 'Request body must be valid JSON')
  }
}

/**
 * The request body as raw bytes.
 *
 * Webhook signatures are computed over exactly the bytes the provider sent.
 * Parsing to JSON and re-serialising would produce a different string — key
 * order, whitespace, unicode escaping — and the signature would never match.
 */
export async function readRawBody(request, limitBytes = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) {
      throw new AppError(413, 'payload_too_large', 'Request body is too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body)
}

export const SESSION_COOKIE = 'mxt_session'

function cookieValue(request, name) {
  const header = request.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim()) || null
    }
  }
  return null
}

/**
 * The caller's credential, from the Authorization header or the session cookie.
 *
 * The cookie is not a convenience: a `<video src>` or an `<img src>` cannot
 * carry an Authorization header, so recordings and screenshots would be
 * unviewable without it. Putting the token in the query string instead would
 * leak it into access logs, browser history and Referer headers.
 */
export function bearerToken(request) {
  const value = request.headers.authorization
  if (value && value.startsWith('Bearer ')) {
    return value.slice('Bearer '.length).trim() || null
  }
  return cookieValue(request, SESSION_COOKIE)
}

export function sessionCookie(token, { secure, maxAgeSeconds = 43_200 }) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: a report link pasted into chat should still open
    // logged in. It is a GET-only relaxation; every mutating route is POST.
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/**
 * Match a pathname against a pattern with `:name` segments.
 *
 * A trailing `:verb` on the last pattern segment (`/runs/:runId:complete`) is an
 * action suffix, not a parameter: it must appear literally in the path. This is
 * the shape the API contract uses for non-CRUD operations.
 *
 * A trailing `*` captures the remaining path into `params['*']`, for artifact
 * paths that legitimately contain slashes (`videos/smoke/auth.cy.ts.mp4`).
 */
export function routeMatch(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean)
  const patternParts = pattern.split('/').filter(Boolean)
  const params = {}

  if (patternParts.at(-1) === '*') {
    const head = patternParts.slice(0, -1)
    if (pathParts.length <= head.length) return null
    const matched = routeMatch(`/${pathParts.slice(0, head.length).join('/')}`, `/${head.join('/')}`)
    if (!matched) return null
    return {
      ...matched,
      '*': pathParts
        .slice(head.length)
        .map((part) => decodeURIComponent(part))
        .join('/'),
    }
  }

  if (pathParts.length !== patternParts.length) return null
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]
    const actual = pathParts[index]
    if (!expected.startsWith(':')) {
      if (expected !== actual) return null
      continue
    }
    const suffixAt = expected.indexOf(':', 1)
    if (suffixAt === -1) {
      params[expected.slice(1)] = decodeURIComponent(actual)
      continue
    }
    // `:runId:complete` — the action suffix is literal, the prefix is the value.
    const action = expected.slice(suffixAt)
    if (!actual.endsWith(action) || actual.length === action.length) return null
    params[expected.slice(1, suffixAt)] = decodeURIComponent(actual.slice(0, -action.length))
  }
  return params
}

export function requiredString(body, name, { maxLength = 300 } = {}) {
  const value = body?.[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'invalid_request', `${name} is required`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new AppError(400, 'invalid_request', `${name} exceeds ${maxLength} characters`)
  }
  return trimmed
}

export function optionalString(body, name, { maxLength = 300 } = {}) {
  const value = body?.[name]
  if (value == null || value === '') return null
  if (typeof value !== 'string') {
    throw new AppError(400, 'invalid_request', `${name} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new AppError(400, 'invalid_request', `${name} exceeds ${maxLength} characters`)
  }
  return trimmed || null
}

export function enumValue(body, name, allowed, fallback) {
  const value = body?.[name]
  if (value == null || value === '') {
    if (fallback === undefined) {
      throw new AppError(400, 'invalid_request', `${name} is required`)
    }
    return fallback
  }
  if (!allowed.includes(value)) {
    throw new AppError(400, 'invalid_request', `${name} must be one of ${allowed.join(', ')}`)
  }
  return value
}

export function stringArray(value, { maxItems = 200, maxLength = 240 } = {}) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw new AppError(400, 'invalid_request', 'Expected an array of strings')
  }
  return value
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .slice(0, maxItems)
    .map((entry) => entry.trim().slice(0, maxLength))
}

// Branch, tag or commit. Deliberately narrower than what git itself accepts:
// this string reaches a `git fetch` argument, so anything that could be read as
// an option (a leading `-`) or a path traversal is refused here rather than
// defended against downstream.
const GIT_REF = /^[A-Za-z0-9][\w.\-/]{0,199}$/u

export function gitRef(body, name) {
  const value = optionalString(body, name, { maxLength: 200 })
  if (value == null) return null
  if (!GIT_REF.test(value) || value.includes('..')) {
    throw new AppError(400, 'invalid_request', `${name} 不是合法的 git ref`)
  }
  return value
}

/**
 * A project root inside the checkout, e.g. `po-frontend`.
 *
 * Refused: absolute paths, `..` segments, and anything starting with `-`. This
 * value becomes a `cd` target on a machine that also holds the run token, so it
 * must not be able to walk out of the workspace or be read as an option.
 */
const RELATIVE_DIR = /^[A-Za-z0-9][\w.\-/]{0,199}$/u

export function relativeDir(body, name) {
  const value = optionalString(body, name, { maxLength: 200 })
  if (value == null) return null
  const normalized = value.replace(/\/+$/u, '')
  // `.` and `./` are how a person writes "the repository root", and a test
  // team's own repository has no subdirectory to name. The platform already
  // spells that as null, so normalise rather than reject: a caller who has to
  // learn that the root is expressed by *omitting* the field will instead send
  // `.`, get a 400, and have nothing to go on.
  if (normalized === '' || normalized === '.') return null
  if (!RELATIVE_DIR.test(normalized) || normalized.split('/').includes('..')) {
    throw new AppError(400, 'invalid_request', `${name} 必须是仓库内的相对目录，不能包含 ..`)
  }
  return normalized
}

/**
 * The command a suite runs, as an argv array.
 *
 * Deliberately permissive, because deciding *how* to test is the test team's
 * job and they should not need a pull request into someone else's repository to
 * change it. `pytest -q --junitxml=...`, `npx playwright test`, `k6 run` — all
 * of these are typed straight into the platform.
 *
 * What keeps that safe is not a vocabulary of approved words:
 *
 * 1. The argv is executed with `spawnSync(argv[0], argv.slice(1), {shell:false})`.
 *    Nothing here is ever parsed by a shell, so `;`, `|`, `$()` and backticks
 *    are inert — they arrive as literal characters in an argument.
 * 2. Creating a suite requires the `admin` role.
 * 3. The container is sandboxed: no service account token, egress restricted by
 *    NetworkPolicy, workspace on an ephemeral volume.
 *
 * An earlier version of this allowed only `pnpm/npm/yarn/make` calling a named
 * entry point in the repository. That was inconsistent: `runnerImage` accepts
 * any image, and an image's entrypoint is arbitrary code, so the vocabulary
 * check constrained honest use while stopping nobody determined. See ADR-0007.
 */

// Handing argv[0] to a shell would put back exactly the parsing that argv
// execution removes. This is a guard against a slip, not against an
// adversary — anyone who needs a shell pipeline writes a script in the test
// repository and calls that.
const COMMAND_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh'])

export function suiteCommand(value) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw new AppError(400, 'invalid_request', 'command 必须是字符串数组，例如 ["pytest","-q"]')
  }
  const argv = value
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .slice(0, 30)
    .map((entry) => entry.trim().slice(0, 500))
  if (argv.length === 0) return []

  const program = argv[0].split(/[\/]/u).pop().toLowerCase()
  if (COMMAND_SHELLS.has(program)) {
    throw new AppError(
      400,
      'invalid_request',
      `command 不能直接调用 ${argv[0]}：参数不经过 shell，所以 shell 语法不会生效。` +
        '需要管道或多条命令时，把它们写成测试仓库里的一个脚本再调用那个脚本。',
    )
  }
  for (const token of argv) {
    // Control characters break argv handling and let a crafted argument forge
    // extra lines in the run log.
    if (/[ -]/u.test(token)) {
      throw new AppError(400, 'invalid_request', 'command 的参数不能包含控制字符')
    }
  }
  return argv
}
