const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const PATH = '/api/v1/data/search'
const V2_PATH = '/api/v2/data/search'
const V2_CONTRACT = 'mx-insight-hub.data-search.v2'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const incomplete = value => value === '[redacted]' || (object(value) || Array.isArray(value)) && Object.values(value).some(incomplete)
export const EMPTY_TWITTER_RETRY = Object.freeze({ preparation: null, attempt: null, busy: false, preparing: false, checking: false, error: null })
const stateOf = session => session.getSnapshot().twitterRetry || EMPTY_TWITTER_RETRY
const update = (session, values) => session.update(state => ({ twitterRetry: { ...(state.twitterRetry || EMPTY_TWITTER_RETRY), ...values } }))
const updateAttempt = (session, values) => update(session, { attempt: { ...stateOf(session).attempt, ...values } })
const isV2 = value => value?.requestEvidence?.request?.path === V2_PATH
function v2BodyValid(body) {
  const window = body.timeWindow
  if (Object.keys(body).some(key => !['platform', 'query', 'pageSize', 'type', 'cursor', 'timeWindow'].includes(key))
    || body.platform !== 'twitter' || !Number.isInteger(body.pageSize) || body.pageSize < 1 || body.pageSize > 100
    || !['fresh', 'stable'].includes(body.type) || body.query.length > 500 || !object(window)
    || Object.keys(window).some(key => !['from', 'to', 'timezone', 'boundary'].includes(key))
    || window.boundary !== '[from,to)' || typeof window.timezone !== 'string'
    || !Number.isFinite(Date.parse(window.from)) || !Number.isFinite(Date.parse(window.to))
    || Date.parse(window.from) >= Date.parse(window.to)
    || body.cursor != null && (typeof body.cursor !== 'string' || !body.cursor.startsWith('mxds2.') || body.cursor.length > 16384)) return false
  try { new Intl.DateTimeFormat('en', { timeZone: window.timezone }).format() } catch { return false }
  return true
}

export function twitterRetryPreparationValid(value, requestId) {
  if (!object(value) || !UUID.test(requestId) || value.requestId !== requestId
    || !['reserved', 'unknown', 'committed', 'released'].includes(value.status)
    || typeof value.eligibility?.allowed !== 'boolean') return false
  // A denied preparation may deliberately omit an unusable saved body or
  // historical Key identity. Show its reason; it cannot authorize dispatch.
  if (value.eligibility.allowed === false) return true
  const request = value?.requestEvidence?.request
  return value.status === 'unknown'
    && value.scope?.platform === 'twitter' && UUID.test(value.owner?.apiKeyId || '')
    && request?.method === 'POST' && [PATH, V2_PATH].includes(request.path) && object(request.body) && !request.bodyOmitted
    && !incomplete(request.body) && ['twitter', 'x'].includes(String(request.body.platform).trim().toLowerCase())
    && typeof request.body.query === 'string' && request.body.query.trim().length > 0
    && (request.path === PATH ? value.requestEvidence.contractVersion !== V2_CONTRACT
      : value.requestEvidence.contractVersion === V2_CONTRACT && v2BodyValid(request.body))
    && typeof value.requestEvidence.idempotencyKey === 'string'
    && typeof value.eligibility?.allowed === 'boolean'
}

function samePreparation(left, right) {
  return right.requestId === left.requestId && right.owner?.apiKeyId === left.owner?.apiKeyId
    && right.requestEvidence?.idempotencyKey === left.requestEvidence?.idempotencyKey
    && right.requestEvidence?.contractVersion === left.requestEvidence?.contractVersion
    && JSON.stringify(right.requestEvidence?.request) === JSON.stringify(left.requestEvidence?.request)
}

function retryIntentFor(preparation, attempt) {
  const intent = preparation?.retryIntent
  if (!isV2(preparation) || !object(intent) || intent.apiKeyId !== preparation.owner?.apiKeyId
    || !['registered', 'running', 'retryable', 'unknown', 'failed', 'complete'].includes(intent.state)
    || typeof intent.idempotencyKey !== 'string' || !intent.idempotencyKey
    || intent.idempotencyKey === preparation.requestEvidence?.idempotencyKey
    || intent.requestId != null && (!UUID.test(intent.requestId) || intent.requestId === preparation.requestId)
    || preparation.successor && intent.requestId !== preparation.successor.requestId
    || attempt && (intent.idempotencyKey !== attempt.idempotencyKey || intent.apiKeyId !== attempt.keyId)) return null
  return intent
}

export function twitterRetryResumeAllowed(preparation, requestId, attempt = null) {
  const intent = retryIntentFor(preparation, attempt)
  return Boolean(isV2(preparation) && twitterRetryPreparationValid({ ...preparation,
    eligibility: { ...preparation?.eligibility, allowed: true } }, requestId)
    && intent?.resumeAllowed === true && intent.state === 'retryable'
    && (intent.requestId == null ? intent.usageStatus === null : intent.usageStatus === 'released')
    && (!preparation.successor || preparation.successor.status === 'released'))
}

function successorFor(preparation, attempt) {
  const successor = preparation.successor
  if (!object(successor) || !UUID.test(successor.requestId || '') || successor.requestId === preparation.requestId
    || !['reserved', 'unknown', 'committed', 'released'].includes(successor.status)
    || !UUID.test(preparation.owner?.apiKeyId || '') || successor.apiKeyId !== preparation.owner.apiKeyId || typeof successor.idempotencyKey !== 'string'
    || successor.idempotencyKey === preparation.requestEvidence?.idempotencyKey
    || attempt && (successor.idempotencyKey !== attempt.idempotencyKey || successor.apiKeyId !== attempt.keyId)) return null
  return successor
}

function applyPreparation(session, preparation) {
  const attempt = stateOf(session).attempt
  update(session, { preparation })
  const successor = successorFor(preparation, attempt)
  const intent = retryIntentFor(preparation, attempt)
  if (successor && attempt) {
    const state = isV2(preparation) && intent?.state !== 'complete' && successor.status === 'committed' ? 'uncertain' : successor.status
    updateAttempt(session, { state, requestId: successor.requestId, ledger: successor,
      ...(isV2(preparation) ? { protocolState: intent?.state || 'unconfirmed' } : {}),
      responseMismatch: Boolean(attempt.response && (attempt.responseRequestId !== successor.requestId
        || successor.responseStatus != null && attempt.response.status !== successor.responseStatus)),
      message: isV2(preparation) && successor.status === 'committed'
        ? intent?.state === 'complete' ? '已只读确认 v2 完成交付及底层请求提交；请结合 HTTP 状态判断结果。'
          : '底层请求已提交，但 v2 交付尚未确认完成；请保留本次幂等键继续只读核对。'
        : successor.status === 'committed' ? '已只读确认新请求提交；请结合 HTTP 状态判断成功或失败。'
        : successor.status === 'released' ? '新请求预留已释放；本面板保留此次尝试，不再发送。'
          : successor.status === 'reserved' ? '新请求仍在处理中，请稍后只读核对。' : '新请求结果仍未知，请保留本次幂等键，只读核对。' })
  }
  if (intent && attempt && !successor) {
    const resumable = twitterRetryResumeAllowed(preparation, preparation.requestId, attempt)
    updateAttempt(session, { state: resumable ? 'retryable' : 'uncertain', protocolState: intent.state,
      requestId: intent.requestId || null,
      message: resumable ? '已只读确认本次重试尚未采集；可人工继续同一幂等键，不创建新的重试。'
        : '已登记本次 v2 重试意图；尚未确认底层请求及交付结果，本面板不会再次发送。' })
  }
  return successor || intent
}

export async function prepareTwitterRetry(session, { token, requestId }, { adminApi }) {
  if (stateOf(session).busy || stateOf(session).preparing || stateOf(session).checking) return
  update(session, { preparing: true, error: null })
  try {
    const preparation = await adminApi.twitterRetryPreparation(token, requestId)
    if (!twitterRetryPreparationValid(preparation, requestId)) throw new Error('原请求参数或身份不完整，不能准备 Twitter 重试。')
    applyPreparation(session, preparation)
  } catch (error) { update(session, { error }) }
  finally { update(session, { preparing: false }) }
}

export async function checkTwitterRetry(session, { token, requestId }, { adminApi }) {
  const current = stateOf(session)
  if (current.busy || current.preparing || current.checking) return
  update(session, { checking: true, error: null })
  try {
    const preparation = await adminApi.twitterRetryPreparation(token, requestId)
    if (!twitterRetryPreparationValid(preparation, requestId)) throw new Error('只读核对未能匹配原请求身份与参数。')
    if (current.preparation && (current.attempt || current.preparation.eligibility.allowed)
      && !samePreparation(current.preparation, preparation)) {
      if (preparation.eligibility.allowed === false) update(session, { preparation })
      throw new Error(preparation.eligibility.allowed === false
        ? preparation.eligibility.message || '原请求目前不符合重试条件；已保留本次尝试，请核对账本。'
        : '只读核对未能匹配原请求身份与参数。')
    }
    const successor = applyPreparation(session, preparation)
    if (current.attempt?.dispatched && !successor) updateAttempt(session, { state: 'uncertain',
      message: '尚未查到与本次幂等键匹配的重试记录；这不证明请求未发送，本面板不会再次 POST。' })
  } catch (error) { update(session, { error }) }
  finally { update(session, { checking: false }) }
}

export function twitterRetryResponseIdentity(response) {
  const bodyId = response?.body?.requestId
  const evidenceId = response?.evidence?.requestId
  const headerId = response?.evidence?.headerRequestId
  return UUID.test(bodyId || '') && UUID.test(evidenceId || '') && bodyId === evidenceId
    && (headerId == null || headerId === bodyId) ? bodyId : null
}

export async function resumeTwitterRetry(session, options, dependencies) {
  return sendTwitterRetry(session, { ...options, resumeRegisteredIntent: true }, dependencies)
}

export async function sendTwitterRetry(session, { token, requestId, newIdempotencyKey = () => `twitter-retry-${crypto.randomUUID()}`,
  resumeRegisteredIntent = false }, { adminApi, publicDataApi }) {
  const current = stateOf(session), original = current.preparation
  if (current.busy || current.preparing || current.checking || current.attempt?.dispatched && !resumeRegisteredIntent) return
  if (resumeRegisteredIntent ? !twitterRetryResumeAllowed(original, requestId, current.attempt)
    : !twitterRetryPreparationValid(original, requestId) || original.eligibility.allowed !== true || original.successor || original.retryIntent) {
    update(session, { error: new Error('请先只读准备并核对符合条件的原 Twitter 请求。') }); return
  }
  const idempotencyKey = resumeRegisteredIntent ? original.retryIntent.idempotencyKey : current.attempt?.idempotencyKey || newIdempotencyKey()
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 191
    || idempotencyKey === original.requestEvidence.idempotencyKey) {
    update(session, { error: new Error('重试必须使用不同于原请求的新幂等键。') }); return
  }
  const attempt = current.attempt || { originalRequestId: requestId, keyId: original.owner.apiKeyId,
    idempotencyKey, body: structuredClone(original.requestEvidence.request.body), path: original.requestEvidence.request.path,
    contractVersion: original.requestEvidence.contractVersion, dispatched: false }
  if (attempt.originalRequestId !== requestId || attempt.keyId !== original.owner.apiKeyId || attempt.path !== original.requestEvidence.request.path
    || attempt.idempotencyKey !== idempotencyKey
    || attempt.contractVersion !== original.requestEvidence.contractVersion
    || JSON.stringify(attempt.body) !== JSON.stringify(original.requestEvidence.request.body)) {
    update(session, { error: new Error('已保留的重试参数与原请求不一致，本次未发送。') }); return
  }
  update(session, { busy: true, error: null, attempt: { ...attempt, state: 'sending', message: null } })
  try {
    // Re-read the source identity before obtaining its short-lived credential.
    const latest = await adminApi.twitterRetryPreparation(token, requestId)
    if (!twitterRetryPreparationValid(latest, requestId)) {
      throw new Error('原请求身份或参数已变化，请重新只读核对；本次未发送。')
    }
    if (resumeRegisteredIntent ? !twitterRetryResumeAllowed(latest, requestId, attempt) : latest.eligibility.allowed !== true) {
      applyPreparation(session, latest)
      throw new Error(latest.eligibility.message || '原请求已不满足重试条件或已有后续请求；本次未发送。')
    }
    if (!samePreparation(original, latest)) throw new Error('原请求身份或参数已变化，请重新只读核对；本次未发送。')
    if (resumeRegisteredIntent && latest.retryIntent.idempotencyKey !== attempt.idempotencyKey) throw new Error('已登记的重试幂等键已变化；本次未发送。')
    applyPreparation(session, latest)
    if (!resumeRegisteredIntent && (latest.eligibility.allowed !== true || latest.successor || latest.retryIntent)) throw new Error('原请求已不满足重试条件或已有后续请求；本次未发送。')
    const identity = await adminApi.demoCredential(token, attempt.keyId)
    if (identity?.keyId !== attempt.keyId || typeof identity.secret !== 'string' || !identity.secret) {
      throw new Error('原 API Key 已不可用，无法以原身份重试；本次未发送。')
    }
    // Persist before POST: navigation or an uncertain response cannot authorize
    // another POST. Explicit same-key resume needs verified unstarted evidence.
    updateAttempt(session, { dispatched: true, state: 'sending' })
    let response
    try {
      const result = await publicDataApi.twitterRetry(identity.secret, attempt.body, attempt.idempotencyKey, requestId,
        ...(attempt.path === V2_PATH ? [V2_PATH] : []))
      response = { status: result.status, body: result.payload, evidence: result.evidence }
    } catch (error) {
      if (!error.status) throw new Error('网络响应中断，重试结果尚未确认。请只读核对，不要重复发送。')
      response = { status: error.status, body: error.responseBody, evidence: error.evidence || { requestId: error.requestId } }
    }
    const responseRequestId = twitterRetryResponseIdentity(response)
    updateAttempt(session, { state: 'uncertain', response, responseRequestId,
      message: responseRequestId ? '已收到 HTTP 响应，正在只读核对本次重试账本。' : 'HTTP 响应未提供一致的请求 ID；仅依据只读账本核对新请求。' })
    const receipt = await adminApi.twitterRetryPreparation(token, requestId)
    if (!twitterRetryPreparationValid(receipt, requestId) || !samePreparation(original, receipt)) throw new Error('只读核对未能匹配原请求身份与参数。')
    if (!applyPreparation(session, receipt)) updateAttempt(session, { state: 'uncertain',
      message: '尚未查到与本次幂等键匹配的后续记录。已保留 HTTP 响应，本面板不会再次发送。' })
  } catch (error) {
    updateAttempt(session, { state: stateOf(session).attempt?.dispatched ? 'uncertain' : 'not_sent', message: error.message })
  } finally { update(session, { busy: false }) }
}
