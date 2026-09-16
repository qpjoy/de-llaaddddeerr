/**
 * 通过出网通道发一个 HTTPS 请求。
 *
 * Node 22's global `fetch` ignores the proxy environment entirely, and
 * `NODE_USE_ENV_PROXY` only exists from Node 24 — which is exactly what the
 * egress page has been telling operators. So an active egress profile cannot
 * be implemented by setting a variable and hoping: the request has to be made
 * through the tunnel on purpose.
 *
 * This is a `fetch`-shaped function over `node:https` with an HTTP CONNECT
 * agent. It implements only what the model gateway actually uses — method,
 * headers, string body, `redirect: 'error'`, an abort signal, and a response
 * with `ok` / `status` / an async-iterable `body` that can be cancelled — and
 * nothing else. A partial imitation with a small surface is easier to audit
 * than a dependency that can do everything.
 *
 * Plaintext never goes through the tunnel: only `https:` targets are proxied,
 * loopback and bypass hosts stay direct, and a non-local `http:` target is
 * refused rather than quietly sent somewhere.
 */
import { Agent, request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { connect as tlsConnect } from 'node:tls'
import { RigError } from '../../packages/contracts/index.mjs'
import { bypassed } from './egress-profiles.mjs'

const CONNECT_TIMEOUT_MS = 15_000

class TunnelAgent extends Agent {
  constructor({ proxy, credential }) {
    // No keep-alive: a workbench makes a handful of model calls, and a pooled
    // tunnel that outlives a profile switch would keep using the old channel.
    super({ keepAlive: false, maxSockets: 4 })
    this.proxy = proxy
    this.credential = credential
  }
  createConnection(options, callback) {
    const port = Number(options.port) || 443
    const target = `${options.host}:${port}`
    const send = this.proxy.protocol === 'https:' ? httpsRequest : httpRequest
    const connecting = send({
      host: this.proxy.hostname,
      port: Number(this.proxy.port),
      method: 'CONNECT',
      path: target,
      setHost: false,
      timeout: CONNECT_TIMEOUT_MS,
      headers: {
        host: target,
        ...(this.credential
          ? { 'proxy-authorization': `Basic ${Buffer.from(this.credential).toString('base64')}` }
          : {})
      }
    })
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      callback(error)
    }
    connecting.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        // 407 is the one status worth naming: it is the difference between "no
        // route" and "the channel wants credentials we do not have".
        fail(
          new RigError(
            'egress_refused',
            response.statusCode === 407
              ? '出网通道要求代理凭据；请检查通道的凭据环境变量'
              : `出网通道拒绝了这次连接（${response.statusCode}）`,
            502
          )
        )
        return
      }
      if (head?.length) socket.unshift(head)
      const secure = tlsConnect({
        socket,
        servername: options.host,
        // We speak HTTP/1.1 over this socket; offering h2 would let a gateway
        // negotiate a protocol this client cannot write.
        ALPNProtocols: ['http/1.1']
      })
      secure.once('error', fail)
      secure.once('secureConnect', () => {
        if (settled) return
        settled = true
        secure.removeListener('error', fail)
        callback(null, secure)
      })
    })
    connecting.once('timeout', () => {
      connecting.destroy()
      fail(new RigError('egress_timeout', '连接出网通道超时', 504))
    })
    connecting.once('error', () =>
      fail(new RigError('egress_unreachable', '无法连接出网通道', 502))
    )
    connecting.end()
  }
}

/** Build the `fetch`-shaped transport for one profile. */
export function createProxyFetch(profile, { environment = process.env, base = fetch } = {}) {
  const proxy = new URL(profile.proxyUrl)
  const credential = profile.authEnv ? environment[profile.authEnv] || '' : ''
  const agent = new TunnelAgent({ proxy, credential })
  return async function proxiedFetch(input, init = {}) {
    const url = new URL(String(input))
    if (bypassed(url.hostname, profile.bypass)) return base(input, init)
    if (url.protocol !== 'https:')
      throw new RigError(
        'egress_plaintext',
        '出网通道只代理 HTTPS 请求；本机 http 网关请留在直连列表里',
        409
      )
    return tunnelled(url, init, agent)
  }
}

function tunnelled(url, init, agent) {
  const { signal } = init
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      { method: init.method || 'GET', headers: init.headers || {}, agent },
      (response) => {
        const status = response.statusCode ?? 0
        if (init.redirect === 'error' && status >= 300 && status < 400) {
          response.destroy()
          reject(new RigError('egress_redirect', '目标返回了重定向；已按不跟随处理', 502))
          return
        }
        // `cancel()` is the one piece of the WHATWG body interface the gateway
        // relies on, to drop a response it will not read.
        response.cancel = async () => {
          response.destroy()
        }
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: response.headers,
          body: response
        })
      }
    )
    const abort = () => request.destroy(new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    request.once('close', () => signal?.removeEventListener('abort', abort))
    request.once('error', (error) =>
      reject(
        error instanceof RigError || error?.name === 'AbortError'
          ? error
          : new RigError('egress_failed', '通过出网通道的请求失败', 502)
      )
    )
    if (init.body != null) request.write(init.body)
    request.end()
  })
}
