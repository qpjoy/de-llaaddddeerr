import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { restoreTwitterCommentRoutes } from '../../server/ops/restore-twitter-comment-routes.mjs'
import { planOperation } from '../../scripts/migrate-missing-operation-prices.mjs'

const operationKey = 'native.r.twitter_aio_tweet_thread'
const oldOperation = 'native.r.twitter_aio_tweet_replies'
const migration = name => readFile(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8')

test('TweetDetail registration preserves recovered TikHub routes, old operation evidence and manual controls', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA control')
  const schema = await migration('060_external_platform_operation_control')
  await db.exec(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS control.external_platform_provider_price_books'),
    schema.indexOf('CREATE OR REPLACE FUNCTION control.reject_external_platform_append_only_mutation')))
  await db.exec("INSERT INTO control.external_platform_provider_price_books(provider_key,version,source,status) VALUES('rapidapi',0,'legacy_environment','inherited')")
  for (const name of ['150_strategy_search_routes','160_twitter_strategy_search','170_facebook_account_business_pause',
    '181_comment_strategy_routes','191_twitter_rapidapi_comments']) await db.exec(await migration(name))
  const recovery = await restoreTwitterCommentRoutes(db)
  assert.ok(recovery.after.every(row => row.revision === 3 && row.mode === 'fixed' && row.primary_provider === 'tikhub'))
  const snapshot = async () => {
    const tables = ['strategy_search_routes','strategy_search_route_events','external_platform_provider_price_books',
      'external_platform_operation_releases','external_platform_operation_policies','external_platform_operation_policy_events']
    return Object.fromEntries(await Promise.all(tables.map(async table => {
      const where = table.startsWith('external_platform_operation_') ? ` WHERE operation_key <> '${operationKey}'` : ''
      const result = await db.query(`SELECT * FROM control.${table}${where} ORDER BY 1,2`)
      return [table, result.rows]
    })))
  }
  const before = await snapshot()
  assert.ok(before.external_platform_operation_releases.some(row => row.operation_key === oldOperation))
  const install = await migration('192_twitter_rapidapi_tweet_thread')
  await db.exec(install)
  assert.deepEqual(await snapshot(), before)
  const release = (await db.query('SELECT * FROM control.external_platform_operation_releases WHERE operation_key=$1', [operationKey])).rows[0]
  const policy = (await db.query('SELECT * FROM control.external_platform_operation_policies WHERE operation_key=$1', [operationKey])).rows[0]
  const events = async () => (await db.query('SELECT * FROM control.external_platform_operation_policy_events WHERE operation_key=$1 ORDER BY revision', [operationKey])).rows
  const registeredEvents = await events()
  assert.equal(release.contract_version, 'mx-insight-hub.native-forwarding.v1')
  assert.deepEqual(release.endpoint_keys, [operationKey])
  assert.equal(release.price_book_version, 0)
  assert.equal(policy.desired_state, 'disabled')
  assert.equal(policy.control_source, 'database')
  assert.equal(policy.revision, 1)
  assert.equal(registeredEvents.length, 1)
  assert.equal(registeredEvents[0].actor, 'migration-192')
  const operation = { operationKey, desiredState: 'disabled', controlSource: 'database', revision: 1,
    release: { status: release.status, endpointKeys: release.endpoint_keys }, priceBook: {} }
  const options = { provider: 'rapidapi', events: registeredEvents, defaults: true,
    defaultCurrency: 'CNY', defaultCurrencySource: 'deployment_default', missingBudgetMinor: 100000 }
  const defaults = planOperation(operation, options)
  assert.equal(defaults.action, 'apply')
  assert.equal(defaults.body.desiredState, 'active', 'existing deployment defaults recognize the new audited bootstrap disable')
  assert.deepEqual(defaults.body.priceBook.unitCostMinorByEndpoint, { [operationKey]: 1 })
  await db.exec(install)
  assert.deepEqual(await snapshot(), before)
  assert.deepEqual(await events(), registeredEvents, 'repeat migration cannot append a second bootstrap event')
  assert.deepEqual((await db.query('SELECT * FROM control.external_platform_operation_policies WHERE operation_key=$1', [operationKey])).rows[0], policy)

  await db.query("UPDATE control.external_platform_operation_policies SET desired_state='paused',revision=2,updated_by='operator' WHERE operation_key=$1", [operationKey])
  await db.query(`INSERT INTO control.external_platform_operation_policy_events
    (event_id,provider_key,operation_key,previous_revision,revision,previous_state,desired_state,actor,reason)
    VALUES(gen_random_uuid(),'rapidapi',$1,1,2,'disabled','paused','operator','Hold pending production validation')`, [operationKey])
  const manualPolicy = (await db.query('SELECT * FROM control.external_platform_operation_policies WHERE operation_key=$1', [operationKey])).rows[0]
  const manualEvents = await events()
  await db.exec(install)
  assert.deepEqual((await db.query('SELECT * FROM control.external_platform_operation_policies WHERE operation_key=$1', [operationKey])).rows[0], manualPolicy)
  assert.deepEqual(await events(), manualEvents)
  assert.deepEqual(await snapshot(), before)
  assert.equal(planOperation({ ...operation, desiredState: 'paused', revision: 2 }, { ...options, events: manualEvents }).body.desiredState, 'paused')
})
