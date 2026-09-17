import { AppError } from '../core/errors.mjs'
import { requestFingerprint } from '../core/crypto.mjs'
import {
  NIGHT_ALL_LEGACY_OPERATIONS,
} from '../contracts/night-all-legacy.mjs'
import { normalizeNightAllCompatibilityRequest } from '../data/night-all-compat.mjs'
import { prepareNightAllCompatibilityTraversal } from '../data/night-all-pagination.mjs'

export const ACQUISITION_REQUEST_VERIFICATION_CONTRACT =
  'mx-insight-hub.acquisition-request-verification.v1'

const COMPATIBILITY_CONTRACT_VERSION = 'mx-insight-hub.night-all-compat.v1'
const ROUTE_PATTERN = /^\/api\/v1\/(?:night-all\/)?search\/([a-z-]+)$/u

// Both Night-All compatibility routes — the historical passthrough and the
// Hub-direct projection — fingerprint the same canonical form, and the public
// aliases are folded onto one path. A first-page request is unchanged by
// traversal preparation, so one derivation covers every reproducible run.
export function nightAllCompatibilityRoute(path) {
  const match = ROUTE_PATTERN.exec(String(path || ''))
  const operation = match?.[1]
  return operation && NIGHT_ALL_LEGACY_OPERATIONS.has(operation)
    ? { operation, canonicalPath: `/api/v1/night-all/search/${operation}` }
    : null
}

/**
 * Recompute the fingerprint a candidate body would have produced.
 *
 * Page-size and crawl-work limits are deliberately taken at their contract
 * maximum: this asks "is this the body that was sent", not "would today's
 * quota still accept it". A body that was accepted then is canonicalized the
 * same way now, because those limits only gate admission and never rewrite the
 * upstream body.
 */
export function nightAllCompatibilityRequestFingerprint({ path, body, businessId, canonicalizePlatform }) {
  const route = nightAllCompatibilityRoute(path)
  if (!route) {
    throw new AppError(400, 'unsupported_verification_route', 'Only Night-All compatibility search routes can be verified')
  }
  const normalized = normalizeNightAllCompatibilityRequest(route.operation, body, {
    businessId,
    canonicalizePlatform,
    maxPageSize: 100,
    maxCrawlWork: 100,
  })
  const traversal = prepareNightAllCompatibilityTraversal({
    operation: route.operation,
    platform: normalized.platform,
    upstreamBody: normalized.upstreamBody,
    // A wrapped continuation cursor needs the original consumer-scoped codec,
    // which a later verification cannot reconstruct. First-page candidates —
    // the reproducible ones — never reach the codec.
    codec: {
      decode() {
        throw new AppError(
          400,
          'unsupported_verification_cursor',
          'A continuation cursor cannot be verified; compare the first page of the traversal instead',
        )
      },
    },
  })
  return {
    operation: route.operation,
    canonicalPath: route.canonicalPath,
    canonicalBody: { contractVersion: COMPATIBILITY_CONTRACT_VERSION, ...traversal.upstreamBody },
    fingerprint: requestFingerprint({
      method: 'POST',
      path: route.canonicalPath,
      body: { contractVersion: COMPATIBILITY_CONTRACT_VERSION, ...traversal.upstreamBody },
    }),
  }
}

/**
 * Decide whether a candidate reproduces a stored run's request identity.
 *
 * A match is proof the parameters are byte-identical after canonicalization,
 * which is exactly what a historical run with no saved body could not
 * otherwise establish. A mismatch only means "not this body" and never
 * discloses what the original was.
 */
export function verifyAcquisitionRequestCandidate({ storedFingerprint, path, body, businessId, canonicalizePlatform }) {
  let derived
  try {
    derived = nightAllCompatibilityRequestFingerprint({ path, body, businessId, canonicalizePlatform })
  } catch (error) {
    if (error instanceof AppError && error.status === 400) {
      return {
        contractVersion: ACQUISITION_REQUEST_VERIFICATION_CONTRACT,
        match: false,
        rejected: { code: error.code, message: error.message },
      }
    }
    throw error
  }
  return {
    contractVersion: ACQUISITION_REQUEST_VERIFICATION_CONTRACT,
    match: derived.fingerprint === storedFingerprint,
    operation: derived.operation,
    canonicalPath: derived.canonicalPath,
    canonicalBody: derived.canonicalBody,
    candidateFingerprint: derived.fingerprint,
  }
}
