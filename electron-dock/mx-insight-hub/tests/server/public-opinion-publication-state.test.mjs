import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  AgentPipelineStore,
  publicationStateFromResult,
} from '../../server/agent/pipeline-store.mjs'
import {
  PROVINCE_ANALYSIS_FIELDS,
  buildPublicOpinionQualityAssessment,
  runProvinceAnalysisGraph,
} from '../../server/agent/province-analysis-graph.mjs'
import { buildContentDocument } from '../../server/search/document.mjs'
import {
  publicOpinionLocation,
  publicOpinionSourceStage,
} from '../../server/stores/postgres-store.mjs'

test('migration 035 owns revision-fenced candidate publication state and backfills formal rows', async () => {
  const migration = await readFile(
    new URL('../../migrations/035_public_opinion_publication_state.sql', import.meta.url),
    'utf8',
  )
  assert.match(migration, /CREATE TABLE IF NOT EXISTS core\.public_opinion_current_state/)
  assert.match(migration, /record_id uuid PRIMARY KEY/)
  assert.match(migration, /canonical_revision integer NOT NULL/)
  assert.match(migration, /source_object_revision_id bigint/)
  assert.match(migration, /source_stage IN \('formal', 'candidate'\)/)
  assert.match(migration, /status IN \('formal', 'pending', 'qualified', 'rejected', 'failed'\)/)
  assert.match(migration, /qualification_threshold smallint NOT NULL DEFAULT 80/)
  assert.match(migration, /location_label text/)
  assert.match(migration, /country_name text/)
  assert.match(migration, /raw_payload #>> '\{raw,politicalTerrorEventLocation,label\}'/)
  assert.match(migration, /WHERE record\.dataset_id = 'public-opinion\.province\.v1'/)
  assert.match(migration, /'formal',[\s\S]*?'formal'/)
  assert.doesNotMatch(migration, /ON DELETE CASCADE/)
})

test('Agent task locks exclude the nullable publication side of the outer join', async () => {
  const source = await readFile(
    new URL('../../server/agent/pipeline-store.mjs', import.meta.url),
    'utf8',
  )
  const completeClaim = source.slice(
    source.indexOf('async completeClaim('),
    source.indexOf('async failClaim('),
  )
  const exhaustedFailure = source.slice(source.indexOf('async failClaim('))

  for (const query of [completeClaim, exhaustedFailure]) {
    assert.match(query, /LEFT JOIN core\.public_opinion_current_state publication/)
    assert.match(
      query,
      /FOR UPDATE OF task, source_revision, source_object, record/,
    )
    assert.doesNotMatch(query, /FOR UPDATE OF[^`\n]*publication/)
  }
})

test('ingest recognizes only public-opinion stages and bounds display location fields', () => {
  assert.equal(publicOpinionSourceStage('other.v1', { source_stage: 'candidate' }), null)
  assert.equal(
    publicOpinionSourceStage('public-opinion.province.v1', { source_stage: 'formal' }),
    'formal',
  )
  assert.equal(
    publicOpinionSourceStage('public-opinion.province.v1', { source_stage: 'candidate' }),
    'candidate',
  )
  for (const rawItem of [{}, { source_stage: '' }, { source_stage: 'unknown' }]) {
    assert.throws(
      () => publicOpinionSourceStage('public-opinion.province.v1', rawItem),
      (error) => error.status === 400 && error.code === 'invalid_public_opinion_source_stage',
    )
  }
  assert.deepEqual(publicOpinionLocation({
    raw: {
      politicalTerrorEventLocation: {
        label: '南苏丹', type: 'country', country: '南苏丹', countryCode: 'ss',
        evidence: { provider: 'must-not-be-copied' },
      },
    },
  }), {
    label: '南苏丹', type: 'country', countryName: '南苏丹', countryCode: 'SS',
  })
})

test('external ingest initializes publication state before enqueueing analysis and emits one fenced projection', async () => {
  const source = await readFile(
    new URL('../../server/stores/postgres-store.mjs', import.meta.url),
    'utf8',
  )
  const stateAt = source.indexOf('INSERT INTO core.public_opinion_current_state')
  const taskAt = source.indexOf('INSERT INTO agent_center.analysis_tasks', stateAt)
  const outboxAt = source.indexOf('INSERT INTO outbox.projection_events', taskAt)
  assert.ok(stateAt > 0)
  assert.ok(taskAt > stateAt)
  assert.ok(outboxAt > taskAt)
  assert.match(source, /source_object_revision_id\s+IS DISTINCT FROM EXCLUDED\.source_object_revision_id/)
  assert.match(source, /SET projection_revision = projection_revision \+ 1/)
  assert.match(
    source,
    /\$25::boolean[\s\S]*?event_time IS NULL[\s\S]*?collected_at IS DISTINCT FROM EXCLUDED\.collected_at/,
  )
})

test('publication decision keeps formal rows formal and qualifies candidates at the configured threshold', () => {
  const assertions = [
    { fieldKey: 'geography.event_admin1_code', value: 'CN-JS', status: 'accepted' },
    { fieldKey: 'geography.publisher_admin1_code', value: 'CN-BJ', status: 'proposed' },
    { fieldKey: 'geography.geo_scope', value: 'province', status: 'proposed' },
    { fieldKey: 'quality.score', value: 80, status: 'proposed' },
    { fieldKey: 'quality.flags', value: ['substantive_text'], status: 'proposed' },
    { fieldKey: 'quality.rejection_codes', value: [], status: 'proposed' },
    { fieldKey: 'quality.geography_verified', value: true, status: 'proposed' },
  ]
  const formal = publicationStateFromResult({ assertions, sourceStage: 'formal' })
  assert.equal(formal.status, 'formal')
  assert.equal(formal.displayAdmin1Code, 'CN-JS')
  assert.equal(formal.geographyVerified, true)
  const candidate = publicationStateFromResult({
    assertions: [
      ...assertions,
      { fieldKey: 'geography.location_label', value: '南京' },
      { fieldKey: 'geography.location_type', value: 'city' },
      { fieldKey: 'geography.country_name', value: '中国' },
      { fieldKey: 'geography.country_code', value: 'CN' },
    ],
    sourceStage: 'candidate', qualificationThreshold: 80,
  })
  assert.equal(candidate.status, 'qualified')
  assert.equal(candidate.qualityScore, 80)
  assert.equal(candidate.displayAdmin1Code, 'CN-JS')
  assert.equal(candidate.geographyVerified, true)
  assert.equal(candidate.locationLabel, '南京')
  assert.equal(candidate.locationType, 'city')
  assert.equal(candidate.countryName, '中国')
  assert.equal(candidate.countryCode, 'CN')
  const publisherFallback = publicationStateFromResult({
    assertions: [
      { fieldKey: 'geography.publisher_admin1_code', value: 'CN-BJ', status: 'proposed' },
      { fieldKey: 'geography.geo_scope', value: 'unknown', status: 'proposed' },
      { fieldKey: 'quality.score', value: 90, status: 'proposed' },
    ],
    sourceStage: 'candidate',
  })
  assert.equal(publisherFallback.displayAdmin1Code, 'CN-BJ')
  assert.equal(publisherFallback.geographyVerified, false)
  const overseas = publicationStateFromResult({
    assertions: [
      { fieldKey: 'geography.publisher_admin1_code', value: 'CN-BJ', status: 'proposed' },
      { fieldKey: 'geography.geo_scope', value: 'overseas', status: 'proposed' },
      { fieldKey: 'quality.score', value: 90, status: 'proposed' },
    ],
    sourceStage: 'candidate',
  })
  assert.equal(overseas.publisherAdmin1Code, 'CN-BJ')
  assert.equal(overseas.displayAdmin1Code, null)
  assert.equal(publicationStateFromResult({
    assertions: assertions.map((item) => (
      item.fieldKey === 'quality.score' ? { ...item, value: 79 } : item
    )),
    sourceStage: 'candidate',
  }).status, 'rejected')
  assert.equal(publicationStateFromResult({
    assertions: [], sourceStage: 'candidate',
  }).status, 'failed')
})

test('proposed geography never enters formal province serving', () => {
  const assertions = [
    { fieldKey: 'geography.event_admin1_code', value: 'CN-JS', status: 'proposed' },
    { fieldKey: 'geography.publisher_admin1_code', value: 'CN-BJ', status: 'proposed' },
    { fieldKey: 'geography.geo_scope', value: 'province', status: 'proposed' },
    { fieldKey: 'quality.score', value: 95, status: 'proposed' },
    { fieldKey: 'quality.geography_verified', value: true, status: 'proposed' },
  ]

  const formal = publicationStateFromResult({ assertions, sourceStage: 'formal' })
  assert.equal(formal.eventAdmin1Code, null)
  assert.equal(formal.publisherAdmin1Code, 'CN-BJ')
  assert.equal(formal.displayAdmin1Code, null)
  assert.equal(formal.geographyVerified, false)

  const candidate = publicationStateFromResult({ assertions, sourceStage: 'candidate' })
  assert.equal(candidate.displayAdmin1Code, 'CN-JS')
  assert.equal(candidate.geographyVerified, false)

  const emptyAccepted = publicationStateFromResult({
    assertions: [
      { fieldKey: 'geography.event_admin1_code', value: '', status: 'accepted' },
      { fieldKey: 'geography.geo_scope', value: 'province', status: 'proposed' },
      { fieldKey: 'quality.geography_verified', value: true, status: 'proposed' },
    ],
    sourceStage: 'formal',
  })
  assert.equal(emptyAccepted.displayAdmin1Code, null)
  assert.equal(emptyAccepted.geographyVerified, false)
})

test('accepted source province cannot be hidden or replaced by proposed geography', () => {
  const assertions = [
    { fieldKey: 'geography.event_admin1_code', value: 'CN-JS', status: 'accepted' },
    { fieldKey: 'geography.event_admin1_code', value: 'CN-ZJ', status: 'proposed' },
    { fieldKey: 'geography.publisher_admin1_code', value: 'CN-BJ', status: 'proposed' },
    { fieldKey: 'geography.geo_scope', value: 'overseas', status: 'proposed' },
    { fieldKey: 'geography.location_label', value: '海外', status: 'proposed' },
  ]

  const formal = publicationStateFromResult({ assertions, sourceStage: 'formal' })
  assert.equal(formal.eventAdmin1Code, 'CN-JS')
  assert.equal(formal.geoScope, 'overseas')
  assert.equal(formal.displayAdmin1Code, 'CN-JS')
  assert.equal(formal.geographyVerified, true)

  const candidate = publicationStateFromResult({ assertions, sourceStage: 'candidate' })
  assert.equal(candidate.eventAdmin1Code, 'CN-ZJ')
  assert.equal(candidate.displayAdmin1Code, null)
})

test('quality scoring is deterministic and cannot qualify an unlocated keyword-only fragment', () => {
  const qualified = buildPublicOpinionQualityAssessment({
    raw: { title: '江苏通报恐怖袭击处置进展', url: 'https://news.example/item' },
    eventText: '江苏通报恐怖袭击处置进展，公安机关已完成现场处置并发布后续调查信息，相关部门正在持续核实伤亡情况与事件原因。',
    sourceClass: 'news/web',
    eventAdmin1Code: 'CN-JS',
    geoScope: 'province',
    geoScopeConfidence: 0.9,
  })
  assert.equal(qualified.qualityScore, 100)
  assert.equal(qualified.geographyVerified, true)
  const fragment = buildPublicOpinionQualityAssessment({
    raw: { title: '袭击' }, eventText: '袭击', sourceClass: 'unknown',
    eventAdmin1Code: null, geoScope: 'unknown', geoScopeConfidence: 1,
  })
  assert.ok(fragment.qualityScore < 80)
  assert.ok(fragment.rejectionCodes.includes('geography_unverified'))
  assert.ok(fragment.rejectionCodes.includes('content_too_short'))
})

test('a source-backed foreign event location is verified without inventing a China province', async () => {
  let agentCalls = 0
  const result = await runProvinceAnalysisGraph({
    claim: {
      promptVersion: 'province-analysis.v1',
      input: {
        title: '南苏丹发生武装袭击，多名居民受伤',
        body: '南苏丹当地部门通报武装袭击处置进展，安全人员已抵达现场并继续调查事件原因。',
        platform: 'news', content_type: 'news',
        raw_payload: {
          title: '南苏丹发生武装袭击，多名居民受伤',
          summary: '南苏丹当地部门通报武装袭击处置进展，安全人员已抵达现场并继续调查事件原因。',
          source_name: '中新网即时新闻', source_type: 'news', platform: 'news',
          link: 'https://news.example/ss',
          eventLocation: {
            label: '南苏丹', type: 'country', country: '南苏丹', countryCode: 'SS',
          },
        },
      },
    },
    agent: { available: true, async complete() { agentCalls += 1 } },
  })
  const value = (field) => result.assertions
    .filter((item) => item.fieldKey === field)
    .at(-1)?.value
  assert.equal(agentCalls, 0)
  assert.equal(value(PROVINCE_ANALYSIS_FIELDS.eventAdmin1), undefined)
  assert.equal(value(PROVINCE_ANALYSIS_FIELDS.geoScope), 'overseas')
  assert.equal(value(PROVINCE_ANALYSIS_FIELDS.locationLabel), '南苏丹')
  assert.equal(value(PROVINCE_ANALYSIS_FIELDS.countryCode), 'SS')
  assert.equal(value(PROVINCE_ANALYSIS_FIELDS.geographyVerified), true)
  assert.ok(value(PROVINCE_ANALYSIS_FIELDS.qualityScore) >= 80)
})

test('the bounded Agent can archive an unknown foreign country with exact evidence', async () => {
  let agentCalls = 0
  const result = await runProvinceAnalysisGraph({
    claim: {
      promptVersion: 'province-analysis.v1',
      input: {
        title: '哈萨克斯坦发生爆炸，多人受伤',
        body: '哈萨克斯坦发生爆炸，多人受伤，当地部门正在调查事件原因。',
        platform: 'news', content_type: 'news',
        raw_payload: {
          title: '哈萨克斯坦发生爆炸，多人受伤',
          summary: '哈萨克斯坦发生爆炸，多人受伤，当地部门正在调查事件原因。',
          source_name: '国际新闻', source_type: 'news', platform: 'news',
          link: 'https://news.example/kz',
        },
      },
    },
    agent: {
      available: true,
      async complete() {
        agentCalls += 1
        return {
          provider: 'test-provider',
          model: 'test-model',
          payload: { choices: [{ message: { content: JSON.stringify({
            eventAdmin1Code: null,
            eventConfidence: 0,
            eventEvidenceText: '',
            publisherAdmin1Code: null,
            publisherConfidence: 0,
            publisherEvidenceText: '',
            geoScope: 'overseas',
            scopeConfidence: 0.98,
            scopeEvidenceText: '哈萨克斯坦',
            locationLabel: '哈萨克斯坦',
            locationType: 'country',
            countryName: '哈萨克斯坦',
            countryCode: 'KZ',
            locationConfidence: 0.98,
            locationEvidenceText: '哈萨克斯坦',
          }) } }] },
        }
      },
    },
  })
  const value = (field) => result.assertions
    .filter((item) => item.fieldKey === field)
    .at(-1)?.value
  assert.equal(agentCalls, 1)
  assert.equal(value(PROVINCE_ANALYSIS_FIELDS.geoScope), 'overseas')
  assert.equal(value(PROVINCE_ANALYSIS_FIELDS.locationLabel), '哈萨克斯坦')
  assert.equal(value(PROVINCE_ANALYSIS_FIELDS.locationType), 'country')
  assert.equal(value(PROVINCE_ANALYSIS_FIELDS.countryName), '哈萨克斯坦')
  assert.equal(value(PROVINCE_ANALYSIS_FIELDS.countryCode), 'KZ')
  assert.equal(value(PROVINCE_ANALYSIS_FIELDS.geographyVerified), true)
})

test('the rebuild and live projector index bounded publication markers without provider evidence', async () => {
  const [projector, searchIndex] = await Promise.all([
    readFile(new URL('../../server/search/projector.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../server/search/index.mjs', import.meta.url), 'utf8'),
  ])
  assert.match(projector, /LEFT JOIN core\.public_opinion_current_state publication/)
  assert.match(projector, /publication\.canonical_revision = record\.current_revision/)
  assert.match(searchIndex, /LEFT JOIN core\.public_opinion_current_state publication/)
  assert.match(searchIndex, /publication\.updated_at >= \$3/)
  const document = await buildContentDocument({
    id: 'record-1', dataset_id: 'public-opinion.province.v1',
    schema_version: 'external.v1', current_revision: 2, projection_revision: 3,
    platform: 'public_opinion', object_type: 'opinion_item', external_id: 'item-1',
    title: '标题', body: '正文', stable_fields: {},
    event_time: null, collected_at: new Date('2026-08-24T03:00:00.000Z'),
    extensions: {
      providerId: 'hidden', source_stage: 'candidate', sourceDisposition: 'candidate',
    },
    publication_source_stage: 'candidate', publication_status: 'qualified',
    publication_quality_score: 88, publication_quality_threshold: 80,
    publication_event_admin1_code: 'CN-JS', publication_display_admin1_code: 'CN-JS',
    publication_geography_verified: true, publication_geo_scope: 'province',
    publication_location_label: '江苏', publication_location_type: 'province',
  }, { segmenter: { async segment() { return [] } } })
  assert.deepEqual(document.publication, {
    stage: 'candidate',
    status: 'qualified',
    qualityScore: 88,
    displayAdmin1: 'CN-JS',
    geographyVerified: true,
    effectiveTime: new Date('2026-08-24T03:00:00.000Z'),
    locationLabel: '江苏',
    locationType: 'province',
  })
  assert.deepEqual(document.extensions, {})
})

test('claim completion materializes only the claimed revisions and queues a new projection', async () => {
  const calls = []
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('SELECT task.*, source_revision.revision')) {
        return {
          rows: [{
            status: 'running', locked_by: 'worker-1', claim_generation: '3',
            canonical_revision: '2', current_canonical_revision: '2',
            source_revision_number: '4', current_source_revision: '4',
            source_stage: 'candidate', qualification_threshold: '80',
            dataset_id: 'public-opinion.candidates.v1', platform: 'public_opinion',
            object_type: 'opinion_candidate',
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('INSERT INTO agent_center.classification_assertions')) {
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("SET status = 'succeeded'")) return { rows: [], rowCount: 1 }
      if (sql.includes('UPDATE core.public_opinion_current_state')) {
        return { rows: [{ record_id: 'record-1' }], rowCount: 1 }
      }
      if (sql.includes('UPDATE core.canonical_records')) {
        return { rows: [{ projection_revision: '7' }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO outbox.projection_events')) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new AgentPipelineStore({ async connect() { return client } })
  const claim = {
    taskId: 9, pipelineKey: 'province-geography-v1', recordId: 'record-1',
    sourceObjectRevisionId: 14, canonicalRevision: 2, inputSha256: 'a'.repeat(64),
    analysisVersion: 'province-geography.v1', taxonomyVersion: 'cn-geography.v1',
    ruleVersion: 'rules.v1', promptVersion: 'prompt.v1', generation: 3,
    workerId: 'worker-1',
  }
  const result = {
    assertions: [
      { fieldKey: 'geography.event_admin1_code', value: 'CN-JS', method: 'rule', confidence: 0.9 },
      { fieldKey: 'geography.geo_scope', value: 'province', method: 'rule', confidence: 0.9 },
      { fieldKey: 'quality.score', value: 88, method: 'rule', confidence: 1 },
      { fieldKey: 'quality.flags', value: ['substantive_text'], method: 'rule', confidence: 1 },
      { fieldKey: 'quality.rejection_codes', value: [], method: 'rule', confidence: 1 },
      { fieldKey: 'quality.geography_verified', value: true, method: 'rule', confidence: 1 },
    ],
    summary: {},
  }
  assert.deepEqual(await store.completeClaim(claim, result), { completed: true })
  const state = calls.find(({ sql }) => sql.includes('UPDATE core.public_opinion_current_state'))
  assert.deepEqual(state.parameters.slice(0, 6), ['record-1', 2, 14, 'qualified', 88, 80])
  assert.match(state.sql, /canonical_revision = \$2/)
  assert.match(state.sql, /source_object_revision_id = \$3/)
  const outbox = calls.find(({ sql }) => sql.includes('INSERT INTO outbox.projection_events'))
  assert.equal(outbox.parameters[1], '7')
  assert.equal(outbox.parameters[2].publicationStateChanged, true)
  assert.equal(calls.at(-1).sql, 'COMMIT')
})
