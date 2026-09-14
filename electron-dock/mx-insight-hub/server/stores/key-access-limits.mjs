import { AppError } from '../core/errors.mjs'
const identity = (id, type, key) => JSON.stringify([id, type, key])
function normalize(input) {
 const allowed = ['scopeType','scopeKey','totalLimit','rateLimit','windowSeconds','revision']
 if (!input || Object.keys(input).some(key => !allowed.includes(key)) || !['platform','capability'].includes(input.scopeType) || !/^[a-z][a-z0-9._-]{0,127}$/u.test(input.scopeKey || '')) throw new AppError(400,'invalid_key_limit','Invalid scope')
 for (const field of ['totalLimit','rateLimit']) if (input[field] !== null && (!Number.isSafeInteger(input[field]) || input[field] < 1 || input[field] > 2147483647)) throw new AppError(400,'invalid_key_limit','Limits must be positive integers or null')
 if (!Number.isInteger(input.windowSeconds) || input.windowSeconds < 1 || input.windowSeconds > 86400 || !Number.isInteger(input.revision) || input.revision < 0) throw new AppError(400,'invalid_key_limit','Invalid window or revision')
 return input
}
const dto = row => ({ scopeType: row.scope_type, scopeKey: row.scope_key, totalLimit: row.total_limit == null ? null : Number(row.total_limit), rateLimit: row.rate_limit, windowSeconds: row.window_seconds, revision: row.revision })
export async function readKeyAccessLimits(store, id) {
 if (store.pool) return (await store.pool.query('SELECT * FROM control.api_key_access_limits WHERE api_key_id=$1', [id])).rows.map(dto)
 return [...(store.keyAccessLimits || new Map()).values()].filter(row => row.apiKeyId === id).map(({apiKeyId,...row}) => row)
}
export async function saveKeyAccessLimit(store, key, raw, actor) {
 const input = normalize(raw)
 const valid = input.scopeType === 'platform' ? await store.listEffectiveGrants(key.consumerId,key.id) : await store.listEffectiveCapabilityGrants(key.consumerId,key.id)
 if (!valid.includes(input.scopeKey)) throw new AppError(403,'key_scope_not_granted','Choose a currently granted Key scope')
 const result = {...input,revision:input.revision+1}
 if (!store.pool) {
  store.keyAccessLimits ||= new Map()
  const id = identity(key.id,input.scopeType,input.scopeKey)
  if ((store.keyAccessLimits.get(id)?.revision || 0) !== input.revision) throw new AppError(409,'revision_conflict','Reload limits before saving')
  store.keyAccessLimits.set(id,{...result,apiKeyId:key.id})
  store.keyAccessLimitEvents ||= []; store.keyAccessLimitEvents.push({apiKeyId:key.id,...result,actor})
  return result
 }
 const client = await store.pool.connect()
 try {
  await client.query('BEGIN')
  // Same lock as usage admission: limit changes and concurrent requests serialize.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${key.tenantId}:${key.consumerId}:plan-month`])
  const previous = await client.query('SELECT revision FROM control.api_key_access_limits WHERE api_key_id=$1 AND scope_type=$2 AND scope_key=$3 FOR UPDATE',[key.id,input.scopeType,input.scopeKey])
  if ((previous.rows[0]?.revision || 0) !== input.revision) throw new AppError(409,'revision_conflict','Reload limits before saving')
  await client.query(`INSERT INTO control.api_key_access_limits (api_key_id,scope_type,scope_key,total_limit,rate_limit,window_seconds,revision)
   VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (api_key_id,scope_type,scope_key) DO UPDATE SET total_limit=$4,rate_limit=$5,window_seconds=$6,revision=$7,updated_at=now()`,[key.id,input.scopeType,input.scopeKey,input.totalLimit,input.rateLimit,input.windowSeconds,result.revision])
  await client.query('INSERT INTO control.api_key_access_limit_events (api_key_id,scope_type,scope_key,configuration,actor) VALUES ($1,$2,$3,$4::jsonb,$5)',[key.id,input.scopeType,input.scopeKey,JSON.stringify(result),actor])
  await client.query('COMMIT'); return result
 } catch(error) {await client.query('ROLLBACK');throw error} finally {client.release()}
}
function enforce(limit,total,recent) {
 if (limit.totalLimit != null && total >= limit.totalLimit) throw new AppError(429,'api_key_total_limit_exceeded','This Key has reached its operation usage limit',{scope:limit.scopeKey,limit:limit.totalLimit,used:total})
 if (limit.rateLimit != null && recent >= limit.rateLimit) throw new AppError(429,'api_key_rate_limit_exceeded','Too many requests for this Key; try later',{scope:limit.scopeKey,limit:limit.rateLimit,windowSeconds:limit.windowSeconds})
}
export function assertMemoryKeyAccessLimits(store,apiKeyId,scopes) {
 for (const scope of scopes) {
  const limit=store.keyAccessLimits?.get(identity(apiKeyId,scope.type,scope.key))
  if (!limit) continue
  const records=[...store.requests.values()].filter(row=>row.apiKeyId===apiKeyId && (store.usageAuthorizationScopes.get(row.id)||[{type:row.platform?'platform':'capability',key:row.platform||row.capability}]).some(value=>value.type===scope.type && value.key===scope.key))
  enforce(limit,records.filter(row=>['reserved','committed','unknown'].includes(row.status)).length,records.filter(row=>new Date(row.reservedAt).getTime()>=Date.now()-limit.windowSeconds*1000).length)
 }
}
export async function assertPostgresKeyAccessLimits(client,apiKeyId,scopes) {
 const limits=(await client.query('SELECT * FROM control.api_key_access_limits WHERE api_key_id=$1',[apiKeyId])).rows.map(dto)
 for (const limit of limits) {
  if (!scopes.some(scope=>scope.type===limit.scopeType && scope.key===limit.scopeKey) || (limit.totalLimit==null && limit.rateLimit==null)) continue
  const {rows}=await client.query(`SELECT count(*) FILTER (WHERE status IN ('reserved','committed','unknown'))::bigint AS total,
   count(*) FILTER (WHERE reserved_at >= now()-$4*interval '1 second')::bigint AS recent
   FROM usage_requests request WHERE api_key_id=$1 AND (
    EXISTS (SELECT 1 FROM usage_request_authorization_scopes scope WHERE scope.usage_request_id=request.id AND scope.scope_type=$2 AND scope.scope_key=$3)
    OR (NOT EXISTS (SELECT 1 FROM usage_request_authorization_scopes scope WHERE scope.usage_request_id=request.id)
      AND CASE WHEN $2='platform' THEN request.platform ELSE request.capability END=$3))`,[apiKeyId,limit.scopeType,limit.scopeKey,limit.windowSeconds])
  enforce(limit,Number(rows[0].total),Number(rows[0].recent))
 }
}
