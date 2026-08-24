import { EXTERNAL_PULL_QUEUE } from './sync-job.mjs'
import { enqueueJobsAtomically } from './atomic-enqueue.mjs'
import {
  isTelegramMonitorSourceKey,
  TELEGRAM_MONITOR_INPUTS,
  TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST,
  TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION,
} from '../telegram/monitor-pipeline.mjs'
import { TELEGRAM_SQLITE_INPUTS } from '../telegram/sqlite-pipeline.mjs'
import {
  PROVINCE_OPINION_PIPELINE_KEY,
  PROVINCE_OPINION_SAFE_BATCH_SIZE,
  PROVINCE_OPINION_SOURCE_KEY,
  PROVINCE_OPINION_WRITER_CONTRACT_DIGEST,
  PROVINCE_OPINION_WRITER_CONTRACT_VERSION,
  isProvinceOpinionSourceKey,
  provinceOpinionHanlpIssues,
  provinceOpinionSourceContractIssues,
} from '../province/monitor-pipeline.mjs'
import { sqliteApiDailyWindowAt } from './sqlite-api-source.mjs'

const TELEGRAM_SCHEDULE_ERRORS = Object.freeze({
  unavailable: {
    code: 'telegram_schedule_unavailable',
    message: 'Telegram monitor scheduling requires the PostgreSQL queue',
  },
  failed: {
    code: 'telegram_schedule_failed',
    message: 'No Telegram monitor task was scheduled',
  },
  outcomeUnknown: {
    code: 'telegram_schedule_outcome_unknown',
    message: 'The Telegram monitor scheduling outcome is unknown',
  },
})

const TELEGRAM_SQLITE_SCHEDULE_ERRORS = Object.freeze({
  unavailable: {
    code: 'telegram_sqlite_schedule_unavailable',
    message: 'Telegram SQLite API scheduling requires the PostgreSQL queue',
  },
  failed: {
    code: 'telegram_sqlite_schedule_failed',
    message: 'No Telegram SQLite API task was scheduled',
  },
  outcomeUnknown: {
    code: 'telegram_sqlite_schedule_outcome_unknown',
    message: 'The Telegram SQLite API scheduling outcome is unknown',
  },
})

const PROVINCE_OPINION_SCHEDULE_ERRORS = Object.freeze({
  unavailable: {
    code: 'province_opinion_schedule_unavailable',
    message: 'Province opinion scheduling requires the PostgreSQL queue',
  },
  failed: {
    code: 'province_opinion_schedule_failed',
    message: 'No province opinion task was scheduled',
  },
  outcomeUnknown: {
    code: 'province_opinion_schedule_outcome_unknown',
    message: 'The province opinion scheduling outcome is unknown',
  },
})

function isDue(source, cursor, now) {
  if (cursor && cursor.status !== 'idle') return false
  const updatedAt = cursor?.updated_at ?? cursor?.updatedAt ?? null
  const intervalMs = (source.syncIntervalSeconds ?? 60) * 1_000
  return !updatedAt || now.getTime() - new Date(updatedAt).getTime() >= intervalMs
}

function scheduledJob(sourceKey, batchSize, trigger = 'schedule') {
  return {
    queue: EXTERNAL_PULL_QUEUE,
    payload: { sourceKey, batchSize, trigger, chunk: 0 },
    options: { dedupeKey: `external-pull:${sourceKey}:0`, priority: 220 },
  }
}

function telegramSQLiteScheduleTrigger(cursors, now) {
  const dailyWindow = sqliteApiDailyWindowAt(now)
  if (!dailyWindow.available) return 'schedule'
  const initialized = cursors.every((cursor) => cursor?.position?.lastCompletedAt)
  const dailyWindowDue = cursors.some(
    (cursor) => cursor?.position?.lastDailyWindowDate !== dailyWindow.date,
  )
  return initialized && dailyWindowDue ? 'daily_window' : 'schedule'
}

/** Schedule one incremental scan for every active foreign database source. */
export async function scheduleActiveDatabaseSources({
  store,
  queue,
  batchSize = 1_000,
  now = new Date(),
  segmenterConfig = null,
}) {
  const sources = await store.listExternalSources()
  let enqueued = 0
  for (const source of sources) {
    if (source.sourceKind !== 'database' || source.status !== 'active') continue
    if (isTelegramMonitorSourceKey(source.sourceKey) || isProvinceOpinionSourceKey(source.sourceKey)) continue
    const cursor = await queue.getCursor(`external:${source.sourceKey}`)
    // A running continuation owns this source. Failed cursors require an
    // operator to fix/probe and explicitly resume; automatic retries would
    // turn a deterministic mapping failure into an alert storm.
    if (cursor && cursor.status !== 'idle') continue
    if (!isDue(source, cursor, now)) continue
    const jobId = await queue.enqueue(
      EXTERNAL_PULL_QUEUE,
      { sourceKey: source.sourceKey, batchSize, trigger: 'schedule', chunk: 0 },
      { dedupeKey: `external-pull:${source.sourceKey}:0`, priority: 220 },
    )
    if (jobId != null) enqueued += 1
  }

  const telegramSources = TELEGRAM_MONITOR_INPUTS.map((input) => (
    sources.find((source) => source.sourceKey === input.sourceKey)
  ))
  if (telegramSources.every((source) => source?.sourceKind === 'database' && source.status === 'active')) {
    const attestation = await store.getLatestPipelineWriterContractAttestation?.('telegram-monitor')
    const attested = attestation?.contractVersion === TELEGRAM_MONITOR_WRITER_CONTRACT_VERSION
      && attestation?.contractDigest === TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST
    if (attested) {
      const cursors = await Promise.all(telegramSources.map(
        (source) => queue.getCursor(`external:${source.sourceKey}`),
      ))
      if (telegramSources.every((source, index) => isDue(source, cursors[index], now))) {
        const jobIds = await enqueueJobsAtomically(
          queue,
          telegramSources.map((source) => scheduledJob(source.sourceKey, batchSize)),
          TELEGRAM_SCHEDULE_ERRORS,
        )
        enqueued += jobIds.filter((jobId) => jobId != null).length
      }
    }
  }

  const provinceOpinionSource = sources.find((source) => source.sourceKey === PROVINCE_OPINION_SOURCE_KEY)
  if (
    provinceOpinionSource?.sourceKind === 'database'
    && provinceOpinionSource.status === 'active'
    && provinceOpinionSourceContractIssues(provinceOpinionSource).length === 0
    && provinceOpinionHanlpIssues(segmenterConfig).length === 0
  ) {
    const attestation = await store.getLatestPipelineWriterContractAttestation?.(PROVINCE_OPINION_PIPELINE_KEY)
    const attested = attestation?.contractVersion === PROVINCE_OPINION_WRITER_CONTRACT_VERSION
      && attestation?.contractDigest === PROVINCE_OPINION_WRITER_CONTRACT_DIGEST
    if (attested) {
      const cursor = await queue.getCursor(`external:${PROVINCE_OPINION_SOURCE_KEY}`)
      if (isDue(provinceOpinionSource, cursor, now)) {
        const jobIds = await enqueueJobsAtomically(
          queue,
          [scheduledJob(
            PROVINCE_OPINION_SOURCE_KEY,
            Math.min(batchSize, PROVINCE_OPINION_SAFE_BATCH_SIZE),
          )],
          PROVINCE_OPINION_SCHEDULE_ERRORS,
        )
        enqueued += jobIds.filter((jobId) => jobId != null).length
      }
    }
  }

  const sqliteSources = TELEGRAM_SQLITE_INPUTS.map((input) => (
    sources.find((source) => source.sourceKey === input.sourceKey)
  ))
  if (sqliteSources.every((source) => source?.sourceKind === 'sqlite_api' && source.status === 'active')) {
    const cursors = await Promise.all(sqliteSources.map(
      (source) => queue.getCursor(`external:${source.sourceKey}`),
    ))
    if (sqliteSources.every((source, index) => isDue(source, cursors[index], now))) {
      const sqliteBatchSize = Math.min(batchSize, 500)
      const trigger = telegramSQLiteScheduleTrigger(cursors, now)
      const jobIds = await enqueueJobsAtomically(
        queue,
        sqliteSources.map((source) => scheduledJob(source.sourceKey, sqliteBatchSize, trigger)),
        TELEGRAM_SQLITE_SCHEDULE_ERRORS,
      )
      enqueued += jobIds.filter((jobId) => jobId != null).length
    }
  }

  return {
    active: sources.filter((source) => (
      (source.sourceKind === 'database' || source.sourceKind === 'sqlite_api')
      && source.status === 'active'
    )).length,
    enqueued,
  }
}

function waitForNextScan(intervalMs, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, intervalMs)
    function done() {
      signal?.removeEventListener?.('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener?.('abort', done, { once: true })
  })
}

/** Keep active sources incremental after their initial full scan reaches idle. */
export async function runExternalPullScheduler({
  store,
  queue,
  batchSize,
  intervalMs,
  segmenterConfig,
  signal,
  logger = console,
}) {
  while (!signal?.aborted) {
    try {
      const result = await scheduleActiveDatabaseSources({ store, queue, batchSize, segmenterConfig })
      if (result.enqueued > 0) logger.log?.(`[external] scheduled ${result.enqueued}/${result.active} active database source(s)`)
    } catch (error) {
      const candidate = typeof error?.code === 'string' ? error.code : error?.name
      const code = typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)
        ? candidate
        : 'scheduler_failed'
      logger.warn?.(`[external] scheduler failed code=${code}`)
    }
    await waitForNextScan(intervalMs, signal)
  }
}
