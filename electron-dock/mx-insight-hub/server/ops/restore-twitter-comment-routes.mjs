// Recovery for the two revision-2 routes reported after migration 191.
// Changes only audited routing configuration; no supplier calls or restarts.
export async function restoreTwitterCommentRoutes(db) {
  await db.query('BEGIN')
  try {
    await db.query("SET LOCAL lock_timeout='5s'")
    await db.query("SET LOCAL statement_timeout='15s'")
    const select = `SELECT interface_key,mode,primary_provider,fallback_provider,revision
      FROM control.strategy_search_routes WHERE platform='twitter'
      AND interface_key IN ('post-comments','comment-replies') ORDER BY interface_key`
    const before = (await db.query(`${select} FOR UPDATE`)).rows
    const fixed = row => row.mode === 'fixed' && row.primary_provider === 'tikhub' && row.fallback_provider === null
    const reported = row => row.revision === 2 && row.mode === 'priority'
      && row.primary_provider === 'rapidapi' && row.fallback_provider === 'tikhub'
    if (before.length !== 2 || before.some(row => !fixed(row) && !reported(row))) {
      throw Object.assign(new Error('routing_changed'), { code: 'routing_changed' })
    }
    // The exact current values were supplied by the operator. Do not require
    // a particular historical actor or override any newer/operator change.
    const changed = (await db.query(`WITH changed AS (
      UPDATE control.strategy_search_routes SET mode='fixed',primary_provider='tikhub',fallback_provider=NULL,
        revision=revision+1,updated_at=now(),reason='Temporary TikHub routing after RapidAPI 404; compatibility validation pending'
      WHERE platform='twitter' AND interface_key IN ('post-comments','comment-replies') AND revision=2
        AND mode='priority' AND primary_provider='rapidapi' AND fallback_provider='tikhub' RETURNING *
    ) INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy)
      SELECT interface_key,platform,revision,'ops-twitter-rapid-404-recovery',jsonb_build_object(
        'interface',interface_key,'platform',platform,'mode',mode,'primaryProvider',primary_provider,
        'fallbackProvider',fallback_provider,'revision',revision,'reason',reason,'updatedAt',updated_at)
      FROM changed RETURNING interface_key,revision`)).rows
    const after = (await db.query(select)).rows
    if (after.length !== 2 || !after.every(fixed) || changed.length !== before.filter(reported).length) {
      throw Object.assign(new Error('routing_restore_unverified'), { code: 'routing_restore_unverified' })
    }
    await db.query('COMMIT')
    return { supplierHttpCallsMade: 0, changed, before, after }
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error }
}
