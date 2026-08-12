import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''

async function waitForRelationLock(pool, applicationName) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `SELECT wait_event
         FROM pg_stat_activity
        WHERE application_name = $1
          AND state = 'active'
          AND wait_event_type = 'Lock'
        LIMIT 1`,
      [applicationName],
    )
    if (rows[0]) return rows[0].wait_event
    await delay(10)
  }
  assert.fail('concurrent Admin disable did not wait for the migration table lock')
}

test('migration 020 serializes its backfill with a concurrent Admin disable', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const schema = `mxhub_tokenize_${randomUUID().replaceAll('-', '')}`
  const adminApplicationName = `mxhub-disable-${randomUUID().slice(0, 8)}`
  const rootPool = new pg.Pool({ connectionString, statement_timeout: 5_000 })
  const scopedConfig = {
    connectionString,
    options: `-c search_path=${schema}`,
    statement_timeout: 5_000,
  }
  const setupPool = new pg.Pool(scopedConfig)
  const migrationPool = new pg.Pool({ ...scopedConfig, application_name: 'mxhub-migration-020-test' })
  const adminPool = new pg.Pool({ ...scopedConfig, application_name: adminApplicationName })
  const store = new PostgresStore(adminPool)
  let migrationClient
  let disablePromise

  try {
    await rootPool.query(`CREATE SCHEMA ${schema}`)
    const [initialMigration, capabilityMigration, defaultMigration] = await Promise.all([
      readFile(fileURLToPath(new URL('../../migrations/001_initial.sql', import.meta.url)), 'utf8'),
      readFile(fileURLToPath(new URL('../../migrations/018_public_capabilities.sql', import.meta.url)), 'utf8'),
      readFile(fileURLToPath(new URL('../../migrations/020_default_tokenize_capability.sql', import.meta.url)), 'utf8'),
    ])
    await setupPool.query(initialMigration)
    await setupPool.query(capabilityMigration)

    const tenantId = randomUUID()
    const consumerId = randomUUID()
    await setupPool.query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'Migration concurrency test')`,
      [tenantId],
    )
    await setupPool.query(
      `INSERT INTO consumers (id, tenant_id, name, business_id)
       VALUES ($1, $2, 'Consumer', $3)`,
      [consumerId, tenantId, `migration-test-${consumerId}`],
    )

    const lockStatement = defaultMigration.match(
      /LOCK TABLE\s+consumers,\s*capability_grants,\s*consumer_capability_policies\s+IN SHARE ROW EXCLUSIVE MODE;/,
    )?.[0]
    assert.ok(lockStatement, 'migration must declare its serialization lock')

    migrationClient = await migrationPool.connect()
    await migrationClient.query('BEGIN')
    await migrationClient.query(lockStatement)

    disablePromise = store.putCapabilityConfiguration({
      tenantId,
      consumerId,
      capability: 'nlp.tokenize',
      enabled: false,
      maxRequests: 250,
      windowSeconds: 900,
    })
    assert.equal(await waitForRelationLock(rootPool, adminApplicationName), 'relation')

    // The runner executes the complete file in this same transaction. Re-taking
    // the table lock is harmless and keeps this test tied to the production SQL.
    await migrationClient.query(defaultMigration)
    await migrationClient.query('COMMIT')
    migrationClient.release()
    migrationClient = null

    const disabledPolicy = await disablePromise
    disablePromise = null
    assert.equal(disabledPolicy.maxRequests, 250)
    assert.equal(disabledPolicy.windowSeconds, 900)

    const [{ rows: grants }, { rows: policies }] = await Promise.all([
      setupPool.query(
        `SELECT capability FROM capability_grants
          WHERE consumer_id = $1 AND capability = 'nlp.tokenize'`,
        [consumerId],
      ),
      setupPool.query(
        `SELECT max_requests, window_seconds FROM consumer_capability_policies
          WHERE consumer_id = $1 AND capability = 'nlp.tokenize'`,
        [consumerId],
      ),
    ])
    assert.deepEqual(grants, [], 'the later explicit disable must win')
    assert.deepEqual(policies, [{ max_requests: 250, window_seconds: 900 }])
  } finally {
    if (migrationClient) {
      await migrationClient.query('ROLLBACK').catch(() => {})
      migrationClient.release()
    }
    await disablePromise?.catch(() => {})
    await Promise.allSettled([setupPool.end(), migrationPool.end(), adminPool.end()])
    await rootPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
    await rootPool.end()
  }
})
