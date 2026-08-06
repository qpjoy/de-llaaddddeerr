// Declarative, idempotent Elasticsearch index lifecycle.
//
// An index set is described once in code; `ensureIndexSet` reconciles a cluster
// to that description and is safe to run on every deploy. It never deletes data:
// the destructive operations (drop index, drop alias) are intentionally absent
// from this module, so a deploy path can never remove a projection by accident.
//
// Naming, and why it has three layers:
//
//   read alias   mx-insight-hub-content            <- what queries use, forever
//   write alias  mx-insight-hub-content-v1         <- rollover target for one schema version
//   backing idx  mx-insight-hub-content-v1-000001  <- what ILM actually rolls
//
// A backwards-incompatible mapping change bumps the schema version, creating a
// second write alias behind the same read alias. Queries keep working across the
// migration and the old version is retired only after the reindex is verified.

import { ElasticsearchError } from './client.mjs'
import { MX_ANALYSIS } from './analysis.mjs'

const RESOURCE_ALREADY_EXISTS = new Set([
  'resource_already_exists_exception',
  'index_already_exists_exception',
])

/**
 * Age-based hot/warm/cold policy with no delete phase.
 *
 * One honest limitation: Elasticsearch ILM transitions on *age*, not on access.
 * There is no "promote back to hot when queried" action — cold-phase data stays
 * fully queryable, just at lower allocation priority and force-merged, so reads
 * are slower rather than unavailable. The access-triggered restore people
 * usually picture is `searchable_snapshot`, which requires an Enterprise
 * license; everything below runs on Basic.
 */
export function defaultIlmPolicy({
  rolloverMaxAge = '30d',
  rolloverMaxPrimaryShardSize = '50gb',
  rolloverMaxDocs = 50_000_000,
  warmAfter = '30d',
  coldAfter = '90d',
} = {}) {
  return {
    policy: {
      phases: {
        hot: {
          min_age: '0ms',
          actions: {
            set_priority: { priority: 100 },
            rollover: {
              max_age: rolloverMaxAge,
              max_primary_shard_size: rolloverMaxPrimaryShardSize,
              max_docs: rolloverMaxDocs,
            },
          },
        },
        warm: {
          min_age: warmAfter,
          actions: {
            set_priority: { priority: 50 },
            // One segment per shard: smaller heap footprint and faster reads for
            // data that no longer receives writes.
            forcemerge: { max_num_segments: 1 },
          },
        },
        cold: {
          min_age: coldAfter,
          actions: {
            set_priority: { priority: 0 },
            readonly: {},
          },
        },
        // No `delete` phase, by product decision: search data is retained
        // indefinitely and pruned only through an explicit, audited operation.
      },
    },
  }
}

/**
 * Describe one logical search projection.
 *
 * @param {object} definition
 * @param {string} definition.productId    isolation unit, e.g. `mx-insight-hub`
 * @param {string} definition.name         projection name, e.g. `content`
 * @param {number} definition.schemaVersion bump only for incompatible mappings
 * @param {object} definition.properties   ES mapping properties
 * @param {object} [definition.ilm]        overrides for defaultIlmPolicy
 */
export function defineIndexSet({
  productId,
  name,
  schemaVersion = 1,
  properties,
  dynamic = 'strict',
  numberOfShards = 1,
  numberOfReplicas = 0,
  ilm = {},
  meta = {},
}) {
  if (!productId || !name) throw new Error('productId and name are required')
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error('schemaVersion must be a positive integer')
  }
  const readAlias = `${productId}-${name}`
  const writeAlias = `${readAlias}-v${schemaVersion}`
  return {
    productId,
    name,
    schemaVersion,
    readAlias,
    writeAlias,
    indexPattern: `${writeAlias}-*`,
    bootstrapIndex: `${writeAlias}-000001`,
    policyName: `${readAlias}-policy`,
    templateName: `${writeAlias}-template`,
    settings: {
      number_of_shards: numberOfShards,
      number_of_replicas: numberOfReplicas,
      'index.lifecycle.name': `${readAlias}-policy`,
      'index.lifecycle.rollover_alias': writeAlias,
      analysis: MX_ANALYSIS,
    },
    mappings: {
      dynamic,
      _meta: { productId, name, schemaVersion, ...meta },
      properties,
    },
    ilm,
  }
}

async function ignoreAlreadyExists(promise) {
  try {
    return await promise
  } catch (error) {
    if (error instanceof ElasticsearchError && RESOURCE_ALREADY_EXISTS.has(error.type)) {
      return { acknowledged: true, alreadyExists: true }
    }
    throw error
  }
}

/**
 * Reconcile a cluster to an index-set definition. Idempotent and additive.
 *
 * Mapping updates are applied to the *template* (which governs indices created
 * from the next rollover onward) and attempted on the current write index.
 * Elasticsearch accepts new fields but rejects a changed type; that rejection is
 * surfaced as `mappingConflict` rather than thrown, because a deploy must not
 * fail on a schema change that requires an operator-driven reindex.
 */
export async function ensureIndexSet(client, definition, { logger = console } = {}) {
  const result = {
    readAlias: definition.readAlias,
    writeAlias: definition.writeAlias,
    createdBootstrapIndex: false,
    mappingConflict: null,
  }

  await client.putIlmPolicy(definition.policyName, defaultIlmPolicy(definition.ilm))

  await client.putIndexTemplate(definition.templateName, {
    index_patterns: [definition.indexPattern],
    priority: 500,
    _meta: {
      owner: definition.productId,
      projection: definition.name,
      schemaVersion: definition.schemaVersion,
    },
    template: {
      settings: definition.settings,
      mappings: definition.mappings,
      // Only the write alias is attached by the template. The read alias is
      // managed separately below, because it must span schema versions and a
      // template can only describe the version it belongs to.
      aliases: { [definition.readAlias]: {} },
    },
  })

  // Bootstrap the first backing index. ILM will not roll over an alias that has
  // no write index, so this step is what actually starts the lifecycle.
  if (!(await client.aliasExists(definition.writeAlias))) {
    const created = await ignoreAlreadyExists(
      client.createIndex(definition.bootstrapIndex, {
        aliases: {
          [definition.writeAlias]: { is_write_index: true },
          [definition.readAlias]: {},
        },
      }),
    )
    result.createdBootstrapIndex = !created.alreadyExists
    logger?.info?.(
      `[mx-common] bootstrapped ${definition.bootstrapIndex} (write alias ${definition.writeAlias})`,
    )
  } else {
    // Existing alias: push additive mapping changes onto every backing index so
    // a new field is queryable immediately instead of only after a rollover.
    try {
      await client.putMapping(definition.writeAlias, {
        properties: definition.mappings.properties,
      })
    } catch (error) {
      if (error instanceof ElasticsearchError && error.status === 400) {
        result.mappingConflict = error.body?.error?.reason || 'incompatible mapping change'
        logger?.warn?.(
          `[mx-common] ${definition.writeAlias} mapping change needs a reindex: ${result.mappingConflict}`,
        )
      } else {
        throw error
      }
    }
  }

  return result
}

/**
 * Copy every document from one schema version into the next.
 *
 * Runs as an async ES task by default: a reindex over a large projection far
 * outlives an HTTP request, and holding a deploy script open on it would make
 * the deploy look hung. Poll `_tasks/<taskId>` for progress.
 */
export async function reindexSchemaVersion(client, { from, to, script = null, waitForCompletion = false }) {
  return client.reindex(
    {
      source: { index: from.writeAlias },
      dest: { index: to.writeAlias, op_type: 'index' },
      ...(script ? { script } : {}),
    },
    { waitForCompletion },
  )
}
