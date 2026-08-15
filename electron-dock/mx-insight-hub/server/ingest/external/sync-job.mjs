export const EXTERNAL_PULL_QUEUE = 'external-pull'

function safeFailureCode(error) {
  for (const candidate of [error?.code, error?.name]) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)) return candidate
  }
  return 'source_pull_failed'
}

/** Run one bounded source batch and enqueue exactly one continuation if needed. */
export async function runExternalPullJob({
  puller,
  queue,
  payload,
  job,
  signal,
  logger = console,
  heartbeatIntervalMs = 30_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  continuationDelayMs = 0,
  now = () => new Date(),
}) {
  const sourceKey = payload?.sourceKey
  if (!sourceKey) throw new Error('external pull payload is missing sourceKey')
  if (!Number.isInteger(continuationDelayMs) || continuationDelayMs < 0) {
    throw new Error('continuationDelayMs must be a non-negative integer')
  }
  const heartbeat = () => queue.heartbeat(job.id).catch(() => {})
  await heartbeat()
  const timer = setIntervalFn(heartbeat, heartbeatIntervalMs)
  timer?.unref?.()
  let result
  try {
    result = await puller.pullBatch(sourceKey, {
      batchSize: payload.batchSize ?? 1_000,
      importRunId: payload.importRunId ?? null,
      trigger: payload.trigger ?? 'manual',
    })
  } catch (error) {
    if (error?.code === 'source_contract_mismatch') {
      if (typeof puller.markSourceContractFailed !== 'function') throw error
      await puller.markSourceContractFailed(sourceKey, error.code)
      logger.warn?.(`[external] ${sourceKey} stopped for operator action: ${error.code}`)
      return {
        pulled: 0,
        ingested: 0,
        changed: 0,
        rejected: 0,
        done: true,
        failed: true,
        error: error.code,
      }
    }
    if (['row_rejections_detected', 'import_batch_failed'].includes(error?.code)) {
      logger.warn?.(`[external] ${sourceKey} stopped for operator action: ${error.code}`)
      return {
        pulled: 0,
        ingested: 0,
        changed: 0,
        rejected: 0,
        done: true,
        failed: true,
        error: error.code,
      }
    }
    const exhausted = Number(job?.attempts) >= Number(job?.max_attempts)
    if (exhausted && typeof puller.markContinuationFailed === 'function') {
      await puller.markContinuationFailed(
        sourceKey,
        payload.importRunId ?? null,
        safeFailureCode(error),
      ).catch((finalizeError) => {
        logger.error?.(`[external] ${sourceKey} could not preserve failed pull checkpoint: ${finalizeError.message}`)
      })
    }
    throw error
  } finally {
    clearIntervalFn(timer)
  }
  await heartbeat()
  logger.log?.(
    `[external] ${sourceKey} pulled=${result.pulled} ingested=${result.ingested} changed=${result.changed || 0} rejected=${result.rejected || 0} done=${result.done}`,
  )

  if (!result.done) {
    const nextChunk = (payload.chunk ?? 0) + 1
    // Persist the hand-off even during graceful shutdown. pullBatch has already
    // marked the durable cursor `running`; omitting the continuation here would
    // leave no job for the next worker while the periodic scheduler correctly
    // refuses to overlap a running source.
    try {
      const runAt = continuationDelayMs > 0
        ? new Date(new Date(now()).getTime() + continuationDelayMs)
        : null
      await queue.enqueue(
        EXTERNAL_PULL_QUEUE,
        {
          ...payload,
          ...(result.importRunId ? { importRunId: result.importRunId } : {}),
          chunk: nextChunk,
        },
        {
          dedupeKey: `external-pull:${sourceKey}:${nextChunk}`,
          priority: 220,
          ...(runAt ? { runAt } : {}),
        },
      )
    } catch (error) {
      const exhausted = Number(job?.attempts) >= Number(job?.max_attempts)
      if (exhausted && result.importRunId && typeof puller.markContinuationFailed === 'function') {
        await puller.markContinuationFailed(
          sourceKey,
          result.importRunId,
          'continuation_enqueue_failed',
        ).catch((finalizeError) => {
          logger.error?.(`[external] ${sourceKey} could not close failed continuation: ${finalizeError.message}`)
        })
      }
      throw error
    }
  }
  return result
}
