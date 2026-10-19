import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { normalizeRequestFailureDiagnostic, REQUEST_FAILURE_PHASES } from '../../server/core/request-failure-diagnostic.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const postgres = { skip: modulePath ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL SQL' }
const diagnostic = () => ({ phase: 'finish_step', sqlState: '55P03', callId: randomUUID(), errorClass: 'Error' })

test('failure evidence keeps only bounded fields and rejects unknown phases, classes, SQLSTATEs and IDs', () => {
  const evidence = diagnostic()
  assert.deepEqual(normalizeRequestFailureDiagnostic({ ...evidence, message: 'private SQL', stack: 'private stack',
    details: { authorization: 'private credential' } }), evidence)
  assert.deepEqual(normalizeRequestFailureDiagnostic({ phase: 'commit_delivery', errorClass: 'AppError' }),
    { phase: 'commit_delivery', errorClass: 'AppError', sqlState: null, callId: null })
  for (const invalid of [null, [], {}, { ...evidence, phase: 'arbitrary-private-phase' },
    { ...evidence, errorClass: 'private error text' }, { ...evidence, sqlState: '55p03' },
    { ...evidence, sqlState: '' }, { ...evidence, sqlState: '55P03 SQL' },
    { ...evidence, sqlState: 55003 }, { ...evidence, callId: 'private-host' }]) {
    assert.throws(() => normalizeRequestFailureDiagnostic(invalid), TypeError)
  }
})

test('memory first failure is private and immutable without changing usage, replay or billing', async () => {
  const store = new MemoryStore(), consumerId = randomUUID()
  for (const status of ['reserved', 'committed', 'unknown', 'released']) {
    const id = randomUUID(), evidence = diagnostic()
    store.requests.set(id, { id, consumerId, status, errorCode: 'existing', unitsActual: 13,
      responseBody: { data: { items: ['original'] } }, fingerprint: 'original-fingerprint' })
    store.requestsByScope.set(`${consumerId}:${id}`, id)
    store.customerCharges.set(id, { status: 'reserved', amountMinor: 10 })
    store.creditLedgerEntries.push({ requestId: id, amountMinor: 10 })
    const before = structuredClone({ requests: store.requests, bindings: store.requestsByScope,
      charges: store.customerCharges, ledger: store.creditLedgerEntries, accounts: store.creditAccounts })
    const publicBefore = await store.getRequest(id, consumerId)
    assert.deepEqual(await store.recordRequestFailure(id, evidence), { recorded: true })
    const first = structuredClone(store.requestFailures.get(id))
    assert.equal(first.requestId, id)
    assert.deepEqual({ phase: first.phase, sqlState: first.sqlState, callId: first.callId, errorClass: first.errorClass }, evidence)
    assert.ok(Number.isFinite(Date.parse(first.recordedAt)))
    assert.deepEqual(await store.recordRequestFailure(id, { phase: 'commit_delivery', sqlState: null, errorClass: 'TypeError' }), { recorded: false })
    assert.deepEqual(store.requestFailures.get(id), first)
    assert.deepEqual(await store.getRequest(id, consumerId), publicBefore)
    assert.deepEqual({ requests: store.requests, bindings: store.requestsByScope,
      charges: store.customerCharges, ledger: store.creditLedgerEntries, accounts: store.creditAccounts }, before)
  }
  await assert.rejects(store.recordRequestFailure(randomUUID(), diagnostic()), { code: 'request_not_found' })
  assert.equal(store.requestFailures.size, 4)
})

test('PostgreSQL diagnostic writes use bounded local timeouts and reject invalid input before connecting', async () => {
  const commands = [], id = randomUUID()
  let connects = 0, releasedWith = 'not-released'
  const store = new PostgresStore({ async connect() { connects++; return {
    async query(sql, args) { commands.push({ sql, args }); return { rows: sql.includes('RETURNING') ? [{ request_id: id }] : [] } },
    release(error) { releasedWith = error },
  } } })
  await assert.rejects(store.recordRequestFailure(id, { ...diagnostic(), phase: 'unknown-phase' }), TypeError)
  await assert.rejects(store.recordRequestFailure('not-a-uuid', diagnostic()), TypeError)
  assert.equal(connects, 0)
  assert.deepEqual(await store.recordRequestFailure(id, diagnostic()), { recorded: true })
  assert.deepEqual(commands.slice(0, 4).map(row => row.sql), ['BEGIN', "SET LOCAL lock_timeout = '1s'",
    "SET LOCAL statement_timeout = '3s'", "SET LOCAL idle_in_transaction_session_timeout = '5s'"])
  assert.equal(commands.at(-1).sql, 'COMMIT')
  assert.equal(releasedWith, null)
})

for (const failurePoint of ['connect', 'insert', 'commit', 'rollback']) {
  test(`diagnostic ${failurePoint} failure preserves the original exception and never updates usage`, async () => {
    const commands = [], original = Object.assign(new Error('private database message'), { code: '57014' })
    const rollbackError = new Error('rollback connection failure')
    let releasedWith
    const store = new PostgresStore({ async connect() {
      if (failurePoint === 'connect') throw original
      return { async query(sql) {
        commands.push(sql)
        if (sql.startsWith('INSERT') && failurePoint !== 'commit' || sql === 'COMMIT' && failurePoint === 'commit') throw original
        if (sql === 'ROLLBACK' && failurePoint === 'rollback') throw rollbackError
        return { rows: [] }
      }, release(error) { releasedWith = error } }
    } })
    await assert.rejects(store.recordRequestFailure(randomUUID(), diagnostic()), error => error === original)
    assert.equal(commands.some(sql => /UPDATE|DELETE/u.test(sql)), false)
    if (failurePoint === 'connect') assert.deepEqual(commands, [])
    else {
      assert.equal(commands.at(-1), 'ROLLBACK')
      assert.equal(releasedWith, failurePoint === 'rollback' ? rollbackError : original)
    }
  })
}

async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  // Isolated usage/billing boundary; the diagnostic table uses its exact
  // production migration. A trigger detects any attempted usage mutation.
  await db.exec(`CREATE TABLE public.usage_requests(id uuid PRIMARY KEY,consumer_id uuid,status text,
    response_status int,response_body jsonb,error_code text,units_actual int);
    CREATE TABLE billing_probe(request_id uuid PRIMARY KEY,amount_minor int,usage_updates int DEFAULT 0);
    CREATE FUNCTION probe_usage_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE billing_probe SET usage_updates=usage_updates+1 WHERE request_id=NEW.id; RETURN NEW;
    END $$;
    CREATE TRIGGER probe_usage AFTER UPDATE ON public.usage_requests FOR EACH ROW EXECUTE FUNCTION probe_usage_update();`)
  await db.exec(await readFile(new URL('../../migrations/161_usage_request_failures.sql', import.meta.url), 'utf8'))
  const id = randomUUID(), consumerId = randomUUID()
  await db.query(`INSERT INTO public.usage_requests VALUES($1,$2,'unknown',200,'{"original":true}','original_error',13)`, [id, consumerId])
  await db.query('INSERT INTO billing_probe(request_id,amount_minor) VALUES($1,10)', [id])
  const pool = { query: (sql, args) => db.query(sql, args),
    connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }) }
  const snapshot = async () => ({ usage: (await db.query('SELECT * FROM public.usage_requests ORDER BY id')).rows,
    billing: (await db.query('SELECT * FROM billing_probe ORDER BY request_id')).rows })
  return { db, id, consumerId, store: new PostgresStore(pool), snapshot }
}

test('actual PostgreSQL first write, nullable SQLSTATE and duplicate writes preserve original evidence and public state', postgres, async t => {
  const f = await fixture(t), before = await f.snapshot(), publicBefore = await f.store.getRequest(f.id, f.consumerId)
  assert.deepEqual(await f.store.recordRequestFailure(f.id, { phase: 'commit_delivery', errorClass: 'Error' }), { recorded: true })
  const first = (await f.db.query('SELECT * FROM public.usage_request_failures WHERE request_id=$1', [f.id])).rows[0]
  assert.equal(first.sql_state, null)
  assert.equal(first.call_id, null)
  assert.ok(first.recorded_at instanceof Date)
  assert.deepEqual(await f.store.recordRequestFailure(f.id, diagnostic()), { recorded: false })
  assert.deepEqual((await f.db.query('SELECT * FROM public.usage_request_failures WHERE request_id=$1', [f.id])).rows[0], first)
  assert.deepEqual(await f.snapshot(), before)
  assert.deepEqual(await f.store.getRequest(f.id, f.consumerId), publicBefore)
  assert.equal(JSON.stringify(publicBefore).includes('commit_delivery'), false)
})

test('actual PostgreSQL migration enforces bounded values, foreign key and deletion lifecycle', postgres, async t => {
  const f = await fixture(t)
  for (const phase of REQUEST_FAILURE_PHASES) {
    await f.db.query('INSERT INTO public.usage_request_failures(request_id,phase,error_class) VALUES($1,$2,$3)', [f.id, phase, 'Error'])
    await f.db.query('DELETE FROM public.usage_request_failures WHERE request_id=$1', [f.id])
  }
  for (const [phase, state, errorClass] of [['private phase', null, 'Error'], ['admission', 'x', 'Error'],
    ['admission', '55p03', 'Error'], ['admission', null, 'private message']]) {
    await assert.rejects(f.db.query('INSERT INTO public.usage_request_failures(request_id,phase,sql_state,error_class) VALUES($1,$2,$3,$4)',
      [f.id, phase, state, errorClass]), { code: '23514' })
  }
  const before = await f.snapshot()
  await assert.rejects(f.store.recordRequestFailure(randomUUID(), diagnostic()), { code: '23503' })
  assert.deepEqual(await f.snapshot(), before)
  assert.deepEqual(await f.store.recordRequestFailure(f.id, diagnostic()), { recorded: true })
  await f.db.query('DELETE FROM public.usage_requests WHERE id=$1', [f.id])
  assert.deepEqual((await f.db.query('SELECT * FROM public.usage_request_failures')).rows, [])
})

test('actual PostgreSQL failed diagnostic insert and absent migration leave usage and billing unchanged', postgres, async t => {
  const f = await fixture(t), before = await f.snapshot()
  await f.db.exec(`CREATE FUNCTION reject_diagnostic() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'private diagnostic failure' USING ERRCODE='55000'; END $$;
    CREATE TRIGGER reject_diagnostic BEFORE INSERT ON public.usage_request_failures
    FOR EACH ROW EXECUTE FUNCTION reject_diagnostic();`)
  await assert.rejects(f.store.recordRequestFailure(f.id, diagnostic()), { code: '55000' })
  assert.deepEqual(await f.snapshot(), before)
  assert.deepEqual((await f.db.query('SELECT * FROM public.usage_request_failures')).rows, [])
  await f.db.exec('DROP TABLE public.usage_request_failures')
  await assert.rejects(f.store.recordRequestFailure(f.id, diagnostic()), { code: '42P01' })
  assert.deepEqual(await f.snapshot(), before)
})
