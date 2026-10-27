import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { diagnoseInstagramCircuit } from '../../server/ops/diagnose-instagram-circuit.mjs'

const requestId = 'ed363e5f-41c2-4082-8c02-8e004d389358'
const secret = 'private-query-credential-customer-body'
function fixture({ platform = 'instagram', missing = false, fail = '', count = 1, privateValues = false, optionalTables = true } = {}) {
  const queries = []
  let released = false, releaseError
  const pool = { async connect() { return { async query(sql, params) {
    queries.push({ sql, params })
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|WITH|ROLLBACK)\b/u)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b/u)
    if (fail && sql.includes(fail)) throw new Error(secret)
    const row = { id: randomUUID(), provider_key: 'justone', status: 'released', response_status: 503,
      error_code: 'external_platform_circuit_open', source_mode: 'circuit_rejected', saved_search_provider: null,
      reserved_at: new Date('2026-10-27T03:36:24.391Z'), completed_at: new Date('2026-10-27T03:36:24.417Z'),
      observed_at: new Date('2026-10-27T07:00:00Z'), created_at: new Date('2026-10-27T03:36:24.417Z'),
      consecutive_failures: 3, circuit_open_until: new Date('2026-10-27T08:00:00Z'), open_now: true,
      last_error_code: 'upstream_rate_limited', last_failure_at: new Date('2026-10-27T06:55:00Z'), updated_at: new Date(),
      marketplace: 'twitter', outcome: 'rejected', http_status: 429, business_code: 429, billed: false,
      started_at: new Date('2026-10-27T03:36:00Z'), completed_before_target: true,
      mode: 'fixed', primary_provider: 'tikhub', fallback_provider: null, revision: 2, raw_body: secret }
    if (privateValues) for (const key of Object.keys(row)) row[key] = secret
    if (sql.includes('instagram-circuit:usage')) return { rows: missing ? [] : [{ ...row, platform,
      has_contract_circuits: optionalTables, has_search_routes: optionalTables }] }
    if (/instagram-circuit:(gateways|nearby)/u.test(sql)) return { rows: Array.from({ length: count }, () => row) }
    if (/instagram-circuit:(states|contracts|policy)/u.test(sql)) return { rows: [row] }
    return { rows: [] }
  }, release(error) { released = true; releaseError = error } } } }
  return { pool, queries, get released() { return released }, get releaseError() { return releaseError } }
}

test('Instagram diagnostic separates recorded provider from current policy and uses read-only bounded metadata queries', async () => {
  const db = fixture()
  const result = await diagnoseInstagramCircuit(db.pool, requestId)
  assert.equal(result.diagnosticRevision, 'instagram-circuit-diagnostic.v1')
  assert.deepEqual(result.historical.gatewayProviders, ['justone'])
  assert.equal(result.historical.savedSearchProvider, null, 'missing saved route marker stays missing')
  assert.equal(result.current.searchPolicy.primaryProvider, 'tikhub', 'current policy never overrides recorded provider')
  assert.equal(result.historical.historicalCircuitState, 'not_recorded_here')
  assert.equal(result.nearbyHistoricalFailures[0].completedBeforeTarget, true)
  assert.equal(result.current.providerCircuits[0].openNow, true)
  assert.equal(db.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(db.released, true)
  const nearby = db.queries.find(row => row.sql.includes('instagram-circuit:nearby'))
  assert.deepEqual(nearby.params, [requestId, ['justone']])
  assert.match(nearby.sql, /INTERVAL '5 minutes'/u)
  assert.match(nearby.sql, /LIMIT 21/u)
  for (const query of db.queries) assert.doesNotMatch(query.sql, /SELECT\s+\*|response_body|body_bytes|parsed_payload|tenant_id|consumer_id|api_key_id|credentials|\breason\b/u)
  assert.doesNotMatch(JSON.stringify(result), /private-|raw_body|acquisition_request/u)
})

test('Instagram diagnostic bounds lists, filters arbitrary metadata and explicitly reports unavailable optional schema', async () => {
  const result = await diagnoseInstagramCircuit(fixture({ count: 21, privateValues: true }).pool, requestId)
  assert.equal(result.historical.gateways.length, 20)
  assert.equal(result.historical.gatewayProvidersComplete, false)
  assert.deepEqual(result.historical.gatewayProviders, [], 'a truncated history does not select a guessed provider')
  assert.equal(result.nearbyHistoricalFailures.length, 20)
  assert.equal(result.nearbyFailuresTruncated, true)
  assert.equal(result.current.providerCircuits[0].openNow, null)
  assert.doesNotMatch(JSON.stringify(result), /private-/u)
  const db = fixture({ optionalTables: false })
  const old = await diagnoseInstagramCircuit(db.pool, requestId)
  assert.equal(old.current.instagramContractTableAvailable, false)
  assert.equal(old.current.missingInstagramContractRows, null)
  assert.equal(old.current.searchPolicyTableAvailable, false)
  assert.equal(old.current.searchPolicy, null)
  assert.equal(db.queries.some(row => /instagram-circuit:(contracts|policy)/u.test(row.sql)), false)
})

test('Instagram diagnostic stops safely on invalid input, missing history and DB errors without revealing raw errors', async () => {
  await assert.rejects(diagnoseInstagramCircuit({ connect() { assert.fail('must not connect') } }, secret), { message: 'invalid_request_id' })
  for (const [options, message] of [[{ missing: true }, 'request_not_found'], [{ platform: 'twitter' }, 'request_not_instagram'],
    [{ fail: 'instagram-circuit:nearby' }, 'diagnostic_read_failed'], [{ fail: 'ROLLBACK' }, 'diagnostic_read_failed']]) {
    const db = fixture(options)
    await assert.rejects(diagnoseInstagramCircuit(db.pool, requestId), { message })
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(db.released, true)
    assert.equal(Boolean(db.releaseError), options.fail === 'ROLLBACK')
  }
})

test('Instagram diagnostic runs from stdin without deployed runtime modules and rejects missing configuration safely', () => {
  const source = readFileSync(new URL('../../server/ops/diagnose-instagram-circuit.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(/u)
  const env = { ...process.env }
  delete env.DATABASE_URL
  for (const [args, expected] of [[[requestId], 'database_url_required'], [[secret], 'invalid_request_id'], [[requestId, secret], 'invalid_arguments']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error: expected })
  }
})

test('Instagram diagnostic executes actual SQL against PostgreSQL, limits nearby evidence and tolerates absent optional tables', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    CREATE TABLE usage_requests(id uuid PRIMARY KEY, platform text, status text, error_code text, response_status int,
      reserved_at timestamptz, completed_at timestamptz, acquisition_request jsonb);
    CREATE TABLE external_platform.gateway_requests(id uuid PRIMARY KEY, usage_request_id uuid, provider_key text,
      source_mode text, response_status int, error_code text, provider_call_id uuid, created_at timestamptz);
    CREATE TABLE external_platform.provider_state(provider_key text PRIMARY KEY, consecutive_failures int,
      circuit_open_until timestamptz, last_failure_at timestamptz, last_error_code text, updated_at timestamptz);
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY, usage_request_id uuid, provider_key text,
      marketplace text, outcome text, http_status int, business_code int, error_code text, billed boolean,
      started_at timestamptz, completed_at timestamptz);`)
  await db.query(`INSERT INTO usage_requests VALUES($1,'instagram','released','external_platform_circuit_open',503,
    '2026-10-27T03:36:24.391Z','2026-10-27T03:36:24.417Z',$2)`, [requestId, JSON.stringify({ body: secret })])
  await db.query(`INSERT INTO external_platform.gateway_requests VALUES($1,$2,'justone','circuit_rejected',503,
    'external_platform_circuit_open',NULL,'2026-10-27T03:36:24.417Z')`, [randomUUID(), requestId])
  await db.query(`INSERT INTO external_platform.provider_state VALUES('justone',3,now()+interval '1 minute',
    now()-interval '1 minute','upstream_rate_limited',now())`)
  const before = randomUUID(), after = randomUUID()
  const insertCall = (id, provider, outcome, when, own = false) => db.query(`INSERT INTO external_platform.provider_calls
    VALUES($1,$2,$3,'taobao',$4,429,429,'upstream_rate_limited',false,$5::timestamptz,$5::timestamptz+interval '1 second')`,
  [id, own ? requestId : randomUUID(), provider, outcome, when])
  await insertCall(before, 'justone', 'rejected', '2026-10-27T03:36:00Z')
  await insertCall(after, 'justone', 'unknown', '2026-10-27T03:37:00Z')
  await insertCall(randomUUID(), 'tikhub', 'rejected', '2026-10-27T03:36:00Z')
  await insertCall(randomUUID(), 'justone', 'succeeded', '2026-10-27T03:36:00Z')
  await insertCall(randomUUID(), 'justone', 'rejected', '2026-10-27T03:30:00Z')
  await insertCall(randomUUID(), 'justone', 'rejected', '2026-10-27T03:42:00Z')
  await insertCall(randomUUID(), 'justone', 'rejected', '2026-10-27T03:36:00Z', true)
  const pool = { connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }) }
  const old = await diagnoseInstagramCircuit(pool, requestId)
  assert.deepEqual(old.nearbyHistoricalFailures.map(row => row.callId), [before, after])
  assert.deepEqual(old.nearbyHistoricalFailures.map(row => row.completedBeforeTarget), [true, false])
  assert.equal(old.nearbyHistoricalFailures[0].marketplace, 'taobao', 'shared-provider evidence can originate from ecommerce')
  assert.equal(old.current.providerCircuits[0].openNow, true)
  assert.equal(old.current.instagramContractTableAvailable, false)
  assert.equal(old.current.searchPolicyTableAvailable, false)
  await db.exec(`CREATE TABLE external_platform.provider_contract_circuits(LIKE external_platform.provider_state);
    ALTER TABLE external_platform.provider_contract_circuits ADD COLUMN scope text;
    INSERT INTO external_platform.provider_contract_circuits SELECT *, 'instagram' FROM external_platform.provider_state;
    CREATE TABLE control.strategy_search_routes(interface_key text, platform text, mode text,
      primary_provider text, fallback_provider text, revision int, updated_at timestamptz);
    INSERT INTO control.strategy_search_routes VALUES('search','instagram','fixed','tikhub',NULL,2,now());`)
  const current = await diagnoseInstagramCircuit(pool, requestId)
  assert.deepEqual(current.historical.gatewayProviders, ['justone'])
  assert.equal(current.current.searchPolicy.primaryProvider, 'tikhub')
  assert.equal(current.current.instagramContractCircuits[0].provider, 'justone')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM external_platform.provider_calls')).rows[0].n, 7)
  assert.doesNotMatch(JSON.stringify(current), /private-/u)
  await db.exec('ALTER TABLE external_platform.provider_state DROP COLUMN last_error_code')
  await assert.rejects(diagnoseInstagramCircuit(pool, requestId), { message: 'diagnostic_schema_unavailable' })
})
