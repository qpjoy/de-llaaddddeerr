// Incremental usage statistics (migration 182).
//
// Triggers append signed delta rows for every counted change of
// usage_requests / billing.customer_charges in the changing transaction. This
// module owns the other half:
// - buildUsageRollup: one REPEATABLE READ transaction computes the hourly
//   baseline from history and deletes exactly the deltas its snapshot already
//   contains, so no change is counted twice or lost.
// - compactUsageRollup: folds committed deltas into hourly totals.
// - usageRollupQueries: SQL for PostgresStore.usage() that reads totals +
//   pending deltas + raw rows of partial edge hours, returning the same rows as
//   the historical full-history queries.
// Builder and compactor share one advisory lock; readers take no locks.

export const USAGE_ROLLUP_VERSION = 1
const LOCK = [129761, 182]
const HOUR = 3_600_000
const RECENT_LIMIT = 50

const USAGE_DIMS = 'bucket, tenant_id, consumer_id, api_key_id, platform, capability, meter_key, status'
const CHARGE_DIMS = 'bucket, tenant_id, consumer_id, api_key_id, meter_key, currency, enforcement_mode, status, quoted_positive'

export async function readUsageRollupState(queryable) {
  const { rows } = await queryable.query('SELECT status, definition_version, built_at, compacted_at FROM reporting.usage_rollup_state')
  return rows[0] || null
}

const isReady = state => state?.status === 'ready' && state.definition_version === USAGE_ROLLUP_VERSION

async function withLock(pool, work) {
  const client = await pool.connect()
  let locked = false
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', LOCK)).rows[0].acquired === true
    if (!locked) return { skipped: 'busy' }
    return await work(client)
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1, $2)', LOCK).catch(() => {})
    client.release()
  }
}

// The lock is taken before BEGIN, so the snapshot (first statement) already
// sees every compaction committed before it. Deltas visible to that snapshot
// are inside the baseline and are deleted with it; later commits remain.
export function buildUsageRollup(pool, { statementTimeoutMs = 30 * 60_000, onClient = null } = {}) {
  return withLock(pool, async client => {
    onClient?.(client)
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${statementTimeoutMs}ms`])
      await client.query("SET LOCAL lock_timeout = '5s'")
      // History scans must not take the shared database's parallel workers.
      await client.query('SET LOCAL max_parallel_workers_per_gather = 0')
      await client.query('DELETE FROM reporting.usage_request_totals')
      await client.query('DELETE FROM reporting.customer_charge_totals')
      const requests = await client.query(`INSERT INTO reporting.usage_request_totals (${USAGE_DIMS}, requests, units, latency_sum, latency_count)
        SELECT date_trunc('hour', request.created_at, 'UTC'), request.tenant_id, request.consumer_id, request.api_key_id,
               request.platform, request.capability, coalesce(request.billing_meter_key, request.capability, request.platform), request.status,
               count(*), coalesce(sum(request.units_actual), 0), coalesce(sum(request.upstream_latency_ms), 0), count(request.upstream_latency_ms)
          FROM public.usage_requests request
         GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`)
      const charges = await client.query(`INSERT INTO reporting.customer_charge_totals (${CHARGE_DIMS}, charges, quoted_minor, charged_minor)
        SELECT date_trunc('hour', request.created_at, 'UTC'), request.tenant_id, request.consumer_id, request.api_key_id,
               charge.meter_key, charge.currency, charge.enforcement_mode, charge.status, charge.quoted_minor > 0,
               count(*), sum(charge.quoted_minor), sum(charge.charged_minor)
          FROM billing.customer_charges charge
          JOIN public.usage_requests request ON request.id = charge.usage_request_id
         GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`)
      await client.query('DELETE FROM reporting.usage_request_deltas')
      await client.query('DELETE FROM reporting.customer_charge_deltas')
      // Freshly filled totals have no planner statistics until autovacuum runs;
      // without them owner/time reads may choose full scans.
      await client.query('ANALYZE reporting.usage_request_totals')
      await client.query('ANALYZE reporting.customer_charge_totals')
      await client.query(`UPDATE reporting.usage_rollup_state
        SET status = 'ready', definition_version = $1, built_at = now(), compacted_at = now(), updated_at = now()`, [USAGE_ROLLUP_VERSION])
      await client.query('COMMIT')
      return { built: true, requestGroups: requests.rowCount, chargeGroups: charges.rowCount }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { onClient?.(null) }
  })
}

// One statement per table moves a batch of deltas into totals (atomic for
// readers) and reports, from the rows it just merged, which keys netted to
// zero and whether any went negative. Cost depends on the batch, not on the
// size of totals, even when a months-old request changes state.
const compactSql = ({ table, dims, metrics, zero, negative, keyJson }) => `WITH moved AS (
    DELETE FROM reporting.${table}_deltas
     WHERE ctid = ANY (ARRAY(SELECT ctid FROM reporting.${table}_deltas LIMIT $1))
    RETURNING *
  ), merged AS (
    INSERT INTO reporting.${table}_totals AS total (${dims}, ${metrics.join(', ')})
    SELECT ${dims}, ${metrics.map(metric => `sum(${metric})`).join(', ')}
      FROM moved GROUP BY ${dims}
    ON CONFLICT (${dims}) DO UPDATE SET ${metrics.map(metric => `${metric} = total.${metric} + EXCLUDED.${metric}`).join(', ')}
    RETURNING *
  )
  SELECT (SELECT count(*) FROM moved)::integer AS moved,
         count(*) FILTER (WHERE ${negative})::integer AS negative,
         coalesce(jsonb_agg(jsonb_build_object(${keyJson})) FILTER (WHERE ${zero}), '[]'::jsonb) AS zero_keys
    FROM merged`

const USAGE_ZERO = 'requests = 0 AND units = 0 AND latency_sum = 0 AND latency_count = 0'
const CHARGE_ZERO = 'charges = 0 AND quoted_minor = 0 AND charged_minor = 0'
const jsonKeys = dims => dims.split(', ').map(column => `'${column}', ${column}`).join(', ')
const COMPACTION = [
  {
    merge: compactSql({ table: 'usage_request', dims: USAGE_DIMS, metrics: ['requests', 'units', 'latency_sum', 'latency_count'],
      zero: USAGE_ZERO, negative: 'requests < 0 OR latency_count < 0', keyJson: jsonKeys(USAGE_DIMS) }),
    // platform / capability / meter_key may be NULL (migration 018).
    prune: `DELETE FROM reporting.usage_request_totals total
      USING jsonb_to_recordset($1::jsonb) AS zero(bucket timestamptz, tenant_id uuid, consumer_id uuid, api_key_id uuid,
        platform text, capability text, meter_key text, status text)
      WHERE total.bucket = zero.bucket AND total.tenant_id = zero.tenant_id AND total.consumer_id = zero.consumer_id
        AND total.api_key_id = zero.api_key_id AND total.status = zero.status
        AND total.platform IS NOT DISTINCT FROM zero.platform AND total.capability IS NOT DISTINCT FROM zero.capability
        AND total.meter_key IS NOT DISTINCT FROM zero.meter_key AND ${USAGE_ZERO.replace(/(\w+) = 0/gu, 'total.$1 = 0')}`,
    label: 'usage_request_totals',
  },
  {
    merge: compactSql({ table: 'customer_charge', dims: CHARGE_DIMS, metrics: ['charges', 'quoted_minor', 'charged_minor'],
      zero: CHARGE_ZERO, negative: 'charges < 0', keyJson: jsonKeys(CHARGE_DIMS) }),
    prune: `DELETE FROM reporting.customer_charge_totals total
      USING jsonb_to_recordset($1::jsonb) AS zero(bucket timestamptz, tenant_id uuid, consumer_id uuid, api_key_id uuid,
        meter_key text, currency text, enforcement_mode text, status text, quoted_positive boolean)
      WHERE (total.bucket, total.tenant_id, total.consumer_id, total.api_key_id, total.meter_key, total.currency,
             total.enforcement_mode, total.status, total.quoted_positive)
          = (zero.bucket, zero.tenant_id, zero.consumer_id, zero.api_key_id, zero.meter_key, zero.currency,
             zero.enforcement_mode, zero.status, zero.quoted_positive)
        AND ${CHARGE_ZERO.replace(/(\w+) = 0/gu, 'total.$1 = 0')}`,
    label: 'customer_charge_totals',
  },
]

// A negative total can only mean a missed or foreign write: fall back to the
// exact history queries and rebuild instead of serving it.
export function compactUsageRollup(pool, { batchSize = 50_000, maxBatches = 20 } = {}) {
  return withLock(pool, async client => {
    if (!isReady(await readUsageRollupState(client))) return { skipped: 'not_ready' }
    let moved = 0
    for (let batch = 0; batch < maxBatches; batch += 1) {
      let batchMoved = 0
      try {
        await client.query('BEGIN')
        await client.query("SET LOCAL statement_timeout = '60s'")
        await client.query("SET LOCAL lock_timeout = '5s'")
        for (const step of COMPACTION) {
          const { rows: [result] } = await client.query(step.merge, [batchSize])
          batchMoved = Math.max(batchMoved, result.moved)
          if (result.negative > 0) {
            await client.query(`UPDATE reporting.usage_rollup_state SET status = 'pending', updated_at = now()`)
            await client.query('COMMIT')
            return { moved: moved + batchMoved, invalidated: step.label }
          }
          if (result.zero_keys.length) await client.query(step.prune, [JSON.stringify(result.zero_keys)])
        }
        if (batchMoved) await client.query('UPDATE reporting.usage_rollup_state SET compacted_at = now(), updated_at = now()')
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
      moved += batchMoved
      if (batchMoved < batchSize) break
    }
    return { moved }
  })
}

// Admin-only background maintenance: build when missing/outdated, then keep
// the delta tables small. Readers are exact without it (they include pending
// deltas); it only bounds their size. A failed build waits before retrying.
export class UsageRollupMaintainer {
  constructor(pool, { logger = console, intervalMs = 30_000, buildRetryMs = 30 * 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { pool, logger, intervalMs, buildRetryMs, now })
    this.timer = null
    this.running = null
    this.nextBuildAt = 0
    this.buildClient = null
  }

  async runOnce() {
    const state = await readUsageRollupState(this.pool)
    if (!state) return { skipped: 'missing' }
    if (!isReady(state)) {
      if (this.now() < this.nextBuildAt) return { skipped: 'retry_wait' }
      const startedAt = this.now()
      this.logger.info?.('[usage-rollup] building hourly usage statistics from history')
      try {
        const built = await buildUsageRollup(this.pool, { onClient: client => { this.buildClient = client } })
        if (built.built) this.logger.info?.(`[usage-rollup] built ${built.requestGroups} request and ${built.chargeGroups} charge groups in ${Math.round((this.now() - startedAt) / 1000)}s`)
        return built
      } catch (error) {
        this.nextBuildAt = this.now() + this.buildRetryMs
        this.logger.warn?.(`[usage-rollup] build failed (${error.code || error.name}); usage statistics keep the history queries and retry later`)
        return { failed: true }
      }
    }
    const compacted = await compactUsageRollup(this.pool)
    if (compacted.invalidated) this.logger.warn?.(`[usage-rollup] ${compacted.invalidated} became inconsistent; rebuilding from history`)
    return compacted
  }

  tick() {
    if (this.running) return this.running
    this.running = this.runOnce().catch(error => {
      this.logger.warn?.(`[usage-rollup] maintenance failed (${error.code || error.name}); statistics remain exact`)
    }).finally(() => { this.running = null })
    return this.running
  }

  start() {
    if (!this.pool || this.timer) return
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref?.()
  }

  // A long baseline build is cancelled server-side so shutdown is not held up;
  // its transaction rolls back and the next Admin process rebuilds.
  async close() {
    clearInterval(this.timer)
    this.timer = null
    const pid = this.buildClient?.processID
    if (pid) await this.pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => {})
    await this.running
  }
}

// ---- read side ---------------------------------------------------------

// Same truthiness as the history queries' `if (filters.from)`.
const ms = value => value ? new Date(value).getTime() : null
const hasOwnerFilter = filters => Boolean(filters.tenantId || filters.consumerId || filters.apiKeyId)

// The plan for one usage() transaction, or null while the totals are not built
// for this definition (callers then use the history queries).
export async function usageRollupPlan(client, filters) {
  return isReady(await readUsageRollupState(client)) ? usageRollupQueries(filters) : null
}

// Whole UTC hours inside [from, to) come from totals/deltas; the partial hours
// at either end come from raw rows, with the caller's exact from/to bounds.
export function usageRollupWindow({ from, to } = {}) {
  const fromMs = ms(from), toMs = ms(to)
  const low = fromMs == null ? null : Math.ceil(fromMs / HOUR) * HOUR
  const high = toMs == null ? null : Math.floor(toMs / HOUR) * HOUR
  if (low != null && high != null && low >= high) {
    return { hours: null, edges: fromMs < toMs ? [[from, to]] : [] }
  }
  const edges = []
  if (fromMs != null && low > fromMs) edges.push([from, new Date(low)])
  if (toMs != null && high < toMs) edges.push([new Date(high), to])
  return { hours: { low: low == null ? null : new Date(low), high: high == null ? null : new Date(high) }, edges }
}

function builder() {
  const values = []
  return { values, add: value => { values.push(value); return `$${values.length}` } }
}
const ownerClauses = (filters, alias, add) => [['tenant_id', filters.tenantId], ['consumer_id', filters.consumerId], ['api_key_id', filters.apiKeyId]]
  .filter(([, value]) => value).map(([column, value]) => `${alias}.${column} = ${add(value)}`)
const where = clauses => clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

// totals ∪ pending deltas over whole hours, ∪ raw rows over partial hours.
function parts(filters, window, { table, columns, live }) {
  const q = builder(), selects = []
  if (window.hours) for (const source of [`${table}_totals`, `${table}_deltas`]) {
    const clauses = ownerClauses(filters, 'part', q.add)
    if (window.hours.low) clauses.push(`part.bucket >= ${q.add(window.hours.low)}`)
    if (window.hours.high) clauses.push(`part.bucket < ${q.add(window.hours.high)}`)
    selects.push(`SELECT ${columns} FROM reporting.${source} part ${where(clauses)}`)
  }
  if (window.edges.length) {
    const ranges = window.edges.map(([start, end]) => `(request.created_at >= ${q.add(start)} AND request.created_at < ${q.add(end)})`)
    selects.push(`${live} ${where([...ownerClauses(filters, 'request', q.add), `(${ranges.join(' OR ')})`])}`)
  }
  // An empty window still yields a typed, empty relation.
  if (!selects.length) selects.push(`SELECT ${columns} FROM reporting.${table}_totals part WHERE false`)
  return { text: selects.join('\n UNION ALL\n'), values: q.values }
}

const usageColumns = 'part.platform, part.capability, part.meter_key, part.status, part.requests, part.units, part.latency_sum, part.latency_count'
const usageLive = `SELECT request.platform, request.capability,
    coalesce(request.billing_meter_key, request.capability, request.platform) AS meter_key, request.status,
    1::bigint AS requests, coalesce(request.units_actual, 0)::bigint AS units,
    coalesce(request.upstream_latency_ms, 0)::bigint AS latency_sum,
    CASE WHEN request.upstream_latency_ms IS NULL THEN 0 ELSE 1 END::bigint AS latency_count
  FROM public.usage_requests request`
const chargeColumns = 'part.meter_key, part.currency, part.enforcement_mode, part.status, part.quoted_positive, part.charges, part.quoted_minor, part.charged_minor'
const chargeLive = `SELECT charge.meter_key, charge.currency::text AS currency, charge.enforcement_mode, charge.status,
    charge.quoted_minor > 0 AS quoted_positive, 1::bigint AS charges, charge.quoted_minor, charge.charged_minor
  FROM public.usage_requests request
  JOIN billing.customer_charges charge ON charge.usage_request_id = request.id`

// Same row shapes, names and ordering as the history queries in usage().
// A group whose signed parts net to zero has no rows and is not returned.
export function usageRollupQueries(filters = {}) {
  const window = usageRollupWindow(filters)
  const usage = parts(filters, window, { table: 'usage_request', columns: usageColumns, live: usageLive })
  const charges = parts(filters, window, { table: 'customer_charge', columns: chargeColumns, live: chargeLive })
  return {
    aggregate: { values: usage.values, text: `WITH parts AS (${usage.text})
      SELECT platform, capability,
             sum(requests)::bigint AS requests,
             coalesce(sum(requests) FILTER (WHERE status = 'committed'), 0)::bigint AS committed,
             coalesce(sum(requests) FILTER (WHERE status = 'released'), 0)::bigint AS released,
             coalesce(sum(requests) FILTER (WHERE status = 'unknown'), 0)::bigint AS unknown,
             coalesce(sum(units) FILTER (WHERE status = 'committed'), 0)::bigint AS units,
             round(sum(latency_sum)::numeric / nullif(sum(latency_count), 0))::integer AS average_latency
        FROM parts GROUP BY platform, capability HAVING sum(requests) <> 0` },
    meter: { values: usage.values, text: `WITH parts AS (${usage.text})
      SELECT meter_key,
             sum(requests)::bigint AS requests,
             coalesce(sum(requests) FILTER (WHERE status = 'committed'), 0)::bigint AS committed,
             coalesce(sum(requests) FILTER (WHERE status = 'released'), 0)::bigint AS released,
             coalesce(sum(requests) FILTER (WHERE status = 'unknown'), 0)::bigint AS unknown,
             coalesce(sum(requests) FILTER (WHERE status = 'reserved'), 0)::bigint AS reserved,
             coalesce(sum(units) FILTER (WHERE status = 'committed'), 0)::bigint AS units
        FROM parts GROUP BY meter_key HAVING sum(requests) <> 0 ORDER BY meter_key` },
    billing: { values: charges.values, text: `WITH parts AS (${charges.text})
      SELECT meter_key, currency,
             sum(charges)::bigint AS requests,
             coalesce(sum(charges) FILTER (WHERE enforcement_mode = 'enforced' AND status = 'captured' AND quoted_positive), 0)::bigint AS captured_requests,
             coalesce(sum(charges) FILTER (WHERE enforcement_mode = 'enforced' AND status IN ('reserved', 'unknown') AND quoted_positive), 0)::bigint AS held_requests,
             coalesce(sum(charges) FILTER (WHERE enforcement_mode = 'enforced' AND status = 'released' AND quoted_positive), 0)::bigint AS released_requests,
             coalesce(sum(charges) FILTER (WHERE enforcement_mode = 'shadow'), 0)::bigint AS shadow_requests,
             coalesce(sum(quoted_minor), 0)::bigint AS quoted_minor,
             coalesce(sum(charged_minor), 0)::bigint AS charged_minor,
             coalesce(sum(quoted_minor) FILTER (WHERE enforcement_mode = 'enforced' AND status IN ('reserved', 'unknown')), 0)::bigint AS held_minor,
             coalesce(sum(quoted_minor) FILTER (WHERE enforcement_mode = 'shadow'), 0)::bigint AS shadow_quoted_minor
        FROM parts GROUP BY meter_key, currency HAVING sum(charges) <> 0 ORDER BY meter_key, currency` },
    // Owner-filtered "recent requests": the hours that hold the newest 50
    // matching rows, newest first. Partial edge hours never count toward the
    // 50 (their totals include rows outside from/to), so the set is a superset.
    recentHours: hasOwnerFilter(filters) ? recentHoursQuery(filters) : null,
  }
}

function recentHoursQuery(filters) {
  const q = builder(), clauses = ownerClauses(filters, 'part', q.add)
  const fromMs = ms(filters.from), toMs = ms(filters.to)
  if (fromMs != null) clauses.push(`part.bucket >= ${q.add(new Date(Math.floor(fromMs / HOUR) * HOUR))}`)
  if (toMs != null) clauses.push(`part.bucket < ${q.add(filters.to)}`)
  const from = fromMs == null ? 'NULL::timestamptz' : `${q.add(filters.from)}::timestamptz`
  const to = toMs == null ? 'NULL::timestamptz' : `${q.add(filters.to)}::timestamptz`
  const scope = where(clauses)
  return { values: q.values, text: `WITH hours AS (
      SELECT bucket, sum(requests) AS requests FROM (
        SELECT part.bucket, part.requests FROM reporting.usage_request_totals part ${scope}
        UNION ALL
        SELECT part.bucket, part.requests FROM reporting.usage_request_deltas part ${scope}
      ) owned GROUP BY bucket HAVING sum(requests) <> 0
    ), ranked AS (
      SELECT bucket, sum(CASE WHEN bucket < ${from} OR bucket + interval '1 hour' > ${to} THEN 0 ELSE requests END)
               OVER (ORDER BY bucket DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS newer
        FROM hours
    )
    SELECT bucket FROM ranked WHERE coalesce(newer, 0) < ${RECENT_LIMIT} ORDER BY bucket DESC` }
}

// Adjacent hours merge into one created_at range for the recent-rows query.
export function recentHourRanges(buckets) {
  const ranges = []
  for (const bucket of [...buckets].map(value => new Date(value).getTime()).sort((a, b) => a - b)) {
    const last = ranges.at(-1)
    if (last && last[1] === bucket) last[1] = bucket + HOUR
    else ranges.push([bucket, bucket + HOUR])
  }
  return ranges.map(([start, end]) => [new Date(start), new Date(end)])
}
