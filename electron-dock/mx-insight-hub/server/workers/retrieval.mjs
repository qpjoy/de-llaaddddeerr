import { pathToFileURL } from 'node:url'
import { createRetrievalPool } from '../retrieval/pool.mjs'
import { loadConfig } from '../config.mjs'
import { createSearch } from '../search/index.mjs'
import { requireSegmenterBackend } from '../search/reindex-integrity.mjs'
import { createAgentRuntime } from '../agent/runtime.mjs'
import { AgentSettingsStore } from '../agent/settings-store.mjs'
import { AgentControlStore } from '../agent/control-store.mjs'
import { EmbeddingPipeline } from '../embedding/pipeline.mjs'
import { runRetrievalWorker } from '../retrieval/worker.mjs'

export async function main(config = loadConfig()) {
  if (config.storeDriver !== 'postgres')
    throw new Error('retrieval worker requires MX_INSIGHT_STORE=postgres')
  const pool = createRetrievalPool(config.common.postgres, { worker: true })
  let agent
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const search = createSearch({ pool, config: config.common })
    agent = await createAgentRuntime({
      config,
      settingsStore: new AgentSettingsStore(pool),
      controlStore: new AgentControlStore(pool, { deploymentEgress: config.deploymentEgress }),
      managedKinds: ['embedding'],
    })
    const segmenter = requireSegmenterBackend(search.segmenter, {
      expectedBackend: 'hanlp',
      maxBatch: 16,
      maxAttempts: 3,
    })
    const pipeline = new EmbeddingPipeline({
      pool,
      agent,
      client: search.client,
      chunkIndexSet: search.chunkIndexSet,
      segmenter,
    })
    await runRetrievalWorker({ pool, pipeline, signal: controller.signal })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    agent?.close()
    await pool.end()
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
