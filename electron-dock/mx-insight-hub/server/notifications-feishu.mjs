import { AppError } from './core/errors.mjs'
import { BALANCE_PROVIDERS } from './external-platforms/balance-adapters.mjs'
import { describeMonitorSchedule, nextMonitorRun } from '../shared/monitor-schedule.mjs'
import { MonitorCronTimer } from './monitor-cron-timer.mjs'

// Ported from the reviewed standalone /tmp/fee_monitor script: same webhook
// contract, configurable per-provider reminder spacing, same rule that only a confirmed bot
// reply starts the cooldown. What changes is where the state lives -- PostgreSQL
// instead of the script's state.json -- so reminders survive restarts and are
// not duplicated by a second replica. Hub is now the only sender; running the
// Python script alongside this would double-post to the same group.
//
// Bot hooks are operator policy on the balance monitor row, not deployment
// environment. They are re-read on every pass, so changing one in the console
// takes effect on the next pass without restarting or redeploying anything.
const FAILURE_AUDIT_INTERVAL_SECONDS = 60 * 60
export const BALANCE_INCIDENT_CODE = 'supplier_balance_low'
export const PROBE_INCIDENT_CODE = 'supplier_balance_unreadable'
const ALERT_CODES = [BALANCE_INCIDENT_CODE, PROBE_INCIDENT_CODE]
const HOOK_PREFIX = '/open-apis/bot/v2/hook/'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 65_536
const LEASE_SECONDS = 120
const BATCH_SIZE = 20

// Fixed origin and path shape, mirroring the balance adapters. A webhook is a
// credential: only the explicit reauthenticated Admin reveal returns its value.
export function feishuWebhook(value) {
  // Absent means "this group is not configured". A value of the wrong type is a
  // mistake, and is reported rather than quietly disabling the group.
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new AppError(400, 'invalid_feishu_webhook', 'invalid_feishu_webhook')
  if (!value.trim()) return null
  let url
  try { url = new URL(value.trim()) } catch { throw new AppError(400, 'invalid_feishu_webhook', 'invalid_feishu_webhook') }
  const id = url.pathname.startsWith(HOOK_PREFIX) ? url.pathname.slice(HOOK_PREFIX.length) : ''
  if (url.protocol !== 'https:' || url.host !== 'open.feishu.cn'
      || !id || id.includes('/') || url.search || url.hash) {
    throw new AppError(400, 'invalid_feishu_webhook', 'invalid_feishu_webhook')
  }
  return url.href
}

// A short, non-identifying tail so two bots can be told apart in the console.
export function webhookHint(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const id = value.trim().split('/').pop()
  return id.length > 6 ? `…${id.slice(-6)}` : id
}

const decimalText = value => String(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
const unitOf = currency => currency === 'USD' ? '美元' : currency === 'CNY' ? '元' : currency
const money = (amount, currency) => `${decimalText(amount)} ${unitOf(currency)}（${currency}）`
const beijing = at => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(at).replace(/\//g, '-')

const nameOf = provider => BALANCE_PROVIDERS[provider]?.name || provider

// Both bots are keyword-gated on 「额度」; a message without it is dropped by
// Feishu with a success-shaped reply, so the keyword stays in the first line of
// every message this module can produce.
export function alertText(provider, code, evidence, observedAt, reminderMinutes = 60) {
  const reminder = typeof reminderMinutes === 'number' ? `每 ${reminderMinutes} 分钟提醒一次`
    : `按「${describeMonitorSchedule(reminderMinutes)}」重复提醒（北京时间）`
  const { balance, currency, level, warningThreshold, criticalThreshold, errorCode, lastSuccessAt } = evidence
  if (code === PROBE_INCIDENT_CODE) {
    return [
      `【额度告警】${nameOf(provider)} 余额查询失败`,
      '连续两次无法读取账户余额，余额监控当前失效。',
      `失败原因：${errorCode || 'balance_query_failed'}`,
      `最近成功：${lastSuccessAt ? `${beijing(new Date(lastSuccessAt))}（北京时间）` : '尚无成功查询'}`,
      `检查时间：${beijing(observedAt)}（北京时间）`,
      `请检查平台凭证与网络。持续不可读时，${reminder}。`,
    ].join('\n')
  }
  return [
    `【额度告警】${nameOf(provider)} 账户余额${level === 'critical' ? '严重不足' : '偏低'}`,
    `当前余额：${money(balance, currency)}`,
    `提醒阈值：低于 ${money(warningThreshold, currency)}`,
    `严重阈值：低于 ${money(criticalThreshold, currency)}`,
    `检查时间：${beijing(observedAt)}（北京时间）`,
    `请及时充值。余额持续不足时，${reminder}。`,
  ].join('\n')
}

// Sent only for an incident the group was actually told about, so a recovery
// never arrives for a problem nobody heard of.
export function recoveryText(provider, code, evidence, recoveredAt) {
  const { balance, currency, warningThreshold } = evidence || {}
  if (code === PROBE_INCIDENT_CODE) {
    return [
      `【额度监控恢复】${nameOf(provider)} 余额查询已恢复`,
      '已能重新读取账户余额，余额监控恢复正常。',
      `恢复时间：${beijing(recoveredAt)}（北京时间）`,
    ].join('\n')
  }
  return [
    `【额度恢复】${nameOf(provider)} 账户余额已恢复`,
    balance != null ? `当前余额：${money(balance, currency)}` : '余额已回到提醒阈值以上。',
    warningThreshold != null ? `提醒阈值：低于 ${money(warningThreshold, currency)}` : null,
    `恢复时间：${beijing(recoveredAt)}（北京时间）`,
  ].filter(Boolean).join('\n')
}

export class FeishuAlertNotifier {
  constructor({ pool, fetchImpl, logger = console, now = () => Date.now() }) {
    this.pool = pool
    this.logger = logger
    this.now = now
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args))
    this.running = null
    this.timer = null
    this.abort = new AbortController()
  }

  async send(webhook, text) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(webhook, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text } }),
        signal: AbortSignal.any([this.abort.signal, controller.signal]),
      })
      if (!response.ok) { await response.body?.cancel(); throw new AppError(502, 'notify_http_error', 'notify_http_error') }
      const body = await response.text()
      if (body.length > MAX_RESPONSE_BYTES) throw new AppError(502, 'notify_response_too_large', 'notify_response_too_large')
      let payload
      try { payload = JSON.parse(body) } catch { throw new AppError(502, 'notify_invalid_json', 'notify_invalid_json') }
      // Only an explicit success reply starts the cooldown. Anything else is
      // retried on the next pass rather than silently swallowing a reminder.
      if (payload?.code !== 0) throw new AppError(502, 'notify_rejected', 'notify_rejected')
    } catch (error) {
      // The webhook is the credential and fetch puts the URL in its message.
      if (error instanceof AppError) throw error
      throw new AppError(502, 'notify_network_error', 'notify_network_error')
    } finally { clearTimeout(timeout) }
  }

  // Candidates: an open balance incident that has never been delivered, whose
  // reminder window has elapsed, or that escalated to critical since the last
  // delivery. A de-escalation back to warning deliberately waits out the window.
  async candidates() {
    const { rows } = await this.pool.query(`
      SELECT i.id, i.source, i.code, i.severity, i.last_occurred_at, i.notified_severity,
             m.feishu_webhook, m.feishu_schedule, e.evidence
      FROM notifications.incidents i
      JOIN external_platform.balance_monitors m ON m.provider_key = i.source
      LEFT JOIN LATERAL (
        SELECT evidence FROM notifications.events
        WHERE incident_id = i.id AND kind IN ('balance_observed','probe_failed') AND evidence IS NOT NULL
        ORDER BY id DESC LIMIT 1
      ) e ON true
      WHERE i.code = ANY($1) AND i.status <> 'closed'
        AND (i.notify_lease_until IS NULL OR i.notify_lease_until < now())
        AND (i.notified_at IS NULL
          OR i.next_reminder_at IS NULL OR i.next_reminder_at <= now()
          OR (i.notified_severity = 'warning' AND i.severity = 'critical'))
      ORDER BY i.id LIMIT $2`, [ALERT_CODES, BATCH_SIZE])
    return rows
  }

  // A recovery is announced once, and only for an incident whose problem was
  // announced. `recovered_at` is set by the monitor, never by a manual closure,
  // so closing an incident by hand stays silent.
  //
  // `merged` marks a probe recovery that the same provider's balance recovery is
  // about to cover. A restored balance already proves reads work, so sending
  // both would be two messages for one event.
  async recoveries() {
    const { rows } = await this.pool.query(`
      SELECT i.id, i.source, i.code, i.recovered_at, m.feishu_webhook, e.evidence,
             (i.code = $3 AND EXISTS (
               SELECT 1 FROM notifications.incidents balance
               WHERE balance.source = i.source AND balance.code = $4
                 AND balance.status = 'closed' AND balance.recovered_at IS NOT NULL
                 AND balance.notified_at IS NOT NULL AND balance.recovery_notified_at IS NULL
             )) AS merged
      FROM notifications.incidents i
      JOIN external_platform.balance_monitors m ON m.provider_key = i.source
      LEFT JOIN LATERAL (
        SELECT evidence FROM notifications.events
        WHERE incident_id = i.id AND kind IN ('balance_recovered','probe_recovered')
        ORDER BY id DESC LIMIT 1
      ) e ON true
      WHERE i.code = ANY($1) AND i.status = 'closed'
        AND i.recovered_at IS NOT NULL AND i.notified_at IS NOT NULL
        AND i.recovery_notified_at IS NULL
        AND (i.notify_lease_until IS NULL OR i.notify_lease_until < now())
      ORDER BY i.id LIMIT $2`, [ALERT_CODES, BATCH_SIZE, PROBE_INCIDENT_CODE, BALANCE_INCIDENT_CODE])
    return rows
  }

  async claim(id, recovery = false) {
    return this.transaction(async client => {
      const { rows } = await client.query(`SELECT i.*,m.feishu_schedule,m.feishu_webhook,now() AS server_now,e.evidence
        FROM notifications.incidents i JOIN external_platform.balance_monitors m ON m.provider_key=i.source
        LEFT JOIN LATERAL (SELECT evidence FROM notifications.events WHERE incident_id=i.id
          AND kind=ANY($2) ORDER BY id DESC LIMIT 1) e ON true
        WHERE i.id=$1 AND (i.notify_lease_until IS NULL OR i.notify_lease_until < now())
        FOR UPDATE OF i SKIP LOCKED`, [id, recovery ? ['balance_recovered', 'probe_recovered'] : ['balance_observed', 'probe_failed']])
      const row = rows[0]
      if (!row) return false
      if (recovery) {
        if (row.status !== 'closed' || !row.recovered_at || !row.notified_at || row.recovery_notified_at) return false
      } else {
        if (row.status === 'closed') return false
        const escalated = row.notified_severity === 'warning' && row.severity === 'critical'
        if (row.notified_at && !escalated) {
          const due = row.next_reminder_at ?? nextMonitorRun(row.feishu_schedule, row.notified_at)
          if (!row.next_reminder_at) await client.query('UPDATE notifications.incidents SET next_reminder_at=$2 WHERE id=$1', [id, due])
          // Fixed-time reminders missed during downtime are skipped, not sent
          // at an unrelated time. A rolling interval retains its elapsed policy.
          if (row.feishu_schedule.mode === 'cron' && new Date(row.server_now) - new Date(due) >= 5 * 60_000) {
            await client.query('UPDATE notifications.incidents SET next_reminder_at=$2 WHERE id=$1',
              [id, nextMonitorRun(row.feishu_schedule, row.server_now)])
            return false
          }
          if (new Date(due) > new Date(row.server_now)) return false
        }
      }
      await client.query('UPDATE notifications.incidents SET notify_lease_until=now()+make_interval(secs => $2) WHERE id=$1', [id, LEASE_SECONDS])
      return row
    })
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

  // Covered by the balance recovery in this pass: marked delivered so it cannot
  // resurface later as a second message, with the reason kept in the timeline.
  async mergedRecovery(id) {
    await this.pool.query(`UPDATE notifications.incidents
      SET recovery_notified_at = now(), notify_lease_until = NULL, updated_at = now()
      WHERE id = $1`, [id])
    await this.pool.query(`INSERT INTO notifications.events
      (incident_id, kind, actor, evidence, occurred_at)
      VALUES ($1, 'notify_merged', 'notifier:feishu', $2::jsonb, now())`,
    [id, JSON.stringify({ channel: 'feishu', delivery: 'recovery', mergedInto: BALANCE_INCIDENT_CODE })])
  }

  async recovered(id, evidence) {
    await this.pool.query(`UPDATE notifications.incidents
      SET recovery_notified_at = now(), notify_lease_until = NULL, updated_at = now()
      WHERE id = $1`, [id])
    await this.pool.query(`INSERT INTO notifications.events
      (incident_id, kind, actor, evidence, occurred_at)
      VALUES ($1, 'notified', 'notifier:feishu', $2::jsonb, now())`,
    [id, JSON.stringify({ channel: 'feishu', delivery: 'recovery', ...evidence })])
  }

  async succeeded(id, severity, evidence) {
    await this.transaction(async client => {
      // Match policy-write lock order (monitor, then incident), and calculate
      // from the actual successful reply using the latest committed policy.
      const { rows } = await client.query(`SELECT m.feishu_schedule,now() AS server_now
        FROM external_platform.balance_monitors m JOIN notifications.incidents i ON i.source=m.provider_key
        WHERE i.id=$1 FOR UPDATE OF m`, [id])
      const next = nextMonitorRun(rows[0].feishu_schedule, rows[0].server_now)
      await client.query(`UPDATE notifications.incidents
        SET notified_at=now(),notified_severity=$2,next_reminder_at=$3,notify_lease_until=NULL,updated_at=now()
        WHERE id=$1`, [id, severity, next])
      await client.query(`INSERT INTO notifications.events
        (incident_id,kind,actor,evidence,occurred_at) VALUES ($1,'notified','notifier:feishu',$2::jsonb,now())`,
      [id, JSON.stringify({ channel: 'feishu', severity, ...evidence })])
    })
  }

  // A failing webhook must not append an event every pass. One record per hour
  // per incident is enough for an operator to see why the group went quiet.
  async failed(id, errorCode) {
    await this.pool.query(`UPDATE notifications.incidents
      SET notify_lease_until = NULL WHERE id = $1`, [id])
    await this.pool.query(`INSERT INTO notifications.events
      (incident_id, kind, actor, evidence, occurred_at)
      SELECT $1, 'notify_failed', 'notifier:feishu', $2::jsonb, now()
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications.events
        WHERE incident_id = $1 AND kind = 'notify_failed'
          AND occurred_at > now() - make_interval(secs => $3))`,
    [id, JSON.stringify({ channel: 'feishu', errorCode }), FAILURE_AUDIT_INTERVAL_SECONDS])
  }

  // Each provider is handled on its own. A missing, broken or unreachable hook
  // for one platform never stops the other from being delivered, and never
  // consumes the other's reminder window.
  async deliverOne(row, { text, record, requireEvidence, recovery = false }) {
    const claimed = await this.claim(row.id, recovery)
    if (!claimed) return
    row = claimed
    let webhook
    // Re-validated at the point of use: the stored value is operator input, and
    // a bad one must disable that single group rather than the pass.
    try { webhook = feishuWebhook(row.feishu_webhook) }
    catch { return this.failed(row.id, 'notify_webhook_invalid') }
    if (!webhook) return this.failed(row.id, 'notify_webhook_unconfigured')
    if (requireEvidence && !row.evidence) return this.failed(row.id, 'notify_evidence_missing')
    try {
      await this.send(webhook, text(row))
      await record(row)
    } catch (error) {
      await this.failed(row.id, error instanceof AppError ? error.code : 'notify_failed')
    }
  }

  async deliverBatch() {
    for (const row of await this.candidates()) {
      if (this.abort.signal.aborted) return
      try {
        await this.deliverOne(row, {
          requireEvidence: true,
          text: current => alertText(current.source, current.code, current.evidence, new Date(current.last_occurred_at), current.feishu_schedule),
          record: current => this.succeeded(current.id, current.severity, current.evidence),
        })
      } catch {
        this.logger.warn('[feishu] Delivery pass failed for one incident; other providers are unaffected')
      }
    }
    for (const row of await this.recoveries()) {
      if (this.abort.signal.aborted) return
      try {
        if (row.merged) { await this.mergedRecovery(row.id); continue }
        await this.deliverOne(row, {
          requireEvidence: false,
          recovery: true,
          text: current => recoveryText(current.source, current.code, current.evidence, new Date(current.recovered_at)),
          record: current => this.recovered(current.id, current.evidence || {}),
        })
      } catch {
        this.logger.warn('[feishu] Recovery pass failed for one incident; other providers are unaffected')
      }
    }
  }

  deliver() {
    if (!this.pool || this.abort.signal.aborted) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.deliverBatch()
      .catch(() => { this.logger.warn('[feishu] Delivery pass failed; reminders are retried on the next pass') })
      .finally(() => { this.running = null })
    return this.running
  }

  start() {
    if (!this.pool || this.timer) return
    this.timer = new MonitorCronTimer({ run: () => this.deliver(), logger: this.logger, nextAt: async () => {
      const { rows } = await this.pool.query(`SELECT min(GREATEST(next_reminder_at,COALESCE(notify_lease_until,next_reminder_at))) AS at
        FROM notifications.incidents WHERE status <> 'closed' AND code=ANY($1) AND next_reminder_at > now()`, [ALERT_CODES])
      return rows[0]?.at
    } })
    this.timer.start()
  }

  async close() { this.abort.abort(); await this.timer?.close(); this.timer = null; await this.running }
}
