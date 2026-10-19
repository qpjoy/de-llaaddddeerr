import { AppError } from '../core/errors.mjs'
import { normalizeHubDataSearch } from '../contracts/hub-data-search.mjs'
import { createDataSearchCursorCodec } from '../external-platforms/cursor.mjs'
import { twitterV2RetryPreparation } from '../data/twitter-v2-retry.mjs'
import {
  normalizedTwitterRetryBody, validateTwitterManualRetry, twitterManualRetryOwnerFor,
} from '../external-platforms/twitter-manual-retry.mjs'

// Called in the history store's READ ONLY snapshot. No status reaper, credential
// retrieval, reservation, retry claim or provider call belongs in preparation.
export async function prepareTwitterRetry(client, requestId, { apiKeyPepper = null } = {}) {
  try {
    await client.query("SET LOCAL statement_timeout = '3s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    const { rows: [root] } = await client.query(`/* twitter-retry:root */
      SELECT u.id,u.tenant_id,u.consumer_id,u.api_key_id,u.platform,u.status,
        u.idempotency_key,u.fingerprint,u.acquisition_request,
        k.key_prefix AS api_key_prefix,k.last_four AS api_key_last_four
      FROM public.usage_requests u LEFT JOIN public.api_keys k ON k.id=u.api_key_id
      WHERE u.id=$1`, [requestId])
    if (!root) throw new AppError(404, 'acquisition_query_run_not_found', '未找到原请求')
    const result = {
      requestId: root.id, status: root.status, scope: { platform: root.platform },
      owner: { tenantId: root.tenant_id, consumerId: root.consumer_id, apiKeyId: root.api_key_id,
        apiKeyPrefix: root.api_key_prefix, apiKeyLastFour: root.api_key_last_four },
      requestEvidence: { idempotencyKey: root.idempotency_key, request: null },
      eligibility: { allowed: false, reasonCode: 'uncertain_retry_not_allowed',
        message: '仅支持保留完整原参数及当前 Twitter 标准搜索调用证据的未知结果请求。' },
      successor: null,
      retryIntent: null,
    }
    if (root.platform !== 'twitter') return result
    let normalized
    try {
      const protocol = await twitterV2RetryPreparation(client, root, { apiKeyPepper })
      normalized = normalizedTwitterRetryBody(root.acquisition_request)
      result.requestEvidence.request = protocol
        ? { method: 'POST', path: '/api/v2/data/search', body: protocol.body }
        : root.acquisition_request
      if (protocol) {
        result.requestEvidence.contractVersion = 'mx-insight-hub.data-search.v2'
        result.retryIntent = protocol.retryIntent
      }
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error
      result.eligibility.reasonCode = 'twitter_retry_evidence_unavailable'
      result.eligibility.message = '未保留可验证的 Twitter 标准搜索原参数或完整 v2 绑定，不能从此记录重试。'
      return result
    }
    const store = { pool: client, providerKey: 'rapidapi' }
    const successorId = await twitterManualRetryOwnerFor(store, root.id, client)
    if (successorId) {
      const { rows: [successor] } = await client.query(`/* twitter-retry:successor */
        SELECT id,status,idempotency_key,api_key_id,response_status
        FROM public.usage_requests WHERE id=$1 AND tenant_id=$2 AND consumer_id=$3
          AND api_key_id=$4 AND fingerprint=$5 AND platform='twitter'
          AND acquisition_request->>'path'='/api/v1/data/search'`,
      [successorId, root.tenant_id, root.consumer_id, root.api_key_id, root.fingerprint])
      if (successor) result.successor = { requestId: successor.id, status: successor.status,
        idempotencyKey: successor.idempotency_key, apiKeyId: successor.api_key_id,
        responseStatus: successor.response_status }
      result.eligibility = { allowed: false, reasonCode: 'twitter_retry_already_claimed',
        message: '此原请求已有后续重试，请查看后续请求及结算；这里不会再发起另一笔请求。' }
      return result
    }
    if (result.retryIntent) {
      result.eligibility = { allowed: false, reasonCode: 'twitter_retry_already_claimed',
        message: '此原请求已登记 v2 重试意图，请保留后续幂等键并只读核对；不会再创建另一笔请求。' }
      return result
    }
    try {
      let bufferCallId
      if (normalized.cursor) {
        if (!apiKeyPepper) throw new AppError(409, 'invalid_cursor', '无法验证原请求游标')
        const { type, ...body } = normalized
        const codec = createDataSearchCursorCodec(apiKeyPepper, `${root.consumer_id}:${root.api_key_id}`)
        bufferCallId = normalizeHubDataSearch(body, codec, type).buffer?.callId
      }
      await validateTwitterManualRetry(store, { retryOfRequestId: root.id,
        tenantId: root.tenant_id, consumerId: root.consumer_id, apiKeyId: root.api_key_id,
        fingerprint: root.fingerprint, bufferCallId }, client)
      result.eligibility = { allowed: true, reasonCode: null,
        message: '可以人工确认后按原参数重试。原请求及账单保留；重试可能再次计费，发送时仍检查当前权限和运行限制。' }
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error
      result.eligibility.reasonCode = error.code
      if (error.code === 'invalid_cursor') result.eligibility.message = '原分页游标已过期、失效或无法验证，不能按此游标重试。'
    }
    return result
  } catch (error) {
    if (['42P01', '42703'].includes(error.code)) {
      throw new AppError(503, 'twitter_retry_schema_unavailable', 'Twitter 重试所需数据库迁移尚未就绪，请先完成 Hub 数据库迁移')
    }
    if (['57014', '55P03'].includes(error.code)) {
      throw new AppError(503, 'twitter_retry_lookup_busy', '重试证据查询暂时繁忙，请稍后只读核对')
    }
    throw error
  }
}
