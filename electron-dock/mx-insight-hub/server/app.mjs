import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { secureEqual } from './core/crypto.mjs'
import { AppError } from './core/errors.mjs'
import { bearerToken, publicApiKey, readBuffer, readJson, routeMatch, sendJson } from './core/http.mjs'
import { validateFieldMap } from './ingest/external/mapping.mjs'
import {
  adminTokenPrincipal,
  filterByTenant,
  requireCapability,
  scopeTenantFilter,
} from './identity/index.mjs'

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

// Combine per-tenant usage summaries into one. Counters add; the latency figure
// is re-derived as a request-weighted mean, because averaging two averages
// unweighted would over-represent a tenant with almost no traffic.
function mergeUsage(left, right) {
  if (!left) return right
  const byPlatform = { ...left.byPlatform }
  for (const [platform, entry] of Object.entries(right.byPlatform || {})) {
    const existing = byPlatform[platform]
    byPlatform[platform] = existing
      ? {
          ...existing,
          requests: existing.requests + entry.requests,
          committed: existing.committed + entry.committed,
          released: existing.released + entry.released,
          unknown: existing.unknown + entry.unknown,
          units: existing.units + entry.units,
        }
      : entry
  }
  const requests = (left.requests || 0) + (right.requests || 0)
  const weighted =
    (left.averageUpstreamLatencyMs || 0) * (left.requests || 0) +
    (right.averageUpstreamLatencyMs || 0) * (right.requests || 0)
  return {
    ...left,
    requests,
    committed: (left.committed || 0) + (right.committed || 0),
    released: (left.released || 0) + (right.released || 0),
    unknown: (left.unknown || 0) + (right.unknown || 0),
    units: (left.units || 0) + (right.units || 0),
    averageUpstreamLatencyMs: requests > 0 ? Math.round(weighted / requests) : null,
    byPlatform,
  }
}

function requiredField(body, name) {
  const value = body?.[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'invalid_request', `${name} is required`)
  }
  return value.trim()
}

function requiredQuery(searchParams, name) {
  const value = searchParams.get(name)
  if (!value) throw new AppError(400, 'invalid_request', `${name} query parameter is required`)
  return value
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
  identity = null,
  queue = null,
  backfillPlatforms = [],
  importer = null,
  agent = null,
  search = null,
  embedding = null,
  listenerMode = 'combined',
  staticRoot,
  logger = console,
}) {
  /**
   * Resolve the caller of an administrative route.
   *
   * Order matters and is not arbitrary: the admin token is checked first, with a
   * constant-time comparison, and only a credential that is *not* the admin
   * token is offered to Launcher. That keeps the break-glass path completely
   * independent of Launcher's availability — an operator holding the admin token
   * gets in whether or not the identity provider is reachable.
   */
  async function resolvePrincipal(request) {
    const credential = adminCredential(request)
    if (!credential) {
      throw new AppError(401, 'admin_auth_required', 'Admin token or Launcher session is required')
    }
    // The `adminToken &&` guard is load-bearing: secureEqual stringifies its
    // arguments, so a null admin token would compare equal to the literal
    // credential "null".
    if (adminToken && secureEqual(credential, adminToken)) return adminTokenPrincipal()

    if (!identity?.enabled) {
      throw new AppError(401, 'admin_auth_required', 'Valid admin token is required')
    }
    const principal = await identity.resolve(credential)
    if (!principal) {
      throw new AppError(401, 'invalid_session', 'Session is invalid, expired, or revoked')
    }
    return principal
  }

  async function requirePublic(request) {
    return service.authenticate(publicApiKey(request))
  }

  // Usage for exactly the tenants a principal may see. An unscoped principal
  // passes straight through to the existing platform-wide query.
  async function scopedUsageFor(principal, filters) {
    const scope = scopeTenantFilter(principal, filters.tenantId ?? null)
    if (!Array.isArray(scope)) {
      return service.usage({ ...filters, tenantId: scope || undefined })
    }
    const results = await Promise.all(
      scope.map((tenantId) => service.usage({ ...filters, tenantId })),
    )
    return results.reduce(mergeUsage, null) ?? results[0] ?? { requests: 0, byPlatform: {} }
  }

  // Resolve a consumer's owning tenant before acting on it. The tenant is never
  // taken from the request body: a caller who could name the tenant could name
  // one they are entitled to and still address a consumer in another.
  async function assertConsumerInScope(principal, consumerId) {
    if (principal.tenantIds === null || !consumerId) return
    const consumer = await store.getConsumer(consumerId)
    if (!consumer) throw new AppError(404, 'consumer_not_found', 'Consumer not found')
    scopeTenantFilter(principal, consumer.tenantId)
  }

  async function assertApiKeyInScope(principal, apiKeyId) {
    if (principal.tenantIds === null) return
    const keys = await service.listApiKeys()
    const key = keys.find((candidate) => candidate.id === apiKeyId)
    if (!key) throw new AppError(404, 'api_key_not_found', 'API key not found')
    scopeTenantFilter(principal, key.tenantId)
  }

  async function requireSource(sourceKey) {
    const source = await store.getExternalSource(sourceKey)
    if (!source) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
    return source
  }

  function requireImporter() {
    if (!importer) {
      throw new AppError(503, 'importer_unavailable', 'External imports require the PostgreSQL store')
    }
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

      let principal = null
      if (isAdminPath) {
        principal = await resolvePrincipal(request)
      }

      // Who am I, and what may I see? The console calls this first and renders
      // itself from the answer, so a scoped user never sees a control they are
      // not allowed to use.
      if (request.method === 'GET' && pathname === '/internal/v1/admin/session') {
        sendJson(response, 200, {
          data: {
            kind: principal.kind,
            memberId: principal.memberId,
            displayName: principal.displayName,
            platformAdmin: principal.platformAdmin,
            scoped: principal.tenantIds !== null,
            tenantIds: principal.tenantIds,
            capabilities: principal.capabilities,
            memberships: principal.memberships,
            identityProvider: identity?.enabled ? 'mx-launcher' : null,
            // Diagnostic pair for federated sessions: what the provider said,
            // and what would have granted platform admin.
            ...(principal.launcherScopes
              ? {
                  launcherScopes: principal.launcherScopes,
                  adminScopeAllowlist: principal.adminScopeAllowlist,
                  adminScopeMatched: principal.launcherScopes.filter((scope) =>
                    principal.adminScopeAllowlist.includes(scope),
                  ),
                }
              : {}),
          },
          requestId,
        })
        return
      }

      if (request.method === 'GET' && pathname === '/internal/v1/admin/dashboard') {
        requireCapability(principal, 'usage.read')
        // A scoped principal must not see platform-wide totals, so the
        // dashboard is derived from their own usage rather than the global one.
        if (principal.tenantIds !== null) {
          const scopedUsage = await scopedUsageFor(principal, {})
          sendJson(response, 200, { data: scopedUsage, requestId })
          return
        }
        sendJson(response, 200, { data: await service.dashboard(), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/ops/summary') {
        // Operational summary for Launcher's health proxy: platform-wide by
        // definition, so it stays admin-token only.
        requireCapability(principal, 'membership.write')
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
        requireCapability(principal, 'tenant.read')
        const tenants = filterByTenant(
          principal,
          (await service.listTenants()).map((tenant) => ({ ...tenant, tenantId: tenant.id })),
        )
        sendJson(response, 200, { data: tenants.map(({ tenantId: _, ...rest }) => rest), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/tenants') {
        // Creating a tenant is a platform action: a scoped user has no tenant to
        // create it "inside", and letting them would let anyone mint themselves
        // an unbounded namespace.
        requireCapability(principal, 'tenant.write')
        sendJson(response, 201, { data: await service.createTenant(await readJson(request)), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/consumers') {
        requireCapability(principal, 'consumer.read')
        const scope = scopeTenantFilter(principal, searchParams.get('tenantId') || null)
        if (Array.isArray(scope)) {
          const all = await Promise.all(scope.map((tenantId) => service.listConsumers(tenantId)))
          sendJson(response, 200, { data: all.flat(), requestId })
          return
        }
        sendJson(response, 200, { data: await service.listConsumers(scope || undefined), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/consumers') {
        requireCapability(principal, 'consumer.write')
        const body = await readJson(request)
        scopeTenantFilter(principal, body?.tenantId ?? null)
        sendJson(response, 201, { data: await service.createConsumer(body), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/api-keys') {
        requireCapability(principal, 'apikey.read')
        const keys = filterByTenant(principal, await service.listApiKeys(searchParams.get('consumerId') || undefined))
        sendJson(response, 200, { data: keys, requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/api-keys') {
        requireCapability(principal, 'apikey.write')
        const body = await readJson(request)
        // The tenant is derived from the consumer, so scope has to be checked
        // against the consumer's owner rather than anything the caller sends.
        await assertConsumerInScope(principal, body?.consumerId)
        sendJson(response, 201, { data: await service.createApiKey(body), requestId })
        return
      }
      let params = routeMatch(pathname, '/internal/v1/admin/api-keys/:id/revoke')
      if (request.method === 'POST' && params) {
        requireCapability(principal, 'apikey.write')
        await assertApiKeyInScope(principal, params.id)
        sendJson(response, 200, { data: await service.revokeApiKey(params.id), requestId })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/platforms') {
        requireCapability(principal, 'consumer.read')
        const filters = queryFilters(searchParams)
        await assertConsumerInScope(principal, filters.consumerId)
        sendJson(response, 200, {
          data: await service.getPlatformConfiguration(filters),
          requestId,
        })
        return
      }
      params = routeMatch(pathname, '/internal/v1/admin/platforms/:platform')
      if (request.method === 'PUT' && params) {
        requireCapability(principal, 'platform.write')
        const body = await readJson(request)
        scopeTenantFilter(principal, body?.tenantId ?? null)
        sendJson(response, 200, {
          data: await service.putPlatformConfiguration(params.platform, body),
          requestId,
        })
        return
      }
      if (request.method === 'GET' && pathname === '/internal/v1/admin/usage') {
        requireCapability(principal, 'usage.read')
        sendJson(response, 200, {
          data: await scopedUsageFor(principal, queryFilters(searchParams)),
          requestId,
        })
        return
      }

      // ---- external sources (P4) ------------------------------------------
      //
      // Registering a source and approving a mapping decide how outside data
      // enters the canonical model, so both need platform authority rather than
      // a tenant-scoped role.
      if (request.method === 'GET' && pathname === '/internal/v1/admin/sources') {
        requireCapability(principal, 'membership.write')
        sendJson(response, 200, { data: await store.listExternalSources(), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/sources') {
        requireCapability(principal, 'membership.write')
        const body = await readJson(request)
        const created = await store.createExternalSource({
          sourceKey: requiredField(body, 'sourceKey'),
          displayName: requiredField(body, 'displayName'),
          sourceKind: body.sourceKind || 'file',
          // External data lands in its own dataset by default so it never
          // silently merges into the Night-All corpus and skews platform stats.
          datasetId: body.datasetId || `external.${requiredField(body, 'sourceKey')}.v1`,
          platform: body.platform || 'external',
          objectType: body.objectType || 'record',
          connection: body.connection || {},
        })
        sendJson(response, 201, { data: created, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/mappings')
      if (params && request.method === 'GET') {
        requireCapability(principal, 'membership.write')
        const source = await requireSource(params.key)
        sendJson(response, 200, { data: await store.listSourceMappings(source.id), requestId })
        return
      }
      if (params && request.method === 'POST') {
        requireCapability(principal, 'membership.write')
        const source = await requireSource(params.key)
        const body = await readJson(request)
        validateFieldMap(body?.fieldMap)
        const mapping = await store.createSourceMapping({
          sourceId: source.id,
          fieldMap: body.fieldMap,
          origin: body.origin || 'manual',
          agentModel: body.agentModel,
          agentConfidence: body.agentConfidence,
          notes: body.notes,
        })
        // Created unapproved on purpose: a mapping decides how stored data is
        // shaped, so it takes a second, explicit action to put it in force.
        sendJson(response, 201, { data: mapping, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/mappings/:version/approve')
      if (params && request.method === 'POST') {
        requireCapability(principal, 'membership.write')
        const source = await requireSource(params.key)
        const approved = await store.approveSourceMapping({
          sourceId: source.id,
          version: Number(params.version),
          approvedBy: principal.memberId || 'admin-token',
        })
        sendJson(response, 200, { data: approved, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/preview')
      if (params && request.method === 'POST') {
        requireCapability(principal, 'membership.write')
        requireImporter()
        const buffer = await readBuffer(request)
        const preview = await importer.preview(buffer, requiredQuery(searchParams, 'filename'))
        // Ask the agent to improve on the deterministic mapping. It returns the
        // inferred one unchanged when no model is configured or every provider
        // is down, so this never blocks the preview.
        const suggestion = await agent?.suggestFieldMap({
          columns: preview.columns,
          sampleRows: preview.sample.map((entry) => entry.raw),
        })
        sendJson(response, 200, {
          data: { ...preview, suggestion: suggestion ?? null },
          requestId,
        })
        return
      }

      // ---- retrieval ------------------------------------------------------
      if (request.method === 'GET' && pathname === '/internal/v1/admin/retrieval') {
        requireCapability(principal, 'usage.read')
        sendJson(response, 200, {
          data: embedding ? await embedding.status() : { enabled: false },
          requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/retrieval/search') {
        requireCapability(principal, 'usage.read')
        if (!search?.queries?.chunkIndexSet) {
          throw new AppError(503, 'semantic_search_unavailable', 'The chunk index is not configured')
        }
        const body = await readJson(request)
        const result = await search.queries.semanticSearch(requiredField(body, 'query'), {
          platform: body.platform ?? null,
          datasetId: body.datasetId ?? null,
          size: body.size ?? 10,
          // Passing the embedder in rather than reaching for a global keeps the
          // query layer independent of whether an agent exists at all.
          embed: agent?.embeddings?.available ? (texts) => agent.embed(texts) : null,
        })
        sendJson(response, 200, { data: result, requestId })
        return
      }

      // ---- agent (P5) -----------------------------------------------------
      if (request.method === 'GET' && pathname === '/internal/v1/admin/agent') {
        requireCapability(principal, 'membership.write')
        sendJson(response, 200, {
          data: {
            available: Boolean(agent?.available),
            // The circuit state per provider is the operationally useful part:
            // it shows when the chain is quietly running on a fallback.
            ...(agent?.status() ?? {}),
          },
          requestId,
        })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/import')
      if (params && request.method === 'POST') {
        requireCapability(principal, 'membership.write')
        requireImporter()
        // Raw body plus a filename query parameter, deliberately not multipart:
        // multipart needs its own parser for attacker-controlled input, and this
        // path already accepts untrusted spreadsheets.
        const buffer = await readBuffer(request)
        const result = await importer.importFile({
          sourceKey: params.key,
          buffer,
          filename: requiredQuery(searchParams, 'filename'),
        })
        sendJson(response, result.status === 'skipped' ? 200 : 201, { data: result, requestId })
        return
      }

      params = routeMatch(pathname, '/internal/v1/admin/sources/:key/imports')
      if (params && request.method === 'GET') {
        requireCapability(principal, 'membership.write')
        const source = await requireSource(params.key)
        sendJson(response, 200, { data: await store.listImportRuns(source.id), requestId })
        return
      }

      // ---- backfill control ----------------------------------------------
      //
      // Backfill is platform-wide, reads Night-All's whole store, and costs
      // real database work, so it requires the same authority as membership
      // changes rather than any tenant-scoped role.
      if (request.method === 'GET' && pathname === '/internal/v1/admin/backfill') {
        requireCapability(principal, 'membership.write')
        if (!queue) {
          throw new AppError(503, 'queue_unavailable', 'Backfill requires the PostgreSQL store')
        }
        const cursors = await Promise.all(
          backfillPlatforms.map(async (platform) => [
            platform,
            await queue.getCursor(`backfill:night-all:${platform}`),
          ]),
        )
        sendJson(response, 200, {
          data: {
            platforms: Object.fromEntries(cursors),
            queue: await queue.stats('backfill'),
          },
          requestId,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/backfill') {
        requireCapability(principal, 'membership.write')
        if (!queue) {
          throw new AppError(503, 'queue_unavailable', 'Backfill requires the PostgreSQL store')
        }
        const body = await readJson(request)
        const platform = body?.platform
        // Only configured platforms: an arbitrary name would fall through the
        // generic normalizer and produce lower-fidelity canonical rows silently.
        if (!backfillPlatforms.includes(platform)) {
          throw new AppError(400, 'platform_not_backfillable', 'Platform is not configured for backfill', {
            supported: backfillPlatforms,
          })
        }
        const jobId = await queue.enqueue(
          'backfill',
          { platform, since: body?.since ?? null, maxPages: body?.maxPages ?? 50, chunk: 0 },
          { dedupeKey: `backfill:${platform}:0`, priority: 200 },
        )
        sendJson(response, 202, {
          // A null id means an identical backfill is already outstanding, which
          // is a success: the work the caller asked for is already scheduled.
          data: { platform, jobId, alreadyScheduled: jobId === null },
          requestId,
        })
        return
      }

      // ---- membership administration ------------------------------------
      if (request.method === 'GET' && pathname === '/internal/v1/admin/members') {
        requireCapability(principal, 'membership.write')
        sendJson(response, 200, { data: await store.listMembers(), requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/members/memberships') {
        requireCapability(principal, 'membership.write')
        const body = await readJson(request)
        scopeTenantFilter(principal, body?.tenantId ?? null)
        const granted = await store.grantTenantMembership({
          memberId: body?.memberId,
          tenantId: body?.tenantId,
          role: body?.role,
          grantedBy: principal.memberId || 'admin-token',
        })
        // The introspection cache holds the old membership set, so a grant would
        // otherwise take effect only after the TTL elapsed.
        identity?.client?.invalidate?.()
        sendJson(response, 201, { data: granted, requestId })
        return
      }
      if (request.method === 'POST' && pathname === '/internal/v1/admin/members/memberships/revoke') {
        requireCapability(principal, 'membership.write')
        const body = await readJson(request)
        scopeTenantFilter(principal, body?.tenantId ?? null)
        const revoked = await store.revokeTenantMembership({
          memberId: body?.memberId,
          tenantId: body?.tenantId,
          revokedBy: principal.memberId || 'admin-token',
        })
        identity?.client?.invalidate?.()
        sendJson(response, 200, { data: revoked, requestId })
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
