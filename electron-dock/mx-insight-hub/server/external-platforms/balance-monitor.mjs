import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { BALANCE_PROVIDERS, balanceLevel, decimalAmount, queryProviderBalance } from './balance-adapters.mjs'
import { BALANCE_INCIDENT_CODE, PROBE_INCIDENT_CODE, DAILY_SPEND_INCIDENT_CODE, feishuWebhook, webhookHint } from '../notifications-feishu.mjs'
import { advanceDailySpend, dailySpendExceeded, dailySpendWindow } from './daily-spend.mjs'
import { DEFAULT_BALANCE_SCHEDULE, MONITOR_TIME_ZONE, nextMonitorRun, normalizeMonitorSchedule } from '../../shared/monitor-schedule.mjs'
import { MonitorCronTimer } from '../monitor-cron-timer.mjs'

export function balancePolicy(input) {
  const fields = ['enabled', 'warningThreshold', 'criticalThreshold', 'expectedRevision', 'feishuWebhook', 'feishuReminderMinutes', 'balanceSchedule', 'feishuSchedule', 'dailySpendEnabled', 'dailySpendThreshold', 'dailySpendDayStartHour']
  try {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))
      || typeof input.enabled !== 'boolean'
      || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw Error()
    const warning = decimalAmount(input.warningThreshold)
    const critical = decimalAmount(input.criticalThreshold)
    if (critical.units < 0n || warning.units <= critical.units) throw Error()
    if ('dailySpendEnabled' in input && typeof input.dailySpendEnabled !== 'boolean') throw Error()
    if ('dailySpendThreshold' in input && decimalAmount(input.dailySpendThreshold).units <= 0n) throw Error()
    if ('dailySpendDayStartHour' in input && ![0, 10].includes(input.dailySpendDayStartHour)) throw Error()
    if ('feishuReminderMinutes' in input && (!Number.isInteger(input.feishuReminderMinutes)
      || input.feishuReminderMinutes < 1 || input.feishuReminderMinutes > 1440)) throw Error()
    if ('feishuReminderMinutes' in input && 'feishuSchedule' in input) throw Error()
    const schedules = {}
    for (const field of ['balanceSchedule', 'feishuSchedule']) {
      if (field in input) {
        try { schedules[field] = normalizeMonitorSchedule(input[field]) }
        catch (error) { throw new AppError(400, 'invalid_monitor_schedule', error.message) }
      }
    }
    // Absent means "leave the stored hook alone": ordinary console reads do not
    // include its value, and a separate reveal never changes the edit field.
    // An explicit empty string clears it and stops notifying that group.
    const webhook = 'feishuWebhook' in input
      ? { set: true, value: feishuWebhook(input.feishuWebhook) }
      : { set: false, value: null }
    return { ...input, ...schedules, warningThreshold: warning.text, criticalThreshold: critical.text, webhook }
  } catch (error) {
    if (error?.code === 'invalid_monitor_schedule') throw error
    if (error?.code === 'invalid_feishu_webhook') {
      throw new AppError(400, 'invalid_feishu_webhook', '飞书机器人地址需为 https://open.feishu.cn/open-apis/bot/v2/hook/<id>，留空表示不修改')
    }
    throw new AppError(400, 'invalid_balance_policy', '有效阈值需满足 0 ≤ 严重阈值 < 提醒阈值；日消费阈值需大于 0，日界线为 00:00 或 10:00；飞书重复提醒间隔需为 1–1440 分钟的整数')
  }
}

const iso = value => value ? new Date(value).toISOString() : null

export class SupplierBalanceMonitor {
  constructor({ pool, credentials = {}, fetchers = {}, logger = console, now = () => Date.now() }) {
    this.pool = pool
    this.credentials = credentials
    this.fetchers = fetchers
    this.logger = logger
    this.now = now
    this.running = null
    this.timer = null
    this.abort = new AbortController()
  }

  async credential(provider) {
    const entry = this.credentials[provider]
    if (!entry) return { value: null, scope: 'unconfigured' }
    const snapshot = await entry.store.readCredentialSnapshot(provider)
    const value = snapshot.source === 'database' ? snapshot.apiKey : entry.environmentValue
    // Fingerprint never leaves the service DTO; rotation invalidates cached
    // account balances, including environment credentials with revision zero.
    const digest = value ? createHash('sha256').update(value).digest('hex') : 'missing'
    return { value, scope: `${snapshot.source}:${snapshot.revision}:${digest}` }
  }

  async transaction(operation) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL statement_timeout = '5s'")
      await client.query("SET LOCAL lock_timeout = '2s'")
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }

  async list() {
    if (!this.pool) return { available: false, items: [] }
    const { rows } = await this.pool.query('SELECT * FROM external_platform.balance_monitors ORDER BY provider_key')
    const items = await Promise.all(rows.filter(row => BALANCE_PROVIDERS[row.provider_key]).map(async row => {
      let credential
      try { credential = await this.credential(row.provider_key) } catch { credential = null }
      const same = Boolean(credential?.value && credential.scope === row.credential_scope)
      const hasBalance = same && row.last_balance != null
      const stale = hasBalance && (Boolean(row.last_error_code)
        || this.now() - new Date(row.last_success_at).getTime() > 24 * 60 * 60 * 1000)
      const daily = same ? row.daily_spend_state : null
      const currentDay = dailySpendWindow(this.now(), row.daily_spend_day_start_hour ?? 0)
      const currentDaily = daily?.windowStart === currentDay.windowStart ? daily : null
      return {
        provider: row.provider_key, displayName: BALANCE_PROVIDERS[row.provider_key].name,
        currency: row.currency, enabled: row.enabled, revision: row.revision,
        warningThreshold: row.warning_threshold, criticalThreshold: row.critical_threshold,
        schedule: { timeZone: MONITOR_TIME_ZONE, ...row.balance_schedule },
        balanceSchedule: row.balance_schedule,
        feishuSchedule: row.feishu_schedule,
        feishuReminderMinutes: row.feishu_reminder_minutes,
        // Ordinary reads expose metadata only; reveal requires reauthentication.
        feishu: { configured: Boolean(row.feishu_webhook), hint: webhookHint(row.feishu_webhook) },
        balance: hasBalance ? row.last_balance : null,
        level: hasBalance ? balanceLevel(row.last_balance, row.warning_threshold, row.critical_threshold) : 'unknown',
        state: !row.enabled ? 'paused' : !credential ? 'error' : !credential.value ? 'unconfigured'
          : stale ? 'stale' : !same ? 'pending' : row.last_error_code ? 'error' : hasBalance ? 'ready' : 'pending',
        lastSuccessAt: hasBalance ? iso(row.last_success_at) : null,
        lastAttemptAt: same ? iso(row.last_attempt_at) : null,
        nextCheckAt: row.enabled ? iso(row.next_check_at) : null,
        errorCode: same ? row.last_error_code : null,
        ...(row.provider_key === 'tikhub' ? { dailySpend: {
          enabled: row.daily_spend_enabled, threshold: row.daily_spend_threshold,
          dayStartHour: row.daily_spend_day_start_hour,
          amount: currentDaily?.amount ?? null, ...currentDay,
          baselineAt: currentDaily?.baselineAt ?? null, observedAt: currentDaily?.observedAt ?? null,
          partial: currentDaily?.partial ?? true,
          state: !row.enabled || !row.daily_spend_enabled ? 'paused' : stale || row.last_error_code ? 'stale' : currentDaily ? 'ready' : 'pending',
          exceeded: Boolean(currentDaily && dailySpendExceeded(currentDaily.amount, row.daily_spend_threshold)),
        } } : {}),
      }
    }))
    return { available: true, items }
  }

  async update(provider, input) {
    if (!BALANCE_PROVIDERS[provider]) throw new AppError(404, 'balance_provider_unsupported', '该平台尚未接入余额查询')
    if (!this.pool) throw new AppError(503, 'balance_monitor_unavailable', '余额监控需要 PostgreSQL')
    const policy = balancePolicy(input)
    if (provider !== 'tikhub' && Object.keys(input).some(key => key.startsWith('dailySpend'))) {
      throw new AppError(400, 'invalid_balance_policy', '日消费估算暂仅支持 TikHub')
    }
    await this.transaction(async client => {
      const { rows } = await client.query(`SELECT *,now() AS server_now FROM external_platform.balance_monitors
        WHERE provider_key=$1 FOR UPDATE`, [provider])
      const previous = rows[0]
      if (!previous || previous.revision !== policy.expectedRevision) throw new AppError(409, 'balance_policy_conflict', '监控设置已变化，请刷新后重试')
      const balanceSchedule = policy.balanceSchedule ?? previous.balance_schedule
      const feishuSchedule = policy.feishuSchedule ?? (policy.feishuReminderMinutes == null ? previous.feishu_schedule
        : { mode: 'interval', minutes: policy.feishuReminderMinutes })
      const nextCheck = nextMonitorRun(balanceSchedule, previous.server_now,
        JSON.stringify(balanceSchedule) === JSON.stringify(previous.balance_schedule) ? previous.next_check_at : previous.server_now)
      const result = await client.query(`UPDATE external_platform.balance_monitors
        SET enabled=$2, warning_threshold=$3, critical_threshold=$4,
          feishu_webhook=CASE WHEN $6 THEN $7 ELSE feishu_webhook END,
          feishu_reminder_minutes=COALESCE($8,feishu_reminder_minutes),
          balance_schedule=$9::jsonb, feishu_schedule=$10::jsonb,
          revision=revision+1, next_check_at=$11,
          lease_token=NULL, lease_until=NULL, updated_at=now()
        WHERE provider_key=$1 AND revision=$5 RETURNING revision`, [provider, policy.enabled,
        policy.warningThreshold, policy.criticalThreshold, policy.expectedRevision,
        policy.webhook.set, policy.webhook.value, feishuSchedule.mode === 'interval' ? feishuSchedule.minutes : null,
        JSON.stringify(balanceSchedule), JSON.stringify(feishuSchedule), nextCheck])
      if (!result.rowCount) throw new AppError(409, 'balance_policy_conflict', '监控设置已变化，请刷新后重试')
      const dailyEnabled = policy.dailySpendEnabled ?? previous.daily_spend_enabled
      const dailyHour = policy.dailySpendDayStartHour ?? previous.daily_spend_day_start_hour
      const dailyReset = dailyEnabled !== previous.daily_spend_enabled || dailyHour !== previous.daily_spend_day_start_hour
        || policy.enabled !== previous.enabled
      await client.query(`UPDATE external_platform.balance_monitors SET daily_spend_enabled=$2,
        daily_spend_threshold=$3,daily_spend_day_start_hour=$4,
        daily_spend_state=CASE WHEN $5 THEN NULL ELSE daily_spend_state END WHERE provider_key=$1`,
      [provider, dailyEnabled, policy.dailySpendThreshold ?? previous.daily_spend_threshold, dailyHour, dailyReset])
      // New settings require a new observation before sending; day changes and
      // pauses retire the former window without claiming refunded consumption.
      if (dailyReset || (policy.dailySpendThreshold != null && decimalAmount(policy.dailySpendThreshold).units !== decimalAmount(previous.daily_spend_threshold).units)) {
        await this.closeDailyAlerts(client, provider, previous.server_now, 'policy_changed')
      }
      if (JSON.stringify(feishuSchedule) !== JSON.stringify(previous.feishu_schedule)) {
        const incidents = await client.query(`SELECT id,notified_at FROM notifications.incidents
          WHERE source=$1 AND code=ANY($2) AND status <> 'closed' AND notified_at IS NOT NULL FOR UPDATE`,
        [provider, [BALANCE_INCIDENT_CODE, PROBE_INCIDENT_CODE, DAILY_SPEND_INCIDENT_CODE]])
        for (const incident of incidents.rows) {
          const after = feishuSchedule.mode === 'cron' ? previous.server_now : incident.notified_at
          await client.query('UPDATE notifications.incidents SET next_reminder_at=$2 WHERE id=$1',
            [incident.id, nextMonitorRun(feishuSchedule, after)])
        }
      }
      // The audit record keeps what changed, never the hook itself.
      const { webhook, feishuWebhook: _raw, ...audited } = policy
      await client.query(`INSERT INTO external_platform.balance_monitor_settings_events(provider_key,revision,settings)
        VALUES ($1,$2,$3::jsonb)`, [provider, result.rows[0].revision, JSON.stringify({
        ...audited,
        feishuWebhook: !webhook.set ? 'unchanged' : webhook.value ? `set:${webhookHint(webhook.value)}` : 'cleared',
      })])
    })
    void this.timer?.refresh()
    this.onScheduleChanged?.()
    return (await this.list()).items.find(item => item.provider === provider)
  }

  async revealWebhook(provider) {
    if (!BALANCE_PROVIDERS[provider]) throw new AppError(404, 'balance_provider_unsupported', '该平台尚未接入余额查询')
    if (!this.pool) throw new AppError(503, 'balance_monitor_unavailable', '余额监控需要 PostgreSQL')
    return this.transaction(async client => {
      const { rows } = await client.query(`SELECT feishu_webhook,revision FROM external_platform.balance_monitors
        WHERE provider_key=$1`, [provider])
      const row = rows[0]
      if (!row?.feishu_webhook) throw new AppError(404, 'feishu_webhook_unconfigured', '该平台尚未配置飞书机器人地址')
      await client.query(`INSERT INTO external_platform.balance_monitor_settings_events(provider_key,revision,settings)
        VALUES ($1,$2,$3::jsonb)`, [provider, row.revision, JSON.stringify({ action: 'feishu_webhook_revealed' })])
      return { provider, feishuWebhook: row.feishu_webhook }
    })
  }

  async checkProvider(provider) {
    const lease = randomUUID()
    // Missed slots after downtime are skipped, not replayed at arbitrary times.
    // A five-minute grace window tolerates scheduler/database delays.
    const claimed = await this.transaction(async client => {
      const { rows } = await client.query(`SELECT *,now() AS server_now FROM external_platform.balance_monitors
        WHERE provider_key=$1 AND enabled AND next_check_at <= now()
          AND (lease_until IS NULL OR lease_until < now()) FOR UPDATE SKIP LOCKED`, [provider])
      const row = rows[0]
      if (!row) return false
      const missed = new Date(row.server_now) - new Date(row.next_check_at) >= 5 * 60_000
      const next = nextMonitorRun(row.balance_schedule ?? DEFAULT_BALANCE_SCHEDULE, row.server_now, row.next_check_at)
      await client.query(`UPDATE external_platform.balance_monitors
        SET next_check_at=$2,lease_token=$3,lease_until=CASE WHEN $3::uuid IS NULL THEN NULL ELSE now()+interval '2 minutes' END
        WHERE provider_key=$1`, [provider, next, missed ? null : lease])
      return !missed
    })
    if (!claimed) return
    let credential
    let result
    try {
      credential = await this.credential(provider)
      result = await queryProviderBalance(provider, credential.value, {
        fetchImpl: this.fetchers[provider], signal: this.abort.signal,
      })
    } catch (error) {
      result = { errorCode: /^balance_[a-z_]+$/.test(error?.code) || error?.code === 'invalid_balance'
        ? error.code : 'balance_query_failed' }
    }
    // A slot is consumed before network I/O: errors, crashes and credential
    // rotation cannot cause another request in the same scheduled slot.
    // Discard in-flight results for a replaced account, then await the next slot.
    const current = await this.credential(provider).catch(() => null)
    if (credential && current?.scope !== credential.scope) {
      await this.pool.query(`UPDATE external_platform.balance_monitors SET lease_token=NULL,lease_until=NULL
        WHERE provider_key=$1 AND lease_token=$2`, [provider, lease])
      return
    }
    await this.saveObservation(provider, lease, credential?.scope || null, result)
    this.onScheduleChanged?.()
  }

  async saveObservation(provider, lease, scope, result) {
    await this.transaction(async client => {
      const locked = await client.query(`SELECT * FROM external_platform.balance_monitors
        WHERE provider_key=$1 AND lease_token=$2 AND lease_until > now() AND enabled FOR UPDATE`, [provider, lease])
      const row = locked.rows[0]
      if (!row) return // Superseded settings/lease cannot overwrite new evidence.
      scope ||= row.credential_scope || 'unavailable'
      const id = randomUUID()
      const observed = await client.query(`INSERT INTO external_platform.balance_observations
        (id,provider_key,credential_scope,currency,balance,error_code)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING observed_at`, [id, provider, scope, row.currency,
        result.balance ?? null, result.errorCode ?? null])
      const at = observed.rows[0].observed_at
      await client.query(`UPDATE external_platform.balance_monitors
        SET last_attempt_at=$3, last_error_code=$4, credential_scope=$5,
          last_balance=CASE WHEN $6::numeric IS NOT NULL THEN $6 WHEN credential_scope=$5 THEN last_balance ELSE NULL END,
          last_success_at=CASE WHEN $6::numeric IS NOT NULL THEN $3 WHEN credential_scope=$5 THEN last_success_at ELSE NULL END,
          daily_spend_state=CASE WHEN credential_scope=$5 THEN daily_spend_state ELSE NULL END,
          lease_token=NULL, lease_until=NULL
        WHERE provider_key=$1 AND lease_token=$2`, [provider, lease, at, result.errorCode ?? null, scope, result.balance ?? null])
      if (result.balance == null) {
        // Unknown is neither zero nor recovery, but it is not nothing either: a
        // monitor that cannot read a balance has stopped protecting anything.
        await this.recordProbeFailure(client, row, { id, at, scope, errorCode: result.errorCode })
        return
      }
      await this.recordProbeRecovery(client, row, { id, at })
      await this.recordAlert(client, row, { id, at, scope, balance: result.balance })
      if (provider === 'tikhub' && row.daily_spend_enabled) {
        const previous = row.credential_scope === scope ? row.daily_spend_state : null
        const daily = advanceDailySpend(previous, { at, balance: result.balance, dayStartHour: row.daily_spend_day_start_hour })
        await client.query('UPDATE external_platform.balance_monitors SET daily_spend_state=$2::jsonb WHERE provider_key=$1',
          [provider, JSON.stringify(daily)])
        await this.recordDailyAlert(client, row, { id, at, scope, daily: daily.previousWindow ?? daily })
      }
    })
  }

  async closeDailyAlerts(client, provider, at, reason, keep = null) {
    const { rows } = await client.query(`SELECT i.id FROM notifications.incidents i
      LEFT JOIN LATERAL (SELECT evidence FROM notifications.events WHERE incident_id=i.id
        AND kind='daily_spend_observed' ORDER BY id DESC LIMIT 1) e ON true
      WHERE i.source=$1 AND i.code=$2 AND i.status <> 'closed'
        AND ($3::text IS NULL OR i.source_scope<>$3 OR e.evidence->>'windowStart' IS DISTINCT FROM $4)
      FOR UPDATE OF i`, [provider, DAILY_SPEND_INCIDENT_CODE, keep?.scope ?? null, keep?.windowStart ?? null])
    for (const incident of rows) {
      await client.query("UPDATE notifications.incidents SET status='closed',updated_at=now() WHERE id=$1", [incident.id])
      await client.query(`INSERT INTO notifications.events(incident_id,kind,actor,evidence,occurred_at)
        VALUES ($1,'daily_spend_reset','monitor:daily-spend',$2::jsonb,$3)`, [incident.id, JSON.stringify({ reason }), at])
    }
  }

  async recordDailyAlert(client, row, { id, at, scope, daily }) {
    await this.closeDailyAlerts(client, row.provider_key, at, 'window_or_account_changed', { scope, windowStart: daily.windowStart })
    if (!dailySpendExceeded(daily.amount, row.daily_spend_threshold)) return
    const evidence = { amount: daily.amount, currency: row.currency, threshold: row.daily_spend_threshold,
      windowStart: daily.windowStart, windowEnd: daily.windowEnd, baselineAt: daily.baselineAt,
      observedAt: daily.observedAt, partial: daily.partial, dayStartHour: daily.dayStartHour }
    const { rows } = await client.query(`INSERT INTO notifications.incidents
      (category,severity,source,source_scope,code,title,first_occurred_at,last_occurred_at)
      VALUES ('supplier.cost','warning',$1,$2,$3,'TikHub 日消费估算超过阈值',$4,$4)
      ON CONFLICT (source,source_scope,code) WHERE status <> 'closed'
      DO UPDATE SET last_occurred_at=EXCLUDED.last_occurred_at,updated_at=now() RETURNING id`,
    [row.provider_key, scope, DAILY_SPEND_INCIDENT_CODE, at])
    // One mutable observation event per active daily incident. Delivery events
    // retain what was sent; sampling does not append another history row.
    const updated = await client.query(`UPDATE notifications.events SET evidence=$2::jsonb,occurred_at=$3,balance_observation_id=$4
      WHERE incident_id=$1 AND kind='daily_spend_observed' RETURNING id`, [rows[0].id, JSON.stringify(evidence), at, id])
    if (!updated.rowCount) await client.query(`INSERT INTO notifications.events
      (incident_id,kind,actor,evidence,occurred_at,balance_observation_id)
      VALUES ($1,'daily_spend_observed','monitor:daily-spend',$2::jsonb,$3,$4)`, [rows[0].id, JSON.stringify(evidence), at, id])
  }

  async pruneMonitoringHistory() {
    // Small indexed batches, only monitoring data; paid receipts and policy
    // audits are outside this retention policy. Each replica shares the lock.
    await this.transaction(async client => {
      const lock = await client.query('SELECT pg_try_advisory_xact_lock(129761,194) AS acquired')
      if (!lock.rows[0].acquired) return
      // Daily incident history, including handling notes, expires as a whole.
      // Keep unrelated administrative/paid-call audit records untouched.
      const expired = await client.query(`SELECT id FROM notifications.incidents
        WHERE code=$1 AND status='closed' AND updated_at < now()-interval '90 days'
        ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED`, [DAILY_SPEND_INCIDENT_CODE])
      if (expired.rows.length) {
        const ids = expired.rows.map(row => row.id)
        await client.query('DELETE FROM notifications.events WHERE incident_id=ANY($1::bigint[])', [ids])
        await client.query('DELETE FROM notifications.incidents WHERE id=ANY($1::bigint[])', [ids])
      }
      await client.query(`DELETE FROM notifications.events WHERE id IN (
        SELECT e.id FROM notifications.events e JOIN notifications.incidents i ON i.id=e.incident_id
        WHERE e.actor IN ('monitor:balance','monitor:daily-spend','notifier:feishu')
          AND e.occurred_at < now()-interval '90 days'
          AND i.code=ANY($1) AND (i.status='closed' OR EXISTS (
            SELECT 1 FROM notifications.events newer WHERE newer.incident_id=e.incident_id
              AND newer.kind=e.kind AND newer.id>e.id))
        ORDER BY e.occurred_at,e.id LIMIT 500)`, [[BALANCE_INCIDENT_CODE, PROBE_INCIDENT_CODE, DAILY_SPEND_INCIDENT_CODE]])
      await client.query(`DELETE FROM notifications.incidents WHERE id IN (
        SELECT i.id FROM notifications.incidents i WHERE i.code=ANY($1) AND i.status='closed'
          AND i.updated_at < now()-interval '90 days'
          AND NOT EXISTS (SELECT 1 FROM notifications.events e WHERE e.incident_id=i.id) LIMIT 100)`,
      [[BALANCE_INCIDENT_CODE, PROBE_INCIDENT_CODE, DAILY_SPEND_INCIDENT_CODE]])
      await client.query(`DELETE FROM external_platform.balance_observations WHERE id IN (
        SELECT id FROM external_platform.balance_observations WHERE observed_at < now()-interval '90 days'
        ORDER BY observed_at,id LIMIT 500)`)
    })
  }

  // One failed probe is usually a blip; two in a row means someone has to look.
  // `row` is the pre-update snapshot, so its error code is the previous attempt's
  // and no extra counter column is needed.
  async recordProbeFailure(client, row, observation) {
    const { id, at, scope, errorCode } = observation
    if (!row.last_error_code) return
    const evidence = JSON.stringify({ errorCode: errorCode || 'balance_query_failed',
      currency: row.currency, lastSuccessAt: row.last_success_at })
    const title = `${BALANCE_PROVIDERS[row.provider_key].name} 账户余额查询失败`
    const result = await client.query(`INSERT INTO notifications.incidents
      (category,severity,source,source_scope,code,title,first_occurred_at,last_occurred_at)
      VALUES ('supplier.cost','warning',$1,$2,$3,$4,$5,$5)
      ON CONFLICT (source,source_scope,code) WHERE status <> 'closed'
      DO UPDATE SET occurrence_count=notifications.incidents.occurrence_count+1,
        last_occurred_at=EXCLUDED.last_occurred_at,updated_at=now() RETURNING id`,
    [row.provider_key, scope, PROBE_INCIDENT_CODE, title, at])
    await client.query(`INSERT INTO notifications.events
      (incident_id,kind,actor,balance_observation_id,evidence,occurred_at)
      VALUES ($1,'probe_failed','monitor:balance',$2,$3::jsonb,$4)`, [result.rows[0].id, id, evidence, at])
  }

  // Any successful read proves the monitor works again, including after the
  // credential was replaced, so this closes by provider rather than by scope.
  async recordProbeRecovery(client, row, { id, at }) {
    const open = await client.query(`SELECT id FROM notifications.incidents
      WHERE source=$1 AND code=$2 AND status <> 'closed' FOR UPDATE`, [row.provider_key, PROBE_INCIDENT_CODE])
    for (const incident of open.rows) {
      await client.query(`UPDATE notifications.incidents
        SET status='closed',recovered_at=$2,updated_at=now() WHERE id=$1`, [incident.id, at])
      await client.query(`INSERT INTO notifications.events
        (incident_id,kind,actor,balance_observation_id,evidence,occurred_at)
        VALUES ($1,'probe_recovered','monitor:balance',$2,$3::jsonb,$4)`,
      [incident.id, id, JSON.stringify({ currency: row.currency }), at])
    }
  }

  async recordAlert(client, row, observation) {
    const { id, at, scope, balance } = observation
    const level = balanceLevel(balance, row.warning_threshold, row.critical_threshold)
    const existing = await client.query(`SELECT * FROM notifications.incidents
      WHERE source=$1 AND source_scope=$2 AND code=$3 AND status <> 'closed' FOR UPDATE`, [row.provider_key, scope, BALANCE_INCIDENT_CODE])
    let incident = existing.rows[0]
    if (level === 'healthy' && !incident) return
    const evidence = JSON.stringify({ balance, currency: row.currency, level,
      warningThreshold: row.warning_threshold, criticalThreshold: row.critical_threshold })
    if (level === 'healthy') {
      await client.query(`UPDATE notifications.incidents SET status='closed',recovered_at=$2,updated_at=now() WHERE id=$1`, [incident.id, at])
    } else {
      const title = `${BALANCE_PROVIDERS[row.provider_key].name} 账户余额${level === 'critical' ? '严重不足' : '偏低'}`
      const result = await client.query(`INSERT INTO notifications.incidents
        (category,severity,source,source_scope,code,title,first_occurred_at,last_occurred_at)
        VALUES ('supplier.cost',$1,$2,$3,$6,$4,$5,$5)
        ON CONFLICT (source,source_scope,code) WHERE status <> 'closed'
        DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,
          status=CASE WHEN notifications.incidents.severity='warning' AND EXCLUDED.severity='critical'
            THEN 'open' ELSE notifications.incidents.status END,
          occurrence_count=notifications.incidents.occurrence_count+1,
          last_occurred_at=EXCLUDED.last_occurred_at,updated_at=now() RETURNING *`, [level, row.provider_key, scope, title, at, BALANCE_INCIDENT_CODE])
      incident = result.rows[0]
    }
    await client.query(`INSERT INTO notifications.events
      (incident_id,kind,actor,balance_observation_id,evidence,occurred_at)
      VALUES ($1,$2,'monitor:balance',$3,$4::jsonb,$5)`, [incident.id,
      level === 'healthy' ? 'balance_recovered' : 'balance_observed', id, evidence, at])
  }

  collect() {
    if (!this.pool || this.abort.signal.aborted) return Promise.resolve()
    if (this.running) return this.running
    this.running = Promise.allSettled(Object.keys(BALANCE_PROVIDERS).map(provider => this.checkProvider(provider)))
      .then(async results => {
        if (results.some(result => result.status === 'rejected')) this.logger.warn('[balance-monitor] Collection failed; cached evidence retained')
        if (!this.lastPrunedAt || this.now() - this.lastPrunedAt >= 30 * 60_000) {
          this.lastPrunedAt = this.now()
          await this.pruneMonitoringHistory().catch(() => this.logger.warn('[balance-monitor] History cleanup deferred'))
        }
      }).finally(() => { this.running = null })
    return this.running
  }
  start() {
    if (!this.pool || this.timer) return
    this.timer = new MonitorCronTimer({ run: () => this.collect(), logger: this.logger, nextAt: async () => {
      const { rows } = await this.pool.query(`SELECT min(GREATEST(next_check_at,COALESCE(lease_until,next_check_at))) AS at
        FROM external_platform.balance_monitors WHERE enabled AND next_check_at > now()`)
      return rows[0]?.at
    } })
    this.timer.start()
  }
  async close() { this.abort.abort(); await this.timer?.close(); this.timer = null; await this.running }
}
