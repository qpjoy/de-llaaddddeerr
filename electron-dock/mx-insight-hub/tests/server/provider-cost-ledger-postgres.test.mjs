// Provider procurement-budget admission used to aggregate the whole current
// month of provider_calls (plus every customer charge) under a per-provider
// advisory lock, twice per paid dispatch, and to hold that lock until each
// COMMIT had flushed. Migration 163 folds finished usage requests into monthly
// totals so admission reads totals + open requests; reservations and releases
// commit without waiting for the WAL flush; a call consuming its own
// reservation serializes on that reservation row instead of the provider lock.
//
// The oracle below is the original aggregate, verbatim. Admission decisions are
// a pure function of this row, so equal rows mean identical admit/refuse
// decisions. The cases drive real usage reservations, enforced customer
// charges (capture, release, unknown and its reconciliation), cost evidence of
// every shape, folds and resets, then check concurrency, slow flushes and
// rollback; the crash case runs only when given control of the server.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import test from 'node:test'
import pg from 'pg'
import { PostgresExternalPlatformStore, providerCostExposure } from '../../server/external-platforms/store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { HubService } from '../../server/hub-service.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const native = { skip: connectionString ? false : 'Requires a disposable migrated MX_INSIGHT_TEST_DATABASE_URL' }
const FP = 'c'.repeat(64)
const BIG = 9_000_000_000_000

// The pre-ledger admission aggregate (server/external-platforms/store.mjs before
// migration 163), unchanged.
const ORACLE_SQL = `WITH monthly_calls AS MATERIALIZED (
       SELECT usage_request_id, cost_minor, cost_kind, currency
         FROM external_platform.provider_calls
        WHERE provider_key = $1
          AND (currency = $2 OR usage_request_id = $3
            OR currency IS NULL OR currency !~ '^[A-Z]{3}$')
          AND started_at >= (
            date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          )
          AND started_at < (
            (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')
              AT TIME ZONE 'UTC'
          )
     ), usage_costs AS MATERIALIZED (
       SELECT usage_request_id, sum(cost_minor)::bigint AS cost_minor
         FROM monthly_calls
        WHERE cost_minor IS NOT NULL AND currency = $2
        GROUP BY usage_request_id
     ), subsidy_exposure AS (
       SELECT coalesce(sum(greatest(
                usage_cost.cost_minor - CASE
                  WHEN charge.enforcement_mode = 'enforced'
                   AND charge.status IN ('reserved', 'captured', 'unknown')
                   AND charge.currency = $2
                  THEN charge.quoted_minor
                  ELSE 0
                END,
                0
              )), 0)::bigint AS cost_minor
         FROM usage_costs usage_cost
         LEFT JOIN billing.customer_charges charge
           ON charge.usage_request_id = usage_cost.usage_request_id
     ), active_reservations AS MATERIALIZED (
       SELECT reservation.*,
              coalesce(usage_cost.cost_minor, 0)::bigint AS current_usage_cost_minor,
              CASE
                WHEN charge.enforcement_mode = 'enforced'
                 AND charge.status IN ('reserved', 'captured', 'unknown')
                 AND charge.currency = $2
                THEN charge.quoted_minor
                ELSE 0
              END::bigint AS customer_coverage_minor
         FROM external_platform.provider_cost_reservations reservation
         JOIN usage_requests request ON request.id = reservation.usage_request_id
         LEFT JOIN usage_costs usage_cost
           ON usage_cost.usage_request_id = reservation.usage_request_id
         LEFT JOIN billing.customer_charges charge
           ON charge.usage_request_id = reservation.usage_request_id
        WHERE reservation.provider_key = $1
          AND (reservation.currency = $2 OR reservation.usage_request_id = $3
            OR reservation.currency IS NULL OR reservation.currency !~ '^[A-Z]{3}$')
          AND reservation.status = 'active'
          AND request.status = 'reserved'
          AND (request.lease_expires_at IS NULL OR request.lease_expires_at > now())
          AND reservation.created_at >= (
            date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          )
          AND reservation.created_at < (
            (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')
              AT TIME ZONE 'UTC'
          )
     )
     SELECT (
              SELECT coalesce(sum(cost_minor), 0)::bigint
                FROM monthly_calls
               WHERE cost_minor IS NOT NULL AND currency = $2
            ) AS known_cost_minor,
            (
              SELECT count(*)::integer
                FROM monthly_calls
               WHERE (cost_kind <> 'unknown' AND (cost_minor IS NULL OR cost_minor <= 0))
                  OR (cost_minor IS NOT NULL AND currency IS DISTINCT FROM $2)
            ) AS unknown_cost_calls,
            (
              SELECT count(*)::integer
                FROM monthly_calls
               WHERE usage_request_id = $3
                 AND (
                   cost_kind IS NULL
                   OR cost_kind NOT IN ('estimated', 'provider_reported')
                   OR cost_minor IS NULL
                   OR cost_minor <= 0
                   OR currency IS DISTINCT FROM $2
                 )
            ) AS current_unknown_cost_calls,
            (SELECT cost_minor FROM subsidy_exposure) AS subsidy_cost_minor,
            (
              SELECT coalesce(sum(greatest(
                       reserved_cost_minor
                         - greatest(current_usage_cost_minor - base_cost_minor, 0),
                       0
                     )), 0)::bigint
                FROM active_reservations WHERE currency = $2
            ) AS reserved_cost_minor,
            (
              SELECT coalesce(sum(greatest(
                       reserved_subsidy_minor - greatest(
                         greatest(current_usage_cost_minor - customer_coverage_minor, 0)
                           - greatest(base_cost_minor - customer_coverage_minor, 0),
                         0
                       ),
                       0
                     )), 0)::bigint
                FROM active_reservations WHERE currency = $2
            ) AS reserved_subsidy_minor,
            (
              SELECT count(*)::integer
                FROM active_reservations
               WHERE currency <> $2
                  OR reserved_cost_minor <= 0
                  OR current_usage_cost_minor < base_cost_minor
            ) AS mixed_reservation_count,
            (
              SELECT count(*)::integer
                FROM active_reservations
               WHERE usage_request_id = $3
                 AND (
                   currency IS DISTINCT FROM $2
                   OR base_cost_minor < 0
                   OR reserved_cost_minor <= 0
                   OR reserved_subsidy_minor < 0
                   OR monthly_budget_minor < 0
                   OR monthly_subsidy_budget_minor < 0
                   OR current_usage_cost_minor < base_cost_minor
                 )
            ) AS current_mixed_reservation_count,
            coalesce((
              SELECT cost_minor FROM usage_costs WHERE usage_request_id = $3
            ), 0)::bigint AS usage_cost_minor,
            (
              SELECT quoted_minor FROM billing.customer_charges
               WHERE usage_request_id = $3
                 AND enforcement_mode = 'enforced'
                 AND status IN ('reserved', 'captured', 'unknown')
                 AND currency = $2
            ) AS customer_coverage_minor,
            EXISTS (
              SELECT 1
                FROM billing.customer_charges current_charge
                JOIN usage_requests current_request
                  ON current_request.id = current_charge.usage_request_id
                JOIN billing.credit_ledger_entries current_hold
                  ON current_hold.charge_id = current_charge.id
                 AND current_hold.usage_request_id = current_charge.usage_request_id
                 AND current_hold.account_id = current_charge.account_id
                 AND current_hold.tenant_id = current_charge.tenant_id
                 AND current_hold.kind = 'hold'
                 AND current_hold.amount_minor = current_charge.quoted_minor
                 AND current_hold.available_delta_minor = -current_charge.quoted_minor
                 AND current_hold.held_delta_minor = current_charge.quoted_minor
                 AND current_hold.currency = current_charge.currency
               WHERE current_charge.usage_request_id = $3
                 AND current_request.status = 'reserved'
                 AND current_charge.tenant_id = current_request.tenant_id
                 AND current_charge.consumer_id = current_request.consumer_id
                 AND current_charge.api_key_id = current_request.api_key_id
                 AND current_charge.meter_key = current_request.billing_meter_key
                 AND current_charge.enforcement_mode = 'enforced'
                 AND current_charge.status = 'reserved'
                 AND current_charge.billing_unit = 'request'
                 AND current_charge.quoted_minor > 0
                 AND current_charge.account_id IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1
                     FROM billing.credit_ledger_entries terminal_hold
                    WHERE terminal_hold.charge_id = current_charge.id
                      AND terminal_hold.kind IN ('capture', 'release')
                 )
            ) AS customer_billed,
            (SELECT id FROM active_reservations WHERE id = $4) AS reservation_id,
            (
              SELECT usage_request_id FROM active_reservations WHERE id = $4
            ) AS reservation_usage_request_id,
            (SELECT currency FROM active_reservations WHERE id = $4) AS reservation_currency,
            (
              SELECT base_cost_minor FROM active_reservations WHERE id = $4
            ) AS reservation_base_cost_minor,
            (
              SELECT reserved_cost_minor FROM active_reservations WHERE id = $4
            ) AS reservation_cost_minor,
            (
              SELECT reserved_subsidy_minor FROM active_reservations WHERE id = $4
            ) AS reservation_subsidy_minor,
            (
              SELECT monthly_budget_minor FROM active_reservations WHERE id = $4
            ) AS reservation_monthly_budget_minor,
            (
              SELECT monthly_subsidy_budget_minor FROM active_reservations WHERE id = $4
            ) AS reservation_monthly_subsidy_budget_minor`

// The console projection (describeCostBudget) before migration 163, unchanged.
const DESCRIBE_ORACLE_SQL = `WITH monthly_calls AS (
         SELECT cost_minor, currency
           FROM external_platform.provider_calls
          WHERE provider_key = $1
            AND started_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
            AND started_at < ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')
       )
       SELECT (
                SELECT coalesce(sum(cost_minor), 0)::bigint
                  FROM monthly_calls
                 WHERE cost_minor IS NOT NULL AND currency = $2
              ) AS known_cost_minor,
              (
                SELECT coalesce(sum(reservation.reserved_cost_minor), 0)::bigint
                  FROM external_platform.provider_cost_reservations reservation
                  JOIN usage_requests request ON request.id = reservation.usage_request_id
                 WHERE reservation.provider_key = $1
                   AND reservation.currency = $2
                   AND reservation.status = 'active'
                   AND request.status = 'reserved'
                   AND (request.lease_expires_at IS NULL OR request.lease_expires_at > now())
                   AND reservation.created_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                   AND reservation.created_at < ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')
              ) AS reserved_cost_minor`

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

async function fixture(t, { max = 40, survivesCrash = false } = {}) {
  const pool = new pg.Pool({ connectionString, max, statement_timeout: 20000 })
  if (survivesCrash) {
    // Checked-out and idle clients both report the dropped connections.
    pool.on('connect', client => client.on('error', () => {}))
    pool.on('error', () => {})
  }
  t.after(() => pool.end())
  const usage = new PostgresStore(pool)
  const service = new HubService({ store: usage, adapter: {}, apiKeyPepper: 'provider-cost-ledger-test-pepper-32-chars' })
  const providerKey = `ledger-${randomUUID().slice(0, 8)}`
  const store = new PostgresExternalPlatformStore({ pool, providerKey })
  await pool.query('INSERT INTO external_platform.provider_state(provider_key) VALUES ($1)', [providerKey])

  async function caller(mode) {
    const tenant = await service.createTenant({ name: `${providerKey}-${mode}` })
    if (mode === 'enforced') {
      await service.setTenantBillingProfile(tenant.id, { mode: 'enforced', defaultUnitPriceMinor: 150,
        defaultCurrency: 'CNY' }, 'ledger-test')
      await service.addTenantCredit(tenant.id, { amountMinor: 100_000_000, currency: 'CNY', reason: 'Ledger test credit' },
        { actor: 'ledger-test', idempotencyKey: randomUUID() })
    }
    const consumer = await service.createConsumer({ tenantId: tenant.id, name: mode })
    await service.putPlatformConfiguration('ecommerce', { tenantId: tenant.id, consumerId: consumer.id,
      enabled: true, maxRequests: 1_000_000, windowSeconds: 3600, maxPageSize: 100 })
    const key = await service.createApiKey({ consumerId: consumer.id, name: mode, platforms: ['ecommerce'], capabilities: [] })
    return { tenant, consumer, key, mode }
  }

  async function reserveUsage(who) {
    const requestId = randomUUID()
    await usage.reserve({ requestId, idempotencyKey: requestId, fingerprint: FP,
      tenantId: who.tenant.id, consumerId: who.consumer.id, apiKeyId: who.key.id, platform: 'ecommerce',
      unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 600_000),
      windowStart: new Date(Date.now() - 3600_000), maxRequests: 1_000_000 })
    return { requestId, who, status: 'reserved', calls: [], reservation: null, nextOrdinal: 0 }
  }
  const delivery = u => ({ tenantId: u.who.tenant.id, consumerId: u.who.consumer.id, apiKeyId: u.who.key.id,
    usageRequestId: u.requestId, fingerprint: FP })
  const cost = (costMinor, budget = BIG, subsidy = BIG) => ({ costMinor, costKind: 'estimated', currency: 'CNY',
    monthlyBudgetMinor: budget, monthlySubsidyBudgetMinor: subsidy })
  const begin = (u, costControl, reservationId = null, target = store) => target.beginProviderCall({
    ...delivery(u), operation: 'ecommerce.products.search', contractVersion: 'ledger-test.v1',
    endpointKey: 'ledger-test', endpointVersion: 'v1', marketplace: 'jd', callOrdinal: u.nextOrdinal++,
    costControl, costReservationId: reservationId })
  // Raw settlement so evidence of every historical shape can be produced; the
  // application path enforces the same "only while pending" rule.
  const settle = (callId, { outcome = 'succeeded', costMinor, costKind = 'estimated', currency = 'CNY' }) => pool.query(
    `UPDATE external_platform.provider_calls
        SET outcome = $2, cost_minor = $3, cost_kind = $4, currency = $5, completed_at = now()
      WHERE id = $1 AND outcome = 'pending'`, [callId, outcome, costMinor, costKind, currency])
  const commitUsage = u => usage.commitRequest(u.requestId, { responseStatus: 200,
    responseBody: { data: { items: [] } }, unitsActual: 1 })

  async function compare(probes) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      for (const probe of probes) {
        const values = [providerKey, probe.currency, probe.usageRequestId, probe.reservationId ?? null]
        const expected = (await client.query(ORACLE_SQL, values)).rows[0]
        const actual = await providerCostExposure(client, { providerKey, currency: probe.currency,
          usageRequestId: probe.usageRequestId, reservationId: probe.reservationId ?? null })
        assert.deepEqual(actual, expected, `exposure diverged for ${JSON.stringify(probe)}`)
      }
      await client.query('COMMIT')
    } finally { client.release() }
  }
  const ledger = async () => (await pool.query(
    `SELECT (SELECT count(*) FROM external_platform.provider_cost_open_usages WHERE provider_key = $1)::integer AS open,
            (SELECT coalesce(sum(folded_usages), 0) FROM external_platform.provider_cost_month_totals WHERE provider_key = $1)::integer AS folded`,
    [providerKey])).rows[0]
  return { pool, usage, service, store, providerKey, caller, reserveUsage, delivery, cost, begin, settle,
    commitUsage, compare, ledger }
}

async function foldAll(store) {
  for (;;) {
    const { foldedUsages } = await store.foldProviderCostLedger({ limit: 1000 })
    if (!foldedUsages) return
  }
}

test('ledger admission read equals the full-month aggregate through billing, evidence, folds and resets', native, async t => {
  const f = await fixture(t)
  const next = random(Number(process.env.MX_INSIGHT_LEDGER_SEED || 163))
  const pick = list => list[Math.floor(next() * list.length)]
  const enforced = await f.caller('enforced')
  const plain = await f.caller('plain')
  const usages = []
  const outcomes = new Map()
  const note = (name, result) => outcomes.set(`${name}:${result}`, (outcomes.get(`${name}:${result}`) || 0) + 1)
  const reserved = () => usages.filter(u => u.status === 'reserved')
  const pendingCalls = () => usages.flatMap(u => u.calls.filter(call => call.pending).map(call => ({ u, call })))
  const STEPS = 320
  let lateSettles = 0

  for (let step = 0; step < STEPS; step += 1) {
    const late = step > STEPS * 0.6
    const roll = next()
    try {
      if (roll < 0.14 || reserved().length < 3) {
        usages.push(await f.reserveUsage(next() < 0.5 ? enforced : plain))
        note('usage', 'reserved')
      } else if (roll < 0.28) {
        const u = pick(reserved().filter(item => !item.reservation?.active))
        if (u) {
          const reservation = await f.store.reserveProviderCostWorkflow({ ...f.delivery(u),
            costControls: [f.cost(50 + Math.floor(next() * 150))] })
          u.reservation = { id: reservation.id, remaining: reservation.reservedCostMinor, active: true }
          note('reserve', 'admitted')
        }
      } else if (roll < 0.46) {
        const u = pick(reserved())
        if (u) {
          const useReservation = u.reservation?.active && next() < 0.8
          const amount = useReservation ? Math.max(1, Math.floor(u.reservation.remaining * (0.5 + next() / 2)))
            : 40 + Math.floor(next() * 120)
          const call = await f.begin(u, f.cost(amount), useReservation ? u.reservation.id : null)
          if (useReservation) u.reservation.remaining -= amount
          u.calls.push({ id: call.id, cost: amount, pending: true })
          note('begin', useReservation ? 'reserved' : 'standalone')
        }
      } else if (roll < 0.66) {
        const target = pick(pendingCalls())
        if (target) {
          const { call } = target
          const shapes = {
            exact: { costMinor: call.cost },
            reported: { costMinor: call.cost + 30, costKind: 'provider_reported' },
            unknownCost: { outcome: 'unknown', costMinor: null, costKind: 'unknown', currency: null },
            otherCurrency: { costMinor: call.cost, currency: 'USD' },
            missingCost: { costMinor: null },
            zeroCost: { costMinor: 0 },
            missingCurrency: { costMinor: call.cost, currency: null },
            invalidCurrency: { costMinor: call.cost, currency: 'cny' },
            rejected: { outcome: 'rejected', costMinor: call.cost },
          }
          const names = Object.keys(shapes)
          // Anomalies disable non-billed admission, so they arrive late, each
          // shape in turn so every seed covers all of them.
          const name = !late ? (next() < 0.8 ? 'exact' : pick(['reported', 'unknownCost', 'otherCurrency', 'rejected']))
            : names[lateSettles++ % names.length]
          await f.settle(call.id, shapes[name])
          call.pending = false
          note('settle', name)
        }
      } else if (roll < 0.8) {
        const u = pick(reserved())
        if (u) {
          const end = next()
          if (end < 0.55) { await f.commitUsage(u); u.status = 'committed' }
          else if (end < 0.8) { await f.usage.releaseRequest(u.requestId, 'ledger_test_release'); u.status = 'released' }
          else { await f.usage.markRequestUnknown(u.requestId, 'ledger_test_unknown'); u.status = 'unknown' }
          if (u.reservation?.active && next() < 0.5) {
            await f.store.releaseProviderCostWorkflow({ reservationId: u.reservation.id, usageRequestId: u.requestId })
            u.reservation.active = false
          }
          note('finish', u.status)
        }
      } else if (roll < 0.84) {
        const u = pick(usages.filter(item => item.status === 'unknown' && item.who.mode === 'enforced' && !item.reconciled))
        if (u) {
          await f.service.reconcileUnknownCustomerCharge(u.requestId,
            { disposition: next() < 0.5 ? 'capture' : 'release', reason: 'ledger test reconciliation' },
            { idempotencyKey: randomUUID(), actor: 'ledger-test' })
          u.reconciled = true
          note('reconcile', 'done')
        }
      } else if (roll < 0.88) {
        const u = pick(usages.filter(item => item.reservation?.active))
        if (u) {
          await f.store.releaseProviderCostWorkflow({ reservationId: u.reservation.id, usageRequestId: u.requestId })
          u.reservation.active = false
          note('release', 'done')
        }
      } else if (roll < 0.985) {
        const { foldedUsages } = await f.store.foldProviderCostLedger({ limit: 1 + Math.floor(next() * 12) })
        note('fold', foldedUsages > 0 ? 'moved' : 'none')
      } else {
        await f.store.resetProviderCostLedger()
        note('reset', 'done')
      }
    } catch (error) {
      // Admission refusals are part of the model; both reads must still agree.
      if (!['external_platform_cost_evidence_incomplete', 'external_platform_cost_reservation_mismatch']
        .includes(error?.code)) throw error
      note('refused', error.code)
    }

    const known = usages.length ? usages : [{ requestId: randomUUID() }]
    const probes = []
    for (const currency of ['CNY', 'USD']) {
      const live = pick(reserved()) || pick(known)
      probes.push({ currency, usageRequestId: live.requestId, reservationId: live.reservation?.id ?? null })
      probes.push({ currency, usageRequestId: pick(known).requestId,
        reservationId: pick(known.filter(u => u.reservation))?.reservation.id ?? null })
      probes.push({ currency, usageRequestId: randomUUID() })
    }
    await f.compare(probes)
  }

  // Make sure every kind of request finishes and folds, then compare again.
  for (const { call } of pendingCalls()) await f.settle(call.id, { costMinor: call.cost })
  for (const u of reserved()) { await f.commitUsage(u); u.status = 'committed' }
  await foldAll(f.store)
  await f.compare(usages.slice(0, 20).flatMap(u => ['CNY', 'USD'].map(currency => ({ currency, usageRequestId: u.requestId,
    reservationId: u.reservation?.id ?? null }))))
  for (const currency of ['CNY', 'USD']) {
    const [expected] = (await f.pool.query(DESCRIBE_ORACLE_SQL, [f.providerKey, currency])).rows
    const projected = await f.store.describeCostBudget({ currency, monthlyBudgetMinor: BIG })
    assert.equal(projected.spentMinor, Number(expected.known_cost_minor) + Number(expected.reserved_cost_minor))
  }
  const { open, folded } = await f.ledger()
  if (process.env.MX_INSIGHT_LEDGER_DEBUG) console.log({ open, folded, usages: usages.length, outcomes: [...outcomes] })
  assert.ok(folded >= 15 && outcomes.get('fold:moved') >= 5, `the model folded requests (${folded})`)
  assert.ok(open > 0, 'requests with anomalous evidence or unresolved charges stay open')
  for (const required of ['fold:moved', 'reset:done', 'finish:committed', 'finish:released', 'finish:unknown',
    'begin:reserved', 'begin:standalone', 'reconcile:done', 'release:done', 'settle:reported', 'settle:unknownCost',
    'settle:otherCurrency', 'settle:missingCost', 'settle:zeroCost', 'settle:missingCurrency', 'settle:invalidCurrency',
    'refused:external_platform_cost_evidence_incomplete']) {
    assert.ok(outcomes.get(required) > 0, `scenario exercised ${required}: ${JSON.stringify([...outcomes])}`)
  }
})

test('a request becomes foldable only when nothing can change its contribution', native, async t => {
  const f = await fixture(t)
  const enforced = await f.caller('enforced')
  const plain = await f.caller('plain')
  const isOpen = async u => (await f.pool.query(
    `SELECT 1 FROM external_platform.provider_cost_open_usages WHERE provider_key = $1 AND usage_request_id = $2`,
    [f.providerKey, u.requestId])).rowCount === 1
  async function withCall(who, evidence = {}) {
    const u = await f.reserveUsage(who)
    const call = await f.begin(u, f.cost(100))
    return { u, call, settle: () => f.settle(call.id, { costMinor: 100, ...evidence }) }
  }

  const pending = await withCall(plain)
  await f.usage.markRequestUnknown(pending.u.requestId, 'ledger_test_unknown')
  const reservedUsage = await withCall(plain)
  await reservedUsage.settle()
  const unknownCharge = await withCall(enforced)
  await unknownCharge.settle()
  await f.usage.markRequestUnknown(unknownCharge.u.requestId, 'ledger_test_unknown')
  const anomaly = await withCall(plain, { costMinor: 0 })
  await anomaly.settle()
  await f.commitUsage(anomaly.u)
  const captured = await withCall(enforced)
  await captured.settle()
  await f.commitUsage(captured.u)
  const released = await withCall(enforced)
  await released.settle()
  await f.usage.releaseRequest(released.u.requestId, 'ledger_test_release')

  await foldAll(f.store)
  assert.equal(await isOpen(pending.u), true, 'a pending call can still be settled')
  assert.equal(await isOpen(reservedUsage.u), true, 'a reserved request can still dispatch')
  assert.equal(await isOpen(unknownCharge.u), true, 'an unknown enforced charge can still be released')
  assert.equal(await isOpen(anomaly.u), true, 'anomalous evidence is counted live')
  assert.equal(await isOpen(captured.u), false)
  assert.equal(await isOpen(released.u), false)
  const totals = (await f.pool.query(
    `SELECT known_cost_minor, subsidy_cost_minor, folded_usages FROM external_platform.provider_cost_month_totals
      WHERE provider_key = $1 AND currency = 'CNY'`, [f.providerKey])).rows[0]
  // Captured: cost 100 covered by the 150 quote. Released: coverage dropped to 0.
  assert.deepEqual(totals, { known_cost_minor: '200', subsidy_cost_minor: '100', folded_usages: '2' })

  // The facts the fold relies on are enforced, not assumed.
  await assert.rejects(f.pool.query('UPDATE external_platform.provider_calls SET cost_minor = 1 WHERE id = $1',
    [captured.call.id]), { code: '55000' })
  await assert.rejects(f.pool.query("UPDATE external_platform.provider_calls SET outcome = 'pending', completed_at = NULL WHERE id = $1",
    [captured.call.id]), { code: '55000' })
  await assert.rejects(f.pool.query('DELETE FROM external_platform.provider_calls WHERE id = $1',
    [captured.call.id]), { code: '55000' })
  await f.pool.query('UPDATE external_platform.provider_calls SET cost_minor = 7 WHERE id = $1', [pending.call.id])

  await f.settle(pending.call.id, { costMinor: 7 })
  await f.service.reconcileUnknownCustomerCharge(unknownCharge.u.requestId, { disposition: 'release', reason: 'ledger test' },
    { idempotencyKey: randomUUID(), actor: 'ledger-test' })
  await foldAll(f.store)
  assert.equal(await isOpen(pending.u), false)
  assert.equal(await isOpen(unknownCharge.u), false)
  await f.compare([pending, reservedUsage, unknownCharge, anomaly, captured, released]
    .map(({ u }) => ({ currency: 'CNY', usageRequestId: u.requestId })))
})

test('concurrent admissions with folds and settlements running admit exactly the remaining budget', native, async t => {
  const f = await fixture(t, { max: 60 })
  const plain = await f.caller('plain')
  const history = []
  for (let index = 0; index < 20; index += 1) {
    const u = await f.reserveUsage(plain)
    const reservation = await f.store.reserveProviderCostWorkflow({ ...f.delivery(u), costControls: [f.cost(100)] })
    const call = await f.begin(u, f.cost(100), reservation.id)
    history.push({ u, call })
  }
  // Half of history is folded, half still settling while admissions race.
  for (const { u, call } of history.slice(0, 10)) { await f.settle(call.id, { costMinor: 100 }); await f.commitUsage(u) }
  await foldAll(f.store)
  const budget = 20 * 100 + 12 * 100
  const contenders = []
  for (let index = 0; index < 40; index += 1) contenders.push(await f.reserveUsage(plain))

  let stop = false
  const folding = (async () => { while (!stop) await f.store.foldProviderCostLedger({ limit: 3 }) })()
  const settling = (async () => {
    for (const { u, call } of history.slice(10)) { await f.settle(call.id, { costMinor: 100 }); await f.commitUsage(u) }
  })()
  const results = await Promise.allSettled(contenders.map(async u => {
    const reservation = await f.store.reserveProviderCostWorkflow({ ...f.delivery(u), costControls: [f.cost(100, budget)] })
    await f.begin(u, f.cost(100, budget), reservation.id)
  }))
  await settling
  stop = true
  await folding
  await foldAll(f.store)

  const admitted = results.filter(result => result.status === 'fulfilled').length
  const refused = results.filter(result => result.status === 'rejected')
  assert.equal(admitted, 12, 'exactly the remaining headroom is admitted')
  assert.ok(refused.every(result => result.reason?.code === 'external_platform_cost_budget_exhausted'),
    JSON.stringify(refused.map(result => result.reason?.code)))
  const spent = (await f.pool.query(
    'SELECT sum(cost_minor)::bigint AS spent FROM external_platform.provider_calls WHERE provider_key = $1',
    [f.providerKey])).rows[0].spent
  assert.equal(Number(spent), budget)
  await f.compare([{ currency: 'CNY', usageRequestId: contenders[0].requestId }])
})

test('two calls of one request cannot both spend one reservation without the provider lock', native, async t => {
  const f = await fixture(t)
  const plain = await f.caller('plain')
  for (let round = 0; round < 5; round += 1) {
    const u = await f.reserveUsage(plain)
    const reservation = await f.store.reserveProviderCostWorkflow({ ...f.delivery(u), costControls: [f.cost(100)] })
    const results = await Promise.allSettled([f.begin(u, f.cost(100), reservation.id), f.begin(u, f.cost(100), reservation.id)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'external_platform_cost_reservation_mismatch')
  }
})

test('only admission waits for the provider cost lock; a reserved call and folds do not', native, async t => {
  const f = await fixture(t)
  const plain = await f.caller('plain')
  const u = await f.reserveUsage(plain)
  const reservation = await f.store.reserveProviderCostWorkflow({ ...f.delivery(u), costControls: [f.cost(100)] })
  const standalone = await f.reserveUsage(plain)
  const lockTimeoutPool = new pg.Pool({ connectionString, max: 4, lock_timeout: 1000, statement_timeout: 5000 })
  t.after(() => lockTimeoutPool.end())
  const impatient = new PostgresExternalPlatformStore({ pool: lockTimeoutPool, providerKey: f.providerKey })
  const holder = await f.pool.connect()
  await holder.query('BEGIN')
  await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`external-platform-cost:${f.providerKey}`])
  try {
    const started = Date.now()
    await f.begin(u, f.cost(100), reservation.id, impatient)
    await impatient.foldProviderCostLedger()
    assert.ok(Date.now() - started < 900, 'neither waited for the held provider lock')
    await assert.rejects(f.begin(standalone, f.cost(100), null, impatient), { code: '55P03' })
    await assert.rejects(impatient.reserveProviderCostWorkflow({ ...f.delivery(standalone), costControls: [f.cost(100)] }))
  } finally {
    await holder.query('ROLLBACK')
    holder.release()
  }
})

test("a slow WAL flush no longer serializes one provider's dispatches", native, async t => {
  const f = await fixture(t)
  const plain = await f.caller('plain')
  // commit_delay makes every flushing COMMIT wait 100 ms before its fsync,
  // like the stalled device; it does not apply to asynchronous commits.
  const slow = new pg.Pool({ connectionString, max: 30, options: '-c commit_delay=100000 -c commit_siblings=0' })
  t.after(() => slow.end())
  try { await slow.query('SELECT 1') } catch (error) {
    t.skip(`commit_delay needs a superuser test role: ${error.message}`)
    return
  }
  const store = new PostgresExternalPlatformStore({ pool: slow, providerKey: f.providerKey })
  const usages = await Promise.all(Array.from({ length: 10 }, () => f.reserveUsage(plain)))
  const started = Date.now()
  await Promise.all(usages.map(async u => {
    const reservation = await store.reserveProviderCostWorkflow({ ...f.delivery(u), costControls: [f.cost(100)] })
    await f.begin(u, f.cost(100), reservation.id, store)
  }))
  const elapsed = Date.now() - started
  // Holding the provider lock through both flushes would take >= 10 x 2 x 100 ms.
  assert.ok(elapsed < 1000, `10 dispatches took ${elapsed} ms`)
  assert.equal(Number((await f.pool.query('SELECT count(*) FROM external_platform.provider_calls WHERE provider_key = $1',
    [f.providerKey])).rows[0].count), 10)
})

test('rolled back calls and folds leave the ledger untouched', native, async t => {
  const f = await fixture(t)
  const plain = await f.caller('plain')
  const u = await f.reserveUsage(plain)
  const call = await f.begin(u, f.cost(100))
  await f.settle(call.id, { costMinor: 100 })
  await f.commitUsage(u)
  const other = await f.reserveUsage(plain)
  const before = await f.ledger()
  assert.deepEqual(before, { open: 1, folded: 0 })
  const client = await f.pool.connect()
  try {
    // A call INSERT that rolls back takes its open row with it.
    await client.query('BEGIN')
    await client.query(`INSERT INTO external_platform.provider_calls (id, provider_key, tenant_id, consumer_id, api_key_id,
        usage_request_id, operation, contract_version, endpoint_key, endpoint_version, marketplace, request_fingerprint,
        cost_minor, cost_kind, currency)
      VALUES ($1, $2, $3, $4, $5, $6, 'ecommerce.products.search', 'v1', 'ledger-test', 'v1', 'jd', $7, 100, 'estimated', 'CNY')`,
    [randomUUID(), f.providerKey, plain.tenant.id, plain.consumer.id, plain.key.id, other.requestId, FP])
    assert.equal((await client.query(
      'SELECT count(*)::integer AS open FROM external_platform.provider_cost_open_usages WHERE provider_key = $1',
      [f.providerKey])).rows[0].open, 2)
    await client.query('ROLLBACK')
    // A fold whose transaction ends in ROLLBACK instead of COMMIT.
    const rollingBack = { connect: async () => ({
      query: (sql, values) => client.query(sql === 'COMMIT' ? 'ROLLBACK' : sql, values), release() {},
    }) }
    const aborted = await new PostgresExternalPlatformStore({ pool: rollingBack, providerKey: f.providerKey })
      .foldProviderCostLedger()
    assert.equal(aborted.foldedUsages, 1, 'the fold ran inside the aborted transaction')
  } finally { client.release() }
  assert.deepEqual(await f.ledger(), before)
  await foldAll(f.store)
  assert.deepEqual(await f.ledger(), { open: 0, folded: 1 })
  await f.compare([{ currency: 'CNY', usageRequestId: u.requestId }, { currency: 'CNY', usageRequestId: other.requestId }])
})

// Needs control of a disposable server; never run it alongside other tests.
const crashControl = process.env.MX_INSIGHT_TEST_PG_CRASH === '1' && process.env.MX_INSIGHT_TEST_PG_CTL
  && process.env.MX_INSIGHT_TEST_PGDATA
test('an immediate server crash keeps every acknowledged call with its reservation and an exact ledger', {
  skip: connectionString && crashControl ? false : 'Set MX_INSIGHT_TEST_PG_CRASH=1, MX_INSIGHT_TEST_PG_CTL and MX_INSIGHT_TEST_PGDATA',
}, async t => {
  const pgCtl = process.env.MX_INSIGHT_TEST_PG_CTL
  const dataDir = process.env.MX_INSIGHT_TEST_PGDATA
  const run = promisify(execFile)
  const setup = await fixture(t, { survivesCrash: true })
  const prepared = []
  for (let group = 0; group < 16; group += 1) {
    const plain = await setup.caller('plain')
    for (let index = 0; index < 25; index += 1) prepared.push(await setup.reserveUsage(plain))
  }
  const acknowledged = []
  let crashed = false
  const workers = Array.from({ length: 12 }, async (_, worker) => {
    for (let index = worker; index < prepared.length && !crashed; index += 12) {
      const u = prepared[index]
      try {
        const reservation = await setup.store.reserveProviderCostWorkflow({ ...setup.delivery(u), costControls: [setup.cost(100)] })
        const call = await setup.begin(u, setup.cost(100), reservation.id)
        acknowledged.push({ callId: call.id, reservationId: reservation.id, requestId: u.requestId })
        await setup.settle(call.id, { costMinor: 100 })
        await setup.commitUsage(u)
      } catch { if (crashed) return }
    }
  })
  const folding = (async () => { while (!crashed) await setup.store.foldProviderCostLedger({ limit: 5 }).catch(() => {}) })()
  // Crash mid-burst: reservations, calls, settlements and folds in flight.
  const deadline = Date.now() + 30_000
  while (acknowledged.length < prepared.length / 3 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  crashed = true
  await run(pgCtl, ['stop', '-D', dataDir, '-m', 'immediate'])
  await Promise.allSettled([...workers, folding])
  await run(pgCtl, ['start', '-D', dataDir, '-w', '-l', `${dataDir}/crash-test.log`])

  const pool = new pg.Pool({ connectionString, max: 4 })
  t.after(() => pool.end())
  assert.ok(acknowledged.length > 10 && acknowledged.length < prepared.length,
    `the crash interrupted the burst: ${acknowledged.length}/${prepared.length}`)
  const durable = await pool.query(
    `SELECT call.id, reservation.id AS reservation_id
       FROM unnest($1::uuid[], $2::uuid[]) AS ack(call_id, reservation_id)
       LEFT JOIN external_platform.provider_calls call ON call.id = ack.call_id
       LEFT JOIN external_platform.provider_cost_reservations reservation ON reservation.id = ack.reservation_id`,
    [acknowledged.map(row => row.callId), acknowledged.map(row => row.reservationId)])
  assert.ok(durable.rows.every(row => row.id && row.reservation_id),
    'every acknowledged call and the asynchronously committed reservation it consumed survived')
  const counts = (await pool.query(
    `SELECT (SELECT count(*) FROM external_platform.provider_calls WHERE provider_key = $1)::integer AS calls,
            (SELECT count(*) FROM external_platform.provider_cost_reservations WHERE provider_key = $1)::integer AS reservations`,
    [setup.providerKey])).rows[0]
  t.diagnostic(`acknowledged ${acknowledged.length}; durable calls ${counts.calls}, reservations ${counts.reservations}`)
  const store = new PostgresExternalPlatformStore({ pool, providerKey: setup.providerKey })
  await foldAll(store)
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    for (const usageRequestId of [acknowledged[0].requestId, prepared.at(-1).requestId, randomUUID()]) {
      const values = [setup.providerKey, 'CNY', usageRequestId, null]
      assert.deepEqual(await providerCostExposure(client, { providerKey: setup.providerKey, currency: 'CNY', usageRequestId }),
        (await client.query(ORACLE_SQL, values)).rows[0])
    }
    await client.query('COMMIT')
  } finally { client.release() }
})
