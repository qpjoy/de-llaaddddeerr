import { AppError } from '../core/errors.mjs'
import { compileTwitterSearchQuery } from '../contracts/twitter-search-query.mjs'
import { getSearchAdmissionDispositionIds } from '../operations/search-admission-disposition.mjs'

// The supplier is an implementation detail of standard search. A known
// unresolved delivery cannot be bypassed by changing suppliers, page size or
// API version. Missing historical query snapshots do not block other queries.
const TRIM_CHARACTERS = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
const identity = query => {
  const trimmed = query.trim()
  try { return compileTwitterSearchQuery(trimmed).providerQuery }
  catch { return trimmed }
}

export async function assertTwitterSearchAvailable({ usageStore, context, query, excludeRequestIds = [] }) {
  if (typeof query !== 'string' || !query.trim()) return
  const expected = identity(query)
  let matching
  if (usageStore.pool) {
    // Compare the saved known queries using the same bounded compiler as the
    // adapter. PostgreSQL cannot reconstruct that proven Boolean equivalence;
    // raw/native spellings must not escape each other's unresolved receipt.
    const rows = (await usageStore.pool.query(`SELECT id,status,acquisition_request->'body'->>'query' AS query FROM usage_requests
      WHERE tenant_id=$1 AND consumer_id=$2 AND api_key_id=$3 AND platform='twitter'
        AND acquisition_request->>'path'='/api/v1/data/search'
        AND jsonb_typeof(acquisition_request->'body'->'query')='string'
        AND btrim(acquisition_request->'body'->>'query',$4)<>''
        AND status IN ('unknown','reserved') AND NOT (id=ANY($5::uuid[]))`,
    [context.tenant.id, context.consumer.id, context.apiKey.id, TRIM_CHARACTERS, excludeRequestIds])).rows
    matching = rows.filter(row => typeof row.query === 'string' && identity(row.query) === expected)
    if (matching.some(row => row.status === 'unknown')) {
      const disposed = await getSearchAdmissionDispositionIds(usageStore.pool,
        matching.filter(row => row.status === 'unknown'), {
          tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id,
          platform: 'twitter', query,
        })
      matching = matching.filter(row => !disposed.includes(row.id))
    }
  } else {
    matching = [...usageStore.requests.values()].filter(row => row.tenantId === context.tenant.id
      && row.consumerId === context.consumer.id && row.apiKeyId === context.apiKey.id && row.platform === 'twitter'
      && row.acquisitionRequest?.path === '/api/v1/data/search'
      && typeof row.acquisitionRequest?.body?.query === 'string' && row.acquisitionRequest.body.query.trim()
      && identity(row.acquisitionRequest.body.query) === expected && !excludeRequestIds.includes(row.id))
  }
  const blocker = matching.find(row => row.status === 'unknown') || matching.find(row => row.status === 'reserved')
  if (blocker) throw new AppError(409, blocker.status === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress',
    'An earlier attempt of this search is unresolved; changing suppliers cannot authorize another acquisition',
    { requestId: blocker.id, blockingRequestId: blocker.id, automaticRetryAllowed: false })
}
