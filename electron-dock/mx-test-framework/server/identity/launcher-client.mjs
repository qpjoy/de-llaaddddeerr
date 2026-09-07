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
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 3_000
const DEFAULT_RATE_WINDOW_MS = 10_000
const DEFAULT_MAX_STARTS_PER_WINDOW = 30
const DEFAULT_PASSWORD_LOGIN_RATE_WINDOW_MS = 10_000
const DEFAULT_PASSWORD_LOGIN_MAX_STARTS_PER_WINDOW = 10
const DEFAULT_PASSWORD_LOGIN_MAX_IN_FLIGHT = 4
const DEFAULT_MAX_STARTS_PER_SOURCE_PER_WINDOW = 6
const DEFAULT_MAX_IN_FLIGHT_PER_SOURCE = 2
const DEFAULT_PASSWORD_LOGIN_MAX_STARTS_PER_SOURCE_PER_WINDOW = 3
const DEFAULT_PASSWORD_LOGIN_MAX_IN_FLIGHT_PER_SOURCE = 1
const MAX_CACHE_ENTRIES = 1_000
const MAX_IN_FLIGHT_ENTRIES = 8
const MAX_BUDGET_KEYS = 1_000

class FairStartBudget {
  #sources = new Map()
  #credentials = new Map()
  #global = { windowStartedAt: null, starts: 0, inFlight: 0 }

  constructor({
    windowMs,
    maxStarts,
    maxInFlight,
    maxStartsPerKey,
    maxInFlightPerKey,
    now,
    rateError,
    busyError,
  }) {
    this.windowMs = windowMs
    this.maxStarts = maxStarts
    this.maxInFlight = maxInFlight
    this.maxStartsPerKey = maxStartsPerKey
    this.maxInFlightPerKey = maxInFlightPerKey
    this.now = now
    this.rateError = rateError
    this.busyError = busyError
  }

  #digest(value, fallback) {
    return createHash('sha256').update(value || fallback).digest('base64url')
  }

  #entryFor(map, key, now) {
    for (const [entryKey, entry] of map) {
      if (
        entry.inFlight === 0 &&
        (now < entry.windowStartedAt || now - entry.windowStartedAt >= this.windowMs)
      ) {
        map.delete(entryKey)
      }
    }

    let entry = map.get(key)
    if (!entry) {
      if (map.size >= MAX_BUDGET_KEYS) {
        const evictable = [...map].find(([, candidate]) => candidate.inFlight === 0)
        if (!evictable) throw this.busyError('tracking')
        map.delete(evictable[0])
      }
      entry = { windowStartedAt: now, starts: 0, inFlight: 0 }
      map.set(key, entry)
    } else if (now < entry.windowStartedAt || now - entry.windowStartedAt >= this.windowMs) {
      entry.windowStartedAt = now
      entry.starts = 0
    }
    return entry
  }

  admit({ source, credential = null }) {
    const now = this.now()
    if (
      this.#global.windowStartedAt === null ||
      now < this.#global.windowStartedAt ||
      now - this.#global.windowStartedAt >= this.windowMs
    ) {
      this.#global.windowStartedAt = now
      this.#global.starts = 0
    }
    // Check the emergency ceiling before allocating per-key state. Once a
    // multi-source flood fills the global budget, new spoofed identities must
    // not churn either bounded map.
    if (this.#global.starts >= this.maxStarts) {
      throw this.rateError(
        'global',
        Math.max(1, this.#global.windowStartedAt + this.windowMs - now),
      )
    }
    if (this.#global.inFlight >= this.maxInFlight) throw this.busyError('global')

    const sourceEntry = this.#entryFor(
      this.#sources,
      this.#digest(typeof source === 'string' ? source : '', 'unknown'),
      now,
    )
    if (sourceEntry.starts >= this.maxStartsPerKey) {
      throw this.rateError(
        'key',
        Math.max(1, sourceEntry.windowStartedAt + this.windowMs - now),
      )
    }
    if (sourceEntry.inFlight >= this.maxInFlightPerKey) throw this.busyError('key')

    // Usernames participate only through this digest. The outbound OAuth body
    // still carries the real value, but limiter state and heap-resident maps do
    // not retain it.
    const credentialEntry = credential
      ? this.#entryFor(
          this.#credentials,
          this.#digest(String(credential).trim().toLowerCase(), 'unknown-credential'),
          now,
        )
      : null
    if (credentialEntry?.starts >= this.maxStartsPerKey) {
      throw this.rateError(
        'key',
        Math.max(1, credentialEntry.windowStartedAt + this.windowMs - now),
      )
    }
    if (credentialEntry?.inFlight >= this.maxInFlightPerKey) throw this.busyError('key')
    const keyedEntries = [sourceEntry, ...(credentialEntry ? [credentialEntry] : [])]

    this.#global.starts += 1
    this.#global.inFlight += 1
    for (const entry of keyedEntries) {
      entry.starts += 1
      entry.inFlight += 1
    }

    let released = false
    return () => {
      if (released) return
      released = true
      this.#global.inFlight -= 1
      for (const entry of keyedEntries) entry.inFlight -= 1
    }
  }
}

export class LauncherIdentityClient {
  #cache = new Map()
  #inFlight = new Map()
  #introspectionBudget
  #passwordLoginBudget

  constructor({
    baseUrl,
    audience,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    negativeCacheTtlMs = DEFAULT_NEGATIVE_CACHE_TTL_MS,
    rateWindowMs = DEFAULT_RATE_WINDOW_MS,
    maxStartsPerWindow = DEFAULT_MAX_STARTS_PER_WINDOW,
    passwordLoginRateWindowMs = DEFAULT_PASSWORD_LOGIN_RATE_WINDOW_MS,
    passwordLoginMaxStartsPerWindow = DEFAULT_PASSWORD_LOGIN_MAX_STARTS_PER_WINDOW,
    passwordLoginMaxInFlight = DEFAULT_PASSWORD_LOGIN_MAX_IN_FLIGHT,
    maxStartsPerSourcePerWindow = DEFAULT_MAX_STARTS_PER_SOURCE_PER_WINDOW,
    maxInFlightPerSource = DEFAULT_MAX_IN_FLIGHT_PER_SOURCE,
    passwordLoginMaxStartsPerSourcePerWindow =
      DEFAULT_PASSWORD_LOGIN_MAX_STARTS_PER_SOURCE_PER_WINDOW,
    passwordLoginMaxInFlightPerSource = DEFAULT_PASSWORD_LOGIN_MAX_IN_FLIGHT_PER_SOURCE,
    maxCacheEntries = MAX_CACHE_ENTRIES,
    maxInFlightEntries = MAX_IN_FLIGHT_ENTRIES,
    fetchImpl = globalThis.fetch,
    logger = console,
    now = Date.now,
  }) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/u, '') : null
    this.audience = audience
    this.timeoutMs = timeoutMs
    this.cacheTtlMs = cacheTtlMs
    this.negativeCacheTtlMs = negativeCacheTtlMs
    this.rateWindowMs = rateWindowMs
    this.maxStartsPerWindow = maxStartsPerWindow
    this.passwordLoginRateWindowMs = passwordLoginRateWindowMs
    this.passwordLoginMaxStartsPerWindow = passwordLoginMaxStartsPerWindow
    this.passwordLoginMaxInFlight = passwordLoginMaxInFlight
    this.maxStartsPerSourcePerWindow = maxStartsPerSourcePerWindow
    this.maxInFlightPerSource = maxInFlightPerSource
    this.passwordLoginMaxStartsPerSourcePerWindow = passwordLoginMaxStartsPerSourcePerWindow
    this.passwordLoginMaxInFlightPerSource = passwordLoginMaxInFlightPerSource
    this.maxCacheEntries = maxCacheEntries
    this.maxInFlightEntries = maxInFlightEntries
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.now = now
    this.#introspectionBudget = new FairStartBudget({
      windowMs: rateWindowMs,
      maxStarts: maxStartsPerWindow,
      maxInFlight: maxInFlightEntries,
      maxStartsPerKey: maxStartsPerSourcePerWindow,
      maxInFlightPerKey: maxInFlightPerSource,
      now,
      rateError: (scope, retryAfterMs) =>
        new AppError(429, 'launcher_rate_limited', 'Too many identity verifications; retry shortly', {
          scope,
          retryAfterMs,
        }),
      busyError: (scope) =>
        new AppError(503, 'launcher_busy', 'Identity provider verification is busy; retry shortly', {
          scope,
        }),
    })
    this.#passwordLoginBudget = new FairStartBudget({
      windowMs: passwordLoginRateWindowMs,
      maxStarts: passwordLoginMaxStartsPerWindow,
      maxInFlight: passwordLoginMaxInFlight,
      maxStartsPerKey: passwordLoginMaxStartsPerSourcePerWindow,
      maxInFlightPerKey: passwordLoginMaxInFlightPerSource,
      now,
      rateError: (scope, retryAfterMs) =>
        new AppError(429, 'launcher_login_rate_limited', 'Too many login attempts; retry shortly', {
          scope,
          retryAfterMs,
        }),
      busyError: (scope) =>
        new AppError(503, 'launcher_login_busy', 'Identity provider login is busy; retry shortly', {
          scope,
        }),
    })
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
    if (entry.expiresAt <= this.now()) {
      this.#cache.delete(key)
      return null
    }
    return entry
  }

  #writeCache(key, kind, value, ttlMs) {
    if (ttlMs <= 0 || this.maxCacheEntries <= 0) return
    const now = this.now()
    // Invalid-token floods otherwise leave expired three-second entries in the
    // map until it fills, where they could evict a still-live user decision.
    for (const [cachedKey, entry] of this.#cache) {
      if (entry.expiresAt <= now) this.#cache.delete(cachedKey)
    }
    // Refreshing an existing digest must also refresh its insertion order so
    // the bounded map discards an older decision first.
    this.#cache.delete(key)
    while (this.#cache.size >= this.maxCacheEntries) {
      this.#cache.delete(this.#cache.keys().next().value)
    }
    this.#cache.set(key, { kind, value, expiresAt: now + ttlMs })
  }

  #unauthorized(reason) {
    return reason === 'audience'
      ? new AppError(401, 'unauthorized', 'Token was issued for another audience')
      : new AppError(401, 'unauthorized', '登录已失效，请重新登录')
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
  async passwordLogin({ username, password }, source = null) {
    if (!this.enabled) {
      throw new AppError(503, 'launcher_unavailable', 'No mx-launcher URL is configured')
    }
    const releaseBudget = this.#passwordLoginBudget.admit({ source, credential: username })
    try {
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
    } finally {
      releaseBudget()
    }
  }

  /** Verify an opaque launcher token and return its principal. */
  async introspect(token, source = null) {
    if (!this.enabled) {
      throw new AppError(503, 'launcher_unavailable', 'No mx-launcher URL is configured')
    }
    const key = this.#cacheKey(token)
    const cached = this.#readCache(key)
    if (cached?.kind === 'allow') return cached.value
    if (cached?.kind === 'deny') throw this.#unauthorized(cached.value)

    // Concurrent requests carrying the same opaque token share one upstream
    // operation. Its only token-derived key is a digest, and the promise entry
    // is removed as soon as the operation settles. Concurrency and start-rate
    // caps keep a stream of unique junk tokens from creating unbounded Launcher
    // work.
    const pending = this.#inFlight.get(key)
    if (pending) return pending
    const releaseBudget = this.#introspectionBudget.admit({ source })

    const operation = this.#introspectUncached(token, key)
    this.#inFlight.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.#inFlight.get(key) === operation) this.#inFlight.delete(key)
      releaseBudget()
    }
  }

  async #introspectUncached(token, key) {
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
      this.#writeCache(key, 'deny', 'inactive', this.negativeCacheTtlMs)
      throw this.#unauthorized('inactive')
    }
    // An audience mismatch means the token was minted for a different service.
    if (this.audience && introspection.audience && introspection.audience !== this.audience) {
      this.#writeCache(key, 'deny', 'audience', this.negativeCacheTtlMs)
      throw this.#unauthorized('audience')
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
    this.#writeCache(key, 'allow', principal, this.cacheTtlMs)
    return principal
  }
}
