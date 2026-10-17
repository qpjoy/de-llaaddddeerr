// 浏览器统一认证（docs/25 P4）：用平台的统一认证登录 Rig，网页端和桌面端。
//
// The platform's Auth (oidc-provider in Launcher, e.g. auth.minsight-ai.com)
// does the authentication; @qpjoy/mx-common/identity/sso does the OIDC part
// (code + PKCE, state, nonce, signature and UserInfo checks). What is Rig's:
//
//   - A verified identity becomes an ordinary Rig session for the member a
//     Launcher password sign-in reaches (`user:<userId>`), so roles and
//     project permissions carry over. Nothing about Auth grants a role.
//   - Each such session points at a sealed copy of the upstream session and is
//     checked against Auth again while it is used (at most once a minute):
//     an account disabled there stops working here. If Auth is unreachable,
//     a session verified in the last few minutes keeps working.
//   - The desktop signs in through the system browser (RFC 8252): a one-time
//     code bound to the desktop's challenge goes to its loopback listener,
//     and only the desktop that holds the verifier can turn it into a session.
//     No bearer token is ever put in a URL.
//
// The profile (clientId, clientSecret, sessionKey) comes from the platform's
// registration and is read from a private file; nothing here creates it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createApplicationSso } from '@qpjoy/mx-common/identity/sso'
import { PostgresSsoStore } from '@qpjoy/mx-common/identity/postgres'
import { readApplicationSsoProfile } from '@qpjoy/mx-common/identity/profile'
import { AppError } from '../../packages/test-platform/server/core/errors.mjs'
import { sessionCookie } from '../../packages/test-platform/server/core/http.mjs'

export const UI_MOUNT = '/rig/'
export const SSO_TABLE = 'rig_auth.browser_sso_records'
const DESKTOP_COOKIE = '__Host-mx-rig_desktop'
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const VERIFY_EVERY_MS = 60_000
// Auth unreachable: a session verified this recently keeps working.
const UNREACHABLE_GRACE_MS = 10 * 60_000
const DESKTOP_START_SECONDS = 300
const DESKTOP_CODE_SECONDS = 120

const random = () => randomBytes(32).toString('base64url')
const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url')
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const cookieOf = (request, name) => {
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null
  }
  return null
}
const hostCookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`

/** The store for memory mode and tests; the same contract as PostgresSsoStore. */
export class MemorySsoStore {
  #records = new Map()
  #key = (kind, id) => `${kind}:${id}`
  #live(kind, id) {
    const record = this.#records.get(this.#key(kind, id))
    if (!record) return null
    if (record.until <= Date.now()) {
      this.#records.delete(this.#key(kind, id))
      return null
    }
    return record
  }
  async put(kind, id, value, seconds) {
    this.#records.set(this.#key(kind, id), { value: structuredClone(value), until: Date.now() + seconds * 1000 })
  }
  async get(kind, id, consume = false) {
    if (!TOKEN.test(id ?? '')) return null
    const record = this.#live(kind, id)
    if (record && consume) this.#records.delete(this.#key(kind, id))
    return record ? structuredClone(record.value) : null
  }
  async update(kind, id, value) {
    const record = this.#live(kind, id)
    if (!record) return false
    record.value = structuredClone(value)
    return true
  }
  async remove(kind, id) {
    this.#records.delete(this.#key(kind, id))
  }
}

/** The registration's private profile, or null when none is mounted. */
export function loadSsoProfile(file) {
  if (!file || !existsSync(file)) return null
  return readApplicationSsoProfile(file)
}

export function createBrowserSso({ settings, identity, store, sessionTtlMs = 12 * 3_600_000, oidcConfiguration, verifyEveryMs = VERIFY_EVERY_MS }) {
  const ttlSeconds = Math.floor(sessionTtlMs / 1000)
  const publicHost = new URL(settings.origin).host.toLowerCase()
  const upstreamCopy = (session) => ({ issuer: session.issuer, subject: session.subject, accessToken: session.accessToken, csrf: random() })

  // A Rig session for a verified person, holding its own copy of the upstream
  // session: signing out of the web page does not end a desktop's.
  async function signIn(principal, upstream, source) {
    const ref = random()
    await store.put('session', ref, upstreamCopy(upstream), ttlSeconds)
    try {
      return await identity.issueSsoSession({ principal, ssoRef: ref, source })
    } catch (error) {
      await store.remove('session', ref)
      throw error
    }
  }

  const sso = createApplicationSso({
    settings,
    store,
    oidcConfiguration,
    ErrorClass: AppError,
    applicationName: 'MX Rig',
    navigation: { mounts: [UI_MOUNT] },
    // A desktop sign-in started in this browser rides on this login.
    prepareLogin: async ({ request, transaction }) => {
      const id = cookieOf(request, DESKTOP_COOKIE)
      if (id && (await store.get('login', id))?.type === 'desktop-start') transaction.desktop = id
      return {}
    },
    onAuthenticated: async ({ identity: verified, session, transaction }) => {
      const principal = { id: verified.mxIdentity.subject, subject: verified.mxIdentity.subject, displayName: verified.displayName }
      const web = await signIn(principal, session, null)
      const cookies = [sessionCookie(web.token, { secure: true, maxAgeSeconds: web.expiresIn })]
      let returnUrl = `${UI_MOUNT}?sso=ready`
      if (transaction.desktop) {
        cookies.push(hostCookie(DESKTOP_COOKIE, '', 0))
        const pending = await store.get('login', transaction.desktop, true)
        if (pending?.type === 'desktop-start') {
          const code = random()
          await store.put('login', code, { type: 'desktop-code', challenge: pending.challenge, port: pending.port, state: pending.state, principal, session: upstreamCopy(session) }, DESKTOP_CODE_SECONDS)
          returnUrl = `/auth/desktop/complete?code=${code}`
        }
      }
      return { returnUrl, cookies }
    }
  })

  // Rig sessions from SSO, checked against Auth: tokenHash → last success.
  const checked = new Map()
  identity.useSso({
    async verify(session) {
      const last = checked.get(session.tokenHash) ?? 0
      if (Date.now() - last < verifyEveryMs) return
      const upstream = session.ssoRef ? await store.get('session', session.ssoRef) : null
      if (!upstream) throw new AppError(401, 'sso_session_gone', '统一登录已失效，请重新登录')
      if (`user:${upstream.subject}` !== session.principalId) throw new AppError(401, 'sso_identity_changed', '统一身份不匹配，请重新登录')
      try {
        // Fresh: this check is already rate-limited above, and the module's
        // own 30-second cache would hide a revocation for that long again.
        await sso.verifySession(upstream, true)
      } catch (error) {
        if (error?.status !== 401 && Date.now() - last < UNREACHABLE_GRACE_MS) return
        throw error
      }
      if (checked.size >= 5000) checked.delete(checked.keys().next().value)
      checked.set(session.tokenHash, Date.now())
    },
    async forget(ref) {
      if (ref) await store.remove('session', ref)
    }
  })

  const redirect = (res, location, cookies = []) => {
    res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(cookies.length ? { 'set-cookie': cookies } : {}) })
    res.end()
    return true
  }

  return {
    origin: settings.origin,
    appId: settings.appId,

    /** Requests that arrived through the public HTTPS entrance (docs/25 §11). */
    publicEntrance(req) {
      return String(req.headers.host ?? '').toLowerCase() === publicHost
    },

    /** /auth/sso/* (the shared module) and the desktop hand-off. False when not ours. */
    async handle(req, res, url) {
      const path = url.pathname
      if (path === '/auth/desktop/start' && req.method === 'GET') {
        // The desktop's challenge, its loopback port and its state: kept for
        // five minutes, tied to this browser by a host-only cookie.
        const challenge = url.searchParams.get('challenge') ?? ''
        const state = url.searchParams.get('state') ?? ''
        const port = Number(url.searchParams.get('port'))
        if (!TOKEN.test(challenge) || !TOKEN.test(state) || !Number.isInteger(port) || port < 1024 || port > 65535)
          throw new AppError(400, 'desktop_start_invalid', '桌面端登录请求无效，请回到 MX Rig 重新点「用浏览器登录」')
        const id = random()
        await store.put('login', id, { type: 'desktop-start', challenge, port, state }, DESKTOP_START_SECONDS)
        return redirect(res, `/auth/sso/login?ui=${encodeURIComponent(UI_MOUNT)}`, [hostCookie(DESKTOP_COOKIE, id, DESKTOP_START_SECONDS)])
      }
      if (path === '/auth/desktop/complete' && req.method === 'GET') {
        // Only to the loopback port of a code this server issued.
        const code = url.searchParams.get('code') ?? ''
        const pending = TOKEN.test(code) ? await store.get('login', code) : null
        if (pending?.type !== 'desktop-code') throw new AppError(410, 'desktop_code_expired', '桌面端登录已超时，请回到 MX Rig 重新点「用浏览器登录」')
        return redirect(res, `http://127.0.0.1:${pending.port}/callback?code=${code}&state=${pending.state}`)
      }
      if (path.startsWith('/auth/sso/')) return sso.handle(req, res, url)
      return false
    },

    /** The desktop turns its code into a session, proving it holds the verifier. */
    async redeemDesktop({ code, verifier }, source) {
      if (!TOKEN.test(code ?? '') || typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128)
        throw new AppError(400, 'desktop_code_invalid', '桌面端登录凭据无效')
      const pending = await store.get('login', code, true)
      if (pending?.type !== 'desktop-code' || !same(pending.challenge, challengeOf(verifier)))
        throw new AppError(401, 'desktop_code_invalid', '桌面端登录凭据无效或已使用，请重新登录')
      return signIn(pending.principal, pending.session, source)
    },

    /** Signing out of the web page also ends the shared module's browser session. */
    async signOutBrowser(req) {
      const name = `__Host-${settings.appId}_sso`
      const sid = cookieOf(req, name)
      if (sid) await store.remove('session', sid)
      return hostCookie(name, '', 0)
    }
  }
}

/** The store for the server's mode: PostgreSQL with the profile's key, or memory. */
export function ssoStoreFor({ settings, pool }) {
  return pool ? new PostgresSsoStore(pool, settings.sessionKey, { table: SSO_TABLE }) : new MemorySsoStore()
}
