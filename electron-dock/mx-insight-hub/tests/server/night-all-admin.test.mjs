import test from 'node:test'
import assert from 'node:assert/strict'
import { NightAllPlatformAdminService } from '../../server/external-platforms/night-all-admin.mjs'
import { MultiExternalPlatformAdminService } from '../../server/external-platforms/admin.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

test('Night-All overview reports zero transfer price, no invented health, and rejects provider-price writes', async () => {
  const service = new NightAllPlatformAdminService({ store: new MemoryStore(), config: {baseUrl:'http://private-host',serviceToken:'do-not-expose'} })
  const multi = new MultiExternalPlatformAdminService([service])
  const view = await multi.overview('24h')
  assert.equal(view.summary.providerCount,1)
  assert.equal(view.providers[0].status,'unknown')
  assert.equal(view.summary.actualCostMinor,0)
  assert.doesNotMatch(JSON.stringify(view),/private-host|do-not-expose/)
  assert.throws(()=>multi.updateProviderPriceBook('night-all',{}),e=>e.status===409)
  assert.throws(()=>multi.revealCredential('night-all'),e=>e.status===409)
})

test('PostgreSQL Night-All platform aggregation excludes unrelated operations and out-of-window calls', {skip:!process.env.MX_ECOMMERCE_TEST_DATABASE_URL}, async () => {
  const { default: pg } = await import('pg')
  const { PostgresStore } = await import('../../server/stores/postgres-store.mjs')
  const pool = new pg.Pool({connectionString:process.env.MX_ECOMMERCE_TEST_DATABASE_URL,max:1})
  try {
    await pool.query('CREATE TEMP TABLE usage_requests (id uuid, status text, response_status int)')
    await pool.query('CREATE TEMP TABLE na_connector_calls (operation text,platform text,usage_request_id uuid,http_status int,outcome text,started_at timestamptz)')
    await pool.query("INSERT INTO usage_requests VALUES ('00000000-0000-4000-8000-000000000001','committed',200)")
    await pool.query("INSERT INTO na_connector_calls VALUES ('crawl','twitter','00000000-0000-4000-8000-000000000001',200,'complete','2026-09-13T00:00:00Z'), ('crawl','twitter',null,null,'unknown','2026-09-13T00:00:01Z'), ('other','twitter',null,200,'complete','2026-09-13T00:00:01Z'), ('raw','twitter',null,200,'complete','2026-09-01T00:00:00Z')")
    const store = new PostgresStore({query:(sql,args)=>pool.query(sql.replace('serving.connector_calls','pg_temp.na_connector_calls'),args)})
    const rows = await store.nightAllAnalytics({since:'2026-09-12T00:00:00Z',until:'2026-09-14T00:00:00Z'})
    assert.equal(rows.length,1); assert.equal(rows[0].upstreamCalls,2); assert.equal(rows[0].hubRequests,1)
    assert.equal(rows[0].successfulHubRequests,1); assert.equal(rows[0].unknownOutcomes,1)
    assert.equal(rows[0].lastObservedAt,'2026-09-13T00:00:01.000Z')
  } finally {await pool.end()}
})
