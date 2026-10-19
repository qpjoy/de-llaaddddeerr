import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// Fixed incident, standalone stdin diagnostic. No Hub business request, source
// connection, refresh, rebuild, retry, repair, count or business-text output.
export const REQUEST_IDS = ['96398363-af53-4e15-aae0-a9ebc75cc3ac', 'd3a4c71c-4b06-4bea-b0ca-04de4226fa9e']
const DATASETS = ['telegram.monitor.messages.v1', 'telegram.sqlite.messages.v1']
const EXPECTED = { query: '领导人', sourceScope: 'all', scope: 'messages', matchMode: 'full_text', pageSize: 20,
  from: '2026-10-13T19:51:18.939036Z', to: '2026-10-18T19:51:18.939036Z' }
const FROM = new Date(EXPECTED.from).toISOString(), TO = new Date(EXPECTED.to).toISOString()
const READ = 'mx-insight-hub-content', WRITE = `${READ}-v6`
const CHUNKS = 'mx-insight-hub-chunk'
const FILES = ['server/hub-service.mjs', 'server/data/telegram-monitor.mjs', 'server/search/queries.mjs', 'server/search/index-definitions.mjs']
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const bool = value => typeof value === 'boolean' ? value : null
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value) ? value : null
const time = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null
const choice = (value, allowed) => value == null ? null : allowed.includes(value) ? value : 'other'
const model = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._/:@-]{0,127}$/iu.test(value) ? value : null
const failure = error => ({ state: 'incomplete', code: /^[0-9A-Z]{5}$/u.test(error?.code ?? '') ? error.code : 'diagnostic_read_failed' })
const item = row => ({ id: uuid(row.id), datasetId: choice(row.dataset_id ?? row.datasetId, DATASETS), eventTime: time(row.event_time ?? row.eventTime) })

export async function telegramSearchDatabase(pool) {
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '3s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    await client.query('SET LOCAL search_path = pg_catalog, pg_temp')
    const read = async (sql, values, project) => {
      await client.query('SAVEPOINT telegram_search_diagnostic')
      try {
        const { rows } = await client.query(sql, values)
        await client.query('RELEASE SAVEPOINT telegram_search_diagnostic')
        return { state: 'observed', rows: rows.map(project) }
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT telegram_search_diagnostic')
        await client.query('RELEASE SAVEPOINT telegram_search_diagnostic')
        return { ...failure(error), rows: null }
      }
    }
    const requests = await read(`SELECT /* tg-search:requests */ id,status,response_status,reserved_at,completed_at,
      platform = 'telegram' AS platform_matches, acquisition_request IS NOT NULL AS snapshot_present,
      acquisition_request->>'method' = 'POST' AS method_matches,
      acquisition_request->>'path' = '/api/v1/data/telegram/search' AS path_matches,
      jsonb_build_object(${Object.keys(EXPECTED).map(field => `'${field}', acquisition_request->'body'->'${field}' = $2::jsonb->'${field}'`).join(',')}) AS fields_match,
      NOT (acquisition_request->'body' ? 'cursor') AS first_page,
      response_body #>> '{data,status}' AS delivery_status,
      CASE WHEN jsonb_typeof(response_body #> '{data,items}') = 'array'
        THEN jsonb_array_length(response_body #> '{data,items}') END AS returned_count,
      response_body #> '{data,pageInfo,hasMore}' = 'true'::jsonb AS has_more,
      response_body #> '{data,warnings}' @> '[{"code":"search_projection_degraded"}]'::jsonb AS projection_degraded,
      response_body #> '{data,warnings}' @> '[{"code":"search_profile_degraded"}]'::jsonb AS profile_degraded,
      error_code IS NOT NULL AS error_present
      FROM public.usage_requests WHERE id = ANY($1::uuid[]) ORDER BY id LIMIT 2`, [REQUEST_IDS, EXPECTED], row => ({
      requestId: uuid(row.id), status: choice(row.status, ['reserved', 'committed', 'released', 'unknown']),
      responseStatus: integer(row.response_status), reservedAt: time(row.reserved_at), completedAt: time(row.completed_at),
      platformMatches: bool(row.platform_matches), snapshotPresent: bool(row.snapshot_present), methodMatches: bool(row.method_matches),
      pathMatches: bool(row.path_matches), expectedFieldsMatch: Object.fromEntries(Object.keys(EXPECTED).map(field => [field, bool(row.fields_match?.[field])])), firstPage: bool(row.first_page),
      deliveryStatus: choice(row.delivery_status, ['ok', 'partial', 'error']), returnedCount: integer(row.returned_count),
      hasMore: bool(row.has_more), projectionDegraded: bool(row.projection_degraded), profileDegraded: bool(row.profile_degraded), errorPresent: bool(row.error_present),
    }))
    const datasets = []
    for (const datasetId of DATASETS) {
      const probes = {}
      for (const [name, window, keyword] of [['any', false, false], ['window', true, false], ['windowLiteral', true, true], ['literalAnyTime', false, true]]) {
        probes[name] = await read(`SELECT /* tg-search:${name} */ id,dataset_id,event_time FROM core.canonical_records
          WHERE deleted_at IS NULL AND platform='telegram' AND object_type='message' AND dataset_id=$1
          ${window ? 'AND event_time >= $2::timestamptz AND event_time <= $3::timestamptz' : ''}
          ${keyword ? `AND (title ILIKE '%' || $${window ? 4 : 2} || '%' OR body ILIKE '%' || $${window ? 4 : 2} || '%')` : ''}
          LIMIT 1`, [datasetId, ...(window ? [FROM, TO] : []), ...(keyword ? [EXPECTED.query] : [])], item)
      }
      probes.currentVector = await read(`SELECT /* tg-search:vector */ c.id AS chunk_id,c.chunk_index,c.chunker_version,r.id,r.dataset_id,r.event_time,
        r.current_revision,c.source_revision,c.embedding_model,array_length(c.vector,1) AS dimensions,c.embedded_at,c.projected_at
        FROM core.canonical_records r JOIN core.record_chunks c ON c.record_id=r.id AND c.source_revision=r.current_revision
        WHERE r.deleted_at IS NULL AND r.platform='telegram' AND r.object_type='message' AND r.dataset_id=$1
          AND c.embedded_at IS NOT NULL AND c.embedding_model IS NOT NULL AND array_length(c.vector,1)>0 LIMIT 1`, [datasetId], row => ({
        ...item(row), chunkId: uuid(row.chunk_id), currentRevision: integer(row.current_revision), sourceRevision: integer(row.source_revision),
        model: model(row.embedding_model), dimensions: integer(row.dimensions), embeddedAt: time(row.embedded_at), projectedAt: time(row.projected_at),
        documentId: uuid(row.id) && integer(row.chunk_index) != null && model(row.chunker_version) ? `${row.id}:${row.chunk_index}:${row.chunker_version}` : null,
      }))
      datasets.push({ datasetId, ...probes })
    }
    return { state: requests.state === 'observed' && requests.rows.length === 2
      && datasets.every(row => Object.values(row).filter(value => value && typeof value === 'object').every(value => value.state === 'observed'))
      ? 'observed' : 'incomplete', requests, datasets }
  } catch (error) { return failure(error) }
  finally {
    if (client) {
      let error
      try { await client.query('ROLLBACK') } catch (caught) { error = caught }
      client.release(error)
      if (error) throw new Error('diagnostic_read_failed')
    }
  }
}

// Deadline includes the complete response body. GET source= is read-only ES
// search; redirects are rejected and neither URLs nor error bodies are printed.
export function elasticReader(environment, fetchImpl = fetch, deadlineMs = 5000) {
  const configured = environment.MX_COMMON_ELASTICSEARCH_URL?.trim()
    || (environment.KUBERNETES_SERVICE_HOST?.trim() ? 'http://mx-common-elasticsearch.mx-common.svc.cluster.local:9200' : null)
  if (!configured) return null
  const base = new URL(configured)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('invalid_search_config')
  const username = environment.MX_COMMON_ELASTICSEARCH_USERNAME?.trim(), password = environment.MX_COMMON_ELASTICSEARCH_PASSWORD?.trim()
  const headers = username && password ? { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } : {}
  return async (path, query) => {
    const url = new URL(`${base.href.replace(/\/$/u, '')}${path}`)
    if (query) { url.searchParams.set('source_content_type', 'application/json'); url.searchParams.set('source', JSON.stringify(query)) }
    const controller = new AbortController(); let timer, reader
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')) }, deadlineMs) })
      return await Promise.race([timeout, (async () => {
        const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal })
        if (!response.ok) return { state: 'incomplete', httpStatus: integer(response.status) }
        reader = response.body.getReader(); const chunks = []; let bytes = 0
        while (true) {
          const part = await reader.read(); if (part.done) break
          bytes += part.value.byteLength; if (bytes > 1024 * 1024) throw new Error('body_limit')
          chunks.push(part.value)
        }
        return { state: 'observed', data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      })()])
    } catch { return { state: 'incomplete', code: 'search_read_failed' } }
    finally { clearTimeout(timer); controller.abort(); reader?.cancel().catch(() => {}) }
  }
}

export function summarizeSearch(result, project = item) {
  if (result.state !== 'observed') return result
  const data = result.data, shards = data?._shards
  const complete = data?.timed_out === false && data?.terminated_early !== true && integer(shards?.failed) === 0
    && integer(shards?.total) !== null && shards.total > 0 && shards.successful === shards.total
    && Array.isArray(data?.hits?.hits) && data.hits.hits.length <= 1
  return { state: complete ? 'observed' : 'incomplete', timedOut: bool(data?.timed_out), terminatedEarly: bool(data?.terminated_early),
    shards: { total: integer(shards?.total), successful: integer(shards?.successful), skipped: integer(shards?.skipped), failed: integer(shards?.failed) },
    found: complete ? data.hits.hits.length > 0 : null,
    samples: Array.isArray(data?.hits?.hits) ? data.hits.hits.slice(0, 1).map(hit => project({ ...hit?._source, id: hit?._source?.id ?? hit?._id })) : [] }
}

export async function telegramSearchProjection(read, database) {
  if (!read) return { state: 'incomplete', code: 'search_not_configured' }
  const aliases = [], mappings = []
  for (const alias of [READ, WRITE, CHUNKS]) {
    const response = await read(`/_alias/${alias}`)
    const entries = Object.entries(response.data ?? {}).slice(0, 9)
    aliases.push({ alias, state: response.state === 'observed' && entries.length > 0 && entries.length <= 8
      && entries.every(([, value]) => Object.hasOwn(value?.aliases ?? {}, alias)) ? 'observed' : 'incomplete',
      ...(response.state !== 'observed' ? { readFailure: response } : {}),
      indices: entries.slice(0, 8).map(([index, value]) => ({ index: /^mx-insight-hub-(?:content|chunk)[-a-z0-9]{0,120}$/u.test(index) ? index : 'withheld',
        bound: Object.hasOwn(value?.aliases ?? {}, alias), write: bool(value?.aliases?.[alias]?.is_write_index) })) })
    const fields = alias === CHUNKS ? ['recordId', 'sourceRevision', 'embeddingSpace', 'embedding']
      : ['id', 'datasetId', 'platform', 'objectType', 'eventTime', 'title', 'body', 'chatUsername', 'titleHanlp', 'bodyHanlp']
    const mapping = await read(`/${alias}/_mapping?filter_path=${fields.map(field => `*.mappings.properties.${field}.type`).join(',')},*.mappings.properties.embedding.dims`)
    const mapped = Object.entries(mapping.data ?? {}).slice(0, 9)
    mappings.push({ alias, state: mapping.state === 'observed' && mapped.length > 0 && mapped.length <= 8 ? 'observed' : 'incomplete',
      ...(mapping.state !== 'observed' ? { readFailure: mapping } : {}),
      indices: mapped.slice(0, 8).map(([index, value]) => ({ index: /^mx-insight-hub-(?:content|chunk)[-a-z0-9]{0,120}$/u.test(index) ? index : 'withheld',
        ...(alias === CHUNKS ? { dimensions: integer(value?.mappings?.properties?.embedding?.dims) } : {}),
        fields: Object.fromEntries(fields.map(field => [field,
          choice(value?.mappings?.properties?.[field]?.type, ['keyword', 'text', 'date', 'date_nanos', 'long', 'dense_vector'])])) })) })
  }
  const scope = [{ term: { platform: 'telegram' } }, { terms: { datasetId: DATASETS } }, { term: { objectType: 'message' } }]
  const window = { range: { eventTime: { gte: FROM, lte: TO } } }
  const phrase = { bool: { minimum_should_match: 1, should: ['title', 'body', 'chatUsername'].map(field => ({ match_phrase: { [field]: EXPECTED.query } })) } }
  const search = async query => summarizeSearch(await read(`/${READ}/_search`, {
    size: 1, _source: ['id', 'datasetId', 'eventTime'], track_total_hits: false, timeout: '3s', query,
  }))
  const probes = {}
  for (const [name, filters] of [['scope', scope], ['window', [...scope, window]], ['rawPhrase', [...scope, window, phrase]]]) {
    probes[name] = await search({ bool: { filter: filters } })
  }
  const ids = (database?.datasets ?? []).flatMap(row => row.windowLiteral?.rows ?? []).map(row => row.id).filter(Boolean)
  const canonicalSamples = []
  for (const id of ids) canonicalSamples.push({ id, ...await search({ ids: { values: [id] } }) })
  const vectorSamples = []
  for (const sample of (database?.datasets ?? []).flatMap(row => row.currentVector?.rows ?? [])) {
    if (!sample.documentId) { vectorSamples.push({ chunkId: sample.chunkId, state: 'incomplete', code: 'chunk_identity_unavailable' }); continue }
    const response = await read(`/${CHUNKS}/_search`, { size: 1, _source: ['recordId', 'sourceRevision', 'embeddingSpace'],
      track_total_hits: false, timeout: '3s', query: { ids: { values: [sample.documentId] } } })
    vectorSamples.push({ chunkId: sample.chunkId, ...summarizeSearch(response, row => ({ documentMatches: row.id === sample.documentId, recordId: uuid(row.recordId),
      sourceRevision: integer(row.sourceRevision), recordMatches: row.recordId === sample.id, revisionMatches: row.sourceRevision === sample.currentRevision,
      embeddingSpaceMatches: sample.model != null && row.embeddingSpace === `${sample.model.slice(sample.model.indexOf(':') + 1)}:${sample.dimensions}` })) })
  }
  return { state: [...aliases, ...mappings, ...Object.values(probes), ...canonicalSamples, ...vectorSamples].every(row => row.state === 'observed') ? 'observed' : 'incomplete',
    aliases, mappings, probes, canonicalSamples, vectorSamples }
}

export async function diagnoseTelegramSearch(pool, { environment = process.env, fetchImpl = fetch, root = process.cwd() } = {}) {
  const database = await telegramSearchDatabase(pool)
  let projection
  try { projection = await telegramSearchProjection(elasticReader(environment, fetchImpl), database) }
  catch { projection = { state: 'incomplete', code: 'search_configuration_or_read_failed' } }
  const files = []
  for (const file of FILES) {
    try { files.push({ file, sha256: createHash('sha256').update(await readFile(new URL(file, pathToFileURL(`${root}/`)))).digest('hex') }) }
    catch { files.push({ file, sha256: null }) }
  }
  return { diagnosticRevision: 'telegram-search.v1', checkedAt: new Date().toISOString(),
    status: database.state === 'observed' && projection.state === 'observed' && files.every(row => row.sha256) ? 'observed' : 'incomplete',
    effectiveWindow: { from: FROM, to: TO }, database, projection, runtime: { node: process.version, files },
    evidenceBoundary: 'Current bounded existence probes, not corpus/vector coverage counts or historical ingestion/index state. Failed/partial reads are unknown, not zero. Vector samples prove only sampled current revisions, not all historical Telegram data or active query-model compatibility. Raw phrase is only one public balanced-search branch. No provider/embedding calls, business requests or mutations; runtime hashes describe this Pod filesystem only.' }
}

if (!process.argv[1] || process.argv[1] === '-' || import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    if (process.argv.slice(2).length) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
      query_timeout: 4000, options: '-c default_transaction_read_only=on -c statement_timeout=3000 -c lock_timeout=1000' })
    const report = await diagnoseTelegramSearch(pool)
    console.log(JSON.stringify(report, null, 2)); if (report.status === 'incomplete') process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ error: ['database_url_required', 'invalid_arguments'].includes(error.message) ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await pool?.end().catch(() => { console.error('{"error":"diagnostic_read_failed"}'); process.exitCode = 1 }) }
}
