// Shared environment resolution for MX product modules.
//
// Every product that consumes mx-common declares a `productId` (for example
// `mx-insight-hub`). The productId is the isolation unit agreed in ADR-0003:
// one PostgreSQL database, one Elasticsearch index prefix, one queue namespace.
// Nothing here reads a product's business configuration; products keep owning
// their own config module and pass the resolved values in.

const PRODUCT_ID_PATTERN = /^[a-z][a-z0-9-]{2,39}$/

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
    this.code = 'invalid_configuration'
  }
}

function requirePositiveInteger(value, fallback, name) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer`)
  }
  return parsed
}

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function assertProductId(productId) {
  if (!PRODUCT_ID_PATTERN.test(productId || '')) {
    throw new ConfigError(
      'productId must be 3-40 lowercase characters, digits or hyphens, starting with a letter',
    )
  }
  return productId
}

// `mx-insight-hub` -> `mx_insight_hub`. Used for database names and role names,
// which cannot contain hyphens without quoting everywhere.
export function productDatabaseName(productId) {
  return assertProductId(productId).replaceAll('-', '_')
}

// `mx-insight-hub` + `content` -> `mx-insight-hub-content`. Every index this
// product owns starts with the product prefix, so a shared cluster stays
// attributable and an ILM policy or template can never straddle two products.
export function productIndexPrefix(productId) {
  return assertProductId(productId)
}

/**
 * Resolve the shared data-plane configuration for one product.
 *
 * Absent Elasticsearch/Redis configuration is not an error: both are optional
 * accelerators. Callers decide whether a missing dependency degrades a feature
 * or fails a request; mx-common never turns an unconfigured optional store into
 * a startup failure, because that would let search take down the API.
 */
export function loadCommonConfig(productId, environment = process.env) {
  assertProductId(productId)

  const elasticsearchUrl = trimmed(environment.MX_COMMON_ELASTICSEARCH_URL)
  const redisUrl = trimmed(environment.MX_COMMON_REDIS_URL)
  const hanlpUrl = trimmed(environment.MX_COMMON_HANLP_URL)

  return {
    productId,
    databaseName: productDatabaseName(productId),
    indexPrefix: productIndexPrefix(productId),

    postgres: {
      // Products keep owning their own DATABASE_URL. mx-common only reads it so
      // the migrator and pool share one source of truth.
      url: trimmed(environment.DATABASE_URL),
      maxConnections: requirePositiveInteger(
        environment.MX_COMMON_POSTGRES_MAX_CONNECTIONS,
        10,
        'MX_COMMON_POSTGRES_MAX_CONNECTIONS',
      ),
      statementTimeoutMs: requirePositiveInteger(
        environment.MX_COMMON_POSTGRES_STATEMENT_TIMEOUT_MS,
        30_000,
        'MX_COMMON_POSTGRES_STATEMENT_TIMEOUT_MS',
      ),
    },

    elasticsearch: {
      enabled: Boolean(elasticsearchUrl),
      url: elasticsearchUrl,
      username: trimmed(environment.MX_COMMON_ELASTICSEARCH_USERNAME),
      password: trimmed(environment.MX_COMMON_ELASTICSEARCH_PASSWORD),
      requestTimeoutMs: requirePositiveInteger(
        environment.MX_COMMON_ELASTICSEARCH_TIMEOUT_MS,
        10_000,
        'MX_COMMON_ELASTICSEARCH_TIMEOUT_MS',
      ),
      // Single-node clusters cannot allocate replicas; a replica-1 index stays
      // yellow forever and blocks any "wait for green" gate.
      numberOfReplicas: Number(environment.MX_COMMON_ELASTICSEARCH_REPLICAS ?? 0),
    },

    redis: {
      enabled: Boolean(redisUrl),
      url: redisUrl,
    },

    segmenter: {
      // No URL means the built-in fallback segmenter is used. It is weaker than
      // HanLP but keeps ingest working, and the projection is rebuildable, so a
      // later HanLP rollout is a reindex rather than a data loss.
      hanlpUrl,
      hanlpToken: trimmed(environment.MX_COMMON_HANLP_TOKEN),
      timeoutMs: requirePositiveInteger(
        environment.MX_COMMON_HANLP_TIMEOUT_MS,
        5_000,
        'MX_COMMON_HANLP_TIMEOUT_MS',
      ),
    },

    queue: {
      // Always `postgres` unless a product explicitly opts out. Defaulting to
      // bullmq merely because Redis happens to be reachable would silently
      // remove transactional enqueue -- the property this queue exists for --
      // from any product that later gains a Redis URL for caching. Opting into
      // a weaker durability guarantee has to be a written decision.
      driver: trimmed(environment.MX_COMMON_QUEUE_DRIVER) || 'postgres',
      namespace: productId,
      concurrency: requirePositiveInteger(
        environment.MX_COMMON_QUEUE_CONCURRENCY,
        4,
        'MX_COMMON_QUEUE_CONCURRENCY',
      ),
      visibilityTimeoutMs: requirePositiveInteger(
        environment.MX_COMMON_QUEUE_VISIBILITY_TIMEOUT_MS,
        120_000,
        'MX_COMMON_QUEUE_VISIBILITY_TIMEOUT_MS',
      ),
      maxAttempts: requirePositiveInteger(
        environment.MX_COMMON_QUEUE_MAX_ATTEMPTS,
        5,
        'MX_COMMON_QUEUE_MAX_ATTEMPTS',
      ),
    },
  }
}
