import { randomUUID } from 'node:crypto'
import { AppError } from './errors.mjs'

// This is an evidence allowlist, not a supported-platform or permission list.
// In particular, tieba can fail authorization before endpoint support checks.
export const AUTHORIZATION_REJECTION_PLATFORMS = Object.freeze([
  'twitter', 'facebook', 'instagram', 'bilibili', 'douyin', 'kuaishou', 'weibo',
  'xiaohongshu', 'youtube', 'zhihu', 'tiktok', 'linkedin', 'threads', 'reddit',
  'telegram', 'wechat_search', 'tieba',
])
export const AUTHORIZATION_REJECTION_ROUTES = Object.freeze([
  '/api/v1/data/search', '/api/v2/data/search', '/api/v1/search', '/api/v1/data/telegram/search',
  '/api/v1/night-all/search/raw', '/api/v1/night-all/search/crawl', '/api/v1/night-all/search/user-info',
  '/api/v1/night-all/search/post-detail', '/api/v1/night-all/search/post-comments',
])
const evidenceByError = new WeakMap()
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/u.test(value)
const scopeModes = ['snapshot', 'legacy_dynamic']

// Call only at authenticated platform checks known to precede reservation.
// The public exception, its message and its precedence are unchanged.
export function assertSearchPlatformGranted(allowed, context, platform, path = null) {
  if (allowed) return
  const error = new AppError(403, 'platform_not_granted', 'Platform is not granted')
  const evidence = { tenantId: context?.tenant?.id, consumerId: context?.consumer?.id,
    apiKeyId: context?.apiKey?.id, platform, scopeMode: context?.apiKey?.scopeMode,
    routePath: AUTHORIZATION_REJECTION_ROUTES.includes(path) ? path : null }
  if ([evidence.tenantId, evidence.consumerId, evidence.apiKeyId].every(uuid)
    && AUTHORIZATION_REJECTION_PLATFORMS.includes(platform) && scopeModes.includes(evidence.scopeMode)) {
    evidenceByError.set(error, Object.freeze(evidence))
  }
  throw error
}

export function authorizationRejectionEvidence(error) {
  return error && typeof error === 'object' ? evidenceByError.get(error) ?? null : null
}

export function normalizeAuthorizationRejection(value) {
  if (!value || ![value.eventId, value.tenantId, value.consumerId, value.apiKeyId].every(uuid)
    || !requestId(value.requestId) || !['server', 'client'].includes(value.requestIdSource)
    || !AUTHORIZATION_REJECTION_PLATFORMS.includes(value.platform) || !scopeModes.includes(value.scopeMode)
    || value.routePath != null && !AUTHORIZATION_REJECTION_ROUTES.includes(value.routePath)
    || value.errorCode !== 'platform_not_granted' || value.httpStatus !== 403) {
    throw new TypeError('Invalid authorization rejection evidence')
  }
  return { eventId: value.eventId.toLowerCase(), requestId: value.requestId, requestIdSource: value.requestIdSource,
    tenantId: value.tenantId.toLowerCase(), consumerId: value.consumerId.toLowerCase(), apiKeyId: value.apiKeyId.toLowerCase(),
    platform: value.platform, scopeMode: value.scopeMode, routePath: value.routePath ?? null,
    errorCode: 'platform_not_granted', httpStatus: 403 }
}

// Bounded best effort: diagnostic outages must not replace or indefinitely
// delay the authorization response. There are no credentials or free text in
// either log event, including on database/logger failure.
export async function recordAuthorizationRejection({ error, requestId: identifier, clientRequestId = false, store, logger }) {
  const evidence = authorizationRejectionEvidence(error)
  if (!evidence || error.status !== 403 || error.code !== 'platform_not_granted' || !requestId(identifier)) return
  const record = normalizeAuthorizationRejection({ ...evidence, eventId: randomUUID(), requestId: identifier,
    requestIdSource: clientRequestId ? 'client' : 'server', errorCode: 'platform_not_granted', httpStatus: 403 })
  let timer
  try {
    if (typeof store?.recordAuthorizationRejection !== 'function') throw new Error('unavailable')
    await Promise.race([
      Promise.resolve().then(() => store.recordAuthorizationRejection(record)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 1000) }),
    ])
  } catch {
    try { logger?.warn?.({ event: 'hub_authorization_rejection_persistence_unconfirmed', ...record }) } catch { /* original 403 wins */ }
  } finally { clearTimeout(timer) }
  try { logger?.warn?.({ event: 'hub_authorization_rejected', ...record }) } catch { /* original 403 wins */ }
}
