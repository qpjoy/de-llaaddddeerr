const CURRENT_STATE_CUTOVER_LOCK_PREFIX = 'mx-insight-hub:search:current-cutover:'

export function currentStateCutoverLockName(indexSet) {
  if (!indexSet?.readAlias) throw new TypeError('A current-state read alias is required')
  return `${CURRENT_STATE_CUTOVER_LOCK_PREFIX}${indexSet.readAlias}`
}

async function withAdvisoryFence({ connection, lockName, shared, releaseConnection }, operation) {
  if (typeof connection?.query !== 'function') {
    throw new TypeError('A PostgreSQL connection is required for the current-state write fence')
  }
  const suffix = shared ? '_shared' : ''
  let locked = false
  let operationError = null
  try {
    await connection.query(
      `SELECT pg_advisory_lock${suffix}(hashtextextended($1, 0))`,
      [lockName],
    )
    locked = true
    return await operation(connection)
  } catch (error) {
    operationError = error
    throw error
  } finally {
    let cleanupError = null
    if (locked) {
      try {
        await connection.query(
          `SELECT pg_advisory_unlock${suffix}(hashtextextended($1, 0))`,
          [lockName],
        )
      } catch (error) {
        cleanupError = error
      }
    }
    if (releaseConnection) {
      try {
        // A session-level advisory lock whose unlock failed must never return
        // to the pool. `pg` destroys the client when release receives an error.
        connection.release(cleanupError || undefined)
      } catch (error) {
        cleanupError ||= error
      }
    }
    if (cleanupError && !operationError) throw cleanupError
  }
}

/**
 * Keep live projection resolution, provenance verification and the matching ES
 * bulk write on one side of an A/B cutover. A shared advisory lock is held only
 * for that short write window, so the multi-hour snapshot build remains online.
 */
export async function withCurrentStateWriteFence({ pool, indexSet }, operation) {
  if (typeof pool?.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required for the current-state write fence')
  }
  const lockName = currentStateCutoverLockName(indexSet)
  const connection = await pool.connect()
  return withAdvisoryFence({
    connection,
    lockName,
    shared: true,
    releaseConnection: true,
  }, operation)
}

/** Hold the exclusive side only while the read/write aliases move together. */
export async function withCurrentStateCutoverFence({ connection, indexSet }, operation) {
  return withAdvisoryFence({
    connection,
    lockName: currentStateCutoverLockName(indexSet),
    shared: false,
    releaseConnection: false,
  }, operation)
}

/**
 * Resolve the one concrete write index and every older concrete index that is
 * still visible through the logical read alias.
 *
 * Current-state documents cannot rely on `_id` uniqueness across an alias: the
 * same id may exist once per schema version or ILM generation. Keeping this
 * concern outside the projector also lets the chunk projection reuse it with a
 * different revision field.
 */
export async function resolveCurrentStateBackings({ client, indexSet }) {
  if (typeof client.getAlias !== 'function') {
    return { currentIndex: indexSet.writeAlias, writeTarget: indexSet.writeAlias, staleIndices: [] }
  }

  // Alias movement is atomic in Elasticsearch, but two separate reads can
  // straddle that movement. Never use such a cross-generation snapshot to
  // delete stale copies. Retry once; the bulk write itself targets the stable
  // write alias so a cutover after this check still lands on the live slot.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const writeAliases = await client.getAlias(indexSet.writeAlias)
    const writeEntries = Object.entries(writeAliases || {})
    const explicitWrite = writeEntries.find(([, definition]) => (
      definition?.aliases?.[indexSet.writeAlias]?.is_write_index === true
    ))
    const currentIndex = explicitWrite?.[0] || (writeEntries.length === 1 ? writeEntries[0][0] : null)
    if (!currentIndex) {
      throw new Error(`Cannot resolve a concrete write index for ${indexSet.writeAlias}`)
    }

    const readAliases = await client.getAlias(indexSet.readAlias)
    const readIndices = Object.keys(readAliases || {})
    const rebuildSlots = new Set([
      indexSet.currentIndex,
      `${indexSet.writeAlias}-rebuild`,
    ].filter(Boolean))
    const visibleSlots = readIndices.filter((index) => rebuildSlots.has(index))
    if (visibleSlots.length > 1) {
      const error = new Error(
        `Read alias ${indexSet.readAlias} spans multiple current-state generations: ` +
          visibleSlots.join(', '),
      )
      error.code = 'search_alias_ambiguous'
      throw error
    }
    if (readIndices.includes(currentIndex)) {
      return {
        currentIndex,
        writeTarget: indexSet.writeAlias,
        staleIndices: readIndices.filter((index) => index !== currentIndex),
      }
    }
  }

  const error = new Error(
    `Read alias ${indexSet.readAlias} changed while resolving ${indexSet.writeAlias}; retry the projection`,
  )
  error.code = 'search_alias_changed'
  throw error
}

async function assertCurrentStateBackend({ pool, indexName, expectedBackend }) {
  if (!expectedBackend) return
  if (typeof pool?.query !== 'function') {
    throw new TypeError('A PostgreSQL pool is required to verify current-state tokenizer provenance')
  }
  const { rows } = await pool.query(
    `SELECT segmenter_backend
       FROM control.search_rebuild_progress
      WHERE index_name = $1`,
    [indexName],
  )
  const actualBackend = rows[0]?.segmenter_backend ?? null
  if (actualBackend === expectedBackend) return
  const error = new Error(
    `Refusing to write ${expectedBackend} tokens into ${indexName}; ` +
      `serving index backend is ${actualBackend || 'unrecorded'}`,
  )
  error.code = 'search_index_backend_mismatch'
  error.expectedBackend = expectedBackend
  error.actualBackend = actualBackend
  throw error
}

/**
 * Remove obsolete copies from non-current schema/rollover indices.
 *
 * Each id has its own revision ceiling so a delayed cleanup cannot remove a
 * newer projection written by another worker. `conflicts=proceed` preserves the
 * newer winner if an index changes after delete-by-query took its snapshot.
 */
export async function purgeStaleCurrentStateCopies({
  client,
  pool = null,
  indexSet,
  documents,
  versionField,
  expectedBackend = null,
}) {
  const targets = await resolveCurrentStateBackings({ client, indexSet })
  await assertCurrentStateBackend({
    pool,
    indexName: targets.currentIndex,
    expectedBackend,
  })
  if (targets.staleIndices.length === 0 || documents.length === 0) return targets
  if (typeof client.request !== 'function') {
    throw new Error('Elasticsearch client must support request() to purge stale backing-index copies')
  }

  const should = documents.map(({ id, version }) => ({
    bool: {
      filter: [
        { ids: { values: [id] } },
        {
          bool: {
            should: [
              { range: { [versionField]: { lte: version } } },
              // Legacy schema generations may predate the revision field. They
              // are non-current by definition, so an unversioned copy is stale.
              { bool: { must_not: [{ exists: { field: versionField } }] } },
            ],
            minimum_should_match: 1,
          },
        },
      ],
    },
  }))
  const indexPath = targets.staleIndices.map((index) => encodeURIComponent(index)).join(',')
  const response = await client.request(
    'POST',
    `/${indexPath}/_delete_by_query?conflicts=proceed&refresh=true`,
    { query: { bool: { should, minimum_should_match: 1 } } },
    { timeoutMs: 60_000 },
  )
  if (response?.timed_out || response?.failures?.length > 0) {
    const reason = response?.timed_out
      ? 'delete-by-query timed out'
      : JSON.stringify(response.failures[0]).slice(0, 500)
    throw new Error(`Failed to purge stale current-state copies: ${reason}`)
  }
  return targets
}
