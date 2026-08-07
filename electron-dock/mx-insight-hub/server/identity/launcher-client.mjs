import { AppError } from '../core/errors.mjs'

// Client for MX Launcher's User Center token introspection.
//
// Introspection (RFC 7662 shaped) rather than JWT/JWKS verification, because
// Launcher issues *opaque* tokens (`mx-v1-...`) whose validity lives in its own
// store. A JWT would let the Hub validate offline, but it would also let a
// revoked token keep working until it expired; introspection asks the authority
// every time and therefore honours revocation immediately.
//
// The cost is a network call per request, which is what the short-lived cache
// below is for. Its TTL is the deliberate bound on how stale a revocation
// decision may be.

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
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : null
    this.audience = audience
    this.timeoutMs = timeoutMs
    this.cacheTtlMs = cacheTtlMs
    this.fetchImpl = fetchImpl
    this.logger = logger
  }

  get enabled() {
    return Boolean(this.baseUrl)
  }

  // Cache on a hash of the token, never the token itself: this map is reachable
  // from a heap dump and from any future debug endpoint that prints it.
  async #cacheKey(token) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    return Buffer.from(digest).toString('base64url')
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
    // Only positive results are cached. Caching a failure would extend a
    // transient Launcher blip into a guaranteed rejection window for a user
    // whose token is perfectly valid.
    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value
      this.#cache.delete(oldest)
    }
    this.#cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs })
  }

  /**
   * Introspect a Launcher token.
   *
   * Returns null for an inactive token. Throws `launcher_unavailable` when the
   * authority cannot be reached — the caller must not treat that as "denied and
   * move on", because the correct response to an unreachable authority is a 503
   * that says so, not a 401 that sends the user to re-authenticate against a
   * service that is down.
   */
  async introspect(token) {
    if (!this.enabled) return null
    if (!token) return null

    const key = await this.#cacheKey(token)
    const cached = this.#readCache(key)
    if (cached) return cached

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/internal/v1/user-center/token/introspect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, audience: this.audience }),
        signal: controller.signal,
      })
    } catch (error) {
      this.logger?.warn?.(`[identity] Launcher introspection unreachable: ${error.message}`)
      throw new AppError(503, 'launcher_unavailable', 'Identity provider is unreachable', {
        hint: 'Use the admin token if this is an operational emergency',
      })
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      throw new AppError(503, 'launcher_unavailable', 'Identity provider rejected the introspection call', {
        upstreamStatus: response.status,
      })
    }

    let payload
    try {
      payload = await response.json()
    } catch {
      throw new AppError(502, 'launcher_invalid_response', 'Identity provider returned a malformed response')
    }

    const introspection = payload?.introspection
    if (!introspection?.active || !introspection.principal) {
      // Launcher explains itself in `reason`; discarding it turns every
      // rejection into an indistinguishable "invalid session".
      this.logger?.warn?.(
        `[identity] token rejected by Launcher: ${introspection?.reason || 'no reason given'}`,
      )
      return null
    }

    // Audience is re-checked here even though it was sent in the request.
    // Trusting the authority to have filtered on a value we supplied, without
    // verifying what came back, is how a token minted for another audience gets
    // accepted when an upstream default changes.
    if (this.audience && introspection.audience && introspection.audience !== this.audience) {
      this.logger?.warn?.(
        `[identity] rejecting token for audience ${introspection.audience}, expected ${this.audience}`,
      )
      return null
    }

    const result = {
      issuer: introspection.issuer,
      audience: introspection.audience || this.audience,
      subject: introspection.subject,
      scopes: introspection.scopes || [],
      authProvider: introspection.authProvider || null,
      expiresAt: introspection.expiresAt || null,
      principal: {
        principalId: introspection.principal.principalId,
        kind: introspection.principal.kind,
        launcherTenantId: introspection.principal.tenantId ?? null,
        organizationIds: introspection.principal.orgIds || [],
        displayName: introspection.principal.displayName || introspection.subject,
        userId: introspection.principal.userId ?? null,
        roles: introspection.principal.roles || [],
        scopes: introspection.principal.scopes || [],
      },
    }
    this.#writeCache(key, result)
    return result
  }

  /**
   * Exchange a username and password for a Launcher token, server-side.
   *
   * This reverses an earlier decision to do the exchange in the browser. The
   * browser-side version kept the Hub out of the credential path, which is
   * genuinely better, but it cannot work here: Launcher is only reachable at an
   * internal address that requires VPN, so any user outside the VPN could not
   * sign in at all. Hub and Launcher are co-located and the Hub backend already
   * calls Launcher to introspect, so proxying the exchange uses a trust
   * relationship that already exists.
   *
   * The password is forwarded and forgotten: never logged, never stored, never
   * cached. Only the resulting token is returned.
   */
  async signIn({ username, password, clientIp }) {
    if (!this.enabled) {
      throw new AppError(503, 'launcher_not_configured', 'Launcher sign-in is not configured')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/internal/v1/sdk/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Launcher rate-limits password attempts per source IP. Proxying
          // would make every attempt look like it came from the Hub, so the
          // real client is forwarded; without it one attacker could exhaust the
          // shared limit and lock out everyone.
          ...(clientIp ? { 'x-forwarded-for': clientIp } : {}),
        },
        body: JSON.stringify({
          grant_type: 'password',
          username,
          password,
          audience: this.audience,
        }),
        signal: controller.signal,
      })
    } catch (error) {
      throw new AppError(503, 'launcher_unavailable', 'Identity provider is unreachable')
    } finally {
      clearTimeout(timer)
    }

    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (!response.ok) {
      // 401 is a wrong credential and must stay a 401; anything else is the
      // provider failing, which is not the user's problem to retype.
      if (response.status === 401 || response.status === 400) {
        throw new AppError(401, 'invalid_credentials', 'Account or password is incorrect')
      }
      if (response.status === 429) {
        throw new AppError(429, 'too_many_attempts', 'Too many sign-in attempts; try again later')
      }
      throw new AppError(503, 'launcher_unavailable', 'Identity provider rejected the sign-in', {
        upstreamStatus: response.status,
      })
    }

    const token = extractAccessToken(payload)
    if (!token) {
      throw new AppError(502, 'launcher_invalid_response', 'Launcher did not return a token')
    }
    return { token, expiresAt: payload?.token?.expires_at ?? payload?.expires_at ?? null }
  }

  /** Drop cached introspections; used after a membership change. */
  invalidate() {
    this.#cache.clear()
  }
}

/**
 * Pull the access token out of whatever shape Launcher returned.
 *
 * The nesting matters and is easy to get wrong: the OAuth endpoint answers with
 * `{ token: { access_token, audience, ... } }`, so a naive `payload.token`
 * yields the WRAPPER OBJECT rather than the string. Stringified into a header
 * that becomes the literal "[object Object]", which Launcher then reports as an
 * unknown token — a failure that looks like a session problem and is really a
 * parsing one. Every candidate is therefore type-checked.
 */
function extractAccessToken(payload) {
  const candidates = [
    payload?.token?.access_token,
    payload?.access_token,
    payload?.issued?.token,
    payload?.data?.access_token,
    payload?.token,
  ]
  return candidates.find((candidate) => typeof candidate === 'string' && candidate) || null
}
