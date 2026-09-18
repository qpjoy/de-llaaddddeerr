import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { BALANCE_PROVIDERS, balanceLevel, decimalAmount, queryProviderBalance } from './balance-adapters.mjs'
import { BALANCE_INCIDENT_CODE, PROBE_INCIDENT_CODE, feishuWebhook, webhookHint } from '../notifications-feishu.mjs'

export function balancePolicy(input) {
  const fields = ['enabled', 'warningThreshold', 'criticalThreshold', 'expectedRevision', 'feishuWebhook']
  try {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))
      || typeof input.enabled !== 'boolean'
      || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw Error()
    const warning = decimalAmount(input.warningThreshold)
    const critical = decimalAmount(input.criticalThreshold)
    if (critical.units < 0n || warning.units <= critical.units) throw Error()
    // Absent means "leave the stored hook alone": the console never receives the
    // current value, so it cannot echo one back on an ordinary threshold save.
    // An explicit empty string clears it and stops notifying that group.
    const webhook = 'feishuWebhook' in input
      ? { set: true, value: feishuWebhook(input.feishuWebhook) }
      : { set: false, value: null }
    return { ...input, warningThreshold: warning.text, criticalThreshold: critical.text, webhook }
  } catch (error) {
    if (error?.code === 'invalid_feishu_webhook') {
      throw new AppError(400, 'invalid_feishu_webhook', '飞书机器人地址需为 https://open.feishu.cn/open-apis/bot/v2/hook/<id>，留空表示不修改')
    }
    throw new AppError(400, 'invalid_balance_policy', '有效阈值需满足 0 ≤ 严重阈值 < 提醒阈值；固定北京时间每小时整点检查')
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
      return {
        provider: row.provider_key, displayName: BALANCE_PROVIDERS[row.provider_key].name,
        currency: row.currency, enabled: row.enabled, revision: row.revision,
        warningThreshold: row.warning_threshold, criticalThreshold: row.critical_threshold,
        schedule: { timeZone: 'Asia/Shanghai', cadence: 'hourly' },
        // The hook is secret-bearing, so only whether one is set and a short
        // tail to tell two bots apart ever leave the service.
        feishu: { configured: Boolean(row.feishu_webhook), hint: webhookHint(row.feishu_webhook) },
        balance: hasBalance ? row.last_balance : null,
        level: hasBalance ? balanceLevel(row.last_balance, row.warning_threshold, row.critical_threshold) : 'unknown',
        state: !row.enabled ? 'paused' : !credential ? 'error' : !credential.value ? 'unconfigured'
          : stale ? 'stale' : !same ? 'pending' : row.last_error_code ? 'error' : hasBalance ? 'ready' : 'pending',
        lastSuccessAt: hasBalance ? iso(row.last_success_at) : null,
        lastAttemptAt: same ? iso(row.last_attempt_at) : null,
        nextCheckAt: row.enabled ? iso(row.next_check_at) : null,
        errorCode: same ? row.last_error_code : null,
      }
    }))
    return { available: true, items }
  }

  async update(provider, input) {
    if (!BALANCE_PROVIDERS[provider]) throw new AppError(404, 'balance_provider_unsupported', '该平台尚未接入余额查询')
    if (!this.pool) throw new AppError(503, 'balance_monitor_unavailable', '余额监控需要 PostgreSQL')
    const policy = balancePolicy(input)
    await this.transaction(async client => {
      const result = await client.query(`UPDATE external_platform.balance_monitors
        SET enabled=$2, warning_threshold=$3, critical_threshold=$4,
          feishu_webhook=CASE WHEN $6 THEN $7 ELSE feishu_webhook END,
          revision=revision+1, next_check_at=external_platform.next_balance_check(now()),
          lease_token=NULL, lease_until=NULL, updated_at=now()
        WHERE provider_key=$1 AND revision=$5 RETURNING revision`, [provider, policy.enabled,
        policy.warningThreshold, policy.criticalThreshold, policy.expectedRevision,
        policy.webhook.set, policy.webhook.value])
      if (!result.rowCount) throw new AppError(409, 'balance_policy_conflict', '监控设置已变化，请刷新后重试')
      // The audit record keeps what changed, never the hook itself.
      const { webhook, feishuWebhook: _raw, ...audited } = policy
      await client.query(`INSERT INTO external_platform.balance_monitor_settings_events(provider_key,revision,settings)
        VALUES ($1,$2,$3::jsonb)`, [provider, result.rows[0].revision, JSON.stringify({
        ...audited,
        feishuWebhook: !webhook.set ? 'unchanged' : webhook.value ? `set:${webhookHint(webhook.value)}` : 'cleared',
      })])
    })
    return (await this.list()).items.find(item => item.provider === provider)
  }

  async checkProvider(provider) {
    const lease = randomUUID()
    // Missed slots after downtime are skipped, not replayed at arbitrary times.
    // A five-minute grace window tolerates scheduler/database delays.
    await this.pool.query(`UPDATE external_platform.balance_monitors
      SET next_check_at=external_platform.next_balance_check(now())
      WHERE provider_key=$1 AND enabled AND next_check_at <= now()-interval '5 minutes'
        AND (lease_until IS NULL OR lease_until < now())`, [provider])
    const claimed = await this.pool.query(`UPDATE external_platform.balance_monitors
      SET lease_token=$2, lease_until=now()+interval '2 minutes',
        next_check_at=external_platform.next_balance_check(now())
      WHERE provider_key=$1 AND enabled AND next_check_at <= now()
        AND next_check_at > now()-interval '5 minutes'
        AND (lease_until IS NULL OR lease_until < now()) RETURNING *`, [provider, lease])
    if (!claimed.rows[0]) return
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
      .then(results => {
        if (results.some(result => result.status === 'rejected')) this.logger.warn('[balance-monitor] Collection failed; cached evidence retained')
      }).finally(() => { this.running = null })
    return this.running
  }
  start() {
    if (!this.pool || this.timer) return
    void this.collect()
    this.timer = setInterval(() => { void this.collect() }, 60_000)
    this.timer.unref?.()
  }
  async close() { clearInterval(this.timer); this.timer = null; this.abort.abort(); await this.running }
}
