import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { quarantineRecoverySql } from '../core/admission-recovery.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const iso = value => value == null ? null : new Date(value).toISOString()
const revision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const names = { provider_circuit: '供应商熔断', contract_circuit: '平台契约熔断', response_quarantine: '响应解析冷却',
  unknown: '调用结果未知', pending: '上游调用中', dispatch_lease: '请求派发占用', unavailable: '内容不可用冷却', provider_rate: '供应商本地速率',
  key_window: 'Key 滑动窗口', consumer_window: '调用者滑动窗口', key_rate: 'Key 操作速率', key_total: 'Key 操作总额',
  plan_window: '套餐滑动窗口', plan_burst: '套餐瞬时速率', plan_month: '套餐月度额度' }
const writable = new Set(['provider_circuit', 'contract_circuit', 'response_quarantine', 'provider_rate',
  'key_window', 'consumer_window', 'key_rate', 'plan_window', 'plan_burst'])

function item(kind, target, state, fields = {}) {
  return { kind, target, title: names[kind], scopeType: '', scopeKey: '', revision: revision(state),
    recoverable: writable.has(kind), ...fields }
}
function validateFilter(filter) {
  for (const key of Object.keys(filter)) if (!['apiKeyId', 'requestId'].includes(key)) throw new AppError(400, 'invalid_recovery_filter', 'Unknown filter')
  for (const value of Object.values(filter)) if (value && !UUID.test(value)) throw new AppError(400, 'invalid_recovery_filter', 'Use a complete UUID')
}

// Admin-only. No adapters, credential readers, replay or dispatch methods exist here.
export class AdmissionRecoveryService {
  constructor({ pool, usageStore, providers = {} }) { Object.assign(this, { pool, usageStore, providers }) }

  async #read(client, filter = {}) {
    const { rows: [clock] } = await client.query('SELECT now() AS server_time')
    const now = new Date(clock.server_time).getTime()
    let apiKeyId = filter.apiKeyId || null
    let correlation = null
    if (filter.requestId) {
      const { rows: [request] } = await client.query('SELECT id, api_key_id, platform, status FROM usage_requests WHERE id=$1', [filter.requestId])
      if (!request) throw new AppError(404, 'request_not_found', 'Request not found')
      if (apiKeyId && apiKeyId !== request.api_key_id) throw new AppError(400, 'recovery_filter_mismatch', 'Request belongs to another Key')
      apiKeyId = request.api_key_id
      correlation = { requestId: request.id, platform: request.platform, status: request.status }
    }
    const keys = (await client.query(`SELECT k.id, k.name, k.status, c.name AS consumer_name
      FROM api_keys k JOIN consumers c ON c.id=k.consumer_id ORDER BY k.created_at DESC LIMIT 201`)).rows
    const items = []
    const states = (await client.query('SELECT * FROM external_platform.provider_state WHERE circuit_open_until > now()')).rows
    for (const row of states) items.push(item('provider_circuit', row.provider_key, row, {
      provider: row.provider_key, scope: '该供应商的调用', origin: 'Hub 根据上游失败启用',
      startedAt: iso(row.last_failure_at), until: iso(row.circuit_open_until), errorCode: row.last_error_code,
      note: '解除 Hub 熔断不代表上游已恢复；后续新请求仍可能失败。', failures: row.consecutive_failures,
    }))
    for (const row of (await client.query('SELECT * FROM external_platform.provider_contract_circuits WHERE circuit_open_until > now()')).rows) {
      items.push(item('contract_circuit', row.provider_key, row, { provider: row.provider_key, scopeKey: row.scope,
        scope: row.scope, origin: 'Hub 解析保护', startedAt: iso(row.last_failure_at), until: iso(row.circuit_open_until),
        errorCode: row.last_error_code, note: '确认解析修复已部署后解除。', failures: row.consecutive_failures }))
    }
    // Runtime values are supplied by the same deployment configuration as admission.
    const providerKeys = Object.keys(this.providers)
    const cooldowns = providerKeys.map(key => Math.ceil(this.providers[key].cooldownMs / 1000) * 1000)
    const calls = (await client.query(`SELECT call.id, call.provider_key, call.operation, call.endpoint_key,
      call.contract_version, call.outcome, call.error_code, call.started_at, call.completed_at,
      call.usage_request_id, call.consumer_id, u.api_key_id, u.platform, u.lease_expires_at,
      call.completed_at + cfg.ms * interval '1 millisecond' AS until
      FROM external_platform.provider_calls call
      JOIN unnest($1::text[], $2::int[]) cfg(provider,ms) ON cfg.provider=call.provider_key
      JOIN usage_requests u ON u.id=call.usage_request_id
      WHERE call.outcome='pending' OR (call.outcome IN ('unknown','succeeded_unusable')
        AND call.completed_at + cfg.ms * interval '1 millisecond' > now()
        ${quarantineRecoverySql('call')})
      ORDER BY call.started_at DESC LIMIT 201`, [providerKeys, cooldowns])).rows
    for (const row of calls.slice(0, 200)) {
      const kind = row.outcome === 'succeeded_unusable'
        ? row.error_code === 'upstream_note_unavailable' ? 'unavailable' : 'response_quarantine' : row.outcome
      items.push(item(kind, row.id, row, { provider: row.provider_key, platform: row.platform,
        operation: row.operation, scope: kind === 'response_quarantine' ? `${row.endpoint_key} · 同契约的全部调用者` : '同调用者、同请求内容',
        apiKeyId: row.api_key_id, consumerId: row.consumer_id, requestId: row.usage_request_id, startedAt: iso(row.completed_at || row.started_at),
        until: kind === 'pending' ? null : iso(row.until), leaseExpiresAt: iso(row.lease_expires_at), errorCode: row.error_code,
        origin: 'Hub 派发保护', note: kind === 'response_quarantine' ? '只解除这份响应产生的保护；原始响应和账单保留。'
          : kind === 'pending' ? '执行中不能强制解除。租约到期后仍需确认执行结果。' : '需要核对上游结果；本页不重发未知或不可用的付费请求。' }))
    }
    const leases = (await client.query(`SELECT lease.*,u.api_key_id,u.platform FROM external_platform.dispatch_leases lease
      JOIN usage_requests u ON u.id=lease.owner_request_id WHERE lease.expires_at>now()
      ORDER BY lease.created_at DESC LIMIT 201`)).rows
    for (const row of leases.slice(0,200)) items.push(item('dispatch_lease', revision([row.consumer_id,row.operation,row.request_fingerprint]), row, {
      consumerId: row.consumer_id, apiKeyId: row.api_key_id, requestId: row.owner_request_id, platform: row.platform,
      scope: `同调用者、同请求内容 · ${row.operation}`, origin: 'Hub 并发派发保护',
      startedAt: iso(row.created_at), until: iso(row.expires_at), note: '派发锁可能与上游调用同时存在；锁到期不代表执行成功，不提供强制解锁。',
    }))
    for (const row of (await client.query('SELECT * FROM external_platform.provider_rate_buckets')).rows) {
      const tokens = Number(row.tokens) + Math.max(0, now - new Date(row.refilled_at).getTime()) * row.capacity / row.window_ms
      if (tokens >= 1) continue
      items.push(item('provider_rate', row.provider_key, row, { provider: row.provider_key, scope: '该供应商共享令牌桶',
        origin: 'Hub 本地限流', startedAt: iso(row.refilled_at),
        until: new Date(now + Math.ceil((1 - tokens) * row.window_ms / row.capacity)).toISOString(),
        note: `预计可申请下一个调用的时间；补充速率 ${row.capacity} 次 / ${row.window_ms / 1000} 秒，并发流量会改变倒计时。` }))
    }
    let key = null
    if (apiKeyId) {
      key = (await client.query('SELECT id, tenant_id, consumer_id, name, status, scope_mode FROM api_keys WHERE id=$1', [apiKeyId])).rows[0]
      if (!key) throw new AppError(404, 'api_key_not_found', 'Key not found')
      items.push(...await this.#quotas(client, key))
      if (this.usageStore.internalTrafficPolicy?.matches({ apiKeyId: key.id, tenantId: key.tenant_id })) {
        for (const row of items) {
          if (row.provider !== 'tikhub') continue
          if (row.kind === 'provider_rate') row.selectedKeyEffect = '当前 Key 豁免 TikHub 本地速率；此共享限制仍影响普通调用者。'
          if (row.kind === 'provider_circuit' && row.errorCode === 'upstream_rate_limited') {
            const deadline = Math.min(Date.parse(row.until), Date.parse(row.startedAt) + 10000)
            row.selectedKeyUntil = new Date(deadline).toISOString()
            row.selectedKeyEffect = deadline <= now ? '当前 Key 的内部速率冷却已到期；共享熔断仍影响普通调用者。'
              : '当前 Key 使用 10 秒内部速率冷却；下方展示的仍是供应商共享熔断。'
          }
        }
      }
    }
    const history = (await client.query(`SELECT id,kind,target,scope_type,scope_key,reason,actor,created_at
      FROM control.admission_recoveries ORDER BY created_at DESC LIMIT 30`)).rows
    return { serverTime: iso(clock.server_time), items: items.filter(row => !key || !row.consumerId || row.kind === 'response_quarantine' || row.consumerId === key.consumer_id).map(row => ({ ...row,
      active: !row.exempt && (row.until ? Date.parse(row.until) > now : row.used == null || row.used >= row.limit) })),
      apiKeyId, key: key ? { id: key.id, name: key.name, status: key.status } : null, correlation,
      keys: keys.slice(0, 200).map(row => ({ id: row.id, name: row.name, status: row.status, consumerName: row.consumer_name })),
      keysTruncated: keys.length > 200, callsTruncated: calls.length > 200, leasesTruncated: leases.length > 200, history,
      coverage: '显示供应商共享冷却及当前调用保护；选定 Key 后显示该 Key、调用者和套餐配额。进程内并发计数不跨副本共享，执行中调用仅作为观察证据。余额、授权和运营停用请在上游供应商 / Key 设置中处理；解除冷却不会绕过这些检查。' }
  }

  async #quotas(client, key) {
    const scopes = (await client.query(`WITH entitlements AS (
      SELECT 'platform' AS type,platform AS key,max_requests,window_seconds FROM api_key_platform_entitlements WHERE api_key_id=$1 AND $3='snapshot'
      UNION ALL SELECT 'capability',capability,max_requests,window_seconds FROM api_key_capability_entitlements WHERE api_key_id=$1 AND $3='snapshot'
      UNION ALL SELECT 'platform',g.platform,coalesce(p.max_requests,1000),coalesce(p.window_seconds,3600)
        FROM platform_grants g LEFT JOIN consumer_platform_policies p ON p.consumer_id=g.consumer_id AND p.platform=g.platform WHERE g.consumer_id=$2 AND $3='legacy_dynamic'
      UNION ALL SELECT 'capability',g.capability,coalesce(p.max_requests,1000),coalesce(p.window_seconds,3600)
        FROM capability_grants g LEFT JOIN consumer_capability_policies p ON p.consumer_id=g.consumer_id AND p.capability=g.capability WHERE g.consumer_id=$2 AND $3='legacy_dynamic'
    ) SELECT e.type,e.key,e.max_requests,e.window_seconds,
      coalesce(p.max_requests,1000) AS consumer_max,coalesce(p.window_seconds,3600) AS consumer_window
      FROM entitlements e LEFT JOIN consumer_platform_policies p ON p.consumer_id=$2 AND p.platform=e.key WHERE e.type='platform'
      UNION ALL SELECT e.type,e.key,e.max_requests,e.window_seconds,coalesce(p.max_requests,1000),coalesce(p.window_seconds,3600)
      FROM entitlements e LEFT JOIN consumer_capability_policies p ON p.consumer_id=$2 AND p.capability=e.key WHERE e.type='capability'`, [key.id, key.consumer_id, key.scope_mode])).rows
    const limits = (await client.query('SELECT * FROM control.api_key_access_limits WHERE api_key_id=$1', [key.id])).rows
    const plan = (await client.query(`SELECT v.limits,a.assigned_at,p.plan_key FROM consumer_plan_assignments a
      JOIN plan_versions v ON v.id=a.plan_version_id JOIN plans p ON p.id=v.plan_id WHERE a.consumer_id=$1`, [key.consumer_id])).rows[0]
    const specs = scopes.flatMap(s => [
      { kind: 'key_window', target: key.id, type: s.type, scope: s.key, limit: s.max_requests, seconds: s.window_seconds },
      { kind: 'consumer_window', target: key.consumer_id, type: s.type, scope: s.key, limit: s.consumer_max, seconds: s.consumer_window },
    ])
    for (const l of limits) {
      if (l.rate_limit != null) specs.push({ kind: 'key_rate', target: key.id, type: l.scope_type, scope: l.scope_key, limit: l.rate_limit, seconds: l.window_seconds, allStatuses: true })
      if (l.total_limit != null) specs.push({ kind: 'key_total', target: key.id, type: l.scope_type, scope: l.scope_key, limit: Number(l.total_limit) })
    }
    for (const [kind, field, seconds] of [['plan_window','maxRequests',plan?.limits?.windowSeconds], ['plan_burst','burstRps',1], ['plan_month','monthlyRequests',null]]) {
      if (Number.isInteger(plan?.limits?.[field]) && plan.limits[field] > 0) specs.push({ kind, target: key.consumer_id,
        limit: plan.limits[field], seconds, assignedAt: kind === 'plan_burst' ? null : plan.assigned_at })
    }
    const exempt = this.usageStore.internalTrafficPolicy?.matches({ apiKeyId: key.id, tenantId: key.tenant_id }) === true
    // One database round trip for all Key scopes (Keys can carry hundreds).
    const measured = (await client.query(`WITH specs AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS s(kind text,target uuid,type text,scope text,
        "limit" int,seconds int,"assignedAt" timestamptz,"allStatuses" boolean)
    ) SELECT s.*, q.* FROM specs s CROSS JOIN LATERAL (
      WITH counted AS (SELECT reserved_at FROM usage_requests request
        WHERE ((s.kind LIKE 'key_%' AND request.api_key_id=s.target)
            OR (s.kind NOT LIKE 'key_%' AND request.consumer_id=s.target))
          AND (s."allStatuses" IS TRUE OR request.status IN ('reserved','committed','unknown'))
          AND (s.type IS NULL OR EXISTS (SELECT 1 FROM usage_request_authorization_scopes a
            WHERE a.usage_request_id=request.id AND a.scope_type=s.type AND a.scope_key=s.scope)
            OR (NOT EXISTS (SELECT 1 FROM usage_request_authorization_scopes a WHERE a.usage_request_id=request.id)
              AND CASE WHEN s.type='platform' THEN request.platform ELSE request.capability END=s.scope))
          AND (s.seconds IS NULL OR reserved_at >= now()-s.seconds*interval '1 second')
          AND (s."assignedAt" IS NULL OR reserved_at >= s."assignedAt")
          AND (s.kind <> 'plan_month' OR reserved_at >= date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          AND (s.kind IN ('key_total','plan_month') OR reserved_at > coalesce((SELECT max(created_at)
            FROM control.admission_recoveries r WHERE r.kind=s.kind AND r.target=s.target::text
              AND r.scope_type=coalesce(s.type,'') AND r.scope_key=coalesce(s.scope,'')), '-infinity'::timestamptz))
      ), ranked AS (SELECT reserved_at,row_number() OVER (ORDER BY reserved_at) AS ordinal FROM counted)
      SELECT count(*)::int AS used,max(reserved_at) AS latest,
        (SELECT reserved_at FROM ranked WHERE ordinal=greatest(1,(SELECT count(*) FROM counted)-s."limit"+1)) AS frees_at,
        (SELECT max(created_at) FROM control.admission_recoveries WHERE kind=s.kind AND target=s.target::text
          AND scope_type=coalesce(s.type,'') AND scope_key=coalesce(s.scope,'')) AS reset_at,
        (date_trunc('month',now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS month_end
      FROM counted
    ) q`, [JSON.stringify(specs)])).rows
    const rows = []
    for (const s of measured) {
      const q = { used: s.used, latest: s.latest, frees_at: s.frees_at, reset_at: s.reset_at }
      const until = s.kind === 'plan_month' ? iso(s.month_end)
        : s.seconds && q.frees_at ? new Date(new Date(q.frees_at).getTime() + s.seconds * 1000).toISOString() : null
      rows.push(item(s.kind, s.target, { ...s, ...q, exempt }, { apiKeyId: key.id, scopeType: s.type || '', scopeKey: s.scope || '',
        scope: `${s.scope || plan?.plan_key}${s.kind.startsWith('plan_') || s.kind === 'consumer_window' ? ' · 该调用者的全部 Key 共享' : ' · 当前 Key'}`, limit: Number(s.limit), used: q.used, windowSeconds: s.seconds || null,
        startedAt: iso(q.latest), until: q.used >= s.limit && !exempt ? until : null, exempt,
        origin: 'Hub 配额', recoverable: writable.has(s.kind) && !exempt && q.used >= s.limit,
        note: exempt ? '部署内部白名单豁免；仍保留用量与计费。' : writable.has(s.kind)
          ? '手动恢复从当前时刻重新计算此层配额；不清空历史用量或账单。' : '累计额度请到 Key / 套餐设置调整，不清空商业用量。' }))
    }
    return rows
  }

  async snapshot(filter = {}) {
    validateFilter(filter)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SET LOCAL statement_timeout='10s'")
      const result = await this.#read(client, filter)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async recover(input, { actor = 'admin-token', requestId }) {
    if (!input || Object.keys(input).some(k => !['kind','target','scopeType','scopeKey','apiKeyId','revision','reason'].includes(k))
      || !writable.has(input.kind) || typeof input.target !== 'string' || input.target.length > 200
      || !/^[a-f0-9]{64}$/.test(input.revision || '') || typeof input.reason !== 'string'
      || input.reason.trim().length < 3 || input.reason.trim().length > 500
      || [input.scopeType,input.scopeKey].some(v => v != null && (typeof v !== 'string' || v.length > 200))) {
      throw new AppError(400, 'invalid_recovery', 'Choose a current recoverable limit and provide a reason (3–500 characters)')
    }
    validateFilter({ apiKeyId: input.apiKeyId })
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout='10s'")
      await client.query("SET LOCAL lock_timeout='3s'")
      if (['key_window','consumer_window','key_rate','plan_window','plan_burst'].includes(input.kind)) {
        if (!input.apiKeyId) throw new AppError(400, 'api_key_required', 'Select a Key')
        const key = (await client.query('SELECT tenant_id,consumer_id FROM api_keys WHERE id=$1', [input.apiKeyId])).rows[0]
        if (!key) throw new AppError(404, 'api_key_not_found', 'Key not found')
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${key.tenant_id}:${key.consumer_id}:plan-month`])
      } else if (input.kind === 'response_quarantine') {
        if (!UUID.test(input.target)) throw new AppError(400, 'invalid_recovery', 'Invalid call ID')
        await client.query('SELECT id FROM external_platform.provider_calls WHERE id=$1 FOR UPDATE', [input.target])
      } else {
        const table = { provider_circuit: 'provider_state', contract_circuit: 'provider_contract_circuits', provider_rate: 'provider_rate_buckets' }[input.kind]
        await client.query(`SELECT provider_key FROM external_platform.${table} WHERE provider_key=$1
          ${input.kind === 'contract_circuit' ? 'AND scope=$2' : ''} FOR UPDATE`, input.kind === 'contract_circuit' ? [input.target,input.scopeKey] : [input.target])
      }
      const previous = (await client.query(`SELECT id,created_at FROM control.admission_recoveries
        WHERE kind=$1 AND target=$2 AND scope_type=$3 AND scope_key=$4 AND generation=$5`,
      [input.kind,input.target,input.scopeType || '',input.scopeKey || '',input.revision])).rows[0]
      if (previous) { await client.query('COMMIT'); return { recovered: true, replay: true, recoveryId: previous.id, recoveredAt: iso(previous.created_at), upstreamDispatched: false } }
      const snapshot = await this.#read(client, { apiKeyId: input.apiKeyId })
      const current = snapshot.items.find(row => row.kind === input.kind && row.target === input.target
        && row.scopeType === (input.scopeType || '') && row.scopeKey === (input.scopeKey || ''))
      if (!current?.active || !current.recoverable || current.revision !== input.revision) {
        throw new AppError(409, 'recovery_state_changed', '限制已经变化或到期，请刷新后重新选择')
      }
      if (input.kind === 'provider_circuit') await client.query(`UPDATE external_platform.provider_state
        SET circuit_open_until=NULL,consecutive_failures=0,updated_at=clock_timestamp() WHERE provider_key=$1`, [input.target])
      if (input.kind === 'contract_circuit') await client.query(`UPDATE external_platform.provider_contract_circuits
        SET circuit_open_until=NULL,consecutive_failures=0,updated_at=clock_timestamp() WHERE provider_key=$1 AND scope=$2`, [input.target,input.scopeKey])
      if (input.kind === 'provider_rate') await client.query(`UPDATE external_platform.provider_rate_buckets
        SET tokens=least(capacity,coalesce($2,capacity)),refilled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE provider_key=$1`,
      [input.target, this.providers[input.target]?.burst ?? null])
      const { rows: [record] } = await client.query(`INSERT INTO control.admission_recoveries
        (id,kind,target,scope_type,scope_key,generation,previous_state,reason,actor,request_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,created_at`,
      [randomUUID(),input.kind,input.target,input.scopeType || '',input.scopeKey || '',input.revision,JSON.stringify(current),input.reason.trim(),actor,requestId])
      await client.query('COMMIT')
      return { recovered: true, recoveryId: record.id, recoveredAt: iso(record.created_at), upstreamDispatched: false }
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}
