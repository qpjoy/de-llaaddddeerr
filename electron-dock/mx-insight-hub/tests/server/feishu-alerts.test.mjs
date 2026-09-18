import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { FeishuAlertNotifier, PROBE_INCIDENT_CODE, alertText, feishuWebhook, recoveryText, webhookHint } from '../../server/notifications-feishu.mjs'

const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/6093808e-6a97-4160-8f3c-af97b1f1d151'
const OTHER = 'https://open.feishu.cn/open-apis/bot/v2/hook/1790e6fa-fe18-4501-b55e-2de84d0c2fb1'
const accepted = () => new Response(JSON.stringify({ code: 0, msg: 'success' }))
const evidence = (balance, level = 'warning') => ({
  balance, currency: 'USD', level, warningThreshold: '5.000000000000', criticalThreshold: '3.000000000000',
})

test('only a real Feishu bot hook is accepted and an empty value is not an error', () => {
  assert.equal(feishuWebhook(HOOK), HOOK)
  assert.equal(feishuWebhook(`  ${HOOK}  `), HOOK)
  for (const empty of ['', '   ', null, undefined]) assert.equal(feishuWebhook(empty), null)
  for (const bad of [
    'http://open.feishu.cn/open-apis/bot/v2/hook/abc',          // plaintext
    'https://open.feishu.cn.evil.invalid/open-apis/bot/v2/hook/abc',
    'https://open.feishu.cn:8443/open-apis/bot/v2/hook/abc',    // non-default port
    'https://open.feishu.cn/open-apis/bot/v2/hook/',            // no bot id
    'https://open.feishu.cn/open-apis/bot/v2/hook/abc/def',     // path traversal
    'https://open.feishu.cn/open-apis/bot/v2/hook/abc?x=1',     // smuggled query
    'https://open.feishu.cn/open-apis/bot/v2/hook/abc#f',
    'https://open.feishu.cn/other/path',
    'not-a-url', 42, {},
  ]) assert.throws(() => feishuWebhook(bad), { code: 'invalid_feishu_webhook' }, String(bad))
})

test('the alert carries the keyword, native currency, both thresholds and Beijing time', () => {
  const text = alertText('tikhub', 'supplier_balance_low', evidence('3.8605'), new Date('2026-09-18T03:00:00.000Z'))
  assert.match(text, /^【额度告警】TikHub 账户余额偏低$/m, 'the bots are keyword-gated on 额度')
  assert.match(text, /当前余额：3.8605 美元（USD）/)
  assert.match(text, /提醒阈值：低于 5 美元/, 'trailing zeros are trimmed')
  assert.match(text, /严重阈值：低于 3 美元/)
  assert.match(text, /检查时间：2026-09-18 11:00:00（北京时间）/, 'UTC+8, not server time')
  const critical = alertText('justone', 'supplier_balance_low', { ...evidence('1', 'critical'), currency: 'CNY' }, new Date())
  assert.match(critical, /【额度告警】JustOne 账户余额严重不足/)
  assert.match(critical, /1 元（CNY）/, 'CNY is never relabelled or converted')
})

test('an unreadable balance says so instead of being reported as a number', () => {
  const at = new Date('2026-09-18T03:00:00.000Z')
  const text = alertText('tikhub', PROBE_INCIDENT_CODE,
    { errorCode: 'balance_network_error', currency: 'USD', lastSuccessAt: '2026-09-17T18:00:00.000Z' }, at)
  assert.match(text, /^【额度告警】TikHub 余额查询失败$/m, 'the keyword gate applies to every message')
  assert.match(text, /失败原因：balance_network_error/)
  assert.match(text, /最近成功：2026-09-18 02:00:00（北京时间）/)
  assert.doesNotMatch(text, /当前余额|0 美元/, 'unknown is never rendered as a balance')
  const never = alertText('tikhub', PROBE_INCIDENT_CODE, { currency: 'USD', lastSuccessAt: null }, at)
  assert.match(never, /最近成功：尚无成功查询/)
  assert.match(never, /失败原因：balance_query_failed/, 'a missing code still names something')
})

test('recovery messages carry the keyword and match the incident they close', () => {
  const at = new Date('2026-09-18T04:00:00.000Z')
  const balance = recoveryText('tikhub', 'supplier_balance_low',
    { balance: '12.5', currency: 'USD', warningThreshold: '5.000000000000' }, at)
  assert.match(balance, /^【额度恢复】TikHub 账户余额已恢复$/m)
  assert.match(balance, /当前余额：12.5 美元（USD）/)
  assert.match(balance, /恢复时间：2026-09-18 12:00:00（北京时间）/)
  const probe = recoveryText('justone', PROBE_INCIDENT_CODE, null, at)
  assert.match(probe, /^【额度监控恢复】JustOne 余额查询已恢复$/m)
  assert.doesNotMatch(probe, /当前余额/, 'a probe recovery claims nothing about the balance')
  assert.doesNotMatch(recoveryText('tikhub', 'supplier_balance_low', {}, at), /当前余额/)
})

test('a notifier without PostgreSQL never starts polling', async () => {
  const notifier = new FeishuAlertNotifier({ pool: null })
  notifier.start()
  assert.equal(notifier.timer, null)
  await notifier.close()
})

test('the console hint identifies a bot without exposing the hook', () => {
  assert.equal(webhookHint(HOOK), '…f1d151')
  assert.equal(webhookHint(OTHER), '…0c2fb1')
  assert.notEqual(webhookHint(HOOK), webhookHint(OTHER), 'two bots stay distinguishable')
  for (const empty of ['', '   ', null, undefined, 42]) assert.equal(webhookHint(empty), null)
  assert.doesNotMatch(String(webhookHint(HOOK)), /open\.feishu\.cn|6093808e/)
})

// Reuse the notification suite's optional local PostgreSQL/WASM runtime.
test('durable Feishu delivery: cooldown, escalation, recovery, retry and provider isolation',
  { skip: !process.env.MX_NOTIFICATION_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.MX_NOTIFICATION_PGLITE_MODULE)
  const db = new PGlite()
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) }
  const sent = []
  let reply = accepted
  const fetchImpl = async (url, options) => {
    sent.push({ url, text: JSON.parse(options.body).content.text })
    return reply(url)
  }
  const notifier = new FeishuAlertNotifier({ pool, fetchImpl })
  const setHook = async (provider, value) => db.query(
    'UPDATE external_platform.balance_monitors SET feishu_webhook=$2 WHERE provider_key=$1', [provider, value])

  const raise = async (source, severity, amount, currency = 'USD') => {
    const level = severity === 'critical' ? 'critical' : 'warning'
    const incident = await db.query(`INSERT INTO notifications.incidents
      (category,severity,source,source_scope,code,title,first_occurred_at,last_occurred_at)
      VALUES ('supplier.cost',$1,$2,'credential:1','supplier_balance_low',$3,now(),now())
      ON CONFLICT (source,source_scope,code) WHERE status <> 'closed'
      DO UPDATE SET severity=EXCLUDED.severity,last_occurred_at=now(),updated_at=now() RETURNING id`,
    [severity, source, `${source} 余额`])
    await db.query(`INSERT INTO notifications.events (incident_id,kind,actor,evidence,occurred_at)
      VALUES ($1,'balance_observed','monitor:balance',$2::jsonb,now())`,
    [incident.rows[0].id, JSON.stringify({ ...evidence(amount, level), currency })])
    return incident.rows[0].id
  }
  const age = async (id, interval) => db.exec(
    `UPDATE notifications.incidents SET notified_at=notified_at-interval '${interval}' WHERE id=${id}`)
  const kinds = async id => (await db.query(
    'SELECT kind FROM notifications.events WHERE incident_id=$1 ORDER BY id DESC', [id])).rows.map(row => row.kind)

  try {
    await db.exec('CREATE SCHEMA external_platform')
    for (const file of ['085_admin_notifications.sql', '090_supplier_balance_monitor.sql',
      '097_hourly_balance_check.sql', '098_feishu_balance_alerts.sql', '099_balance_feishu_webhook.sql',
      '100_probe_failure_and_recovery_alerts.sql']) {
      await db.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'))
    }
    // 099 seeds the groups that were already receiving these alerts, so a first
    // deploy notifies without any console step.
    const seeded = (await db.query('SELECT provider_key,feishu_webhook FROM external_platform.balance_monitors ORDER BY provider_key')).rows
    assert.deepEqual(seeded.map(row => row.feishu_webhook), [OTHER, HOOK], 'justone/tikhub seeds')

    const tikhub = await raise('tikhub', 'warning', '3.8605')
    await notifier.deliverBatch()
    assert.equal(sent.length, 1, 'a brand-new incident is delivered at once')
    assert.equal(sent[0].url, HOOK, 'each platform reaches its own bot')
    assert.match(sent[0].text, /【额度告警】TikHub/)
    assert.deepEqual(await kinds(tikhub), ['notified', 'balance_observed'])

    await notifier.deliverBatch()
    assert.equal(sent.length, 1, 'a repeat observation inside the hour stays quiet')

    await raise('tikhub', 'critical', '2.5')
    await notifier.deliverBatch()
    assert.equal(sent.length, 2, 'escalation to critical does not wait out the reminder window')
    assert.match(sent[1].text, /严重不足/)
    await notifier.deliverBatch()
    assert.equal(sent.length, 2, 'an escalation is only announced once')

    await age(tikhub, '61 minutes')
    await notifier.deliverBatch()
    assert.equal(sent.length, 3, 'the hourly reminder resumes while the balance stays low')

    // Recovery closes the incident; a later drop is a new incident and must not
    // inherit the closed one's cooldown.
    await db.exec(`UPDATE notifications.incidents SET status='closed' WHERE id=${tikhub}`)
    await notifier.deliverBatch()
    assert.equal(sent.length, 3, 'a closed incident is never re-announced')
    const reopened = await raise('tikhub', 'warning', '4')
    assert.notEqual(reopened, tikhub)
    await notifier.deliverBatch()
    assert.equal(sent.length, 4, 'a fresh incident after recovery alerts immediately')

    // A rejected or unreachable bot must not consume the reminder.
    const justone = await raise('justone', 'warning', '4.5', 'CNY')
    reply = () => new Response(JSON.stringify({ code: 19021, msg: 'no permission' }))
    await notifier.deliverBatch()
    assert.equal(sent.length, 5)
    assert.equal((await db.query('SELECT notified_at FROM notifications.incidents WHERE id=$1', [justone])).rows[0].notified_at, null,
      'a non-zero bot reply never starts the cooldown')
    assert.deepEqual(await kinds(justone), ['notify_failed', 'balance_observed'])
    await notifier.deliverBatch()
    assert.equal(sent.length, 6, 'a failed delivery is retried on the next pass')
    assert.equal((await kinds(justone)).filter(kind => kind === 'notify_failed').length, 1,
      'a persistently broken hook records one failure per hour, not one per pass')

    reply = accepted
    await notifier.deliverBatch()
    assert.ok((await db.query('SELECT notified_at FROM notifications.incidents WHERE id=$1', [justone])).rows[0].notified_at)

    // The case that motivated moving this into Hub: one platform being broken
    // must never stop the other platform's alert from going out.
    await setHook('tikhub', null)
    const isolated = new FeishuAlertNotifier({ pool, fetchImpl })
    sent.length = 0
    await age(justone, '61 minutes')
    await age(reopened, '61 minutes')
    await isolated.deliverBatch()
    assert.equal(sent.length, 1, 'the configured platform is still delivered')
    assert.equal(sent[0].url, OTHER)
    assert.ok((await kinds(reopened)).includes('notify_failed'), 'the unconfigured platform is recorded, not silent')

    await setHook('tikhub', 'https://evil.invalid/x')
    const broken = new FeishuAlertNotifier({ pool, fetchImpl, logger: { warn() {} } })
    sent.length = 0
    await age(justone, '61 minutes')
    await broken.deliverBatch()
    assert.equal(sent.length, 1, 'an invalid hook for one platform does not block the other')
    assert.equal(sent[0].url, OTHER)

    // Recovery is announced once, and only for a problem the group heard about.
    await setHook('tikhub', HOOK)
    sent.length = 0
    await db.query(`INSERT INTO notifications.events (incident_id,kind,actor,evidence,occurred_at)
      VALUES ($1,'balance_recovered','monitor:balance',$2::jsonb,now())`,
    [tikhub, JSON.stringify({ balance: '12.5', currency: 'USD', warningThreshold: '5.000000000000' })])
    await db.exec(`UPDATE notifications.incidents SET recovered_at=now() WHERE id=${tikhub}`)
    await notifier.deliverBatch()
    const recovery = sent.find(message => message.text.includes('恢复'))
    assert.ok(recovery, 'a monitor-recorded recovery reaches the group')
    assert.match(recovery.text, /【额度恢复】TikHub 账户余额已恢复/)
    assert.match(recovery.text, /当前余额：12.5 美元（USD）/)
    assert.equal(recovery.url, HOOK)
    const delivered = sent.length
    await notifier.deliverBatch()
    assert.equal(sent.length, delivered, 'a recovery is announced once')

    // Balance and probe recovery for one provider in the same pass is one event,
    // so only the balance message goes out and the probe recovery is recorded as
    // merged -- marked delivered, so it cannot resurface as a second message.
    const probe = await db.query(`INSERT INTO notifications.incidents
      (category,severity,source,source_scope,code,title,first_occurred_at,last_occurred_at,
       status,notified_at,recovered_at)
      VALUES ('supplier.cost','warning','tikhub','credential:1','supplier_balance_unreadable',
        'TikHub 账户余额查询失败',now(),now(),'closed',now(),now()) RETURNING id`)
    const low = await db.query(`INSERT INTO notifications.incidents
      (category,severity,source,source_scope,code,title,first_occurred_at,last_occurred_at,
       status,notified_at,recovered_at)
      VALUES ('supplier.cost','warning','tikhub','credential:2','supplier_balance_low',
        'TikHub 账户余额偏低',now(),now(),'closed',now(),now()) RETURNING id`)
    await db.query(`INSERT INTO notifications.events (incident_id,kind,actor,evidence,occurred_at)
      VALUES ($1,'balance_recovered','monitor:balance',$2::jsonb,now())`,
    [low.rows[0].id, JSON.stringify({ balance: '9', currency: 'USD', warningThreshold: '5.000000000000' })])
    sent.length = 0
    await notifier.deliverBatch()
    assert.equal(sent.length, 1, 'one restored balance is one message, not two')
    assert.match(sent[0].text, /【额度恢复】TikHub 账户余额已恢复/)
    assert.doesNotMatch(sent[0].text, /查询已恢复/)
    assert.deepEqual(await kinds(probe.rows[0].id), ['notify_merged'])
    assert.ok((await db.query('SELECT recovery_notified_at FROM notifications.incidents WHERE id=$1',
      [probe.rows[0].id])).rows[0].recovery_notified_at, 'the merged recovery cannot resurface')
    await notifier.deliverBatch()
    assert.equal(sent.length, 1, 'neither recovery is repeated on the next pass')

    // A probe recovery on its own still reaches the group.
    const alone = await db.query(`INSERT INTO notifications.incidents
      (category,severity,source,source_scope,code,title,first_occurred_at,last_occurred_at,
       status,notified_at,recovered_at)
      VALUES ('supplier.cost','warning','tikhub','credential:3','supplier_balance_unreadable',
        'TikHub 账户余额查询失败',now(),now(),'closed',now(),now()) RETURNING id`)
    sent.length = 0
    await notifier.deliverBatch()
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /【额度监控恢复】TikHub 余额查询已恢复/)
    assert.deepEqual(await kinds(alone.rows[0].id), ['notified'])

    // An incident nobody was told about must not produce a recovery out of thin
    // air, and a manual closure is not a recovery at all.
    const quiet = await raise('justone', 'warning', '4.9', 'CNY')
    await db.exec(`UPDATE notifications.incidents SET notified_at=NULL,recovered_at=now(),status='closed' WHERE id=${quiet}`)
    const manual = await raise('justone', 'warning', '4.8', 'CNY')
    await db.exec(`UPDATE notifications.incidents SET notified_at=now(),status='closed' WHERE id=${manual}`)
    sent.length = 0
    await notifier.deliverBatch()
    assert.equal(sent.length, 0, 'unannounced recovery and manual closure both stay silent')

    // An edit in the console reaches the next pass with no restart.
    await setHook('tikhub', OTHER)
    sent.length = 0
    await age(reopened, '61 minutes')
    await notifier.deliverBatch()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].url, OTHER, 'a re-pointed hook takes effect on the next pass')

    const dump = JSON.stringify((await db.query('SELECT * FROM notifications.events')).rows)
    assert.doesNotMatch(dump, /open\.feishu\.cn|6093808e|1790e6fa/, 'webhooks never reach the incident timeline')
  } finally { await db.close() }
})
