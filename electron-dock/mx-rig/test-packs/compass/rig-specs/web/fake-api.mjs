// The fake Compass backend every Web case starts from. It answers in the
// shapes the hdo_v2 front end reads (src/stores/auth.ts, src/components/auth/
// Captcha.vue); a case adds or replaces routes for the page it exercises.
// Nothing here is a real account: the login only exists inside this fake.

import { fakeBackend } from '../lib/network.mjs'

export const ACCOUNT = Object.freeze({
  account: 'rig-tester@example.test',
  password: 'rig-mock-only',
  userName: 'Rig 测试员',
  id: 'rig-user-1'
})

const svg = (width, height, body) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
  )}`

// A puzzle that any drag solves: the fake check accepts every attempt.
const CAPTCHA = {
  type: 'SLIDER',
  backgroundImage: svg(590, 360, '<rect width="590" height="360" fill="#dfe8ff"/><rect x="380" y="130" width="110" height="100" fill="#9fb7ff"/>'),
  templateImage: svg(110, 360, '<rect y="130" width="110" height="100" fill="#4d74f5"/>'),
  backgroundImageWidth: 590,
  backgroundImageHeight: 360,
  templateImageWidth: 110,
  templateImageHeight: 360
}

const ok = (data = null) => ({ code: 200, message: 'ok', data })

/** Routes every page needs: telemetry, the captcha, login and the signed-in user. */
export const BASE_ROUTES = [
  ['POST /api/tracing', () => ok()],
  ['POST /api/captcha/generate', () => ({ json: { id: 'rig-captcha-1', captcha: CAPTCHA } })],
  ['POST /api/captcha/check', ({}, { state }) => {
    state.captchaChecks = (state.captchaChecks ?? 0) + 1
    return ok()
  }],
  [
    'POST /api/account/login',
    (_request, { body, state }) => {
      state.logins = [...(state.logins ?? []), { account: body?.account }]
      return body?.account === ACCOUNT.account && body?.password === ACCOUNT.password
        ? ok({ token: 'rig-fake-token', refresh_token: 'rig-fake-refresh' })
        : { code: 401, message: '账号或密码错误', data: null }
    }
  ],
  ['GET /api/account/user-info', () => ok({ id: ACCOUNT.id, userName: ACCOUNT.userName, account: ACCOUNT.account })],
  ['POST /api/account/verify-token', () => ok({ valid: true })],
  ['GET /api/delta-feature/enabled', () => ok({ enabled: false })],
  // Several pages load the platform list before anything else (src/stores/common.ts).
  ['GET /api/account/platforms', () => ok([])],
  // The signed-in shell's badges: nothing unread, no alerts.
  ['GET /api/opinion/alert-summary', () => ok({ total: 0, items: [] })],
  [/^GET \/api\/[a-z-]+\/unread-completions$/, () => ok({ count: 0, items: [] })],
  ['GET /api/ai/history', () => ({ json: [] })],
  ['GET /api/dashboard/public-opinion', () => ok({ items: [], total: 0 })]
]

/**
 * What the AI chat page reads before anyone types: Delta switched off (so the
 * page uses the plain chat stream), no platforms, an empty conversation.
 */
export const CHAT_SHELL = [
  ['GET /api/delta-agent/agent-feature-keys', () => ok({ delta_enabled: false })],
  ['GET /api/portrait/delta-enabled', () => ok({ enabled: false })],
  ['GET /api/dashboard/data', () => ok({})],
  ['POST /api/ai/add', () => ok()],
  // The conversation detail is a bare array of rounds.
  [/^GET \/api\/ai\/conversation\/[^/]+$/, () => ({ json: [] })],
  [/^GET \/api\/ai\/conversations\/[^/]+\/strategy-(proposals|queries)$/, () => ok([])]
]

/** The base routes plus `extra`, where a later route for the same request wins. */
export function compassApi(extra = [], options = {}) {
  const merged = new Map()
  for (const [key, handler] of [...BASE_ROUTES, ...extra]) merged.set(String(key), [key, handler])
  return fakeBackend([...merged.values()], options)
}
