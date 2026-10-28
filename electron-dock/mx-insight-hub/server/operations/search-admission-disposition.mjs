import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { requestFingerprint } from '../core/crypto.mjs'
import { dataSearchQueryHash } from '../contracts/data-search-v2.mjs'
import { compileTwitterSearchQuery } from '../contracts/twitter-search-query.mjs'
import { normalizedTwitterRetryBody } from '../external-platforms/twitter-manual-retry.mjs'
import { twitterV2BindingEvidence } from '../data/twitter-v2-retry.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const HASH = /^[0-9a-f]{64}$/u
const PATH = '/api/v1/data/search'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity = query => { try { return compileTwitterSearchQuery(query.trim()).providerQuery } catch { return query.trim() } }
const denied = (reasonCode, message) => ({ allowed: false, reasonCode, message })
const schemaError = () => new AppError(503, 'search_admission_disposition_unavailable', '搜索准入处置所需数据库迁移或证据尚未就绪')
const safeText = (value, min, max) => typeof value === 'string' && value.trim().length >= min
  && value.trim().length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
const requireId = id => {
  if (!UUID.test(id || '')) throw new AppError(400, 'invalid_request_id', '请提供完整的原 Hub 请求 UUID')
}
const dispositionView = row => row ? ({ id: row.id, originalRequestId: row.original_usage_request_id,
  actor: row.actor, reason: row.reason, createdAt: new Date(row.created_at).toISOString(),
  revision: row.evidence_revision, requestId: row.request_id }) : null

async function schema(queryable) {
  return (await queryable.query(`SELECT
    to_regclass('control.search_admission_dispositions') IS NOT NULL AS dispositions,
    to_regclass('control.data_search_protocol_bindings') IS NOT NULL AS bindings,
    to_regclass('control.data_search_protocol_leases') IS NOT NULL AS leases,
    to_regclass('external_platform.provider_calls') IS NOT NULL AS calls,
    to_regclass('external_platform.dispatch_leases') IS NOT NULL AS dispatch`)).rows[0]
}

// Bounded, saved evidence only. No credentials, adapters, status reapers or
// billing methods are reachable from this service or its admission lookup.
async function evidence(queryable, id, { lock = false } = {}) {
  const root = (await queryable.query(`SELECT id,tenant_id,consumer_id,api_key_id,platform,status,
    idempotency_key,fingerprint,acquisition_request,reserved_at,completed_at,error_code,response_status,
    response_body IS NOT NULL AS has_response_body
    FROM public.usage_requests WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]
  if (!root) return null
  const calls = (await queryable.query(`SELECT id,tenant_id,consumer_id,api_key_id,usage_request_id,
    provider_key,operation,contract_version,endpoint_key,endpoint_version,request_fingerprint,dispatch_fingerprint,call_ordinal,call_role,
    outcome,started_at,completed_at,http_status,error_code
    FROM external_platform.provider_calls WHERE usage_request_id=$1 ORDER BY id LIMIT 51${lock ? ' FOR UPDATE' : ''}`, [id])).rows
  const bindings = (await queryable.query(`SELECT consumer_id,idempotency_key,tenant_id,api_key_id,platform,
    query_hash,fingerprint,request_body,state,owner_id,lease_expires_at,usage_request_id,
    result IS NOT NULL AS has_result,created_at,updated_at
    FROM control.data_search_protocol_bindings
    WHERE usage_request_id=$1 OR (consumer_id=$2 AND idempotency_key=$3)
    ORDER BY consumer_id,idempotency_key LIMIT 3${lock ? ' FOR UPDATE' : ''}`,
  [id,root.consumer_id,root.idempotency_key])).rows
  const guards = (await queryable.query(`SELECT
    EXISTS(SELECT 1 FROM external_platform.dispatch_leases WHERE owner_request_id=$1 AND expires_at>clock_timestamp()) AS active_dispatch,
    EXISTS(SELECT 1 FROM control.data_search_protocol_leases WHERE consumer_id=$2 AND idempotency_key=$3
      OR owner_id=ANY($4::uuid[])) AS protocol_lease`,
  [id,root.consumer_id,root.idempotency_key,bindings.map(row => row.owner_id)])).rows[0]
  return { root, calls, bindings, guards }
}

function assessment(value, { apiKeyPepper, verifyProtocol = true } = {}) {
  const { root, calls, bindings, guards } = value
  const scope = { platform: root.platform, tenantId: root.tenant_id, consumerId: root.consumer_id, apiKeyId: root.api_key_id, query: null }
  let body = null, eligibility = denied('search_admission_evidence_unavailable', '仅支持保留完整参数和调用证据的 Twitter 标准搜索未知结果。')
  try {
    body = normalizedTwitterRetryBody(root.acquisition_request)
    if (root.platform !== 'twitter' || ![root.tenant_id,root.consumer_id,root.api_key_id].every(id => UUID.test(id))
      || !safeText(root.idempotency_key,1,256) || !HASH.test(root.fingerprint || '')
      || requestFingerprint({ method: 'POST', path: PATH, body }) !== root.fingerprint) throw new Error('evidence')
    scope.query = body.query
    if (root.status !== 'unknown') eligibility = denied('search_admission_not_unknown', '原请求不是结果未知，不能从此入口解除阻断。')
    else if (guards.active_dispatch || guards.protocol_lease || bindings.some(row => row.state === 'running')) {
      eligibility = denied('search_admission_still_running', '原请求仍有派发占用或协议租约；请先核对执行状态，不能强制解除。')
    } else if (!root.completed_at || !calls.length || calls.length > 50
      || calls.some(call => call.outcome === 'pending' || !call.completed_at
        || call.tenant_id !== root.tenant_id || call.consumer_id !== root.consumer_id || call.api_key_id !== root.api_key_id
        || call.request_fingerprint !== root.fingerprint)) {
      eligibility = denied('search_admission_call_evidence_unavailable', '原调用尚未结束，或缺少完整且归属一致的供应商调用证据。')
    } else {
      if (bindings.length > 1) throw new Error('binding')
      if (bindings.length) {
        const binding = bindings[0]
        if (binding.query_hash !== dataSearchQueryHash(body.query) || binding.has_result) throw new Error('binding')
        if (verifyProtocol) twitterV2BindingEvidence(root,binding,{ apiKeyPepper,requireUnknown:true,allowExpiredCursor:true })
        else if (binding.state !== 'unknown' || binding.usage_request_id !== root.id
          || binding.tenant_id !== root.tenant_id || binding.consumer_id !== root.consumer_id
          || binding.api_key_id !== root.api_key_id || binding.platform !== 'twitter'
          || binding.idempotency_key !== root.idempotency_key) throw new Error('binding')
      }
      eligibility = { allowed: true, reasonCode: null,
        message: '可以确认承担原结果及费用未知的风险，仅解除此记录对后续搜索的阻断；原请求、幂等键和账务保持不变。' }
    }
  } catch { /* Missing, unsupported or drifted saved evidence never grants admission. */ }
  return { scope, body, eligibility, revision: hash(value) }
}

function response(value, record, options) {
  const result = assessment(value,options)
  const effective = record && result.eligibility.allowed && result.revision === record.evidence_revision
  return { requestId:value.root.id,scope:result.scope,eligibility:record
    ? effective ? denied('search_admission_already_resolved','此历史请求已有准入处置；原结果及账务仍按原证据保留。')
      : denied('search_admission_disposition_stale','此请求已有处置，但执行证据已经变化；当前保护仍生效，请核对原记录。') : result.eligibility,
  revision:result.revision,disposition:record ? {...dispositionView(record),effective:Boolean(effective)} : null,upstreamDispatched:false }
}

function publicError(error) {
  if (['42P01','42703','42501'].includes(error.code)) return schemaError()
  if (['57014','55P03','40P01','40001'].includes(error.code)) return new AppError(503,
    'search_admission_disposition_busy','处置证据暂时繁忙，请保持原请求并稍后核对')
  return error
}

export class SearchAdmissionDispositionService {
  constructor({ pool, apiKeyPepper = null }) { Object.assign(this,{ pool,apiKeyPepper }) }

  async prepare(id) {
    requireId(id)
    if (!this.pool?.connect) throw schemaError()
    const client = await this.pool.connect()
    let releaseError
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SET LOCAL statement_timeout='5s'")
      await client.query("SET LOCAL lock_timeout='1s'")
      if (!Object.values(await schema(client)).every(Boolean)) throw schemaError()
      const value = await evidence(client,id)
      if (!value) throw new AppError(404,'request_not_found','未找到原请求')
      const record = (await client.query('SELECT * FROM control.search_admission_dispositions WHERE original_usage_request_id=$1',[id])).rows[0]
      const result = response(value,record,{apiKeyPepper:this.apiKeyPepper})
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(failure => { releaseError = failure })
      throw publicError(error)
    } finally { client.release(releaseError) }
  }

  async resolve(id, body, { actor = 'admin-token', requestId = null } = {}) {
    requireId(id)
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['revision','reason','acceptUnknownRisk'].includes(key))
      || !HASH.test(body.revision || '') || body.acceptUnknownRisk !== true || !safeText(body.reason,3,500)
      || !safeText(actor,1,256) || requestId !== null && !safeText(requestId,1,191)) {
      throw new AppError(400,'invalid_search_admission_disposition','请确认未知结果及费用风险，填写 3–500 字原因并使用最新证据版本')
    }
    if (!this.pool?.connect) throw schemaError()
    const client = await this.pool.connect()
    let releaseError, committing = false
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout='5s'")
      await client.query("SET LOCAL lock_timeout='2s'")
      if (!Object.values(await schema(client)).every(Boolean)) throw schemaError()
      const initial = await evidence(client,id)
      if (!initial) throw new AppError(404,'request_not_found','未找到原请求')
      const checked = assessment(initial,{apiKeyPepper:this.apiKeyPepper})
      // Match protocol acquisition's key -> query ordering before row locks.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`search-protocol-key:${initial.root.consumer_id}:${initial.root.idempotency_key}`])
      if (checked.body) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`search-protocol-query:${[initial.root.tenant_id,initial.root.consumer_id,initial.root.api_key_id,initial.root.platform,dataSearchQueryHash(checked.body.query)].join(':')}`])
      const value = await evidence(client,id,{lock:true})
      if (!value) throw new AppError(404,'request_not_found','未找到原请求')
      const existing = (await client.query('SELECT * FROM control.search_admission_dispositions WHERE original_usage_request_id=$1',[id])).rows[0]
      if (existing) {
        if (existing.evidence_revision !== body.revision || existing.actor !== actor.trim() || existing.reason !== body.reason.trim()) {
          throw new AppError(409,'search_admission_disposition_conflict','此请求已按另一份确认处置，请刷新并查看原审计记录')
        }
        const result = {...response(value,existing,{apiKeyPepper:this.apiKeyPepper}),replay:true}
        await client.query('COMMIT')
        return result
      }
      const current = assessment(value,{apiKeyPepper:this.apiKeyPepper})
      if (current.revision !== body.revision) throw new AppError(409,'search_admission_disposition_changed','请求证据已经变化，请重新准备并确认')
      if (!current.eligibility.allowed) throw new AppError(409,'search_admission_disposition_not_allowed',current.eligibility.message)
      const record = (await client.query(`INSERT INTO control.search_admission_dispositions
        (original_usage_request_id,id,tenant_id,consumer_id,api_key_id,platform,query_hash,fingerprint,evidence_revision,actor,reason,request_id)
        VALUES($1,$2,$3,$4,$5,'twitter',$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id,randomUUID(),value.root.tenant_id,value.root.consumer_id,value.root.api_key_id,dataSearchQueryHash(current.body.query),
        value.root.fingerprint,current.revision,actor.trim(),body.reason.trim(),requestId])).rows[0]
      const result = response(value,record,{apiKeyPepper:this.apiKeyPepper})
      committing = true
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(failure => { releaseError = failure })
      if (committing) throw new AppError(503,'search_admission_disposition_outcome_unknown','处置提交结果尚未确认，请只读核对或沿用原证据版本与原因重试')
      throw publicError(error)
    } finally { client.release(releaseError) }
  }
}

// Called only after a gate found unknown candidates. A missing additive table
// preserves the old protection. Never return a caller-supplied bypass list.
export async function getSearchAdmissionDispositionIds(queryable, candidates, scope = {}) {
  const ids = [...new Set((candidates || []).map(row => typeof row === 'string' ? row
    : row?.id || row?.usageRequestId || row?.usage_request_id).filter(id => UUID.test(id || '')))]
  if (!ids.length) return []
  const present = await schema(queryable)
  if (!present?.dispositions || !Object.values(present).every(Boolean)) return []
  const accepted = []
  for (let offset=0; offset<ids.length; offset+=100) {
    const records = (await queryable.query(`SELECT d.* FROM control.search_admission_dispositions d
      JOIN public.usage_requests u ON u.id=d.original_usage_request_id AND u.status='unknown'
        AND u.tenant_id=d.tenant_id AND u.consumer_id=d.consumer_id AND u.api_key_id=d.api_key_id
        AND u.platform=d.platform AND u.fingerprint=d.fingerprint
      WHERE d.original_usage_request_id=ANY($1::uuid[])`,[ids.slice(offset,offset+100)])).rows
    for (const record of records) {
      if (Object.entries({tenantId:'tenant_id',consumerId:'consumer_id',apiKeyId:'api_key_id',platform:'platform'})
        .some(([key,column]) => scope[key] !== undefined && scope[key] !== record[column])) continue
      const value = await evidence(queryable,record.original_usage_request_id)
      if (!value) continue
      // Full v2/cursor proof was verified at the administrative decision. The
      // hash binds that exact saved proof; no secret is needed in hot gates.
      const checked = assessment(value,{verifyProtocol:false})
      if (!checked.eligibility.allowed || checked.revision !== record.evidence_revision
        || record.query_hash !== dataSearchQueryHash(checked.body.query)
        || scope.query !== undefined && (typeof scope.query !== 'string' || identity(scope.query) !== identity(checked.body.query))) continue
      accepted.push(record.original_usage_request_id)
    }
  }
  return accepted
}
