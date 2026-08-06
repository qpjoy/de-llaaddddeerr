// Dependency health probes with an explicit criticality contract.
//
// The distinction that matters: `required` dependencies gate readiness, optional
// ones never do. PostgreSQL is required — without it the Hub cannot serve or
// bill. Elasticsearch, Redis and HanLP are optional accelerators; letting any of
// them fail a readiness probe would take the API out of rotation over a
// degraded-but-working search path, which is the exact failure mode ADR-0005 and
// the Launcher integration contract forbid.

const DEFAULT_TIMEOUT_MS = 3_000

async function timed(fn, timeoutMs) {
  const startedAt = performance.now()
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs).unref?.(),
      ),
    ])
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt), detail: detail ?? null, error: null }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      detail: null,
      error: error.message,
    }
  }
}

export function postgresProbe(pool, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return {
    name: 'postgres',
    required: true,
    check: () =>
      timed(async () => {
        const { rows } = await pool.query('SELECT 1 AS ok')
        return rows[0]?.ok === 1 ? 'ready' : 'unexpected response'
      }, timeoutMs),
  }
}

export function elasticsearchProbe(client, { timeoutMs = 5_000 } = {}) {
  return {
    name: 'elasticsearch',
    required: false,
    check: () =>
      client
        ? timed(async () => {
            const health = await client.clusterHealth({ waitForStatus: 'yellow', timeout: '5s' })
            return health?.status || 'unknown'
          }, timeoutMs)
        : Promise.resolve({ ok: false, latencyMs: 0, detail: 'not configured', error: null }),
  }
}

export function queueProbe(queue, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return {
    name: 'queue',
    required: false,
    check: () =>
      timed(async () => {
        const stats = await queue.stats()
        const dead = stats.filter((row) => row.status === 'dead').reduce((sum, row) => sum + row.count, 0)
        const pending = stats
          .filter((row) => row.status === 'pending')
          .reduce((sum, row) => sum + row.count, 0)
        return { pending, dead }
      }, timeoutMs),
  }
}

export function segmenterProbe(segmenter) {
  return {
    name: 'segmenter',
    required: false,
    check: async () => ({
      ok: segmenter?.available !== false,
      latencyMs: 0,
      detail: segmenter?.constructor?.name === 'HanlpSegmenter' ? 'hanlp' : 'fallback',
      error: segmenter?.lastError || null,
    }),
  }
}

/**
 * Run every probe and derive an overall verdict.
 *
 * `ready` reflects only required dependencies. `degraded` reports that something
 * optional is down so operators still see it — a degraded service stays in
 * rotation and says why.
 */
export async function runProbes(probes) {
  const results = await Promise.all(
    probes.map(async (probe) => ({ name: probe.name, required: probe.required, ...(await probe.check()) })),
  )
  const failedRequired = results.filter((result) => result.required && !result.ok)
  const failedOptional = results.filter((result) => !result.required && !result.ok)
  return {
    ready: failedRequired.length === 0,
    degraded: failedRequired.length === 0 && failedOptional.length > 0,
    checks: Object.fromEntries(results.map(({ name, ...rest }) => [name, rest])),
    degradedBy: failedOptional.map((result) => result.name),
  }
}
