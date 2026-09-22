import { AppError } from '../core/errors.mjs'
import { projectNightAllFailureEvidence } from '../data/night-all-failure-evidence.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LIMIT = 20
const CALL_LIMIT = 50
const MESSAGES = new Set(['未授权调用该接口', '未添加IP白名单'])
const text = value => typeof value === 'string' && /^[\w.:/-]{1,191}$/.test(value) ? value : null

export function diagnosticIdentifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/.test(value.trim())) {
    throw new AppError(400, 'invalid_diagnostic_identifier', '请输入完整的请求 ID（最多 191 个字母、数字、点、冒号、下划线或连字符）')
  }
  return value.trim()
}

function advice(request, providers, connectors) {
  const qixin = providers.find(p => p.provider_key === 'qixin' && p.outcome === 'rejected')
  if (qixin?.business_code === 105) return '启信宝拒绝接口授权。核对当次 AppKey 所属应用的接口开通与授权有效期；不能据此判断未开通、过期或应用不匹配。'
  if (qixin?.business_code === 104) return '启信宝返回白名单拒绝。核对该应用访问供应商时的实际出口 IP。'
  if (request.status === 'unknown' || providers.some(p => p.outcome === 'unknown')) return '存在未知调用结果。保留原请求身份，先核对上游记录与结算，不自动重发。'
  if (connectors.some(c => c.failure_evidence)) return '已保留 Night-All 结构化错误链。查看候选端点和内层错误码；缺失的字段不推测，多个端点失败不等同于已确认唯一根因。'
  if (connectors.some(c => c.error_code)) return '已保存连接器错误码和上游关联 ID；完整上游错误正文未接入本诊断，请按该 ID 和调用时间核对上游日志。'
  if (request.status === 'committed') return 'Hub 已提交响应。上游失败可能已由存量结果回退；请结合交付来源和响应 HTTP 状态判断。下游入库校验结果不在本诊断范围。'
  return '请结合 Hub 状态、上游业务码和调用时间继续排查；缺少调用记录不能单独证明上游未执行。'
}

// Explicit projection, independent of successful-delivery replay. This module
// never returns raw/request bodies, headers, credentials, or arbitrary provider
// text. Reviewed Qixin messages are selected inside SQL before crossing the
// restricted archive boundary; other messages remain unavailable, not guessed.
export async function lookupRequestDiagnostics(pool, input) {
  const identifier = diagnosticIdentifier(input)
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '3s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    const matches = await client.query(`/* request-diagnostics:lookup */
      WITH direct AS (SELECT id FROM public.usage_requests WHERE id = $2::uuid)
      SELECT id FROM (
        (SELECT id FROM direct)
        UNION
        (SELECT DISTINCT usage_request_id AS id FROM external_platform.provider_calls
          WHERE upstream_request_id = $1 AND usage_request_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM direct)
          ORDER BY usage_request_id LIMIT 21)
        UNION
        (SELECT DISTINCT usage_request_id AS id FROM serving.connector_calls
          WHERE upstream_request_id = $1 AND usage_request_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM direct)
          ORDER BY usage_request_id LIMIT 21)
      ) matches ORDER BY id LIMIT 21`, [identifier, UUID.test(identifier) ? identifier : null])
    const runs = []
    for (const { id } of matches.rows.slice(0, LIMIT)) {
      const { rows: [request] } = await client.query(`/* request-diagnostics:usage */
        SELECT id, platform, status, error_code, response_status, delivery_source_mode,
          response_body IS NOT NULL AS has_response_body,
          units_reserved, units_actual, reserved_at, completed_at
        FROM public.usage_requests WHERE id = $1`, [id])
      if (!request) continue
      const providers = (await client.query(`/* request-diagnostics:providers */
        SELECT p.id, p.provider_key, p.operation, p.endpoint_key, p.outcome,
          p.http_status, p.business_code, p.error_code, p.upstream_request_id,
          p.billed, p.cost_minor::text, p.cost_kind, p.currency, p.latency_ms,
          p.started_at, p.completed_at, a.id IS NOT NULL AS has_archive,
          a.content_type, a.body_size,
          r.id IS NOT NULL AS has_restricted_archive,
          CASE WHEN p.provider_key = 'qixin' AND p.outcome = 'rejected'
            AND r.parsed_payload->>'message' IN ('未授权调用该接口', '未添加IP白名单')
            THEN r.parsed_payload->>'message' ELSE NULL END AS reviewed_message
        FROM external_platform.provider_calls p
        LEFT JOIN external_platform.response_archives a ON a.provider_call_id = p.id
        LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id = p.id
        WHERE p.usage_request_id = $1 ORDER BY p.started_at, p.id LIMIT 51`, [id])).rows
      const connectors = (await client.query(`/* request-diagnostics:connectors */
        SELECT id, operation, platform, outcome, http_status, failure_kind,
          error_code, upstream_request_id, upstream_trace_id, upstream_latency_ms,
          started_at, completed_at, to_jsonb(c)->'failure_evidence' AS failure_evidence
        FROM serving.connector_calls c WHERE usage_request_id = $1
        ORDER BY started_at, id LIMIT 51`, [id])).rows
      const charges = (await client.query(`/* request-diagnostics:charges */
        SELECT status, enforcement_mode, quoted_minor::text, charged_minor::text,
          currency, created_at, settled_at
        FROM billing.customer_charges WHERE usage_request_id = $1 LIMIT 1`, [id])).rows
      const providerCalls = providers.slice(0, CALL_LIMIT).map(p => ({
        id: p.id, provider: text(p.provider_key), operation: text(p.operation), endpoint: text(p.endpoint_key),
        outcome: text(p.outcome), httpStatus: p.http_status, businessCode: p.business_code,
        errorCode: text(p.error_code), upstreamRequestId: text(p.upstream_request_id),
        message: MESSAGES.has(p.reviewed_message) ? p.reviewed_message : null,
        messageEvidence: MESSAGES.has(p.reviewed_message) ? 'reviewed_archive_message'
          : p.has_restricted_archive ? 'restricted_message_not_exposed' : 'not_recorded',
        hasArchive: p.has_archive, hasRestrictedArchive: p.has_restricted_archive,
        bodySize: p.body_size, billed: p.billed, costMinor: p.cost_minor,
        costKind: text(p.cost_kind), currency: text(p.currency), latencyMs: p.latency_ms,
        startedAt: p.started_at, completedAt: p.completed_at,
      }))
      runs.push({
        requestId: request.id, platform: text(request.platform), status: text(request.status),
        errorCode: text(request.error_code), responseStatus: request.response_status,
        sourceMode: text(request.delivery_source_mode), hasResponseBody: request.has_response_body,
        replayAvailable: request.status === 'committed' && request.has_response_body,
        unitsReserved: request.units_reserved, unitsActual: request.units_actual,
        reservedAt: request.reserved_at, completedAt: request.completed_at,
        providerCalls,
        connectorCalls: connectors.slice(0, CALL_LIMIT).map(c => ({
          id: c.id, operation: text(c.operation), platform: text(c.platform), outcome: text(c.outcome),
          httpStatus: c.http_status, failureKind: text(c.failure_kind), errorCode: text(c.error_code),
          upstreamRequestId: text(c.upstream_request_id), upstreamTraceId: text(c.upstream_trace_id),
          latencyMs: c.upstream_latency_ms, startedAt: c.started_at, completedAt: c.completed_at,
          failureEvidence: projectNightAllFailureEvidence(c.failure_evidence),
        })),
        callsTruncated: providers.length > CALL_LIMIT || connectors.length > CALL_LIMIT,
        customerCharge: charges[0] ? {
          status: text(charges[0].status), enforcementMode: text(charges[0].enforcement_mode),
          quotedMinor: charges[0].quoted_minor, chargedMinor: charges[0].charged_minor,
          currency: text(charges[0].currency), settledAt: charges[0].settled_at,
        } : null,
        guidance: advice(request, providers, connectors),
      })
    }
    await client.query('COMMIT')
    return { identifier, runs, truncated: matches.rows.length > LIMIT,
      checkedAt: new Date().toISOString() }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error.code === '57014') throw new AppError(503, 'request_diagnostics_timeout', '诊断查询超时，请核对请求 ID 并确认已准备上游 ID 查询索引')
    if (['42P01', '42703', '42501'].includes(error.code)) throw new AppError(503, 'request_diagnostics_unavailable', '诊断证据暂不可读，请由运维核对数据库版本和读取权限')
    throw error
  } finally {
    client.release()
  }
}
