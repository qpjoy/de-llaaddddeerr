import assert from 'node:assert/strict'
import test from 'node:test'
import { loadCommonConfig, productDatabaseName, ConfigError } from '../src/config.mjs'
import { defineIndexSet, defaultIlmPolicy } from '../src/elasticsearch/index-manager.mjs'
import { nameField, vectorField } from '../src/elasticsearch/analysis.mjs'
import { dailySnapshotPolicy, s3Repository, snapshotHealth } from '../src/elasticsearch/snapshots.mjs'
import { createQueue } from '../src/queue/index.mjs'

test('product id maps to a hyphen-free database name', () => {
  assert.equal(productDatabaseName('mx-insight-hub'), 'mx_insight_hub')
  assert.throws(() => productDatabaseName('MX_Insight'), ConfigError)
  assert.throws(() => productDatabaseName('ab'), ConfigError)
})

test('optional stores are absent rather than fatal when unconfigured', () => {
  const config = loadCommonConfig('mx-insight-hub', { DATABASE_URL: 'postgres://x/y' })
  assert.equal(config.elasticsearch.enabled, false)
  assert.equal(config.redis.enabled, false)
  assert.equal(config.segmenter.hanlpUrl, null)
  // No Redis means the queue must still work, so it falls back to PostgreSQL
  // rather than refusing to start.
  assert.equal(config.queue.driver, 'postgres')
})

test('a reachable Redis does not silently downgrade the queue driver', () => {
  // Adding Redis for caching must not take transactional enqueue away from a
  // product that never asked for BullMQ.
  const withRedis = loadCommonConfig('mx-insight-hub', {
    DATABASE_URL: 'postgres://x/y',
    MX_COMMON_REDIS_URL: 'redis://localhost:6379',
  })
  assert.equal(withRedis.queue.driver, 'postgres')

  const optedIn = loadCommonConfig('mx-insight-hub', {
    DATABASE_URL: 'postgres://x/y',
    MX_COMMON_REDIS_URL: 'redis://localhost:6379',
    MX_COMMON_QUEUE_DRIVER: 'bullmq',
  })
  assert.equal(optedIn.queue.driver, 'bullmq')
})

test('bullmq driver refuses a transactional enqueue instead of silently dropping it', async () => {
  const queue = createQueue(
    { driver: 'bullmq', namespace: 'test', redisUrl: 'redis://localhost:6379', maxAttempts: 3 },
    { pool: {}, logger: { error() {} } },
  )
  // Redis cannot join a PostgreSQL transaction. Accepting the client argument
  // and ignoring it would look correct and lose jobs on crash, so it throws.
  await assert.rejects(
    () => queue.enqueue('demo', {}, { client: {} }),
    /Transactional enqueue is not available/,
  )
})

test('index set names encode the schema version in the write alias only', () => {
  const v1 = defineIndexSet({ productId: 'demo-product', name: 'content', properties: {} })
  const v2 = defineIndexSet({
    productId: 'demo-product',
    name: 'content',
    schemaVersion: 2,
    properties: {},
  })
  // The read alias is stable across versions so query code survives a migration.
  assert.equal(v1.readAlias, v2.readAlias)
  assert.notEqual(v1.writeAlias, v2.writeAlias)
  assert.equal(v2.bootstrapIndex, 'demo-product-content-v2-000001')
})

test('single-node index sets default to zero replicas', () => {
  const definition = defineIndexSet({ productId: 'demo-product', name: 'content', properties: {} })
  // A replica that can never be allocated keeps the cluster yellow forever and
  // would block any "wait for green" gate.
  assert.equal(definition.settings.number_of_replicas, 0)
})

test('the lifecycle policy never deletes data', () => {
  const { policy } = defaultIlmPolicy()
  assert.deepEqual(Object.keys(policy.phases).sort(), ['cold', 'hot', 'warm'])
  assert.equal(policy.phases.delete, undefined)
  assert.equal(policy.phases.hot.actions.rollover.max_age, '30d')
  assert.equal(policy.phases.cold.actions.readonly !== undefined, true)
})

test('name fields expose exact, prefix and bigram sub-fields', () => {
  const field = nameField()
  assert.deepEqual(Object.keys(field.fields).sort(), ['bigram', 'keyword', 'prefix'])
  // Applying the ngram filter at search time too would match on any shared
  // prefix and destroy precision.
  assert.equal(field.fields.prefix.analyzer, 'mx_edge_ngram')
  assert.equal(field.fields.prefix.search_analyzer, 'mx_edge_ngram_search')
})

test('vector fields are indexed for kNN and quantized by default', () => {
  const field = vectorField(768)
  assert.equal(field.index, true)
  assert.equal(field.similarity, 'cosine')
  // Raw float32 HNSW sets a hard memory ceiling; quantizing is what keeps a
  // large corpus searchable at all.
  assert.equal(field.index_options.type, 'int8_hnsw')
  assert.equal(vectorField(768, { quantization: 'bbq' }).index_options.type, 'bbq_hnsw')
  assert.equal(vectorField(768, { quantization: null }).index_options.type, 'hnsw')
  assert.throws(() => vectorField(0), /positive integer/)
})

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

test('a snapshot must fail loudly rather than complete partially', () => {
  const policy = dailySnapshotPolicy()
  // A partial snapshot that reports success is worse than no snapshot: it gets
  // trusted at restore time.
  assert.equal(policy.config.partial, false)
  assert.equal(policy.config.ignore_unavailable, false)
})

test('snapshot retention keeps a floor even past the expiry window', () => {
  const { retention } = dailySnapshotPolicy()
  assert.equal(retention.expire_after, '30d')
  // Without min_count, a cluster idle longer than expire_after would expire its
  // way down to zero restore points.
  assert.ok(retention.min_count >= 1)
})

test('cluster state is excluded so a restore cannot clobber another cluster', () => {
  // Index templates, ILM and SLM policies are reconciled from code on every
  // deploy; capturing them here would add a second, staler source of truth.
  assert.equal(dailySnapshotPolicy().config.include_global_state, false)
})

test('an S3 repository requires a bucket rather than defaulting to something', () => {
  assert.throws(() => s3Repository({}), /requires a bucket/)
  const repo = s3Repository({ bucket: 'mx-backups', endpoint: 'http://minio:9000' })
  assert.equal(repo.type, 's3')
  assert.equal(repo.settings.path_style_access, true)
})

test('snapshot health treats "never succeeded" as unhealthy, not unknown', async () => {
  const client = {
    request: async () => ({ 'mx-common-daily': { policy: {}, stats: { snapshots_taken: 0 } } }),
  }
  const health = await snapshotHealth(client)
  assert.equal(health.configured, true)
  // A policy that exists but has never run is the exact failure this catches:
  // "configured" and "working" are different claims.
  assert.equal(health.healthy, false)
  assert.match(health.reason, /no successful snapshot/)
})

test('snapshot health goes unhealthy once the last success is stale', async () => {
  const twoDaysAgo = Date.now() - 48 * 3_600_000
  const client = {
    request: async () => ({
      'mx-common-daily': {
        last_success: { time: twoDaysAgo },
        stats: { snapshots_taken: 12, snapshots_failed: 3 },
      },
    }),
  }
  const health = await snapshotHealth(client, { staleAfterHours: 36 })
  assert.equal(health.healthy, false)
  assert.ok(health.lastSuccessAgeHours >= 47)
  assert.equal(health.snapshotsFailed, 3)
})
