#!/usr/bin/env bash
# Read one existing user-info call on the Hub Kubernetes host. No acquisition,
# retry, settlement, migration or service restart. Do not enable shell tracing.
set -euo pipefail
request_id="${1:-4359ba99-ab95-4924-b26b-7611e5ad6572}"
if [[ $# -gt 1 || ! "$request_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo 'Usage: bash diagnose-xiaohongshu-user-info.sh [Hub-request-UUID]' >&2
  exit 1
fi
kubectl -n "${HUB_NAMESPACE:-mx-insight-hub}" exec -i \
  "${HUB_TARGET:-deployment/mx-insight-hub-public}" \
  -c "${HUB_CONTAINER:-api}" -- node --input-type=module - "$request_id" <<'NODE'
import pg from 'pg'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const requestId = process.argv[2]
const report = { requestId, checkedAt: new Date().toISOString(), calls: [] }
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  application_name: 'xiaohongshu-user-info-readonly-diagnostic',
  options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',
})
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value) ? value.toLowerCase() : null
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null
// Print only fixed classifications, never arbitrary messages, profile content,
// signed links, request headers, credentials or the complete raw response.
function messageKind(value) {
  if (typeof value !== 'string') return null
  if (/(?:用户不存在|用户不存在或已注销|user\s+not\s+found)/iu.test(value)) return 'user_not_found_text'
  if (/(?:服务异常|service\s+error)/iu.test(value)) return 'service_error_text'
  return value.trim() ? 'other_text' : 'empty_text'
}
function shape(value) {
  if (!record(value)) return { type: kind(value), messageKind: messageKind(value) }
  return {
    type: 'object',
    identityFields: Object.fromEntries(['user_id', 'userId', 'id', 'userid', 'uid'].map(key => [key, { type: kind(value[key]), valid: id(value[key]) !== null }])),
    profileFields: ['nickname', 'name', 'red_id', 'desc', 'images', 'avatar', 'fans', 'follows', 'interactions'].filter(key => value[key] != null),
    code: numeric(value.code), statusCode: numeric(value.status_code),
    success: typeof value.success === 'boolean' ? value.success : null,
    messages: Object.fromEntries(['msg', 'message', 'error_msg'].filter(key => typeof value[key] === 'string').map(key => [key, messageKind(value[key])])),
  }
}
try {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error(), { code: 'DATABASE_URL_missing' })
  const { normalizeTikHubXiaohongshuUserInfoResponse: normalize } = await import(pathToFileURL(resolve('server/contracts/tikhub-xiaohongshu-user-info.mjs')))
  const { isTikHubXiaohongshuUnavailable: unavailable } = await import(pathToFileURL(resolve('server/contracts/tikhub-xiaohongshu.mjs')))
  await client.connect()
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const result = await client.query(`
    SELECT p.id, p.endpoint_key, p.outcome, p.http_status, p.business_code,
      p.error_code, p.upstream_request_id, p.billed, p.latency_ms,
      r.provider_call_id AS archive_id, r.json_parsed, r.body_size,
      r.body_sha256, r.captured_at, r.parsed_payload
    FROM external_platform.provider_calls p
    LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id = p.id
    WHERE p.usage_request_id = $1::uuid AND p.provider_key = 'tikhub'
      AND p.endpoint_key = 'xiaohongshu.app-v2.get-user-info.v1'
    ORDER BY p.started_at LIMIT 11`, [requestId])
  report.truncated = result.rows.length > 10
  for (const row of result.rows.slice(0, 10)) {
    const { parsed_payload: raw, ...metadata } = row
    const output = { ...metadata }
    if (row.archive_id && row.json_parsed) {
      output.recognizedServiceError = unavailable(raw)
      output.shape = { root: shape(raw) }
      for (const path of ['data', 'data.data', 'data.basic_info', 'data.basicInfo',
        'data.user', 'data.user_info', 'data.userInfo', 'data.data.basic_info',
        'data.data.basicInfo', 'data.data.user', 'data.data.user_info', 'data.data.userInfo']) {
        const value = path.split('.').reduce((current, key) => current?.[key], raw)
        if (value !== undefined) output.shape[path] = shape(value)
      }
      const expectedUserId = id(raw?.params?.user_id)
      output.expectedUserIdPresent = expectedUserId !== null
      const profile = raw?.data?.data
      if (record(profile)) {
        output.profileFieldNames = Object.keys(profile)
        output.identityMatchesRequest = Object.fromEntries(
          ['user_id', 'userId', 'id', 'userid', 'uid'].map(key => [key,
            expectedUserId && id(profile[key]) ? id(profile[key]) === expectedUserId : null]),
        )
      }
      try {
        const profile = normalize(raw, { expectedUserId })
        output.currentParser = { accepted: true, validUserId: id(profile.user_id) !== null }
      } catch (error) {
        const knownMessages = new Map([
          ['TikHub user info response is invalid', 'invalid_envelope'],
          ['TikHub user info response omitted profile data', 'missing_profile_object'],
          ['TikHub user info response omitted a valid user_id', 'missing_valid_profile_user_id'],
          ['TikHub returned a different Xiaohongshu user', 'identity_mismatch'],
        ])
        output.currentParser = { accepted: false,
          reason: knownMessages.get(error.message) || 'unclassified_parser_error' }
      }
    }
    report.calls.push(output)
  }
  await client.query('ROLLBACK')
} catch (error) {
  report.fatal = { code: /^[a-zA-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'diagnostic_failed' }
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
console.log(JSON.stringify(report, null, 2))
NODE
