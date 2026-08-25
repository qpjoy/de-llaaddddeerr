import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PostgresStore,
  publicOpinionQualitySummaryRow,
} from '../../server/stores/postgres-store.mjs'

test('quality summary maps current volume, geography, analysis and retained revisions', async () => {
  let query = ''
  const store = new PostgresStore({
    async query(sql) {
      query = sql
      return {
        rows: [{
          canonical_total: '5189',
          active_count: '5180',
          deleted_count: '9',
          publication_state_count: '5179',
          missing_publication_state_count: '1',
          stage_counts: { formal: 5000, candidate: 179 },
          status_counts: { formal: 5000, pending: 150, qualified: 20, rejected: 8, failed: 1 },
          assessed_count: '29',
          unassessed_count: '5151',
          candidate_count: '179',
          candidate_scored_count: '29',
          candidate_unscored_count: '150',
          candidate_qualified_count: '20',
          average_candidate_quality_score: '83.42',
          candidate_score_buckets: { unscored: 150, '0-59': 2, '60-79': 7, '80-100': 20 },
          candidate_quality_flags: { title_present: 29, event_geography_verified: 20 },
          candidate_rejection_codes: { geography_unverified: 9 },
          with_province_count: '4800',
          without_province_count: '380',
          verified_count: '4700',
          with_location_count: '55',
          scope_counts: { province: 4800, overseas: 25, unknown: 355 },
          country_counts: { CN: 4800, US: 10, unclassified: 370 },
          province_counts: { 'CN-JS': 210, 'CN-BJ': 190 },
          missing_title_count: '2',
          missing_url_count: '11',
          missing_event_time_count: '33',
          task_counts: { pending: 5151, succeeded: 29, superseded: 9 },
          task_error_counts: { agent_not_configured: 3 },
          assertion_counts: { proposed: 100, accepted: 20 },
          source_object_count: '5189',
          source_revision_count: '5207',
          canonical_revision_count: '5230',
          oldest_record_at: new Date('2026-08-01T00:00:00Z'),
          latest_record_at: new Date('2026-08-25T14:21:00Z'),
          latest_publication_at: new Date('2026-08-25T14:22:00Z'),
        }],
      }
    },
  })

  const summary = await store.getPublicOpinionQualitySummary()

  assert.equal(summary.contractVersion, 'mx-insight-hub.public-opinion.quality-summary.v1')
  assert.deepEqual(summary.canonical, {
    total: 5189,
    active: 5180,
    deleted: 9,
    withPublicationState: 5179,
    missingPublicationState: 1,
  })
  assert.equal(summary.publication.candidates.qualifiedAtThreshold, 20)
  assert.equal(summary.publication.candidates.averageQualityScore, 83.42)
  assert.equal(summary.publication.candidates.scoreBuckets['80-100'], 20)
  assert.equal(summary.publication.candidates.qualityFlags.title_present, 29)
  assert.equal(summary.publication.candidates.rejectionCodes.geography_unverified, 9)
  assert.equal(summary.geography.withoutProvince, 380)
  assert.equal(summary.geography.scopes.maritime, 0)
  assert.equal(summary.geography.countries.US, 10)
  assert.equal(summary.analysis.tasks.pending, 5151)
  assert.equal(summary.analysis.tasks.dead, 0)
  assert.equal(summary.analysis.errors.agent_not_configured, 3)
  assert.deepEqual(summary.archive, {
    sourceObjects: 5189,
    sourceRevisionRows: 5207,
    priorSourceRevisions: 18,
    canonicalRevisionRows: 5230,
    priorCanonicalRevisions: 41,
  })
  assert.equal(summary.time.latestPublicationAt, '2026-08-25T14:22:00.000Z')

  assert.match(query, /publication\.canonical_revision = record\.current_revision/)
  assert.match(query, /record\.dataset_id = 'public-opinion\.province\.v1'/)
  assert.match(query, /source_object\.connector_id = 'external:province-opinion-results'/)
  assert.match(query, /pipeline_key = 'province-geography-v1'/)
})

test('quality summary exposes a stable zero shape when the dataset is empty', () => {
  assert.deepEqual(publicOpinionQualitySummaryRow({}).publication.stages, {
    formal: 0,
    candidate: 0,
  })
  assert.deepEqual(publicOpinionQualitySummaryRow({}).analysis.tasks, {
    pending: 0,
    running: 0,
    succeeded: 0,
    dead: 0,
    superseded: 0,
  })
  assert.equal(publicOpinionQualitySummaryRow({}).time.oldestRecordAt, null)
})
