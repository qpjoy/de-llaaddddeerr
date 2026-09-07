import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'

import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''

test('PostgreSQL snapshots key scopes and atomically enforces the assigned plan', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString, statement_timeout: 5_000 })
  const store = new PostgresStore(pool)
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: 'integration-test-pepper-at-least-32-bytes',
  })
  try {
    const tenant = await service.createTenant({ name: `plan-${randomUUID()}` })
    const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Plan consumer' })
    const initialPlan = await service.getConsumerPlan(consumer.id)
    assert.equal(initialPlan.key, 'launch-1m')
    assert.equal(initialPlan.revision, 1)
    assert.deepEqual(initialPlan.limits, {
      monthlyRequests: 1_000_000,
      maxPageSize: 100,
      burstRps: 100,
    })
    const legacyPlan = (await service.listPlans())
      .find((plan) => plan.key === 'legacy-unmetered')
    assert.ok(legacyPlan)
    const auditBeforeLegacyAttempt = await pool.query(
      'SELECT count(*)::integer AS count FROM consumer_plan_assignment_events WHERE consumer_id = $1',
      [consumer.id],
    )
    await assert.rejects(
      () => service.assignConsumerPlan(consumer.id, {
        planVersionId: legacyPlan.versionId,
        expectedRevision: initialPlan.revision,
      }, 'integration-test'),
      (error) => error?.status === 409 && error?.code === 'plan_version_grandfather_only',
    )
    const afterLegacyAttempt = await service.getConsumerPlan(consumer.id)
    assert.equal(afterLegacyAttempt.versionId, initialPlan.versionId)
    assert.equal(afterLegacyAttempt.revision, initialPlan.revision)
    const auditAfterLegacyAttempt = await pool.query(
      'SELECT count(*)::integer AS count FROM consumer_plan_assignment_events WHERE consumer_id = $1',
      [consumer.id],
    )
    assert.equal(
      Number(auditAfterLegacyAttempt.rows[0].count),
      Number(auditBeforeLegacyAttempt.rows[0].count),
    )

    await service.putPlatformConfiguration('xiaohongshu', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 1_000,
      windowSeconds: 3_600,
      maxPageSize: 100,
    })
    await service.putCapabilityConfiguration('social.posts.resolve', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 1_000,
      windowSeconds: 3_600,
    })
    const issued = await service.createApiKey({
      consumerId: consumer.id,
      name: 'XHS customer key',
      platforms: ['xiaohongshu'],
      capabilities: ['social.posts.resolve'],
    })
    assert.equal(issued.scopeMode, 'snapshot')

    await service.putPlatformConfiguration('xiaohongshu', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: false,
    })
    assert.deepEqual(
      (await store.listApiKeyPlatformEntitlements(issued.id)).map((entry) => entry.platform),
      ['xiaohongshu'],
      'the issuance snapshot remains auditable after a current grant is revoked',
    )
    assert.deepEqual(await store.listEffectiveGrants(consumer.id, issued.id), [])
    await service.putPlatformConfiguration('xiaohongshu', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 1_000,
      windowSeconds: 3_600,
      maxPageSize: 100,
    })

    const planId = randomUUID()
    const planVersionId = randomUUID()
    await pool.query(
      `INSERT INTO plans (id, plan_key, name, status) VALUES ($1, $2, 'Burst test', 'active')`,
      [planId, `burst-${randomUUID()}`],
    )
    await pool.query(
      `INSERT INTO plan_versions
         (id, plan_id, version, status, limits, pricing, published_at)
       VALUES ($1, $2, 1, 'published', $3::jsonb, '{}'::jsonb, now())`,
      [planVersionId, planId, JSON.stringify({
        monthlyRequests: 5,
        maxRequests: 1_000,
        windowSeconds: 3_600,
        maxPageSize: 100,
        burstRps: 2,
      })],
    )
    const assigned = await service.assignConsumerPlan(consumer.id, {
      planVersionId,
      expectedRevision: initialPlan.revision,
    }, 'integration-test')
    assert.equal(assigned.revision, 2)
    assert.equal(assigned.assignedBy, 'integration-test')
    const auditAfterAssignment = await pool.query(
      `SELECT previous_plan_version_id, plan_version_id, assigned_by,
              previous_revision, revision
         FROM consumer_plan_assignment_events
        WHERE consumer_id = $1
        ORDER BY id`,
      [consumer.id],
    )
    assert.equal(auditAfterAssignment.rows.at(-1).previous_plan_version_id, initialPlan.versionId)
    assert.equal(auditAfterAssignment.rows.at(-1).plan_version_id, planVersionId)
    assert.equal(auditAfterAssignment.rows.at(-1).assigned_by, 'integration-test')
    assert.equal(Number(auditAfterAssignment.rows.at(-1).previous_revision), 1)
    assert.equal(Number(auditAfterAssignment.rows.at(-1).revision), 2)
    await assert.rejects(
      () => pool.query(
        `UPDATE consumer_plan_assignment_events
            SET assigned_by = 'tampered'
          WHERE consumer_id = $1`,
        [consumer.id],
      ),
      (error) => error?.code === '55000',
    )

    const noOp = await service.assignConsumerPlan(consumer.id, {
      planVersionId,
      expectedRevision: assigned.revision,
    }, 'integration-test-no-op')
    assert.equal(noOp.revision, assigned.revision)
    assert.equal(noOp.assignedAt, assigned.assignedAt)
    assert.equal(noOp.assignedBy, assigned.assignedBy)
    const auditAfterNoOp = await pool.query(
      'SELECT count(*)::integer AS count FROM consumer_plan_assignment_events WHERE consumer_id = $1',
      [consumer.id],
    )
    assert.equal(Number(auditAfterNoOp.rows[0].count), auditAfterAssignment.rowCount)

    await assert.rejects(
      () => service.assignConsumerPlan(consumer.id, {
        planVersionId: initialPlan.versionId,
        expectedRevision: initialPlan.revision,
      }, 'integration-test-stale'),
      (error) => error?.status === 409
        && error?.code === 'plan_assignment_revision_conflict'
        && error?.details?.currentRevision === 2,
    )

    await assert.rejects(
      () => pool.query('UPDATE plan_versions SET pricing = $2::jsonb WHERE id = $1', [
        planVersionId,
        JSON.stringify({ changed: true }),
      ]),
      (error) => error?.code === '55000',
    )
    await assert.rejects(
      () => pool.query(
        `UPDATE consumer_plan_assignments
            SET assigned_at = now() + interval '1 minute', revision = revision + 1
          WHERE consumer_id = $1`,
        [consumer.id],
      ),
      (error) => error?.code === '23514',
    )

    const context = await service.authenticate(issued.secret)
    const reserve = (index) => store.reserve({
      requestId: randomUUID(),
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      idempotencyKey: randomUUID(),
      fingerprint: String(index).padStart(64, '0'),
      platform: 'xiaohongshu',
      unitsReserved: 1,
      windowStart: new Date(Date.now() - 3_600_000),
      maxRequests: 1_000,
      leaseExpiresAt: new Date(Date.now() + 120_000),
    })
    assert.equal((await reserve(1)).kind, 'reserved')
    assert.equal((await reserve(2)).kind, 'reserved')
    await assert.rejects(
      () => reserve(3),
      (error) => error?.status === 429 && error?.details?.limitScope === 'plan_burst',
    )

    const competingPlanId = randomUUID()
    const competingPlanVersionId = randomUUID()
    await pool.query(
      `INSERT INTO plans (id, plan_key, name, status) VALUES ($1, $2, 'Concurrent test', 'active')`,
      [competingPlanId, `concurrent-${randomUUID()}`],
    )
    await pool.query(
      `INSERT INTO plan_versions
         (id, plan_id, version, status, limits, pricing, published_at)
       VALUES ($1, $2, 1, 'published', '{}'::jsonb, '{}'::jsonb, now())`,
      [competingPlanVersionId, competingPlanId],
    )
    const competingAssignments = await Promise.allSettled([
      service.assignConsumerPlan(consumer.id, {
        planVersionId: initialPlan.versionId,
        expectedRevision: 2,
      }, 'concurrent-a'),
      service.assignConsumerPlan(consumer.id, {
        planVersionId: competingPlanVersionId,
        expectedRevision: 2,
      }, 'concurrent-b'),
    ])
    assert.equal(competingAssignments.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = competingAssignments.find((result) => result.status === 'rejected')
    assert.equal(rejected?.reason?.code, 'plan_assignment_revision_conflict')
    assert.equal((await service.getConsumerPlan(consumer.id)).revision, 3)
  } finally {
    await pool.end()
  }
})
