import { randomUUID } from 'node:crypto'
import { ProgressRate, mergeWorkerMetrics } from '../ops/indexing-metrics.mjs'
import { z } from 'zod'
import { AppError } from '../core/errors.mjs'
import { requireSegmenterBackend } from '../search/reindex-integrity.mjs'

const backfillBudgetSchema = z.object({
  tokenBudget: z.number().int().min(0).max(1000000000).default(1000000000),
}).strict()

export class RetrievalControl {
  constructor({ pool, agent = null, search = null }) {
    this.pool = pool
    this.agent = agent
    this.search = search
    this.countsCache = null
    this.rate = new ProgressRate()
  }
  async status() {
    const [settings, counts, runs, usage, workers, failures] = await Promise.all([
      this.pool.query('SELECT * FROM retrieval.settings WHERE id'),
      this.queueCounts(),
      this.pool.query('SELECT * FROM retrieval.runs ORDER BY started_at DESC LIMIT 1'),
      this.pool.query(
        "SELECT reserved_tokens FROM retrieval.daily_usage WHERE day=(now() AT TIME ZONE 'UTC')::date",
      ),
      this.pool.query(
        "SELECT id,heartbeat_at,telemetry FROM retrieval.workers WHERE heartbeat_at>now()-interval '90 seconds' ORDER BY heartbeat_at DESC",
      ),
      this.pool.query(
        "SELECT record_id,last_error_code,updated_at FROM retrieval.jobs WHERE status='dead' ORDER BY updated_at DESC LIMIT 5",
      ),
    ])
    const run = runs.rows[0] ? { ...runs.rows[0],
      progress: runs.rows[0].snapshot_locked ? await this.runProgress(runs.rows[0].id, runs.rows[0].status) : null,
    } : null
    const telemetry = mergeWorkerMetrics(workers.rows)
    const config = settings.rows[0], today = Number(usage.rows[0]?.reserved_tokens || 0)
    const activeRun = run && ['scanning', 'draining'].includes(run.status)
    const fixed = activeRun && run.snapshot_locked
    const count = (status) => Number(counts.rows.find((row) => row.status === status)?.count || 0)
    const blocked = !config?.enabled ? 'disabled' : config.paused ? 'paused'
      : !this.agent?.embeddings?.available || !this.search?.chunkIndexSet ? 'unready'
      : !workers.rows.length ? 'no_workers' : !telemetry.reportingWorkers ? 'stale'
      : fixed && Number(run.token_budget) > 0 && (Number(run.reserved_tokens) >= Number(run.token_budget) || run.progress?.budgetBlocked) ? 'initialization_budget'
      : !fixed && today >= Number(config.daily_token_budget) ? 'daily_budget' : null
    const eta = activeRun && !fixed ? { seconds: null, rate: null, reason: 'legacy' }
      : this.rate.estimate({ key: `${fixed ? run.id : 'queue'}:${config?.updated_at}`,
        processed: fixed ? Number(run.progress?.completed || 0) + Number(run.progress?.superseded || 0) : count('done'),
        remaining: fixed ? Number(run.progress?.pending || 0) : count('pending') + count('running'),
        at: fixed ? this.progressCache.expires - 30000 : this.countsCache.expires - 30000,
        blocked: blocked || (!fixed && !count('pending') && !count('running') && count('dead') ? 'failed' : null) })
    return {
      observation: { ...telemetry, eta, scope: fixed ? 'initialization' : 'queue',
        effectiveConcurrency: Math.min(Number(config?.max_concurrency || 0), workers.rows.length),
        concurrencyLimit: Number(config?.max_concurrency || 0),
        retrying: counts.rows.reduce((n, row) => n + Number(row.retrying || 0), 0),
        budgetWaiting: counts.rows.reduce((n, row) => n + Number(row.budget_waiting || 0), 0),
        deferred: counts.rows.reduce((n, row) => n + Number(row.deferred || 0), 0),
        dead: count('dead') },
      settings: settings.rows[0],
      workers: workers.rows,
      failures: failures.rows,
      jobs: counts.rows,
      run,
      reservedTokensToday: Number(usage.rows[0]?.reserved_tokens || 0),
      ready: Boolean(this.agent?.embeddings?.available && this.search?.chunkIndexSet),
      reason: !this.search?.chunkIndexSet
        ? '未配置向量维度/索引'
        : !this.agent?.embeddings?.available
          ? '未配置可用的 Embedding 默认 Sequence'
          : null,
      delivery: 'durable-coalesced-at-least-once',
      scope: 'Hub 已入库 canonical 文本；不会补采图片或视频',
      worker: '独立 retrieval worker；暂停不阻止删除投影',
      ha: 'Worker 可接管；数据库和 ES 的宿主机高可用需独立部署',
    }
  }
  async queueCounts() {
    if (this.countsCache && this.countsCache.expires > Date.now()) return this.countsCache.value
    const value = await this.pool.query(
      `SELECT status,count(*)::int AS count,min(updated_at) AS oldest,
        count(*) FILTER (WHERE status='pending' AND run_at>now()) AS deferred,
        count(*) FILTER (WHERE status='pending' AND last_error_code IN ('embedding_budget_exceeded','initialization_budget_exceeded')) AS budget_waiting,
        count(*) FILTER (WHERE status='pending' AND last_error_code IS NOT NULL
          AND last_error_code NOT IN ('embedding_budget_exceeded','initialization_budget_exceeded','retrieval_paused','embedding_not_ready')) AS retrying
       FROM retrieval.jobs GROUP BY status`,
    )
    this.countsCache = { value, expires: Date.now() + 30000 }
    return value
  }
  async runProgress(runId, status) {
    if (this.progressCache?.runId === runId && this.progressCache.status === status && this.progressCache.expires > Date.now())
      return this.progressCache.value
    const { rows } = await this.pool.query(
      `SELECT status,count(*)::bigint AS count,
          EXISTS (SELECT 1 FROM retrieval.jobs WHERE backfill_run_id=$1
            AND completed_version<backfill_version AND status='pending'
            AND last_error_code='initialization_budget_exceeded') AS budget_blocked
         FROM retrieval.run_items WHERE run_id=$1 GROUP BY status`, [runId],
    )
    const value = { ...Object.fromEntries(rows.map((row) => [row.status, Number(row.count)])),
      budgetBlocked: rows.some((row) => row.budget_blocked) }
    this.progressCache = { runId, status, expires: Date.now() + 30000, value }
    return value
  }
  async configure(input) {
    const parsed = z
      .object({
        enabled: z.boolean(),
        paused: z.boolean(),
        maxConcurrency: z.number().int().min(1).max(16),
        dailyTokenBudget: z.number().int().min(1000).max(1000000000),
      })
      .strict()
      .safeParse(input)
    if (!parsed.success) throw new AppError(400, 'invalid_retrieval_settings', '向量化设置无效')
    const v = parsed.data
    if (v.enabled && (!this.agent?.embeddings?.available || !this.search?.chunkIndexSet))
      throw new AppError(409, 'embedding_not_ready', '先配置并验证 Embedding Sequence 及向量维度')
    await this.pool.query(
      `UPDATE retrieval.settings SET enabled=$1,paused=$2,max_concurrency=$3,daily_token_budget=$4,updated_at=now() WHERE id`,
      [v.enabled, v.paused, v.maxConcurrency, v.dailyTokenBudget],
    )
    await this.pool.query("UPDATE retrieval.jobs SET run_at=now() WHERE status='pending' AND last_error_code='embedding_budget_exceeded'")
    return this.status()
  }
  async preflight() {
    const workers = await this.pool.query(
      "SELECT 1 FROM retrieval.workers WHERE heartbeat_at>now()-interval '90 seconds' LIMIT 1",
    )
    if (!workers.rows.length)
      throw new AppError(409, 'retrieval_worker_unavailable', '没有在线的向量化 Worker；请检查部署状态')
    const set = this.search?.chunkIndexSet
    const expectedDims = set?.mappings?.properties?.embedding?.dims
    if (!this.search?.client || !expectedDims || this.agent?.embeddings?.dimensions !== expectedDims)
      throw new AppError(409, 'embedding_dimension_mismatch', 'Embedding 维度与 ES 配置不一致；没有开始任务')
    try {
      const mapping = await this.search.client.request(
        'GET',
        `/${encodeURIComponent(set.writeAlias)}/_mapping`,
      )
      const values = Object.values(mapping)
      if (
        !values.length ||
        values.some(
          (v) =>
            v.mappings?.properties?.embedding?.dims !== expectedDims ||
            !v.mappings?.properties?.embeddingSpace,
        )
      )
        throw new Error('mapping mismatch')
      const strict = requireSegmenterBackend(this.search.segmenter, {
        expectedBackend: 'hanlp',
        maxAttempts: 1,
        maxBatch: 1,
      })
      await strict.segment('向量索引前置检查')
    } catch {
      throw new AppError(
        409,
        'retrieval_dependencies_unready',
        '向量索引映射或 HanLP 未通过检查；没有开始任务，也未使用替代分词器',
      )
    }
  }
  async start(input = {}) {
    const parsed = backfillBudgetSchema.safeParse(input)
    if (!parsed.success) throw new AppError(400, 'invalid_retrieval_request', '本次初始化预算须为 0–10 亿；0 表示不限额')
    if (!this.agent?.embeddings?.available || !this.search?.chunkIndexSet)
      throw new AppError(409, 'embedding_not_ready', 'Embedding 默认 Sequence 或向量索引未就绪；没有开始任务')
    const settings = (await this.pool.query('SELECT enabled,paused FROM retrieval.settings WHERE id')).rows[0]
    if (!settings?.enabled || settings.paused)
      throw new AppError(409, 'retrieval_paused', '请先启用后台向量化并解除暂停')
    await this.preflight()
    const client = await this.pool.connect(), id = randomUUID()
    try {
      await client.query('BEGIN')
      // Only this explicit maintenance action gets a longer statement budget.
      // INSERT SELECT holds no canonical row locks and copies no source bodies.
      await client.query("SET LOCAL statement_timeout='60s'")
      await client.query(
        'INSERT INTO retrieval.runs(id,snapshot_locked,token_budget) VALUES($1,true,$2)',
        [id, parsed.data.tokenBudget],
      )
      const captured = await client.query(
        `INSERT INTO retrieval.run_items(run_id,record_id,source_revision,projection_revision)
         SELECT $1,id,current_revision,projection_revision FROM core.canonical_records
         WHERE deleted_at IS NULL AND coalesce(length(title),0)+coalesce(length(body),0)>=24`, [id],
      )
      await client.query(
        `UPDATE retrieval.runs SET target_count=$2,status=CASE WHEN $2::bigint=0 THEN 'completed' ELSE 'scanning' END,
         finished_at=CASE WHEN $2::bigint=0 THEN now() END WHERE id=$1`, [id, captured.rowCount],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      if (error.code === '23505') throw new AppError(409, 'retrieval_run_active', '已有全库任务正在执行')
      throw error
    } finally {
      client.release()
    }
    return this.status()
  }
  async configureBackfill(input) {
    const parsed = backfillBudgetSchema.safeParse(input)
    if (!parsed.success) throw new AppError(400, 'invalid_retrieval_request', '本次初始化预算须为 0–10 亿；0 表示不限额')
    const { rowCount } = await this.pool.query(
      `UPDATE retrieval.runs SET token_budget=$1,updated_at=now()
       WHERE snapshot_locked AND status IN ('scanning','draining')`, [parsed.data.tokenBudget],
    )
    if (!rowCount) throw new AppError(409, 'retrieval_run_inactive', '没有可调整额度的初始化任务')
    await this.pool.query("UPDATE retrieval.jobs SET run_at=now() WHERE status='pending' AND last_error_code='initialization_budget_exceeded'")
    return this.status()
  }
  async cancel() {
    await this.pool.query(
      `UPDATE retrieval.runs SET status='cancelled',finished_at=now(),updated_at=now() WHERE status IN ('scanning','draining')`,
    )
    // Pause processing too: already queued work remains durable and can resume.
    await this.pool.query('UPDATE retrieval.settings SET paused=true,updated_at=now() WHERE id')
    return this.status()
  }
  async retry() {
    await this.pool.query(
      `UPDATE core.record_chunks SET projection_failed_at=NULL,projection_attempts=0 WHERE projection_failed_at IS NOT NULL AND record_id IN(SELECT record_id FROM retrieval.jobs WHERE status='dead')`,
    )
    await this.pool.query(
      `UPDATE retrieval.jobs SET status='pending',attempts=0,run_at=now(),last_error_code=NULL,updated_at=now() WHERE status='dead'`,
    )
    this.countsCache = null
    this.rate = new ProgressRate()
    return this.status()
  }
}

export class RetrievalJobs {
  constructor(pool) {
    this.pool = pool
  }
  async seedBatch(limit = 250) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const run = (
        await client.query(
          `SELECT * FROM retrieval.runs WHERE status='scanning' FOR UPDATE SKIP LOCKED LIMIT 1`,
        )
      ).rows[0]
      if (!run) {
        await client.query('COMMIT')
        return 0
      }
      // Low priority history; a new outbox event promotes its record to priority 10.
      const rows = (
        await client.query(
          run.snapshot_locked
            ? `SELECT i.record_id AS id,i.projection_revision,i.status,
                r.projection_revision AS current_projection_revision
               FROM retrieval.run_items i LEFT JOIN core.canonical_records r ON r.id=i.record_id
               WHERE i.run_id=$1 AND ($2::uuid IS NULL OR i.record_id>$2) ORDER BY i.record_id LIMIT $3`
            : run.cursor_id
            ? 'SELECT id,projection_revision FROM core.canonical_records WHERE id>$1 ORDER BY id LIMIT $2'
            : 'SELECT id,projection_revision FROM core.canonical_records ORDER BY id LIMIT $1',
          run.snapshot_locked ? [run.id, run.cursor_id, limit] : run.cursor_id ? [run.cursor_id, limit] : [limit],
        )
      ).rows
      const pending = run.snapshot_locked ? rows.filter((r) => r.status === 'pending'
        && String(r.projection_revision) === String(r.current_projection_revision)) : rows
      if (pending.length) {
        await client.query(
          `INSERT INTO retrieval.jobs AS j(record_id,requested_revision,priority,backfill_run_id,backfill_version)
          SELECT id,rev,100,$3,1 FROM unnest($1::uuid[],$2::bigint[]) AS r(id,rev)
          ON CONFLICT(record_id) DO UPDATE SET requested_revision=greatest(j.requested_revision,EXCLUDED.requested_revision),
            version=j.version+1,backfill_run_id=$3,backfill_version=j.version+1,status=CASE WHEN j.status='running' THEN 'running' ELSE 'pending' END,
            priority=CASE WHEN j.status IN ('pending','running') THEN least(j.priority,EXCLUDED.priority) ELSE EXCLUDED.priority END,run_at=now(),last_error_code=NULL,attempts=0,updated_at=now()`,
          [pending.map((r) => r.id), pending.map((r) => r.projection_revision), run.id],
        )
      }
      if (run.snapshot_locked && rows.length) {
        // Also close the capture/ingest race: an update may commit while the
        // manifest is being inserted and its trigger cannot yet see that item.
        await client.query(
          `UPDATE retrieval.run_items i SET status='superseded',finished_at=now()
           WHERE i.run_id=$1 AND i.record_id=ANY($2::uuid[]) AND i.status='pending'
           AND NOT EXISTS(SELECT 1 FROM core.canonical_records r WHERE r.id=i.record_id AND r.projection_revision=i.projection_revision)`,
          [run.id, rows.map((r) => r.id)],
        )
      }
      await client.query(
        `UPDATE retrieval.runs SET cursor_id=coalesce($2,cursor_id),seeded=seeded+$3,status=$4,updated_at=now() WHERE id=$1`,
        [run.id, rows.at(-1)?.id || null, rows.length, rows.length < limit ? 'draining' : 'scanning'],
      )
      await client.query('COMMIT')
      return rows.length
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  async claim({ retireOnly = false } = {}) {
    const client = await this.pool.connect(),
      token = randomUUID()
    try {
      await client.query('BEGIN')
      // One tiny admission lock serializes global capacity decisions, not work.
      await client.query('SELECT pg_advisory_xact_lock(1297633875)')
      await client.query(`UPDATE retrieval.jobs SET status=CASE WHEN attempts>=8 THEN 'dead' ELSE 'pending' END,
        lease_token=NULL,lease_until=NULL,run_at=now()+interval '30 seconds',last_error_code='worker_lease_expired',updated_at=now()
        WHERE status='running' AND lease_until<now()`)
      const settings = (
        await client.query(`SELECT enabled,paused,max_concurrency,
        (SELECT count(*)::int FROM retrieval.jobs WHERE status='running') AS running
        FROM retrieval.settings WHERE id`)
      ).rows[0]
      if (!settings || settings.running >= settings.max_concurrency) {
        await client.query('COMMIT')
        return null
      }
      const onlyRetire = retireOnly || !settings.enabled || settings.paused
      const rows = (
        await client.query(
          `UPDATE retrieval.jobs SET status='running',lease_token=$1,lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now()
        WHERE record_id IN (SELECT record_id FROM retrieval.jobs
          WHERE status='pending' AND run_at<=now() ${onlyRetire ? 'AND retire' : ''}
          ORDER BY retire DESC,priority,run_at,record_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
          [token],
        )
      ).rows
      await client.query('COMMIT')
      return rows[0] || null
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  async heartbeat(job) {
    const { rowCount } = await this.pool.query(
      `UPDATE retrieval.jobs SET lease_until=now()+interval '3 minutes' WHERE record_id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()`,
      [job.record_id, job.lease_token],
    )
    if (rowCount !== 1) throw new AppError(409, 'retrieval_lease_lost', 'Retrieval lease lost')
  }
  async complete(job) {
    await this.pool.query(
      `UPDATE retrieval.jobs SET status=CASE WHEN version=$3 THEN 'done' ELSE 'pending' END,
      completed_version=greatest(completed_version,$3),attempts=0,lease_token=NULL,lease_until=NULL,run_at=now(),last_error_code=NULL,updated_at=now()
      WHERE record_id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()`,
      [job.record_id, job.lease_token, job.version],
    )
    await this.pool.query(
      `UPDATE retrieval.run_items i SET status='completed',finished_at=now()
       WHERE record_id=$1 AND projection_revision=$2 AND status='pending'
       AND EXISTS(SELECT 1 FROM retrieval.jobs j WHERE j.record_id=$1 AND j.completed_version>=$3)
       AND EXISTS(SELECT 1 FROM retrieval.runs r WHERE r.id=i.run_id AND r.status IN ('scanning','draining'))`,
      [job.record_id, job.requested_revision, job.version],
    )
  }
  async fail(job, error) {
    const transient = [
      'embedding_budget_exceeded',
      'initialization_budget_exceeded',
      'embedding_not_ready',
      'reindex_segmenter_degraded',
      'retrieval_paused',
    ].includes(error.code)
    await this.pool.query(
      `UPDATE retrieval.jobs SET status=CASE WHEN attempts>=8 AND NOT $4 AND version=$6 THEN 'dead' ELSE 'pending' END,
      attempts=CASE WHEN version<>$6 THEN 0 WHEN $4 THEN greatest(0,attempts-1) ELSE attempts END,
      run_at=CASE WHEN version<>$6 THEN now()
        WHEN $3='embedding_budget_exceeded' THEN ((now() AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC'
        ELSE now()+make_interval(secs=>$5) END,
      lease_token=NULL,lease_until=NULL,last_error_code=$3,updated_at=now()
      WHERE record_id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()`,
      [
        job.record_id,
        job.lease_token,
        /^[a-z_]{1,80}$/.test(error.code || '') ? error.code : 'retrieval_job_failed',
        transient,
        Math.min(3600, 2 ** job.attempts * 5),
        job.version,
      ],
    )
  }
  async reserveTokens(tokens, job = null, sourceRevision = null) {
    const n = Math.ceil(tokens)
    if (job && sourceRevision != null) {
      const { rows: eligible } = await this.pool.query(
        `SELECT r.id FROM retrieval.runs r JOIN retrieval.run_items i ON i.run_id=r.id
         WHERE r.snapshot_locked AND r.status IN ('scanning','draining') AND i.status='pending'
         AND i.record_id=$1 AND i.projection_revision=$2 AND i.source_revision=$3 LIMIT 1`,
        [job.record_id, job.requested_revision, sourceRevision],
      )
      if (eligible.length) {
        const { rows } = await this.pool.query(
          `UPDATE retrieval.runs SET reserved_tokens=reserved_tokens+$2,updated_at=now()
           WHERE id=$1 AND status IN ('scanning','draining')
           AND (token_budget=0 OR reserved_tokens+$2<=token_budget)
           AND EXISTS(SELECT 1 FROM retrieval.settings WHERE id AND enabled AND NOT paused)
           AND EXISTS(SELECT 1 FROM retrieval.jobs WHERE record_id=$3 AND lease_token=$4 AND status='running' AND lease_until>now())
           RETURNING reserved_tokens`, [eligible[0].id, n, job.record_id, job.lease_token],
        )
        if (!rows.length) throw new AppError(429, 'initialization_budget_exceeded', '初始化额度已用完或任务已暂停；可调整本次额度后继续')
        return { scope: 'initialization', runId: eligible[0].id }
      }
    }
    const { rows } = await this.pool.query(
      `INSERT INTO retrieval.daily_usage AS u(day,reserved_tokens)
      SELECT (now() AT TIME ZONE 'UTC')::date,$1 FROM retrieval.settings WHERE id AND enabled AND NOT paused AND daily_token_budget>=$1
      ON CONFLICT(day) DO UPDATE SET reserved_tokens=u.reserved_tokens+EXCLUDED.reserved_tokens
      WHERE u.reserved_tokens+EXCLUDED.reserved_tokens<=(SELECT daily_token_budget FROM retrieval.settings WHERE id AND enabled AND NOT paused)
      RETURNING reserved_tokens`,
      [n],
    )
    if (!rows.length)
      throw new AppError(429, 'embedding_budget_exceeded', '后台向量化已暂停或达到今日 token 预算')
    return { scope: 'daily' }
  }
  async settleRun() {
    await this.pool
      .query(`UPDATE retrieval.runs SET status='completed',finished_at=now(),updated_at=now() WHERE status='draining'
      AND CASE WHEN snapshot_locked THEN
        NOT EXISTS(SELECT 1 FROM retrieval.run_items WHERE run_id=retrieval.runs.id AND status='pending')
      ELSE NOT EXISTS(SELECT 1 FROM retrieval.jobs WHERE backfill_run_id=retrieval.runs.id AND completed_version<backfill_version) END`)
    await this.pool.query("DELETE FROM retrieval.workers WHERE heartbeat_at<now()-interval '1 day'")
    await this.pool.query(
      'DELETE FROM retrieval.search_snapshots WHERE id IN(SELECT id FROM retrieval.search_snapshots WHERE expires_at<now() LIMIT 1000)',
    )
  }
}
