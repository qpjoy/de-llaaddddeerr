import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { secureEqual } from './core/crypto.mjs'
import { AppError } from './core/errors.mjs'
import { bearerToken, publicApiKey, readJson, routeMatch, sendJson } from './core/http.mjs'

function queryFilters(searchParams) {
  return {
    tenantId: searchParams.get('tenantId') || undefined,
    consumerId: searchParams.get('consumerId') || undefined,
    from: searchParams.get('from') || undefined,
    to: searchParams.get('to') || undefined,
  }
}

function adminCredential(request) {
  const value = request.headers['x-mx-insight-admin-token']
  return (typeof value === 'string' && value) || bearerToken(request)
}

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

async function serveSpa(pathname, response, staticRoot) {
  if (!staticRoot) return false
  const normalizedPath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, '')
  const relativePath = normalizedPath === '/' ? 'index.html' : normalizedPath.replace(/^[/\\]/, '')
  const candidates = [join(staticRoot, relativePath)]
  if (!extname(relativePath)) candidates.push(join(staticRoot, 'index.html'))
  for (const candidate of candidates) {
    try {
      const body = await readFile(candidate)
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(candidate)] || 'application/octet-stream',
        'content-length': body.length,
      })
      response.end(body)
      return true
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error
    }
  }
  return false
}

export function createApp({
  service,
  store,
  adapter,
  adminToken,
  listenerMode = 'combined',
  staticRoot,
  logger = console,
}) {
  async function requireAdmin(request) {
    if (!secureEqual(adminCredential(request) || '', adminToken)) {
      throw new AppError(401, 'admin_auth_required', 'Valid admin token is required')
    }
  }

  async function requirePublic(request) {
    return service.authenticate(publicApiKey(request))
  }

  async function dependencies() {
    const result = { store: { status: 'down' }, nightAll: { status: 'down' } }
    try {
      await store.ping()
      result.store = { status: 'up' }
    } catch (error) {
      result.store = { status: 'down', detail: error.name }
    }
    result.nightAll = await adapter.dependencies()
    return result
  }

  return async function app(request, response) {
    const requestId = request.headers['x-request-id'] || randomUUID()
    response.setHeader('x-request-id', requestId)
    try {
      const url = new URL(request.url, 'http://localhost')
      const { pathname, searchParams } = url

      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-api-key, x-mx-insight-admin-token',
          'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
        })
        response.end()
        return
      }

      if (request.method === 'GET' && (pathname === '/health' || pathname === '/health/live')) {
        sendJson(response, 200, { data: { status: 'live' }, requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/health/dependencies') {
        if (listenerMode === 'public') throw new AppError(404, 'not_found', 'Route not found')
        const data = await dependencies()
        sendJson(response, 200, { data, requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/health/ready') {
        const data = await dependencies()
        const requiredDependencies = listenerMode === 'admin' ? [data.store] : Object.values(data)
        const ready = requiredDependencies.every((entry) => entry.status === 'up')
        const readiness = {
          status: ready ? 'ready' : 'not_ready',
          ...(listenerMode === 'public' ? {} : { dependencies: data }),
        }
        sendJson(response, ready ? 200 : 503, { data: readiness, requestId })
        return
      }

      const isAdminPath = pathname.startsWith('/internal/v1/admin/') || pathname.startsWith('/internal/v1/ops/')
      const isPublicPath = pathname.startsWith('/api/v1/')
      if ((listenerMode === 'public' && isAdminPath) || (listenerMode === 'admin' && isPublicPath)) {
        throw new AppError(404, 'not_found', 'Route not found')
      }

      if (isAdminPath) {
        await requireAdmin(request)
      }

      if (request.method === 'GET' && pathname === '/internal/v1/admin/dashboard') {
        sendJson(response, 200, { data: await service.dashboard(), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/ops/summary') {
        sendJson(response, 200, { data: await service.dashboard(), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/runtime') {
        sendJson(response, 200, {
          data: { listenerMode, dependencies: await dependencies() },
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/tenants') {
        sendJson(response, 200, { data: await service.listTenants(), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/tenants') {
        sendJson(response, 201, { data: await service.createTenant(await readJson(request)), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/consumers') {
        sendJson(response, 200, { data: await service.listConsumers(searchParams.get('tenantId') || undefined), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/consumers') {
        sendJson(response, 201, { data: await service.createConsumer(await readJson(request)), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/api-keys') {
        sendJson(response, 200, { data: await service.listApiKeys(searchParams.get('consumerId') || undefined), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/api-keys') {
        sendJson(response, 201, { data: await service.createApiKey(await readJson(request)), requestId })
        return
      }
      let params = routeMatch(pathname, '/internal/v1/admin/api-keys/:id/revoke')
      if (request.method === 'POST' && params) {
        sendJson(response, 200, { data: await service.revokeApiKey(params.id), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/platforms') {
        sendJson(response, 200, {
          data: await service.getPlatformConfiguration(queryFilters(searchParams)),
          requestId,
        })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/platforms/:platform')
      if (request.method === 'PUT' && params) {
        sendJson(response, 200, {
          data: await service.putPlatformConfiguration(params.platform, await readJson(request)),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/usage') {
        sendJson(response, 200, { data: await service.usage(queryFilters(searchParams)), requestId })
        return
      }

      if (request.method === 'GET' && pathname === '/api/v1/data/capabilities') {
        const context = await requirePublic(request)
        const payload = await service.capabilities(context)
        sendJson(response, 200, { ...payload, requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/data/search') {
        const context = await requirePublic(request)
        const result = await service.search(context, {
          body: await readJson(request),
          idempotencyKey: request.headers['idempotency-key'],
          path: pathname,
        })
        sendJson(response, result.status, { ...result.body, requestId: result.requestId }, {
          'idempotent-replay': String(result.replay),
          'x-mx-insight-request-id': result.requestId,
        })
        return
      }
      params = routeMatch(pathname, '/api/v1/requests/:id')
      if (request.method === 'GET' && params) {
        const context = await requirePublic(request)
        sendJson(response, 200, { data: await service.requestStatus(context, params.id), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/usage') {
        const context = await requirePublic(request)
        sendJson(response, 200, {
          data: await service.publicUsage(context, queryFilters(searchParams)),
          requestId,
        })
        return
      }

      if (
        request.method === 'GET' &&
        listenerMode !== 'public' &&
        !pathname.startsWith('/api/') &&
        !pathname.startsWith('/internal/') &&
        !pathname.startsWith('/health') &&
        await serveSpa(pathname, response, staticRoot)
      ) return

      throw new AppError(404, 'not_found', 'Route not found')
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError(500, 'internal_error', 'Internal server error')
      if (!(error instanceof AppError)) logger.error?.({ requestId, error }, 'request failed')
      sendJson(response, appError.status, {
        error: {
          code: appError.code,
          message: appError.message,
          ...(appError.details ? { details: appError.details } : {}),
        },
        requestId,
      })
    }
  }
}
