import { AppError } from './core/errors.mjs'
import { BALANCE_PROVIDERS } from './external-platforms/balance-adapters.mjs'

// Ported from the reviewed standalone /tmp/fee_monitor script: same webhook
// contract, same one-hour reminder spacing, same rule that only a confirmed bot
// reply starts the cooldown. What changes is where the state lives -- PostgreSQL
// instead of the script's state.json -- so reminders survive restarts and are
// not duplicated by a second replica. Hub is now the only sender; running the
// Python script alongside this would double-post to the same group.
//
// Bot hooks are operator policy on the balance monitor row, not deployment
// environment. They are re-read on every pass, so changing one in the console
// takes effect on the next pass without restarting or redeploying anything.
export const REMINDER_INTERVAL_MS = 60 * 60 * 1000
export const BALANCE_INCIDENT_CODE = 'supplier_balance_low'
export const PROBE_INCIDENT_CODE = 'supplier_balance_unreadable'
const ALERT_CODES = [BALANCE_INCIDENT_CODE, PROBE_INCIDENT_CODE]
const HOOK_PREFIX = '/open-apis/bot/v2/hook/'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 65_536
const LEASE_SECONDS = 120
const BATCH_SIZE = 20

// Fixed origin and path shape, mirroring the balance adapters. A webhook is a
// credential: it is never logged, never persisted and never returned by an API.
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
export function alertText(provider, code, evidence, observedAt) {
  const { balance, currency, level, warningThreshold, criticalThreshold, errorCode, lastSuccessAt } = evidence
  if (code === PROBE_INCIDENT_CODE) {
    return [
      `【额度告警】${nameOf(provider)} 余额查询失败`,
      '连续两次无法读取账户余额，余额监控当前失效。',
      `失败原因：${errorCode || 'balance_query_failed'}`,
      `最近成功：${lastSuccessAt ? `${beijing(new Date(lastSuccessAt))}（北京时间）` : '尚无成功查询'}`,
      `检查时间：${beijing(observedAt)}（北京时间）`,
      '请检查平台凭证与网络。持续不可读时，每小时提醒一次。',
    ].join('\n')
  }
  return [
    `【额度告警】${nameOf(provider)} 账户余额${level === 'critical' ? '严重不足' : '偏低'}`,
    `当前余额：${money(balance, currency)}`,
    `提醒阈值：低于 ${money(warningThreshold, currency)}`,
    `严重阈值：低于 ${money(criticalThreshold, currency)}`,
    `检查时间：${beijing(observedAt)}（北京时间）`,
    '请及时充值。余额持续不足时，每小时提醒一次。',
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
             m.feishu_webhook, e.evidence
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
          OR i.notified_at <= now() - make_interval(secs => $2)
          OR (i.notified_severity = 'warning' AND i.severity = 'critical'))
      ORDER BY i.id LIMIT $3`, [ALERT_CODES, REMINDER_INTERVAL_MS / 1000, BATCH_SIZE])
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

  async claim(id) {
    const { rowCount } = await this.pool.query(`UPDATE notifications.incidents
      SET notify_lease_until = now() + make_interval(secs => $2)
      WHERE id = $1 AND (notify_lease_until IS NULL OR notify_lease_until < now())`, [id, LEASE_SECONDS])
    return rowCount === 1
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
    await this.pool.query(`UPDATE notifications.incidents
      SET notified_at = now(), notified_severity = $2, notify_lease_until = NULL, updated_at = now()
      WHERE id = $1`, [id, severity])
    await this.pool.query(`INSERT INTO notifications.events
      (incident_id, kind, actor, evidence, occurred_at)
      VALUES ($1, 'notified', 'notifier:feishu', $2::jsonb, now())`,
    [id, JSON.stringify({ channel: 'feishu', severity, ...evidence })])
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
    [id, JSON.stringify({ channel: 'feishu', errorCode }), REMINDER_INTERVAL_MS / 1000])
  }

  // Each provider is handled on its own. A missing, broken or unreachable hook
  // for one platform never stops the other from being delivered, and never
  // consumes the other's reminder window.
  async deliverOne(row, { text, record, requireEvidence }) {
    let webhook
    // Re-validated at the point of use: the stored value is operator input, and
    // a bad one must disable that single group rather than the pass.
    try { webhook = feishuWebhook(row.feishu_webhook) }
    catch { return this.failed(row.id, 'notify_webhook_invalid') }
    if (!webhook) return this.failed(row.id, 'notify_webhook_unconfigured')
    if (requireEvidence && !row.evidence) return this.failed(row.id, 'notify_evidence_missing')
    if (!await this.claim(row.id)) return
    try {
      await this.send(webhook, text())
      await record()
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
          text: () => alertText(row.source, row.code, row.evidence, new Date(row.last_occurred_at)),
          record: () => this.succeeded(row.id, row.severity, row.evidence),
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
          text: () => recoveryText(row.source, row.code, row.evidence, new Date(row.recovered_at)),
          record: () => this.recovered(row.id, row.evidence || {}),
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
    void this.deliver()
    this.timer = setInterval(() => { void this.deliver() }, 30_000)
    this.timer.unref?.()
  }

  async close() { clearInterval(this.timer); this.timer = null; this.abort.abort(); await this.running }
}
