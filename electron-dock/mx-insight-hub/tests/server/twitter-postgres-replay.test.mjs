import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { createTwitterSearchRouter } from '../../server/data/twitter-search-routing.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { TIKHUB_CONTENT_SEARCH_VERSION } from '../../server/contracts/tikhub-content-search.mjs'
import { RAW_SEARCH_VERSION } from '../../server/contracts/raw-search.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const options = { skip: !modulePath ? 'Set MX_INSIGHT_TEST_PGLITE_MODULE to the local PGlite module' : false }
const pepper = 'offline-postgres-twitter-replay-only'
const recipe = 't.twitter_web_fetch_search_timeline'
const marker = { searchProvider: 'tikhub', searchContractVersion: TIKHUB_CONTENT_SEARCH_VERSION }

async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform;
    CREATE TABLE usage_requests (id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,api_key_id uuid,
      idempotency_key text,platform text,status text,fingerprint text,response_status int,response_body jsonb,
      acquisition_request jsonb);
    CREATE TABLE usage_idempotency_bindings (consumer_id uuid,idempotency_key text,current_request_id uuid,
      PRIMARY KEY(consumer_id,idempotency_key));
    CREATE TABLE external_platform.provider_calls (id uuid PRIMARY KEY,usage_request_id uuid,tenant_id uuid,
      consumer_id uuid,api_key_id uuid,provider_key text,operation text,endpoint_key text);`)
  const context = { tenant: { id: randomUUID() }, consumer: { id: randomUUID() }, apiKey: { id: randomUUID() } }
  const store = new PostgresStore({ query: (sql, args) => db.query(sql, args) })
  const codec = createDataSearchCursorCodec(pepper, `${context.consumer.id}:${context.apiKey.id}`)
  const cursor = codec.encode({ version: TIKHUB_CONTENT_SEARCH_VERSION, provider: 'tikhub', platform: 'twitter', recipe,
    previousDeliveryId: randomUUID(), page: 2, expiresAt: Date.now() + 86400000, scope: 'fixture-scope' })
  const body = { platform: 'twitter', query: 'unchanged complete query', pageSize: 1, type: 'stable' }
  const selected = []
  const route = createTwitterSearchRouter({ usageStore: store, apiKeyPepper: pepper, provider: 'rapidapi',
    rapidGateway: { searchRaw: async (_, input) => { selected.push({ provider: 'rapidapi', input }); return 'rapidapi' } },
    tikHubGateway: { searchContent: async (_, input) => { selected.push({ provider: 'tikhub', input }); return 'tikhub' } } })
  const seed = async (key, { acquisition = marker, ownCall = false, status = 'committed', queryBody = body } = {}) => {
    const id = randomUUID(), snapshot = { path: '/api/v1/data/search', body: queryBody, ...acquisition }
    await db.query('INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, context.tenant.id, context.consumer.id, context.apiKey.id, key, 'twitter', status, 'a'.repeat(64),
        status === 'committed' ? 200 : null, JSON.stringify({ data: { items: [{ id: 'fixture-post' }] } }), JSON.stringify(snapshot)])
    await db.query('INSERT INTO usage_idempotency_bindings VALUES($1,$2,$3)', [context.consumer.id, key, id])
    if (ownCall) await db.query('INSERT INTO external_platform.provider_calls VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), id, context.tenant.id, context.consumer.id, context.apiKey.id, 'tikhub', `native.${recipe}`, `native.${recipe}`])
    return { id, snapshot }
  }
  const input = (key, continuation = null) => ({ idempotencyKey: key, body: { ...body, ...(continuation ? { cursor: continuation } : {}) },
    normalized: { ...body, ...(continuation ? { cursor: continuation } : {}) }, dataSearch: { resultType: 'stable' } })
  return { db, context, store, codec, cursor, body, selected, route, seed, input }
}

test('Postgres persisted supplier identity routes source and zero-call buffered page replays identically', options, async t => {
  const h = await fixture(t)
  const first = await h.seed('source-page-key', { ownCall: true })
  const second = await h.seed('buffer-page-key', { queryBody: { ...h.body, cursor: h.cursor }, acquisition: {
    ...marker, contentSearch: { version: TIKHUB_CONTENT_SEARCH_VERSION, previousDeliveryId: first.id } } })
  // The first page could previously route by its owned call; a buffered page
  // has no new call, so it must retain the persisted reservation/manifest marker.
  assert.equal(await h.route(h.context, h.input('source-page-key')), 'tikhub')
  const repeated = h.input('buffer-page-key', h.cursor), original = structuredClone(repeated)
  assert.equal(await h.route(h.context, repeated), 'tikhub')
  assert.equal(await h.route(h.context, repeated), 'tikhub')
  assert.deepEqual(repeated, original)
  assert.deepEqual(h.selected.map(row => row.provider), ['tikhub', 'tikhub', 'tikhub'])
  const lookup = await h.store.getUsageRequestByIdempotencyKey(h.context.consumer.id, 'buffer-page-key')
  assert.deepEqual(lookup.acquisitionRequest, second.snapshot)
  assert.equal((await h.db.query('SELECT count(*)::int AS count FROM external_platform.provider_calls WHERE usage_request_id=$1', [second.id])).rows[0].count, 0)
  assert.equal((await h.db.query('SELECT count(*)::int AS count FROM external_platform.provider_calls')).rows[0].count, 1)
})

test('Postgres marker-only pending outcomes and earlier content manifests remain pinned without an owned call', options, async t => {
  const h = await fixture(t)
  for (const status of ['reserved', 'released', 'unknown']) {
    const key = `marker-${status}`
    await h.seed(key, { status })
    assert.equal(await h.route(h.context, h.input(key)), 'tikhub', 'The original gateway must handle the saved outcome, not another supplier')
  }
  await h.seed('manifest-only-page', { acquisition: { contentSearch: { version: TIKHUB_CONTENT_SEARCH_VERSION } } })
  assert.equal(await h.route(h.context, h.input('manifest-only-page', h.cursor)), 'tikhub')
  assert.equal((await h.db.query('SELECT count(*)::int AS count FROM external_platform.provider_calls')).rows[0].count, 0)
})

test('Postgres internal supplier evidence does not expose snapshots through public request lookup', options, async t => {
  const h = await fixture(t), saved = await h.seed('private-snapshot-key')
  assert.deepEqual((await h.store.getUsageRequestByIdempotencyKey(h.context.consumer.id, 'private-snapshot-key')).acquisitionRequest, saved.snapshot)
  const publicRecord = await h.store.getRequest(saved.id, h.context.consumer.id)
  for (const field of ['acquisitionRequest', 'acquisition_request', 'fingerprint', 'responseBody']) assert.equal(Object.hasOwn(publicRecord, field), false)
  assert.equal(await h.store.getUsageRequestByIdempotencyKey(randomUUID(), 'private-snapshot-key'), null)
  assert.equal(await h.store.getRequest(saved.id, randomUUID()), null)
})

test('Postgres replay routing still rejects conflicting supplier cursors and unauthenticated ownership', options, async t => {
  const h = await fixture(t)
  await h.seed('legacy-rapid-key', { acquisition: {} })
  await h.seed('native-marker-key')
  await assert.rejects(h.route(h.context, h.input('legacy-rapid-key', h.cursor)), { code: 'idempotency_conflict' })
  const rapidCursor = h.codec.encode({ version: RAW_SEARCH_VERSION, provider: 'rapidapi' })
  await assert.rejects(h.route(h.context, h.input('native-marker-key', rapidCursor)), { code: 'idempotency_conflict' })
  const otherKeyCursor = createDataSearchCursorCodec(pepper, `${h.context.consumer.id}:${randomUUID()}`)
    .encode({ version: TIKHUB_CONTENT_SEARCH_VERSION, provider: 'tikhub', platform: 'twitter', recipe })
  await assert.rejects(h.route(h.context, h.input('native-marker-key', otherKeyCursor)), { code: 'invalid_cursor' })
  assert.equal(h.selected.length, 0, 'Conflicts must stop before either supplier gateway is selected')
})
