import { randomUUID } from 'node:crypto'
import { PaymentError, requirePayment } from '../src/index.mjs'
import { authenticate, authorize } from './config.mjs'
import { permissionCatalog } from './management.mjs'
import { assertSchema } from './migrate.mjs'

export async function json(request, maximum = 8192) {
  requirePayment(/^application\/json(?:;|$)/i.test(request.headers['content-type'] || ''), 'invalid_content_type', 'JSON required', 415)
  const chunks = []; let length = 0
  for await (const chunk of request) {
    length += chunk.length
    requirePayment(length <= maximum, 'payment_body_too_large', 'Request too large', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new PaymentError(400, 'invalid_json', 'Invalid JSON') }
}
async function notificationForm(request) {
  requirePayment(/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] || ''), 'invalid_content_type', 'Form required', 415)
  const chunks = []; let length = 0
  for await (const chunk of request) {
    length += chunk.length
    requirePayment(length <= 65536, 'payment_body_too_large', 'Notification too large', 413)
    chunks.push(chunk)
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8')), body = Object.create(null)
  for (const [key,value] of form) {
    requirePayment(/^[a-z_]{1,80}$/.test(key) && !Object.hasOwn(body,key), 'invalid_payment_notification', 'Invalid or repeated notification field')
    body[key] = value
  }
  return body
}
export function createApp({ service, credentials, management, state = { draining: false }, logger = console }) {
  let inFlight = 0
  let reportingInFlight = 0
  const reportingPage=async work=>{
    requirePayment(reportingInFlight<2,'reporting_busy','Reporting readers busy; retry with the same cursor',429)
    reportingInFlight+=1
    try {return await work()} finally {reportingInFlight-=1}
  }
  return async (request, response) => {
    const requestId = randomUUID()
    const reply = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-request-id': requestId })
      response.end(JSON.stringify({ ...data, requestId }))
    }
    inFlight += 1
    try {
      const url = new URL(request.url, 'http://mx-pay.local'), path = url.pathname
      if (path === '/health/live' && request.method === 'GET') return reply(200, { status: 'alive' })
      if (path === '/health/ready' && request.method === 'GET') {
        requirePayment(!state.draining, 'payment_draining', 'Draining', 503)
        await assertSchema(service.pool)
        return reply(200, { status: 'ready', service: 'mx-pay' })
      }
      requirePayment(!state.draining && inFlight <= 128, 'payment_temporarily_unavailable', 'Retry with original request identity', 503)
      if (management) await management.syncChannels(service,process.env.MX_PAY_CHECKOUT_PAUSED==='1')
      const notification = /^\/v1\/notifications\/alipay\/([a-zA-Z0-9._-]{1,80})$/.exec(path)
      if (notification && request.method === 'POST') {
        requirePayment(!url.search, 'invalid_payment_query', 'Unexpected query')
        await service.channelPayments.notify(notification[1], await notificationForm(request))
        // Alipay requires literal success. Never acknowledge before the DB commit.
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        return response.end('success')
      }
      const principal = management ? await management.authenticate(request.headers.authorization) : authenticate(request.headers.authorization, credentials)
      const noQuery = () => requirePayment(!url.search, 'invalid_payment_query', 'Unexpected query')
      let data
      if (management && request.method==='GET' && ['/v1/permissions/catalog','/v1/permissions/members'].includes(path)) {
        authorize(principal,'permissions.read')
        requirePayment(principal.appId==='mx-launcher' && principal.environment==='live','payment_scope_required','Launcher permission credential required',403)
        if (path.endsWith('/catalog')) { noQuery(); data=permissionCatalog }
        else {
          requirePayment([...url.searchParams.keys()].every(k=>k==='after') && url.searchParams.getAll('after').length<=1,'invalid_payment_query','Unknown or repeated query')
          const after=url.searchParams.get('after') || ''
          requirePayment(!after || /^[a-f0-9]{64}$/.test(after),'invalid_payment_query','Invalid cursor')
          const rows=(await management.pool.query('SELECT id,identity,grants,revision FROM pay_control.members WHERE id>$1 ORDER BY id LIMIT 101',[after])).rows
          data={items:rows.slice(0,100),hasMore:rows.length>100,nextAfter:rows.length>100?rows[99].id:null}
        }
      }
      else if (path === '/v1/identity' && request.method === 'GET') { noQuery(); data = await service.identity(principal) }
      else if (path === '/v1/channels' && request.method === 'GET') { noQuery(); data = await service.channels(principal) }
      else if (path === '/v1/settings' && request.method === 'GET') {
        noQuery(); authorize(principal, 'settings.write')
        requirePayment(principal.environment === 'live', 'payment_environment_mismatch', 'Live settings require a live credential', 403)
        data = await service.settings()
      }
      else if (path === '/v1/settings' && request.method === 'PUT') { noQuery(); data = await service.configure(principal, await json(request, 750000)) }
      else if (path === '/v1/orders' && request.method === 'GET') data = await service.list(principal, url.searchParams)
      else if (path === '/v1/orders' && request.method === 'POST') {
        noQuery(); data = await service.create(principal, await json(request), request.headers['idempotency-key'])
        return reply(201, { data })
      } else if (path === '/v1/events' && request.method === 'GET') data = await service.pending(principal, url.searchParams)
      else if (path === '/v1/reporting/snapshot' && request.method === 'GET') data = await reportingPage(()=>service.reporting.snapshot(principal,url.searchParams))
      else if (path === '/v1/channel-reviews' && request.method === 'GET') data = await service.channelPayments.reviews(principal, url.searchParams)
      else if (path === '/v1/reporting/changes' && request.method === 'GET') data = await reportingPage(()=>service.reporting.changes(principal,url.searchParams))
      else {
        noQuery()
        const order = /^\/v1\/orders\/([^/]+)(?:\/(submit|cancel|confirm|reject|checkout|refresh))?$/.exec(path)
        const event = /^\/v1\/events\/([^/]+)\/ack$/.exec(path)
        if (order && request.method === 'GET' && !order[2]) {
          authorize(principal, 'orders.read'); data = await service.order(principal, order[1])
        } else if (order?.[2] && ['checkout','refresh'].includes(order[2]) && request.method === 'POST') data = await service.channelPayments[order[2]](principal, order[1], await json(request))
        else if (order?.[2] && request.method === 'POST') data = await service.act(principal, order[1], order[2], await json(request), request.headers['idempotency-key'])
        else if (event && request.method === 'POST') data = await service.acknowledge(principal, event[1], await json(request))
        else throw new PaymentError(404, 'payment_route_not_found', 'Route not found')
      }
      reply(200, { data })
    } catch (error) {
      if (!(error instanceof PaymentError)) logger.error?.(JSON.stringify({ service: 'mx-pay', requestId, code: error.code || 'internal_error' }))
      if (!response.headersSent) reply(error instanceof PaymentError ? error.status : 503, { error: { code: error instanceof PaymentError ? error.code : 'payment_unavailable', message: error instanceof PaymentError ? error.message : 'Payment service unavailable; query or retry with original identity' } })
      else response.end()
    } finally { inFlight -= 1 }
  }
}
