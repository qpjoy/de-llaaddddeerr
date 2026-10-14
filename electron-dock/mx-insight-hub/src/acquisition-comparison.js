export const ACQUISITION_COMPARISON_PATH = '/api/v1/night-all/search/raw'
export const XHS_NATIVE_SEARCH_PATH = '/api/v1/xiaohongshu/app_v2/search_notes'
export const ACQUISITION_COMPARISON_PATHS = ['/api/v1/data/search', ACQUISITION_COMPARISON_PATH, '/api/v1/search/raw', XHS_NATIVE_SEARCH_PATH]

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const incomplete = value => value === '[redacted]' || (value && typeof value === 'object' && Object.values(value).some(incomplete))

export function comparisonUnavailableReason(data, { savedOnly = false } = {}) {
  const snapshot = data?.requestEvidence?.request
  if (!data?.owner?.apiKeyId) return '没有可用的原 API Key 身份，无法按原身份验证。'
  if (data?.scope?.platform === 'instagram') {
    if (!data.costLineage?.providerCalls?.some(call => call.requestCall === true && call.usageRequestId === data.requestId
      && call.providerKey === 'tikhub' && call.operation === 'native.t.instagram_v3_general_search'
      && call.endpointKey === 'native.t.instagram_v3_general_search'
      && call.contractVersion === 'mx-insight-hub.native-forwarding.v1')) return 'Instagram 重新验证需要本次 TikHub 综合搜索的完整调用证据。'
    if (!snapshot) return '这条 Instagram 历史记录未保存请求参数，不能手动重构原请求。'
    if (snapshot.path !== '/api/v1/data/search' || snapshot.method !== 'POST') return 'Instagram 重新验证仅支持保存的 POST /api/v1/data/search；不会转换到其他接口。'
  } else if (data?.scope?.platform !== 'xiaohongshu' || !data?.costLineage?.providerCalls?.some(call => call.requestCall === true
    && call.providerKey === 'tikhub' && call.operation === 'social.posts.search')) return '当前支持有 TikHub 搜索调用证据的小红书 data/search、raw 与 App V2 搜索；此链路暂不支持参数重发。'
  if (!snapshot) return savedOnly ? '这条历史记录未保存请求参数，无法自动构造原请求。可在数据中心的采集查询复现中校验手动参数。' : null
  if (!ACQUISITION_COMPARISON_PATHS.includes(snapshot.path) || !(snapshot.method === 'POST' || snapshot.method === 'GET' && snapshot.path === XHS_NATIVE_SEARCH_PATH)) return '保存的请求路径或方法暂不支持重新验证；不会转换到其他接口。'
  if (snapshot.bodyOmitted || !object(snapshot.body) || incomplete(snapshot.body)) return '保存的请求参数不完整或已脱敏，无法按原参数重新验证。'
  return null
}

export function canCompareAcquisition(data) {
  return !comparisonUnavailableReason(data)
}

export function createAcquisitionComparison(data, bodyText, idempotencyKey, { verifiedBody = null, savedOnly = false } = {}) {
  const unavailable = comparisonUnavailableReason(data, { savedOnly })
  if (unavailable) throw new Error(unavailable)
  const path = data.requestEvidence?.request?.path || ACQUISITION_COMPARISON_PATH
  const method = data.requestEvidence?.request?.method || 'POST'
  const instagram = data.scope?.platform === 'instagram'
  const nativeSearch = path === XHS_NATIVE_SEARCH_PATH
  let body
  try { body = JSON.parse(bodyText) } catch { throw new Error('请输入有效的原请求 JSON。') }
  if (instagram) {
    // Saved data-search parameters only. Never reconstruct a historical request
    // or switch to raw/native routes, whose authorization and billing differ.
    const fields = new Set(['platform', 'query', 'pageSize', 'cursor', 'type'])
    const pageSize = body?.pageSize ?? 20
    if (!object(body) || Object.keys(body).some(key => !fields.has(key)) || incomplete(body)
      || !['instagram', 'ig', 'ins', 'insta'].includes(String(body.platform).trim().toLowerCase())
      || typeof body.query !== 'string' || !body.query.trim() || body.query.trim().length > 500
      || !Number.isInteger(pageSize) || pageSize < 20 || pageSize > 100
      || (body.type != null && !['fresh', 'stable'].includes(body.type))
      || (body.cursor != null && (typeof body.cursor !== 'string' || !body.cursor.startsWith('mxds1.') || body.cursor.length > 8192))) {
      throw new Error('Instagram 重新验证仅支持完整的单关键词 data/search 参数、20–100 条分页与原始 Hub 游标。')
    }
  } else {
    if (!object(body) || (!nativeSearch && !['xiaohongshu', 'xhs', 'red', 'rednote'].includes(String(body.platform).trim().toLowerCase()))) {
      throw new Error('请求必须是 platform=xiaohongshu 的 JSON 对象。')
    }
    // Match the already migrated single-query raw shape; do not accidentally route
    // an edited comparison to the historical Night-All fan-out implementation.
    const dataSearch = path === '/api/v1/data/search'
    const fields = new Set(nativeSearch ? ['keyword', 'page', 'sort_type', 'note_type', 'time_filter', 'search_id', 'search_session_id', 'source', 'ai_mode'] : dataSearch ? ['platform', 'query', 'pageSize', 'cursor', 'type'] : ['platform', 'keyword', 'query', 'count', 'limit', 'pageSize', 'page', 'cursor', 'includeDetails', 'disableAutoDetails', 'maxEnrichItems', 'includeRaw', 'businessId', 'business_id'])
    if (Object.keys(body).some(key => !fields.has(key)) || incomplete(body)) throw new Error('对比仅支持完整的单关键词小红书搜索参数，请核对保存的参数。')
    const queries = [body.keyword, body.query].filter(value => typeof value === 'string' && value.trim())
    if (queries.length !== 1 || queries[0].trim().length > 500) throw new Error('请填写一个 keyword 或 query（最多 500 字）。')
    if (!nativeSearch && ([body.count, body.limit, body.pageSize].some(value => value != null && Number(value) !== 20)
      || (body.page != null && (Number(body.page) !== 1 || body.cursor)))) {
      throw new Error('当前兼容对比支持每页 20 条、首屏 page=1 或原始 Hub cursor；不会猜测后续页游标。')
    }
    const nativePage = body.page == null || body.page === '' ? 1 : Number(body.page)
    if (nativeSearch && (Object.values(body).some(value => value != null && !['string', 'number'].includes(typeof value)) || !Number.isInteger(nativePage) || nativePage < 1 || nativePage > 15)) throw new Error('原生搜索需要有效的标量参数与 1–15 页码；不会猜测分页参数。')
    if (body.cursor != null && (typeof body.cursor !== 'string' || !body.cursor.startsWith('mxec2.'))) throw new Error('只支持原始 Hub 小红书游标，不能重发历史 Night-All 游标。')
  }
  if ((savedOnly || instagram) && JSON.stringify(body) !== JSON.stringify(data.requestEvidence.request.body)) throw new Error('重新验证必须使用保存的原参数。')
  if (!idempotencyKey || idempotencyKey === data.requestEvidence?.idempotencyKey) throw new Error('新请求必须使用独立的幂等键。')
  return {
    idempotencyKey, originalRequestId: data.requestId, keyId: data.owner.apiKeyId,
    body, path, method,
    // 'verified' means the pasted body reproduced the historical request
    // fingerprint exactly; 'manual' stays an unproven reconstruction.
    parameterSource: data.requestEvidence?.request && JSON.stringify(body) === JSON.stringify(data.requestEvidence.request.body)
      ? 'saved'
      : verifiedBody && JSON.stringify(body) === verifiedBody
        ? 'verified'
        : 'manual',
  }
}

export function comparisonOutcome(delivered) {
  const code = delivered?.body?.error?.code
  return ['request_in_progress', 'request_outcome_unknown', 'upstream_outcome_unknown', 'external_platform_outcome_unknown', 'external_platform_call_persistence_unknown', 'internal_error'].includes(code)
    || !delivered?.body ? 'uncertain' : 'received'
}

const HUB_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function instagramComparisonOutcome(delivered, { committedHistory = false } = {}) {
  if (comparisonOutcome(delivered) === 'uncertain') return 'uncertain'
  const { status, body, evidence } = delivered
  if (!object(body) || !HUB_REQUEST_ID.test(evidence?.requestId || '')
    || body.requestId !== evidence.requestId) return 'uncertain'
  if (status >= 500 && !committedHistory
    && !['external_platform_rejected', 'external_platform_response_unusable'].includes(body.error?.code)) return 'uncertain'
  if (status >= 400 && status <= 599) return object(body.error)
    && typeof body.error.code === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(body.error.code)
    && typeof body.error.message === 'string' && body.error.message.trim() ? 'received' : 'uncertain'
  const data = body.data
  const page = data?.pageInfo
  return status >= 200 && status < 300 && object(data)
    && data.contractVersion === 'night-all.data-search.v1' && data.platform === 'instagram'
    && typeof data.query === 'string' && data.query.trim() && Array.isArray(data.items) && data.items.every(object)
    && object(page) && Number.isInteger(page.pageIndex) && page.pageIndex >= 1
    && Number.isInteger(page.pageSize) && page.pageSize >= 20 && page.pageSize <= 100
    && page.returnedCount === data.items.length && typeof page.hasMore === 'boolean'
    && (page.nextCursor === null || typeof page.nextCursor === 'string') && ['opaque', 'none'].includes(page.cursorType)
    && ['ok', 'partial'].includes(data.status) && Array.isArray(data.warnings) && object(data.meta)
    ? 'received' : 'uncertain'
}

export function comparisonResultMessage(attempt) {
  const delivered = attempt.delivered
  if (!delivered) return ''
  const savedStatus = attempt.history?.delivered?.responseStatus
  if (Number.isInteger(savedStatus) && savedStatus !== delivered.status) return `浏览器收到 HTTP ${delivered.status}，账本记录的最终交付为 HTTP ${savedStatus}；请查看新请求诊断中的最终响应与费用。`
  const source = attempt.history?.delivered?.sourceMode || delivered.evidence?.sourceMode
  if (delivered.evidence?.idempotentReplay || ['fresh_cache', 'stored_fallback', 'idempotent_replay'].includes(source)) return '本次包含缓存、存量或幂等回放交付，不能据此确认上游恢复；请查看调用证据。'
  if (delivered.status >= 400) return '本次新请求仍未成功，请查看新的诊断与错误响应。'
  if (source === 'live' && delivered.status >= 200 && delivered.status < 300) return '本次实时请求成功；不代表所有后续请求均已恢复。'
  return '是否实际调用上游请结合新请求的诊断证据判断。'
}

// In-memory only. A session outlives the diagnostics tab so an unknown outcome
// cannot become a fresh paid request merely because the operator navigated away.
export function createAcquisitionComparisonSession(original = null) {
  let snapshot = { original, bodyText: original?.requestEvidence?.request?.body ? JSON.stringify(original.requestEvidence.request.body, null, 2) : '', attempts: [], error: null, busy: false, verifying: false, verified: null, loading: false }
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    update(patch) {
      snapshot = { ...snapshot, ...(typeof patch === 'function' ? patch(snapshot) : patch) }
      listeners.forEach(listener => listener())
    },
  }
}

export function acquisitionComparisonSessionFor(reference, token, requestId) {
  if (reference.current?.token !== token) reference.current = { token, requests: new Map() }
  if (!reference.current.requests.has(requestId)) reference.current.requests.set(requestId, createAcquisitionComparisonSession())
  return reference.current.requests.get(requestId)
}

export async function sendAcquisitionComparison(session, { token, original, retry = null, savedOnly = false, onBusyChange, newIdempotencyKey = () => `compare-${crypto.randomUUID()}` }, { adminApi, publicDataApi }) {
  const current = session.getSnapshot()
  const instagram = original.scope?.platform === 'instagram'
  if (current.busy || current.verifying || current.attempts.some(attempt => ['sending', 'uncertain'].includes(attempt.state) && attempt.idempotencyKey !== retry?.idempotencyKey)) return
  // A fresh data-search request has a finite replay window. Reposting even the
  // same key can buy a new call after expiry; uncertain Instagram attempts may
  // only be resolved by read-only status/ledger evidence, never another POST.
  if (instagram && retry && (retry.state === 'uncertain'
    || current.attempts.some(attempt => attempt.idempotencyKey === retry.idempotencyKey && attempt.state === 'uncertain'))) {
    session.update({ error: new Error('Instagram 请求结果未知。请保留本次幂等键，只读核查请求状态与账本；不能再次发送业务请求。') })
    return
  }
  let attempt
  try {
    attempt = retry || createAcquisitionComparison(original, current.bodyText, newIdempotencyKey(), { verifiedBody: current.verified?.match ? current.verified.body : null, savedOnly })
  } catch (error) { session.update({ error }); return }
  const patch = values => session.update(state => ({ attempts: state.attempts.map(item => item.idempotencyKey === attempt.idempotencyKey ? { ...item, ...values } : item) }))
  session.update(state => ({ busy: true, error: null, attempts: retry ? state.attempts.map(item => item.idempotencyKey === attempt.idempotencyKey ? { ...item, state: 'sending' } : item) : [...state.attempts, { ...attempt, state: 'sending' }] }))
  onBusyChange?.(true)
  let dispatched = false
  try {
    const identity = await adminApi.demoCredential(token, attempt.keyId)
    if (!identity.secret || identity.keyId !== attempt.keyId) throw new Error('原 API Key 已不可用，无法以原身份重新请求。')
    dispatched = true
    let delivered
    try {
      const result = await publicDataApi.acquisitionComparison(identity.secret, attempt.body, attempt.idempotencyKey, attempt.path, attempt.method)
      delivered = { status: result.status, body: result.payload, evidence: result.evidence }
    } catch (error) {
      if (!error.status) throw error
      delivered = { status: error.status, body: error.responseBody, evidence: error.evidence || { requestId: error.requestId } }
    }
    const outcome = instagram ? instagramComparisonOutcome(delivered) : comparisonOutcome(delivered)
    const uncertainRetry = retry?.state === 'uncertain'
    const responseConfirmsRetry = outcome === 'received' && delivered.evidence?.idempotentReplay === true
    // Authentication/admission errors may describe only this HTTP retry. They
    // cannot settle an earlier paid call whose outcome is still unknown.
    if (uncertainRetry && !responseConfirmsRetry) patch({ state: 'uncertain', retryCheck: delivered, message: '本次同键响应尚未确认原请求的最终结果；继续保留原参数与幂等键。' })
    else patch({ state: outcome, delivered, retryCheck: null, message: null })
    if (delivered.evidence?.requestId && (!instagram || HUB_REQUEST_ID.test(delivered.evidence.requestId))) {
      try {
        const history = await adminApi.acquisitionHistory(token, delivered.evidence.requestId)
        const matchesAttempt = history.requestId === delivered.evidence.requestId
          && history.owner?.apiKeyId === attempt.keyId
          && history.requestEvidence?.idempotencyKey === attempt.idempotencyKey
          && (instagram || history.delivered?.responseStatus === delivered.status)
        // A proxy may return JSON even after Hub committed a different response.
        // Confirm only this exact attempt's persisted terminal receipt. Keep the
        // observed browser response intact beside the read-only history evidence.
        const savedBody = history.delivered?.responseBody
        const confirmedInstagram = instagram && matchesAttempt && history.status === 'committed' && object(savedBody)
          && (savedBody.requestId == null || savedBody.requestId === history.requestId)
          && instagramComparisonOutcome({ status: history.delivered.responseStatus,
            body: { ...savedBody, requestId: history.requestId }, evidence: { requestId: history.requestId } }, { committedHistory: true }) === 'received'
        if (confirmedInstagram || !instagram && matchesAttempt && outcome === 'received') patch({ history, state: 'received', delivered, retryCheck: null, message: null, historyError: null })
        else if (!uncertainRetry || responseConfirmsRetry) patch({ historyError: '交付记录尚不能关联到本次原 Key 与幂等键；费用与调用证据暂不展示。' })
      }
      catch { patch({ historyError: '该请求暂无可读取的持久化交付记录；本次 HTTP 响应仍保留在下方。' }) }
    }
  } catch (error) {
    patch({ state: dispatched || retry?.state === 'uncertain' ? 'uncertain' : 'not_sent', message: error.message })
  } finally {
    session.update({ busy: false })
    onBusyChange?.(false)
  }
}

export const PARAMETER_SOURCE_LABELS = {
  saved: '保存的原参数',
  verified: '已校验与原请求一致',
  manual: '手动参数',
}
