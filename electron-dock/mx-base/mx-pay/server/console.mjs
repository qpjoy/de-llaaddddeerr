import { readFileSync } from 'node:fs'
import { createApplicationSso } from '@qpjoy/mx-common/identity/sso'
import { PostgresSsoStore } from '@qpjoy/mx-common/identity/postgres'
import { PaymentError, requirePayment } from '../src/index.mjs'
import { json } from './app.mjs'
import { consolePrincipal } from './console-config.mjs'

const assets = new Map([
  ['/', ['text/html; charset=utf-8', readFileSync(new URL('../console/index.html', import.meta.url))]],
  ['/console.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../console/console.js', import.meta.url))]],
  ['/console.css', ['text/css; charset=utf-8', readFileSync(new URL('../console/console.css', import.meta.url))]],
])
const publicOrder = order => Object.fromEntries(['id','businessOrderId','appId','environment','amountMinor','currency','status','provider','createdAt','updatedAt']
  .map(key => [key, order[key]]))

export function createPaymentConsole({ settings, access, sessionPool, service, management, sso: injectedSso, logger = console }) {
  const sso = injectedSso ?? createApplicationSso({ settings,
    store: new PostgresSsoStore(sessionPool, settings.sessionKey), applicationName: 'MX Pay', ErrorClass: PaymentError,
    resolvePrincipal: identity => management ? management.ssoPrincipal(identity, settings) : consolePrincipal(identity, access),
  })
  let inFlight = 0
  return async (request, response) => {
    const reply = (status, body) => response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body))
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    inFlight++
    try {
      const url = new URL(request.url, settings.origin), path = url.pathname
      if (path === '/health/live' && request.method === 'GET') return reply(200, { service: 'mx-pay-console', status: 'alive' })
      if (path === '/health/ready' && request.method === 'GET') {
        await sessionPool.query('SELECT 1 FROM app_auth.browser_sso_records LIMIT 1')
        return reply(200, { service: 'mx-pay-console', status: 'ready' })
      }
      requirePayment(inFlight <= 32, 'payment_console_busy', '查询台繁忙，请稍后再试', 503)
      if (request.method === 'GET' && assets.has(path)) {
        const [type, content] = assets.get(path)
        return response.writeHead(200, { 'content-type': type }).end(content)
      }
      if (await sso.handle(request, response, url)) return
      // No machine credential fallback and no transaction endpoints on this listener.
      requirePayment(path.startsWith('/console/v1/'), 'payment_route_not_found', 'Route not found', 404)
      requirePayment(management || request.method === 'GET', 'payment_console_read_only', '支付查询台仅支持查看', 405)
      const principal = await sso.principal(request)
      requirePayment(principal, 'payment_console_login_required', '请先统一登录', 401)
      if (management) {
        const actor = await management.principal(principal)
        const body = ['POST','PUT'].includes(request.method) ? await json(request,65536) : {}
        return reply(200, { data: await management.route(actor,request.method,path.slice('/console/v1/'.length),url.searchParams,body) })
      }
      if (path === '/console/v1/me' && !url.search) return reply(200, { data: principal })
      requirePayment(path === '/console/v1/orders', 'payment_route_not_found', 'Route not found', 404)
      const appId = url.searchParams.get('appId'), environment = url.searchParams.get('environment')
      requirePayment(url.searchParams.getAll('appId').length === 1 && url.searchParams.getAll('environment').length === 1,
        'invalid_payment_query', '请选择应用和环境')
      requirePayment(principal.grants.some(grant => grant.role === 'viewer' && grant.appId === appId && grant.environment === environment),
        'payment_console_forbidden', '当前账号没有此应用和环境的支付查看权限', 403)
      const query = new URLSearchParams(url.searchParams); query.delete('appId'); query.delete('environment')
      const page = await service.list({ appId, environment, scopes: ['orders.read'] }, query)
      return reply(200, { data: { ...page, items: page.items.map(publicOrder) } })
    } catch (error) {
      if (!(error instanceof PaymentError)) logger.error?.(JSON.stringify({ service: 'mx-pay-console', code: 'console_unavailable' }))
      if (!response.headersSent) reply(error instanceof PaymentError ? error.status : 503,
        { error: { code: error instanceof PaymentError ? error.code : 'payment_console_unavailable',
          message: error instanceof PaymentError ? error.message : '支付查询台暂不可用，请稍后再试' } })
      else response.end()
    } finally { inFlight-- }
  }
}
