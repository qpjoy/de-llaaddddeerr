export const ACQUISITION_COMPARISON_PATH = '/api/v1/night-all/search/raw'

export function canCompareAcquisition(data) {
  const snapshot = data?.requestEvidence?.request
  return Boolean(data?.owner?.apiKeyId && data?.scope?.platform === 'xiaohongshu'
    && (!snapshot || (snapshot.method === 'POST' && snapshot.path === ACQUISITION_COMPARISON_PATH))
    && data?.costLineage?.providerCalls?.some(call => call.requestCall === true
      && call.providerKey === 'tikhub' && call.operation === 'social.posts.search'))
}

export function createAcquisitionComparison(data, bodyText, idempotencyKey) {
  if (!canCompareAcquisition(data)) throw new Error('目前支持 TikHub 小红书 raw 搜索的请求对比。')
  let body
  try { body = JSON.parse(bodyText) } catch { throw new Error('请输入有效的原请求 JSON。') }
  if (!body || Array.isArray(body) || typeof body !== 'object' || !['xiaohongshu', 'xhs', 'red', 'rednote'].includes(String(body.platform).trim().toLowerCase())) {
    throw new Error('请求必须是 platform=xiaohongshu 的 JSON 对象。')
  }
  // Match the already migrated single-query raw shape; do not accidentally route
  // an edited comparison to the historical Night-All fan-out implementation.
  const fields = new Set(['platform', 'keyword', 'query', 'count', 'limit', 'pageSize', 'page', 'cursor', 'includeDetails', 'disableAutoDetails', 'maxEnrichItems', 'includeRaw', 'businessId', 'business_id'])
  if (Object.keys(body).some(key => !fields.has(key))) throw new Error('对比仅支持单关键词小红书 raw 搜索，请移除不支持的参数。')
  const queries = [body.keyword, body.query].filter(value => typeof value === 'string' && value.trim())
  if (queries.length !== 1 || queries[0].trim().length > 500) throw new Error('请填写一个 keyword 或 query（最多 500 字）。')
  if ([body.count, body.limit, body.pageSize].some(value => value != null && Number(value) !== 20)
    || (body.page != null && (Number(body.page) !== 1 || body.cursor))) {
    throw new Error('当前兼容对比支持每页 20 条、首屏 page=1 或原始 Hub cursor；不会猜测后续页游标。')
  }
  if (body.cursor != null && (typeof body.cursor !== 'string' || !body.cursor.startsWith('mxec2.'))) throw new Error('只支持原始 Hub 小红书游标，不能重发历史 Night-All 游标。')
  if (!idempotencyKey || idempotencyKey === data.requestEvidence?.idempotencyKey) throw new Error('新请求必须使用独立的幂等键。')
  return {
    idempotencyKey, originalRequestId: data.requestId, keyId: data.owner.apiKeyId,
    body, path: ACQUISITION_COMPARISON_PATH,
    parameterSource: data.requestEvidence?.request && JSON.stringify(body) === JSON.stringify(data.requestEvidence.request.body)
      ? 'saved' : 'manual',
  }
}

export function comparisonOutcome(delivered) {
  const code = delivered?.body?.error?.code
  return ['request_in_progress', 'request_outcome_unknown', 'external_platform_outcome_unknown', 'external_platform_call_persistence_unknown', 'internal_error'].includes(code)
    || !delivered?.body ? 'uncertain' : 'received'
}
