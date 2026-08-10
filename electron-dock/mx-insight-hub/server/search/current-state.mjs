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
    return { currentIndex: indexSet.writeAlias, staleIndices: [] }
  }

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
  const staleIndices = Object.keys(readAliases || {}).filter((index) => index !== currentIndex)
  return { currentIndex, staleIndices }
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
  indexSet,
  documents,
  versionField,
}) {
  const targets = await resolveCurrentStateBackings({ client, indexSet })
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
