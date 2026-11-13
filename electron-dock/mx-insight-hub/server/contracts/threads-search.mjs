import { NATIVE_FORWARDING_ENDPOINTS, normalizeNativeForwardingRequest } from './native-forwarding.mjs'
import { rawSearchRecords } from './raw-search.mjs'
import { parseThreadsSearchPage, parseThreadsScraperSearchPage } from './threads.mjs'
import { THREADS_SCRAPER_ROUTE } from '../../shared/threads-search-routing.mjs'

export const THREADS_SEARCH_VERSION = 'mx-insight-hub.threads-search.v1'
export const THREADS_SEARCH_PATH = '/api/v1/data/search'

// TikHub retired its search_top/search_recent routes (they answer 400); search_posts
// replaced them and takes no continuation parameter.
const RECIPES = Object.freeze({
  rapidapi: Object.freeze({ provider: 'rapidapi', key: 'r.threads_search_recent', available: true }),
  [THREADS_SCRAPER_ROUTE]: Object.freeze({ provider: 'rapidapi', key: 'r.threads_scraper_search_posts', available: true }),
  tikhub: Object.freeze({ provider: 'tikhub', key: 't.api_01fa5792e82a0605', available: true }),
})
for (const row of Object.values(RECIPES)) {
  if (!NATIVE_FORWARDING_ENDPOINTS.some(endpoint => endpoint.key === row.key && endpoint.provider === row.provider)) {
    throw new Error(`Missing reviewed Threads search contract: ${row.key}`)
  }
}
export const threadsSearchRecipe = (platform, provider) => platform === 'threads' && Object.hasOwn(RECIPES, provider) ? RECIPES[provider] : null

export function buildThreadsSearchDispatch(request, job = {}, buffer = null) {
  const recipe = RECIPES[request.routeProvider ?? request.provider]
  const continuation = (buffer ? buffer.providerCursor : job.providerCursor) ?? null
  const native = normalizeNativeForwardingRequest(recipe.key, { params: { query: request.query, ...(continuation || {}) } })
  return { ...native, provider: recipe.provider, platform: 'threads', operationKey: native.operation,
    socialCompat: { stage: 'data' }, threadsSearch: { request, continuation } }
}

export function projectThreadsSearchPage(payload, step, { capturedAt }) {
  const continuation = step.threadsSearch.continuation
  const { rows, providerPage } = step.key === RECIPES[THREADS_SCRAPER_ROUTE].key
    ? parseThreadsScraperSearchPage(payload, { currentCursor: continuation?.cursor ?? null, capturedAt })
    : parseThreadsSearchPage(payload, { provider: step.provider, currentCursor: continuation?.end_cursor ?? null, capturedAt })
  const records = rawSearchRecords({ data: { raw_info: '[]', raw_data: JSON.stringify(rows), page: {}, meta: {} } }, 'threads', step.provider)
  return { projected: { acquiredItems: rows, profiles: [], providerPage }, records }
}

export const THREADS_SEARCH_TRAVERSAL = Object.freeze({ version: THREADS_SEARCH_VERSION, datasetId: 'night-all.search.v1',
  buildStep: buildThreadsSearchDispatch, projectPage: projectThreadsSearchPage, countsAsPage: () => true, resolvedDone: () => false,
  usageUnits: rowsByJob => rowsByJob.flat().length })
