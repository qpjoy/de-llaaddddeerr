import { NATIVE_FORWARDING_ENDPOINTS, normalizeNativeForwardingRequest } from './native-forwarding.mjs'
import { rawSearchRecords } from './raw-search.mjs'
import { parseThreadsSearchPage } from './threads.mjs'

export const THREADS_SEARCH_VERSION = 'mx-insight-hub.threads-search.v1'
export const THREADS_SEARCH_PATH = '/api/v1/data/search'

// TikHub retired its search_top/search_recent routes (they answer 400); search_posts
// replaced them and takes no continuation parameter.
const RECIPES = Object.freeze({
  rapidapi: Object.freeze({ provider: 'rapidapi', key: 'r.threads_search_recent', available: true }),
  tikhub: Object.freeze({ provider: 'tikhub', key: 't.api_01fa5792e82a0605', available: true }),
})
for (const row of Object.values(RECIPES)) {
  if (!NATIVE_FORWARDING_ENDPOINTS.some(endpoint => endpoint.key === row.key && endpoint.provider === row.provider)) {
    throw new Error(`Missing reviewed Threads search contract: ${row.key}`)
  }
}
export const threadsSearchRecipe = (platform, provider) => platform === 'threads' ? RECIPES[provider] ?? null : null

export function buildThreadsSearchDispatch(request, job = {}, buffer = null) {
  const recipe = RECIPES[request.provider]
  const continuation = (buffer ? buffer.providerCursor : job.providerCursor) ?? null
  const native = normalizeNativeForwardingRequest(recipe.key, { params: { query: request.query, ...(continuation || {}) } })
  return { ...native, provider: recipe.provider, platform: 'threads', operationKey: native.operation,
    socialCompat: { stage: 'data' }, threadsSearch: { request, continuation } }
}

export function projectThreadsSearchPage(payload, step, { capturedAt }) {
  const { rows, providerPage } = parseThreadsSearchPage(payload, { provider: step.provider,
    currentCursor: step.threadsSearch.continuation?.end_cursor ?? null, capturedAt })
  const records = rawSearchRecords({ data: { raw_info: '[]', raw_data: JSON.stringify(rows), page: {}, meta: {} } }, 'threads', step.provider)
  return { projected: { acquiredItems: rows, profiles: [], providerPage }, records }
}

export const THREADS_SEARCH_TRAVERSAL = Object.freeze({ version: THREADS_SEARCH_VERSION, datasetId: 'night-all.search.v1',
  buildStep: buildThreadsSearchDispatch, projectPage: projectThreadsSearchPage, countsAsPage: () => true, resolvedDone: () => false,
  usageUnits: rowsByJob => rowsByJob.flat().length })
