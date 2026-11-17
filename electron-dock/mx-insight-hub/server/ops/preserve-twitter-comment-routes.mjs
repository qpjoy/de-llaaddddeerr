// Before migration 191: record the existing defaults as deliberately retained
// while paid compatibility validation runs. No routing value is changed.
import { pathToFileURL } from 'node:url'

export const RETAIN_TWITTER_ROUTES_SQL = `
WITH retained AS (
  UPDATE control.strategy_search_routes AS route
  SET revision=route.revision+1,
    reason='Retain current routing until Twitter RapidAPI paid compatibility validation completes',updated_at=now()
  WHERE route.platform='twitter' AND route.revision=1 AND route.primary_provider='tikhub'
    AND ((route.interface_key='post-comments' AND route.mode='priority' AND route.fallback_provider='justone'
      AND route.reason='migration-181: TikHub first, JustOne guarantee')
      OR (route.interface_key='comment-replies' AND route.mode='fixed' AND route.fallback_provider IS NULL
        AND route.reason='migration-181: TikHub replies'))
    AND EXISTS (SELECT 1 FROM control.strategy_search_route_events AS event
      WHERE event.interface_key=route.interface_key AND event.platform=route.platform
        AND event.revision=route.revision AND event.actor='migration-181')
  RETURNING route.*
)
INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy)
SELECT interface_key,platform,revision,'ops-twitter-rapid-validation',jsonb_build_object(
  'interface',interface_key,'platform',platform,'mode',mode,'primaryProvider',primary_provider,
  'fallbackProvider',fallback_provider,'revision',revision,'reason',reason,'updatedAt',updated_at)
FROM retained RETURNING interface_key,revision`

export async function preserveTwitterCommentRoutes(client, apply = false) {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    await client.query("SET LOCAL lock_timeout='5s'")
    await client.query("SET LOCAL statement_timeout='15s'")
    const read = async () => (await client.query(`SELECT interface_key,mode,primary_provider,fallback_provider,revision
      FROM control.strategy_search_routes WHERE platform='twitter'
        AND interface_key IN ('post-comments','comment-replies') ORDER BY interface_key`)).rows
    const before = await read()
    if (before.length !== 2) throw new Error('existing_comment_routes_required')
    const updated = apply ? (await client.query(RETAIN_TWITTER_ROUTES_SQL)).rows : []
    const after = await read()
    await client.query('COMMIT')
    return { revision: 'twitter-comment-routing-preservation.v1', mode: apply ? 'apply' : 'preview',
      supplierCalls: 0, routingValuesChangedByThisTool: false, auditedRevisions: updated,
      before, after, rapidAlreadySelected: after.some(row => row.mode !== 'paused'
        && [row.primary_provider,row.fallback_provider].includes('rapidapi')) }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
}

const entry = process.argv[1] === '-' && import.meta.url === pathToFileURL(`${process.cwd()}/[eval1]`).href
  || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href
if (entry) {
  let client
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || args.length === 1 && args[0] !== '--apply') throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { Client } = await import('pg')
    client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000,
      application_name: 'twitter-comment-routing-preservation.v1' })
    await client.connect()
    console.log(JSON.stringify(await preserveTwitterCommentRoutes(client, args[0] === '--apply'), null, 2))
  } catch (error) {
    const code = ['invalid_arguments','database_url_required','existing_comment_routes_required'].includes(error.message)
      ? error.message : 'routing_preservation_unavailable'
    console.log(JSON.stringify({ errorCode: code, supplierCalls: 0 }))
    process.exitCode = 1
  } finally { await client?.end().catch(() => {}) }
}
