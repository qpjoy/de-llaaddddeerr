import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_FILE_FORMAT_RULES,
  TWITTER_CANYIE_COLUMNS,
  TWITTER_CANYIE_FIELD_MAP,
  TWITTER_CANYIE_RULE_KEY,
  buildDeterministicSamplingSummary,
  detectExternalFile,
  recognizeBuiltinFormatRule,
} from '../../server/ingest/external/builtin-format-rules.mjs'
import { ExternalImporter } from '../../server/ingest/external/importer.mjs'
import { applyMapping } from '../../server/ingest/external/mapping.mjs'
import { parseFile } from '../../server/ingest/external/parsers.mjs'

const EXPECTED_FIELD_MAP = {
  externalId: { from: 'content_id' },
  body: { from: ['full_text', 'content', 'text'] },
  url: { from: ['original_url', 'url'] },
  authorExternalId: { from: 'author_id' },
  language: { from: 'lang' },
  eventTime: { from: 'created_at', type: 'timestamp' },
  editedAt: { from: ['updated_time', 'created_at'], type: 'timestamp' },
  collectedAt: { from: 'crawled_at', type: 'timestamp' },
  'metrics.likes': { from: 'like_count', type: 'number' },
  'metrics.comments': { from: 'reply_count', type: 'number' },
  'metrics.shares': { from: 'forward_count', type: 'number' },
  'metrics.views': { from: 'view_count', type: 'number' },
  'metrics.bookmarks': { from: 'bookmark_count', type: 'number' },
}

function canyieRecord(index, overrides = {}) {
  const suffix = String(index).padStart(2, '0')
  const body = `private-body-${suffix}`
  return {
    text: body,
    content_id: `19623553706236520${suffix}`,
    reply_count: String(index),
    created_at: index % 2 === 0 ? String(1_756_696_953 + index) : String((1_756_696_953 + index) * 1_000),
    author_id: `11920679277777428${suffix}`,
    platform_name: 'twitter',
    source: 'canyie-private-source',
    original_url: `https://twitter.com/private/status/${suffix}`,
    image_urls: '[]',
    updated_time: String(1_756_696_953 + index),
    like_count: String(index),
    forward_count: String(index + 1),
    lang: 'ja',
    is_forward: 'false',
    created_time: String(1_756_696_953 + index),
    quote_count: '0',
    video_urls: '[]',
    content: body,
    crawled_at: String(1_763_694_864 + index),
    full_text: body,
    url: `https://x.com/private/status/${suffix}`,
    bookmark_count: String(index + 2),
    metadata: JSON.stringify({ secret: `metadata-secret-${suffix}` }),
    view_count: String(index + 100),
    ...overrides,
  }
}

function sparseArchiveRecord(index, overrides = {}) {
  const sources = ['github', 'orcid', 'publication']
  return {
    text: `sparse-archive-${index}`,
    source: sources[index % sources.length],
    original_url: index % 2 === 0
      ? `https://github.com/example/archive-${index}`
      : `https://orcid.org/0000-0000-0000-00${index}`,
    content: `sparse-archive-${index}`,
    full_text: `sparse-archive-${index}`,
    url: `https://example.invalid/publication/${index}`,
    metadata: JSON.stringify({ archiveKind: sources[index % sources.length] }),
    ...overrides,
  }
}

function encodeCsvCell(value) {
  const text = String(value ?? '')
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function canyieCsv(records) {
  return [
    TWITTER_CANYIE_COLUMNS.join(','),
    ...records.map((record) => TWITTER_CANYIE_COLUMNS.map((column) => encodeCsvCell(record[column])).join(',')),
  ].join('\n')
}

test('the canyie CSV rule uses an exact mapping and a value-free first/middle/last summary', () => {
  const records = Array.from({ length: 5 }, (_, index) => canyieRecord(index))
  const parsed = parseFile(Buffer.from(canyieCsv(records)), 'canyie.csv')
  const rule = recognizeBuiltinFormatRule({ ...parsed, filename: 'canyie.csv' })

  assert.equal(rule.ruleKey, TWITTER_CANYIE_RULE_KEY)
  assert.equal(rule.ruleKey, 'rule-twitter-canyie')
  assert.equal(rule.inputFormat, 'csv')
  assert.equal('formatRuleKey' in rule, false, 'the public selection key must not acquire a format suffix')
  assert.deepEqual(rule.scope, { platform: 'twitter', objectType: 'post' })
  assert.deepEqual(rule.fieldMap, EXPECTED_FIELD_MAP)
  assert.deepEqual(TWITTER_CANYIE_FIELD_MAP, EXPECTED_FIELD_MAP)
  assert.deepEqual(rule.sampleSummary.sampledRowIndexes, [0, 1, 2, 3, 4])
  assert.equal(rule.sampleSummary.sampledRowCount, 5)
  assert.equal(rule.sampleSummary.signals.twitterPlatformCount, 5)
  assert.equal(rule.sampleSummary.signals.decimalStringContentIdCount, 5)
  assert.equal(rule.sampleSummary.signals.unixSecondsCreatedAtCount, 3)
  assert.equal(rule.sampleSummary.signals.unixMillisecondsCreatedAtCount, 2)

  const serializedSummary = JSON.stringify(rule.sampleSummary)
  for (const sensitive of [
    'private-body-',
    '19623553706236520',
    '11920679277777428',
    'https://twitter.com/private',
    'metadata-secret-',
    'canyie-private-source',
  ]) {
    assert.equal(serializedSummary.includes(sensitive), false, `${sensitive} leaked into the summary`)
  }
})

test('canyie recognition checks every deterministic sample position', () => {
  const records = Array.from({ length: 5 }, (_, index) => canyieRecord(index))
  records[4].platform_name = 'not-twitter'
  const parsed = parseFile(Buffer.from(canyieCsv(records)), 'canyie.csv')

  assert.equal(recognizeBuiltinFormatRule({ ...parsed, filename: 'canyie.csv' }), null)
})

test('canyie recognition accepts a complete Twitter majority and rejects sparse archive rows on import', async () => {
  const records = [
    ...Array.from({ length: 6 }, (_, index) => canyieRecord(index)),
    ...Array.from({ length: 3 }, (_, index) => sparseArchiveRecord(index + 6)),
  ]
  const input = Buffer.from(canyieCsv(records))
  const parsed = parseFile(input, 'canyie.csv')
  const sampling = buildDeterministicSamplingSummary(parsed)
  const rule = recognizeBuiltinFormatRule({ ...parsed, filename: 'canyie.csv', sampling })

  assert.equal(sampling.sampledRowCount, 9)
  assert.equal(sampling.signals.contentIdValueRowCount, 6)
  assert.equal(sampling.signals.completeEligibleRowCount, 6)
  assert.equal(rule.ruleKey, TWITTER_CANYIE_RULE_KEY)

  const ingestedRecords = []
  let rejectedRows = []
  const importer = new ExternalImporter({
    store: {
      getExternalSource: async () => ({
        id: 'source-canyie', sourceKey: 'canyie', status: 'active',
        datasetId: 'external.twitter.canyie.v1', platform: 'twitter', objectType: 'post',
      }),
      getActiveMapping: async () => ({
        version: 1,
        fieldMap: TWITTER_CANYIE_FIELD_MAP,
        formatRuleVersionId: 'rule-version-csv',
      }),
      startImportRun: async () => ({ id: 'run-canyie' }),
      ingestExternalRecords: async ({ records: batch }) => {
        ingestedRecords.push(...batch)
        return { ingested: batch.length, changed: batch.length }
      },
      recordRejectedRows: async (_runId, rows) => { rejectedRows = rows },
      finishImportRun: async () => {},
    },
  })
  const result = await importer.importFile({ sourceKey: 'canyie', buffer: input, filename: 'canyie.csv' })

  assert.equal(result.rowCount, 9)
  assert.equal(result.ingested, 6)
  assert.equal(result.rejected, 3)
  assert.equal(ingestedRecords.length, 6)
  assert.equal(rejectedRows.length, 3)
  assert.equal(rejectedRows.every((row) => row.reason === 'externalId is empty or missing in this row'), true)
})

test('canyie majority recognition still rejects conflicting platforms and unsafe numeric ids', () => {
  const conflictingRecords = [
    ...Array.from({ length: 6 }, (_, index) => canyieRecord(index)),
    canyieRecord(6, { platform_name: 'github' }),
    sparseArchiveRecord(7),
    sparseArchiveRecord(8),
  ]
  const conflicting = parseFile(Buffer.from(canyieCsv(conflictingRecords)), 'canyie.csv')
  assert.equal(recognizeBuiltinFormatRule({ ...conflicting, filename: 'canyie.csv' }), null)

  const unsafeRecords = [
    ...Array.from({ length: 6 }, (_, index) => canyieRecord(index)),
    canyieRecord(6, { content_id: 1_962_355_370_623_652_093 }),
    sparseArchiveRecord(7),
    sparseArchiveRecord(8),
  ]
  const unsafeInput = unsafeRecords.map((record) => JSON.stringify(record)).join('\n')
  const unsafe = parseFile(Buffer.from(unsafeInput), 'canyie.jsonl')
  assert.equal(recognizeBuiltinFormatRule({ ...unsafe, filename: 'canyie.jsonl' }), null)
})

test('JSONL and NDJSON preserve the logical canyie rule and input format', () => {
  const records = Array.from({ length: 3 }, (_, index) => ({
    ...canyieRecord(index),
    metadata: { secret: `native-json-secret-${index}` },
  }))
  const input = records.map((record) => JSON.stringify(record)).join('\n')
  for (const filename of ['canyie.jsonl', 'canyie.ndjson']) {
    const parsed = parseFile(Buffer.from(input), filename)
    const rule = recognizeBuiltinFormatRule({ ...parsed, filename })

    assert.equal(rule.ruleKey, 'rule-twitter-canyie')
    assert.equal(rule.inputFormat, 'jsonl')
    assert.equal(rule.sampleSummary.columns.find((column) => column.name === 'metadata').valueTypeFamilies[0], 'object')
    assert.equal(JSON.stringify(rule.sampleSummary).includes('native-json-secret-'), false)
  }
})

test('JSONL numeric content ids are not auto-recognized after precision may have been lost', () => {
  const records = Array.from({ length: 3 }, (_, index) => ({
    ...canyieRecord(index),
    content_id: 1_962_355_370_623_652_093,
  }))
  const input = records.map((record) => JSON.stringify(record)).join('\n')
  const parsed = parseFile(Buffer.from(input), 'canyie.jsonl')

  assert.equal(recognizeBuiltinFormatRule({ ...parsed, filename: 'canyie.jsonl' }), null)
})

test('ordinary JSON arrays and envelopes share the logical canyie rule', () => {
  assert.deepEqual(BUILTIN_FILE_FORMAT_RULES[0].inputFormats, ['csv', 'json', 'jsonl'])
  const records = Array.from({ length: 3 }, (_, index) => canyieRecord(index))
  for (const input of [JSON.stringify(records), JSON.stringify({ data: records })]) {
    const parsed = parseFile(Buffer.from(input), 'canyie.json')
    const rule = recognizeBuiltinFormatRule({ ...parsed, filename: 'canyie.json' })
    assert.equal(rule.ruleKey, TWITTER_CANYIE_RULE_KEY)
    assert.equal(rule.inputFormat, 'json')
  }
})

test('ordinary JSON numeric content ids are not auto-recognized after precision may have been lost', () => {
  const records = Array.from({ length: 3 }, (_, index) => ({
    ...canyieRecord(index),
    content_id: 1_962_355_370_623_652_093,
  }))
  const parsed = parseFile(Buffer.from(JSON.stringify(records)), 'canyie.json')

  assert.equal(recognizeBuiltinFormatRule({ ...parsed, filename: 'canyie.json' }), null)
})

test('local detection can infer twitter from unanimous URL hosts without exposing URLs', () => {
  const columns = ['id', 'url', 'body']
  const records = [
    { id: 'private-1', url: 'https://x.com/hidden/status/1', body: 'secret-one' },
    { id: 'private-2', url: 'https://twitter.com/hidden/status/2', body: 'secret-two' },
    { id: 'private-3', url: 'https://mobile.twitter.com/hidden/status/3', body: 'secret-three' },
  ]
  const sampling = buildDeterministicSamplingSummary({ columns, records })
  const detection = detectExternalFile({ columns, records, filename: 'posts.csv', sampling })

  assert.deepEqual(detection, {
    platform: 'twitter',
    objectType: 'post',
    ruleKey: null,
    inputFormat: 'csv',
    basis: ['twitter-url-host'],
  })
  const serialized = JSON.stringify({ sampling, detection })
  assert.equal(serialized.includes('hidden/status'), false)
  assert.equal(serialized.includes('secret-'), false)
  assert.equal(serialized.includes('private-'), false)
})

test('preview applies the builtin mapping while keeping the Agent-facing summary value-free', async () => {
  const records = Array.from({ length: 5 }, (_, index) => canyieRecord(index))
  const importer = new ExternalImporter({ store: {} })
  const preview = await importer.preview(Buffer.from(canyieCsv(records)), 'canyie.csv')

  assert.equal(preview.builtinFormatRule.ruleKey, 'rule-twitter-canyie')
  assert.equal(preview.detection.ruleKey, 'rule-twitter-canyie')
  assert.equal(preview.detection.platform, 'twitter')
  assert.equal(preview.detection.objectType, 'post')
  assert.deepEqual(preview.sampling.sampledPositions, [
    { position: 'head', index: 0 },
    { position: 'head', index: 1 },
    { position: 'middle', index: 2 },
    { position: 'middle', index: 3 },
    { position: 'tail', index: 4 },
  ])
  assert.deepEqual(preview.inferredFieldMap, EXPECTED_FIELD_MAP)
  assert.equal(preview.sample[0].mapped.externalId, records[0].content_id)
  assert.equal(preview.sample[0].mapped.platform, 'twitter')
  assert.equal(preview.sample[0].mapped.objectType, 'post')
  assert.equal(preview.sample[0].mapped.eventTime.toISOString(), '2025-09-01T03:22:33.000Z')
  assert.equal(preview.sample[1].mapped.eventTime.toISOString(), '2025-09-01T03:22:34.000Z')
  assert.equal(preview.sample[0].mapped.collectedAt.toISOString(), '2025-11-21T03:14:24.000Z')
  assert.equal(preview.sample[0].mapped.metrics.comments, 0)
  assert.equal(preview.sample[0].mapped.metrics.shares, 1)
  assert.equal(preview.sample[0].mapped.metrics.bookmarks, 2)
  assert.equal(preview.unmappedColumns.includes('metadata'), true)
  for (const mappedSource of ['text', 'content', 'full_text', 'url', 'original_url']) {
    assert.equal(preview.unmappedColumns.includes(mappedSource), false)
  }

  assert.equal(preview.sampling.items[0].raw.content_id, records[0].content_id,
    'Admin preview keeps true sample rows for review')
  const serializedAgentSummary = JSON.stringify({
    sampling: { ...preview.sampling, items: undefined },
    detection: preview.detection,
    builtin: preview.builtinFormatRule.sampleSummary,
  })
  assert.equal(serializedAgentSummary.includes(records[0].content_id), false)
  assert.equal(serializedAgentSummary.includes(records[0].full_text), false)
  assert.equal(serializedAgentSummary.includes(records[0].url), false)
})

test('mapping accepts both ten-digit Unix seconds and thirteen-digit Unix milliseconds', () => {
  const fieldMap = {
    externalId: { from: 'id' },
    eventTime: { from: 'created_at', type: 'timestamp' },
    editedAt: { from: 'updated_at', type: 'timestamp' },
  }
  const { record } = applyMapping({
    id: 'post-1',
    created_at: '1756696953',
    updated_at: '1756696953000',
  }, fieldMap, { platform: 'twitter', objectType: 'post' })

  assert.equal(record.eventTime.toISOString(), '2025-09-01T03:22:33.000Z')
  assert.equal(record.editedAt.toISOString(), '2025-09-01T03:22:33.000Z')
})
