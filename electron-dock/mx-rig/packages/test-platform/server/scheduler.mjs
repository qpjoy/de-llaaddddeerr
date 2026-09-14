import { nextCronTime } from './core/cron.mjs'
import { resolvePlacement } from './runner/placement.mjs'

// Turns due tasks into runs, and reaps runs nobody is looking after.
//
// Runs in-process on a timer. The tick is idempotent per task because the next
// fire time is advanced in the same pass that creates the run, so a slow tick
// overlapping the next one cannot double-fire a schedule.

export function computeNextRunAt(task, after = new Date()) {
  if (!task.enabled) return null
  if (task.scheduleKind === 'cron') {
    const next = nextCronTime(task.cronExpr, after, task.timezone)
    return next ? next.toISOString() : null
  }
  if (task.scheduleKind === 'once') {
    const runAt = new Date(task.runAt)
    return runAt.getTime() > after.getTime() ? runAt.toISOString() : null
  }
  return null // manual
}

export async function runDueTasks(store, now = new Date()) {
  const due = await store.dueTasks(now)
  const created = []

  for (const task of due) {
    const suite = await store.getSuite(task.suiteId)
    if (!suite || !suite.enabled) {
      // A task pointing at a disabled suite would otherwise retry every minute
      // forever. Park it and let a human decide.
      await store.updateTask(task.id, { enabled: false, nextRunAt: null })
      continue
    }
    const placement = resolvePlacement({ task, suite, now })
    const run = await store.createRun({
      appId: task.appId,
      suiteId: suite.id,
      taskId: task.id,
      profile: task.profile,
      track: task.track,
      engine: suite.engine,
      trigger: 'schedule',
      targetUrl: task.targetUrl,
      createdBy: task.createdBy,
      caseFilter: task.caseFilter ?? null,
      ...placement,
    })
    created.push(run)

    // `once` tasks disable themselves after firing; cron tasks advance.
    const nextRunAt = task.scheduleKind === 'once' ? null : computeNextRunAt(task, now)
    await store.updateTask(task.id, {
      lastRunId: run.id,
      nextRunAt,
      ...(task.scheduleKind === 'once' ? { enabled: false } : {}),
    })
  }
  return created
}

export async function tick(store, now = new Date()) {
  const created = await runDueTasks(store, now)
  const swept = await store.sweepStaleRuns(now)
  return { created: created.map((run) => run.id), ...swept }
}

export function startScheduler({ store, intervalMs, onTick = null, logger = console }) {
  let running = false
  const timer = setInterval(async () => {
    // Skip rather than queue: a tick that overruns its interval means the store
    // is slow, and piling on more concurrent ticks would make that worse.
    if (running) return
    running = true
    try {
      const result = await tick(store)
      // Dispatch after the scheduler has created this tick's runs, so work
      // created now starts now rather than waiting a whole interval.
      if (onTick) await onTick()
      if (result.created.length || result.expired.length || result.timedOut.length) {
        logger.log?.(
          `[scheduler] created=${result.created.length} expired=${result.expired.length} timedOut=${result.timedOut.length}`,
        )
      }
    } catch (error) {
      logger.error?.(`[scheduler] tick failed: ${error.message}`)
    } finally {
      running = false
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
