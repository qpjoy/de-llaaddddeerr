import { hostname } from 'node:os'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createPool } from '@qpjoy/mx-common'
import { createAgentRuntime } from '../agent/runtime.mjs'
import { AgentSettingsStore } from '../agent/settings-store.mjs'
import { AgentControlStore } from '../agent/control-store.mjs'
import {
  AgentPipelineStore,
  PROVINCE_GEOGRAPHY_PIPELINE_KEY,
  safeErrorCode,
} from '../agent/pipeline-store.mjs'
import { runProvinceAnalysisGraph } from '../agent/province-analysis-graph.mjs'
import { loadConfig } from '../config.mjs'

const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
const LEASE_SECONDS = 300
const HEARTBEAT_MS = 30_000
const RECLAIM_MS = 30_000
const IDLE_MS = 1_000

// Stable graph boundary for future Hub-owned analysis functions. A LangGraph
// implementation can replace an individual handler without changing durable
// task leases, provider governance, evidence storage or Admin controls.
export const ANALYSIS_GRAPH_HANDLERS = new Map([
  [PROVINCE_GEOGRAPHY_PIPELINE_KEY, runProvinceAnalysisGraph],
])

function wait(ms, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    signal?.addEventListener?.('abort', done, { once: true })
  })
}

export async function runAgentClassifierLoop({
  pipelineStore,
  agent,
  signal,
  logger = console,
  workerId = WORKER_ID,
  leaseSeconds = LEASE_SECONDS,
  heartbeatMs = HEARTBEAT_MS,
  reclaimMs = RECLAIM_MS,
  idleMs = IDLE_MS,
  handlers = ANALYSIS_GRAPH_HANDLERS,
} = {}) {
  let lastReclaimAt = 0
  while (!signal?.aborted) {
    if (Date.now() - lastReclaimAt >= reclaimMs) {
      const reclaimed = await pipelineStore.reclaimExpired().catch((error) => {
        logger.warn?.(`[agent-pipeline] reclaim failed code=${safeErrorCode(error)}`)
        return 0
      })
      if (reclaimed > 0) logger.warn?.(`[agent-pipeline] reclaimed=${reclaimed}`)
      lastReclaimAt = Date.now()
    }

    let claim
    try {
      claim = await pipelineStore.claimNext({ workerId, leaseSeconds })
    } catch (error) {
      logger.warn?.(`[agent-pipeline] claim failed code=${safeErrorCode(error)}`)
      await wait(idleMs, signal)
      continue
    }
    if (!claim) {
      await wait(idleMs, signal)
      continue
    }

    const claimController = new AbortController()
    let abortKind = null
    let heartbeatPromise = null
    const abortClaim = (kind, reason) => {
      if (claimController.signal.aborted) return
      abortKind = kind
      claimController.abort(reason)
    }
    const onShutdown = () => abortClaim('shutdown', signal?.reason)
    if (signal?.aborted) onShutdown()
    else signal?.addEventListener?.('abort', onShutdown, { once: true })
    const renewLease = async () => {
      if (heartbeatPromise || claimController.signal.aborted) return
      heartbeatPromise = (async () => {
        try {
          const ownsClaim = await pipelineStore.heartbeat(claim, leaseSeconds)
          if (!ownsClaim) {
            logger.warn?.(`[agent-pipeline] lease lost task=${claim.taskId}; aborting analysis`)
            abortClaim('lease_lost')
          }
        } catch (error) {
          logger.warn?.(
            `[agent-pipeline] heartbeat unavailable task=${claim.taskId} `
            + `code=${safeErrorCode(error)}; aborting analysis`,
          )
          // Fail closed: without a confirmed renewal this worker must not keep
          // sending the same record to a provider while another replica may
          // reclaim it. The durable lease will make the task runnable again.
          abortClaim('heartbeat_unavailable', error)
        } finally {
          heartbeatPromise = null
        }
      })()
      await heartbeatPromise
    }
    const heartbeat = setInterval(renewLease, heartbeatMs)
    try {
      const handler = handlers.get(claim.pipelineKey)
      if (!handler) {
        const error = new Error('No analysis graph is registered for this pipeline')
        error.code = 'analysis_graph_not_registered'
        throw error
      }
      const result = await handler({ claim, agent, signal: claimController.signal })
      clearInterval(heartbeat)
      await heartbeatPromise
      if (claimController.signal.aborted) {
        const error = claimController.signal.reason instanceof Error
          ? claimController.signal.reason
          : new Error(abortKind || 'analysis_aborted')
        throw error
      }
      const completion = await pipelineStore.completeClaim(claim, result)
      logger.log?.(
        `[agent-pipeline] task=${claim.taskId} completed=${completion.completed === true} `
        + `superseded=${completion.superseded === true} assertions=${result.assertions?.length || 0} `
        + `provider=${result.providerId || 'rules'}`,
      )
    } catch (error) {
      if (abortKind === 'shutdown' || signal?.aborted) {
        const release = await pipelineStore.releaseClaim(claim).catch(() => null)
        logger.log?.(
          `[agent-pipeline] task=${claim.taskId} shutdown_requeue=${release?.released === true}`,
        )
      } else if (abortKind === 'lease_lost' || abortKind === 'heartbeat_unavailable') {
        logger.warn?.(`[agent-pipeline] task=${claim.taskId} abandoned reason=${abortKind}`)
      } else {
        const failure = await pipelineStore.failClaim(claim, error).catch(() => null)
        logger.warn?.(
          `[agent-pipeline] task=${claim.taskId} failed code=${safeErrorCode(error)} `
          + `dead=${failure?.dead === true}`,
        )
      }
    } finally {
      clearInterval(heartbeat)
      signal?.removeEventListener?.('abort', onShutdown)
    }
  }
}

async function main() {
  const config = loadConfig()
  if (config.storeDriver !== 'postgres') {
    console.error('[agent-pipeline] requires MX_INSIGHT_STORE=postgres; refusing to start')
    process.exit(2)
  }
  const pool = createPool(config.common.postgres, {
    applicationName: 'mx-insight-hub-classifier',
  })
  const agent = await createAgentRuntime({
    config,
    settingsStore: new AgentSettingsStore(pool),
    controlStore: new AgentControlStore(pool, { deploymentEgress: config.deploymentEgress }),
    managedKinds: ['chat'],
    logger: console,
  })
  const pipelineStore = new AgentPipelineStore(pool)
  const controller = new AbortController()
  const shutdown = (name) => {
    console.log(`[agent-pipeline] ${name} received; safely requeueing current record`)
    controller.abort()
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))

  console.log('[agent-pipeline] classifier ready; global concurrency=1')
  try {
    await runAgentClassifierLoop({ pipelineStore, agent, signal: controller.signal })
  } finally {
    agent.close()
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[agent-pipeline] fatal code=${safeErrorCode(error)}`)
    process.exit(1)
  })
}
