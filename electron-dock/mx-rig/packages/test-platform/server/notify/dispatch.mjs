import { adapterFor } from './adapters.mjs'
import { channelWants, composeMessage, resolveTransition } from './events.mjs'

// The outbox.
//
// A notification is written to the database in the same request that records
// the run, and delivered later by the scheduler tick. Two reasons, both learned
// from the alternative:
//
// 1. Sending inline would make the runner's `:complete` call wait on someone
//    else's chat server. A slow webhook would then look like a slow test run,
//    and a hanging one would burn the run's lease.
// 2. Fire-and-forget after responding loses the alert on a restart, silently.
//    "The run is recorded but nobody was told" is the one outcome worse than
//    no notifications at all, because the dashboard looks fine.
//
// Writing first also means the delivery attempt is a row someone can look at
// when they say "I never got the message".

const MAX_ATTEMPTS = 4
const DELIVERY_TIMEOUT_MS = 10_000

/**
 * Decide whether this finished run is worth telling anyone about, and queue it.
 *
 * Called after the run is recorded. Returns the ids queued, mostly so tests can
 * assert on silence — which is the behaviour that matters most here.
 */
export async function enqueueForRun({ store, run, config, logger = console }) {
  if (!run?.taskId) return [] // Ad-hoc runs have no history to transition from.

  let channels
  try {
    channels = await store.listNotificationChannels({ enabled: true })
  } catch (error) {
    logger?.error?.(`[notify] 无法读取通知渠道：${error.message}`)
    return []
  }
  if (channels.length === 0) return []

  const previous = await store.findPreviousFinishedRun(run.taskId, run.id)
  const event = resolveTransition(run, previous)
  if (!event) return []

  const wanted = channels.filter((channel) => channelWants(channel, { event, appId: run.appId }))
  if (wanted.length === 0) return []

  const [task, app, suite, cases] = await Promise.all([
    store.getTask(run.taskId),
    store.getApp(run.appId),
    store.getSuite(run.suiteId),
    // Only needed to name the failures; a recovery message does not list cases.
    event === 'failure' ? store.listRunCases(run.id) : Promise.resolve([]),
  ])

  const message = composeMessage({
    event,
    run,
    task,
    app,
    suite,
    cases,
    lastGood: event === 'failure' ? await store.findLastPassingRun(run.taskId, run.id) : null,
    baseUrl: config?.publicUrl ?? '',
  })

  const queued = []
  for (const channel of wanted) {
    const row = await store.createNotification({
      channelId: channel.id,
      runId: run.id,
      event,
      payload: message,
    })
    queued.push(row.id)
  }
  logger?.log?.(`[notify] ${run.id} → ${event}，已入队 ${queued.length} 条`)
  return queued
}

/**
 * Deliver what is queued. Runs on the scheduler tick.
 *
 * Failures are retried on later ticks up to MAX_ATTEMPTS and then marked
 * `failed` with the reason kept. Giving up visibly beats retrying forever: a
 * webhook that was deleted six months ago should not be a permanent background
 * error, and someone should be able to see why it stopped.
 */
export async function deliverPending({ store, logger = console, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  let pending
  try {
    pending = await store.listPendingNotifications({ limit: 50 })
  } catch (error) {
    logger?.error?.(`[notify] 无法读取待发送队列：${error.message}`)
    return []
  }
  const delivered = []

  for (const item of pending) {
    const channel = await store.getNotificationChannel(item.channelId)
    if (!channel || !channel.enabled) {
      await store.updateNotification(item.id, {
        status: 'failed',
        lastError: '渠道已删除或已停用',
        attempts: item.attempts + 1,
      })
      continue
    }

    let request
    try {
      request = adapterFor(channel.kind).build(item.payload, channel.config)
    } catch (error) {
      // A misconfigured channel will never succeed; do not spend retries on it.
      await store.updateNotification(item.id, {
        status: 'failed',
        lastError: `渠道配置无效：${error.message}`.slice(0, 500),
        attempts: item.attempts + 1,
      })
      continue
    }

    const attempts = item.attempts + 1
    try {
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      // Feishu and WeCom answer 200 with an error code in the body, so the
      // status line alone is not proof of delivery.
      const text = await response.text().catch(() => '')
      const code = text ? JSON.parse(text)?.code ?? JSON.parse(text)?.errcode ?? 0 : 0
      if (code) throw new Error(`渠道返回错误码 ${code}：${text.slice(0, 200)}`)

      await store.updateNotification(item.id, {
        status: 'sent',
        attempts,
        deliveredAt: now().toISOString(),
        lastError: null,
      })
      delivered.push(item.id)
    } catch (error) {
      const exhausted = attempts >= MAX_ATTEMPTS
      await store.updateNotification(item.id, {
        status: exhausted ? 'failed' : 'pending',
        attempts,
        lastError: String(error.message ?? error).slice(0, 500),
      })
      if (exhausted) {
        logger?.error?.(`[notify] ${item.id} 放弃投递：${error.message}`)
      }
    }
  }
  return delivered
}
