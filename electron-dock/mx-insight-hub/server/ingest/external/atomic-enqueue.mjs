import { AppError } from '../../core/errors.mjs'

const DEFAULT_ERRORS = Object.freeze({
  unavailable: {
    code: 'atomic_enqueue_unavailable',
    message: 'Atomic scheduling requires the PostgreSQL queue',
  },
  failed: {
    code: 'atomic_enqueue_failed',
    message: 'No jobs were scheduled; retry when the PostgreSQL queue is available',
  },
  outcomeUnknown: {
    code: 'atomic_enqueue_outcome_unknown',
    message: 'The scheduling transaction outcome is unknown; inspect the queue before retrying',
  },
})

function appError(definition) {
  return new AppError(503, definition.code, definition.message)
}

/** Enqueue a related job set in one PostgreSQL transaction. */
export async function enqueueJobsAtomically(queue, jobs, errors = DEFAULT_ERRORS) {
  if (jobs.length === 0) return []
  if (typeof queue?.pool?.connect !== 'function') throw appError(errors.unavailable)

  let client
  try {
    client = await queue.pool.connect()
  } catch {
    throw appError(errors.failed)
  }

  let commitStarted = false
  let committed = false
  let releaseError = null
  try {
    await client.query('BEGIN')
    const jobIds = []
    for (const job of jobs) {
      jobIds.push(await queue.enqueue(job.queue, job.payload, { ...job.options, client }))
    }
    commitStarted = true
    await client.query('COMMIT')
    committed = true
    return jobIds
  } catch (error) {
    if (commitStarted && !committed) {
      releaseError = error
      throw appError(errors.outcomeUnknown)
    }
    await client.query('ROLLBACK').catch(() => {})
    throw appError(errors.failed)
  } finally {
    client.release(releaseError)
  }
}
