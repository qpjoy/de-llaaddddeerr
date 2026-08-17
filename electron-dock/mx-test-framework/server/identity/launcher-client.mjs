import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

// Client for MX Launcher's User Center.
//
// Launcher issues *opaque* tokens, so validity lives in its store, not in the
// token. Introspection asks the authority on every request, which is what makes
// a revoked account stop working immediately instead of at expiry. The cost is
// a network call, which the short cache below bounds — its TTL is the deliberate
// limit on how stale a revocation decision may be.

const DEFAULT_TIMEOUT_MS = 3_000
const DEFAULT_CACHE_TTL_MS = 30_000
const MAX_CACHE_ENTRIES = 1_000

export class LauncherIdentityClient {
  #cache = new Map()

  constructor({
    baseUrl,
    audience,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    fetchImpl = globalThis.fetch,
    logger = console,
  }) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/u, '') : null
    this.audience = audience
    this.timeoutMs = timeoutMs
    this.cacheTtlMs = cacheTtlMs
    this.fetchImpl = fetchImpl
    this.logger = logger
  }

  get enabled() {
    return Boolean(this.baseUrl)
  }

  // Key on a digest, never the token: this map is reachable from a heap dump.
  #cacheKey(token) {
    return createHash('sha256').update(token).digest('base64url')
  }

  #readCache(key) {
    const entry = this.#cache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.#cache.delete(key)
      return null
    }
    return entry.value
  }

  #writeCache(key, value) {
    // Only positive results are cached. Caching a rejection would extend an
    // outage or a typo into the next 30 seconds for no benefit.
    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      this.#cache.delete(this.#cache.keys().next().value)
    }
    this.#cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs })
  }

  async #post(path, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /** Exchange a username and password for a launcher token, for the UI login form. */
  async passwordLogin({ username, password }) {
    if (!this.enabled) {
      throw new AppError(503, 'launcher_unavailable', 'No mx-launcher URL is configured')
    }
    let response
    try {
      response = await this.#post('/internal/v1/sdk/oauth/token', {
        grant_type: 'password',
        username,
        password,
        audience: this.audience,
      })
    } catch (error) {
      throw new AppError(503, 'launcher_unavailable', `mx-launcher is unreachable: ${error.message}`)
    }
    if (!response.ok) {
      // Never echo the upstream body: it may repeat the submitted password.
      throw new AppError(401, 'invalid_credentials', '账号或密码不正确')
    }
    const payload = await response.json().catch(() => ({}))
    const token = payload.access_token || payload.token || payload.accessToken
    if (!token) {
      throw new AppError(502, 'launcher_contract', 'mx-launcher returned no access token')
    }
    return { token, expiresIn: payload.expires_in ?? null }
  }

  /** Verify an opaque launcher token and return its principal. */
  async introspect(token) {
    if (!this.enabled) {
      throw new AppError(503, 'launcher_unavailable', 'No mx-launcher URL is configured')
    }
    const key = this.#cacheKey(token)
    const cached = this.#readCache(key)
    if (cached) return cached

    let response
    try {
      response = await this.#post('/internal/v1/user-center/token/introspect', {
        token,
        audience: this.audience,
      })
    } catch (error) {
      this.logger?.warn?.(`[identity] launcher introspection unreachable: ${error.message}`)
      throw new AppError(503, 'launcher_unavailable', 'Identity provider is unreachable')
    }
    if (!response.ok) {
      throw new AppError(503, 'launcher_unavailable', 'Identity provider rejected the introspection call')
    }

    const payload = await response.json().catch(() => ({}))
    const introspection = payload?.introspection ?? payload
    if (!introspection?.active || !introspection.principal) {
      throw new AppError(401, 'unauthorized', '登录已失效，请重新登录')
    }
    // An audience mismatch means the token was minted for a different service.
    if (this.audience && introspection.audience && introspection.audience !== this.audience) {
      throw new AppError(401, 'unauthorized', 'Token was issued for another audience')
    }

    const principal = {
      kind: 'user',
      id: String(introspection.principal.principalId ?? introspection.subject),
      subject: introspection.subject ?? null,
      displayName:
        introspection.principal.displayName ||
        introspection.principal.name ||
        introspection.subject ||
        'unknown',
      launcherTenantId: introspection.principal.tenantId ?? null,
      expiresAt: introspection.expiresAt ?? null,
    }
    this.#writeCache(key, principal)
    return principal
  }
}
