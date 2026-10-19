import { AppError } from '../core/errors.mjs'

const invalid = message => { throw new AppError(400, 'invalid_twitter_search_parameters', message) }
export function normalizeTwitterSearchParameters(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) invalid('Twitter params must be an object')
  if (Object.hasOwn(params, 'count')) invalid('Use Hub pageSize; Twitter no longer supports the native count parameter')
  if (Object.hasOwn(params, 'cursor')) invalid('Return the unchanged Hub nextCursor in the top-level cursor field')
  if (Object.keys(params).some(key => !['category', 'filters', 'includeTimestamp'].includes(key))) invalid('Unsupported Twitter search parameter')
  const result = {}
  if (Object.hasOwn(params, 'category')) {
    if (params.category === 'People') invalid('People returns accounts; this endpoint searches content only')
    if (!['Top', 'Latest', 'Photos', 'Videos'].includes(params.category)) invalid('category must be Top, Latest, Photos or Videos')
    result.category = params.category
  }
  if (Object.hasOwn(params, 'filters')) {
    if (typeof params.filters !== 'string' || params.filters.length > 2048 || params.filters.includes('\0')) invalid('filters must be a string of at most 2048 characters without NUL')
    if (params.filters.trim()) result.filters = params.filters.trim()
  }
  if (Object.hasOwn(params, 'includeTimestamp')) {
    if (typeof params.includeTimestamp !== 'boolean') invalid('includeTimestamp must be boolean')
    result.includeTimestamp = params.includeTimestamp
  }
  return result
}

export const effectiveTwitterSearchParameters = (params, category = 'Latest') => ({
  category, includeTimestamp: false, ...normalizeTwitterSearchParameters(params ?? {}),
})
export const twitterParametersSupportTikHub = params => ['Top', 'Latest'].includes(params.category)
  && !params.filters && params.includeTimestamp === false
export function twitterTikHubParameters(params) {
  if (!twitterParametersSupportTikHub(params)) throw new AppError(400, 'twitter_search_parameters_unsupported',
    'The selected search route cannot preserve these Twitter parameters; use Top or Latest without filters or timestamp enrichment')
  return { search_type: params.category }
}
