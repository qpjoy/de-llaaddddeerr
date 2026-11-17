import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { preserveTwitterCommentRoutes } from '../../server/ops/preserve-twitter-comment-routes.mjs'

test('pre-validation preservation changes only audit revision, survives migration 191 and never overwrites reviewed routes', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  const migration = name => readFile(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8')
  await db.exec('CREATE SCHEMA control')
  const schema = await migration('060_external_platform_operation_control')
  await db.exec(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS control.external_platform_provider_price_books'),
    schema.indexOf('CREATE OR REPLACE FUNCTION control.reject_external_platform_append_only_mutation')))
  await db.exec("INSERT INTO control.external_platform_provider_price_books(provider_key,version,source,status) VALUES('rapidapi',0,'legacy_environment','inherited')")
  for (const name of ['150_strategy_search_routes','160_twitter_strategy_search','170_facebook_account_business_pause',
    '181_comment_strategy_routes','188_threads_strategy_routes','189_threads_scraper_search','190_threads_scraper_account_detail']) {
    await db.exec(await migration(name))
  }
  const routes = async () => (await db.query('SELECT * FROM control.strategy_search_routes ORDER BY interface_key,platform')).rows
  const events = async () => (await db.query('SELECT * FROM control.strategy_search_route_events ORDER BY id')).rows
  const before = await routes(), audit = await events()
  const preview = await preserveTwitterCommentRoutes(db)
  assert.equal(preview.mode, 'preview')
  assert.deepEqual(await routes(), before)
  assert.deepEqual(await events(), audit)
  const applied = await preserveTwitterCommentRoutes(db, true)
  assert.equal(applied.auditedRevisions.length, 2)
  assert.equal(applied.rapidAlreadySelected, false)
  const held = await routes(), heldEvents = await events()
  for (let i = 0; i < before.length; i++) {
    const old = before[i], current = held[i]
    if (old.platform !== 'twitter' || !['post-comments','comment-replies'].includes(old.interface_key)) {
      assert.deepEqual(current, old)
    } else {
      assert.equal(current.revision, old.revision + 1)
      for (const field of ['mode','primary_provider','fallback_provider']) assert.equal(current[field], old[field])
    }
  }
  assert.deepEqual(heldEvents.slice(0, audit.length), audit)
  assert.equal(heldEvents.length, audit.length + 2)
  assert.equal((await preserveTwitterCommentRoutes(db, true)).auditedRevisions.length, 0)
  await db.exec(await migration('191_twitter_rapidapi_comments'))
  assert.deepEqual(await routes(), held, 'deployment cannot switch traffic before compatibility validation')
  assert.deepEqual(await events(), heldEvents)
  await db.query("UPDATE control.strategy_search_routes SET primary_provider='rapidapi',revision=3 WHERE platform='twitter' AND interface_key='post-comments'")
  const manual = await routes()
  assert.equal((await preserveTwitterCommentRoutes(db, true)).rapidAlreadySelected, true)
  assert.deepEqual(await routes(), manual, 'an already deployed or manually selected provider is not silently reverted')
})
