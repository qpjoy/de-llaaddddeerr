// 用浏览器登录（docs/25 P4）：桌面端经系统浏览器走平台统一认证。
//
// RFC 8252, the way native apps sign in through a browser:
//   1. A verifier stays in this process; its SHA-256 (the challenge), a state
//      and a loopback port go to Rig's /auth/desktop/start, opened in the
//      system browser — the one where the person may already be signed in to
//      Auth, or can use Feishu. The test browser is never used for this.
//   2. After Auth, Rig sends the browser to http://127.0.0.1:<port>/callback
//      with a one-time code and the same state.
//   3. Only this process, holding the verifier, can turn the code into a Rig
//      session (/api/rig/v1/desktop-login, through the product VIP).
// No token travels in a URL; the listener answers one exact callback and
// closes.
//
// A browser sign-in gives Rig's session only. The product network's user
// lease and the overseas channel need a Launcher network token, which only a
// password grant gives today: the network stays anonymous (docs/25 §11).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const TOKEN = /^[A-Za-z0-9_-]{43}$/
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"

function page(title, message) {
  const escape = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1d2433}</style><h1>${escape(title)}</h1><p>${escape(message)}</p></html>`
}

/** Where the browser goes: only Rig's own start path on an HTTPS origin. */
export function startUrl(origin, { challenge, port, state }) {
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
    throw new Error('统一认证地址无效（需要 https 的站点地址）')
  const url = new URL('/auth/desktop/start', base)
  url.search = new URLSearchParams({ challenge, port: String(port), state }).toString()
  return url.toString()
}

/**
 * Sign in through the system browser. `openExternal(url)` opens it;
 * `redeem({ code, verifier })` asks the Rig service for the session.
 * Resolves with what the service answered ({ token, member, expiresIn }).
 */
export async function browserSignIn({ ssoOrigin, openExternal, redeem, timeoutMs = 5 * 60_000, signal } = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(32).toString('base64url')
  let settle
  const arrived = new Promise((resolve, reject) => (settle = { resolve, reject }))
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return res.end()
    }
    const code = url.searchParams.get('code') ?? ''
    const returned = url.searchParams.get('state') ?? ''
    const matches = returned.length === state.length && timingSafeEqual(Buffer.from(returned), Buffer.from(state))
    const headers = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
    if (!matches || !TOKEN.test(code)) {
      // An old tab or someone else's link: this sign-in is not theirs to finish.
      res.writeHead(400, headers)
      return res.end(page('没有完成登录', '这个登录链接已经失效。请回到 MX Rig，重新点「用浏览器登录」。'))
    }
    res.writeHead(200, headers)
    res.end(page('已登录 MX Rig', '可以关闭这个页面，回到 MX Rig 继续。'))
    settle.resolve(code)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const timer = setTimeout(() => settle.reject(new Error('浏览器登录超时（5 分钟），请重试')), timeoutMs)
  const onAbort = () => settle.reject(new Error('已取消浏览器登录'))
  signal?.addEventListener('abort', onAbort, { once: true })
  // Cancelled while the listener was still starting.
  if (signal?.aborted) onAbort()
  try {
    if (!signal?.aborted) await openExternal(startUrl(ssoOrigin, { challenge, port: server.address().port, state }))
    const code = await arrived
    return await redeem({ code, verifier })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    server.close()
    server.closeAllConnections?.()
  }
}
