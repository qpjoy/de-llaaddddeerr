import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { restoreTwitterCommentRoutes } from '../../server/ops/restore-twitter-comment-routes.mjs'

test('404 recovery atomically restores only observed Twitter revision 2, preserves audits, is repeatable and rejects concurrent changes', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  const migration = name => readFile(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8')
  await db.exec('CREATE SCHEMA control')
  for (const name of ['150_strategy_search_routes','160_twitter_strategy_search','170_facebook_account_business_pause','181_comment_strategy_routes']) {
    await db.exec(await migration(name))
  }
  await db.exec(`ALTER TABLE control.strategy_search_routes DROP CONSTRAINT strategy_search_routes_primary_provider_check;
    UPDATE control.strategy_search_routes SET mode='priority',primary_provider='rapidapi',fallback_provider='tikhub',revision=2
      WHERE platform='twitter' AND interface_key IN ('post-comments','comment-replies');
    INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy)
      SELECT interface_key,platform,revision,'migration-191','{}' FROM control.strategy_search_routes
      WHERE platform='twitter' AND interface_key IN ('post-comments','comment-replies');`)
  const rows = async () => (await db.query('SELECT * FROM control.strategy_search_routes ORDER BY interface_key,platform')).rows
  const events = async () => (await db.query('SELECT * FROM control.strategy_search_route_events ORDER BY id')).rows
  const original = await rows(), originalEvents = await events()
  await db.exec("UPDATE control.strategy_search_routes SET revision=3 WHERE platform='twitter' AND interface_key='comment-replies'")
  const concurrent = await rows()
  await assert.rejects(restoreTwitterCommentRoutes(db), { code: 'routing_changed' })
  assert.deepEqual(await rows(), concurrent)
  assert.deepEqual(await events(), originalEvents)
  await db.exec("UPDATE control.strategy_search_routes SET revision=2 WHERE platform='twitter' AND interface_key='comment-replies'")
  // A conflicting audit must roll back both updated rows, not only the insert.
  await db.exec("INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy) VALUES('post-comments','twitter',3,'conflict','{}')")
  await assert.rejects(restoreTwitterCommentRoutes(db))
  assert.deepEqual(await rows(), original)
  await db.exec("DELETE FROM control.strategy_search_route_events WHERE actor='conflict'")
  const report = await restoreTwitterCommentRoutes(db)
  assert.equal(report.changed.length, 2)
  assert.equal(report.supplierHttpCallsMade, 0)
  assert.ok(report.after.every(row => row.mode === 'fixed' && row.primary_provider === 'tikhub' && row.fallback_provider === null && row.revision === 3))
  const recovered = await rows(), recoveredEvents = await events()
  const target = row => row.platform === 'twitter' && ['post-comments','comment-replies'].includes(row.interface_key)
  assert.deepEqual(recovered.filter(row => !target(row)), original.filter(row => !target(row)))
  assert.deepEqual(recoveredEvents.slice(0, originalEvents.length), originalEvents)
  assert.equal(recoveredEvents.length, originalEvents.length + 2)
  for (const event of recoveredEvents.slice(originalEvents.length)) {
    assert.equal(event.actor, 'ops-twitter-rapid-404-recovery')
    assert.equal(event.policy.primaryProvider, 'tikhub')
    assert.equal(event.policy.fallbackProvider, null)
  }
  assert.deepEqual((await restoreTwitterCommentRoutes(db)).changed, [])
  assert.deepEqual(await rows(), recovered)
  assert.deepEqual(await events(), recoveredEvents)
})
