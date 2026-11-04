import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { StrategySearchRoutingStore } from '../../server/external-platforms/strategy-search-routing.mjs'

const change = (patch = {}) => ({ mode: 'fixed', primaryProvider: 'tikhub', fallbackProvider: null,
  expectedRevision: 1, reason: 'Reviewed compatible supplier', ...patch })

test('strategy search seeds Twitter priority, preserves Instagram and keeps unrelated policies outside this store', async () => {
  const store = new StrategySearchRoutingStore()
  assert.deepEqual(await store.get('search', 'instagram'), { interface: 'search', platform: 'instagram',
    mode: 'fixed', primaryProvider: 'justone', fallbackProvider: null, revision: 1, reason: 'initial_route', updatedAt: null })
  assert.deepEqual(await store.get('search', 'twitter'), { interface: 'search', platform: 'twitter',
    mode: 'priority', primaryProvider: 'rapidapi', fallbackProvider: 'tikhub', revision: 1, reason: 'initial_route', updatedAt: null })
  for (const [interfaceId, platform] of [['search','facebook'], ['raw','twitter'], ['crawl','twitter'], ['user-info','twitter'], ['crawl','instagram'], ['user-info','instagram']]) {
    assert.equal(await store.get(interfaceId, platform), null)
    await assert.rejects(store.update(interfaceId, platform, change()), { code: 'strategy_search_route_read_only' })
  }
  const rows = await store.list()
  rows[0].primaryProvider = 'tikhub'
  assert.equal((await store.get('search','instagram')).primaryProvider, 'justone')
  assert.equal(store.events.length, 0)
})

test('Twitter strategies support fixed, reversed priority and pause without accepting Instagram providers', async () => {
  const store = new StrategySearchRoutingStore()
  for (const input of [change({ primaryProvider: 'justone' }), change({ mode: 'priority', fallbackProvider: 'justone' }),
    change({ mode: 'priority', primaryProvider: 'rapidapi', fallbackProvider: 'rapidapi' }), change({ mode: 'auto' })]) {
    await assert.rejects(store.update('search', 'twitter', input), { code: 'invalid_strategy_search_route' })
  }
  const fixed = await store.update('search', 'twitter', change())
  assert.equal(fixed.mode, 'fixed')
  assert.equal(fixed.primaryProvider, 'tikhub')
  const priority = await store.update('search', 'twitter', change({ mode: 'priority', fallbackProvider: 'rapidapi', expectedRevision: 2 }))
  assert.equal(priority.fallbackProvider, 'rapidapi')
  await assert.rejects(store.update('search', 'twitter', change()), { code: 'strategy_search_route_revision_conflict' })
  const paused = await store.update('search', 'twitter', change({ mode: 'paused', expectedRevision: 3 }))
  assert.equal(paused.mode, 'paused')
  assert.equal(store.events.length, 3)
  assert.equal((await store.get('search', 'instagram')).revision, 1)
})

test('strategy changes use revision CAS and record a separate immutable snapshot', async () => {
  const store = new StrategySearchRoutingStore()
  const [first, second] = await Promise.allSettled([
    store.update('search', 'instagram', change()),
    store.update('search', 'instagram', change({ mode: 'priority', fallbackProvider: 'justone' })),
  ])
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  assert.equal(second.reason.code, 'strategy_search_route_revision_conflict')
  first.value.primaryProvider = 'justone'
  assert.equal((await store.get('search','instagram')).primaryProvider, 'tikhub')
  assert.equal(store.events[0].primaryProvider, 'tikhub')
  assert.equal(store.events[0].actor, 'admin-token')
  const priority = await store.update('search', 'instagram', change({ mode: 'priority', fallbackProvider: 'justone', expectedRevision: 2 }))
  assert.equal(priority.revision, 3)
  assert.equal(priority.fallbackProvider, 'justone')
  const paused = await store.update('search','instagram', change({ mode: 'paused', expectedRevision: 3 }))
  assert.equal(paused.mode, 'paused')
  assert.equal(store.events.length, 3)
  assert.equal(store.events[0].revision, 2)
})

test('incompatible fallback, missing revision/reason and undeclared fields never mutate configuration', async () => {
  const store = new StrategySearchRoutingStore()
  for (const input of [null, [], 'invalid', change({ primaryProvider: 'rapidapi' }), change({ mode: 'auto' }),
    change({ fallbackProvider: 'justone' }), change({ fallbackProvider: undefined }),
    change({ mode: 'priority' }), change({ mode: 'priority', fallbackProvider: 'tikhub' }),
    change({ mode: 'paused', fallbackProvider: 'justone' }), change({ expectedRevision: 0 }),
    change({ expectedRevision: '1' }), change({ reason: '  ' }), change({ reason: 'a'.repeat(1001) }),
    change({ providerKey: 'tikhub' }), change({ retry: true })]) {
    await assert.rejects(store.update('search','instagram', input), { code: 'invalid_strategy_search_route' })
  }
  assert.equal((await store.get('search','instagram')).revision, 1)
  assert.equal(store.events.length, 0)
})

test('missing, corrupt or unreadable deployed configuration fails closed without selecting a supplier', async () => {
  for (const pool of [
    { query: async () => ({ rows: [] }) },
    { query: async () => ({ rows: [{ interface_key: 'search', platform: 'instagram', mode: 'fixed', primary_provider: 'rapidapi', revision: 1 }] }) },
    { query: async () => { throw new Error('database unavailable') } },
  ]) {
    const store = new StrategySearchRoutingStore(pool)
    await assert.rejects(store.get('search','instagram'), { status: 503, code: 'strategy_search_route_unavailable' })
  }
})

test('SQL migration, CAS and audit failure rollback preserve the last reviewed strategy', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec('CREATE SCHEMA control')
  await db.exec(await readFile(new URL('../../migrations/150_strategy_search_routes.sql', import.meta.url), 'utf8'))
  const pool = { query: (sql, values) => db.query(sql, values), connect: async () => ({ query: (sql, values) => db.query(sql, values), release() {} }) }
  const store = new StrategySearchRoutingStore(pool)
  assert.equal((await store.list()).length, 1)
  assert.equal((await store.get('search','instagram')).primaryProvider, 'justone')
  const result = await store.update('search','instagram', change({ mode: 'priority', fallbackProvider: 'justone', reason: ' Reviewed priority ' }))
  assert.equal(result.revision, 2)
  assert.equal(result.reason, 'Reviewed priority')
  await assert.rejects(store.update('search','instagram', change()), { code: 'strategy_search_route_revision_conflict' })
  const events = (await db.query('SELECT actor,policy FROM control.strategy_search_route_events ORDER BY revision')).rows
  assert.deepEqual(events.map(row => row.actor), ['migration-150','admin-token'])
  assert.equal(events[0].policy.primaryProvider, 'justone')
  assert.equal(events[1].policy.mode, 'priority')
  assert.equal(events[1].policy.revision, 2)
  await db.exec('ALTER TABLE control.strategy_search_route_events ADD CHECK (revision < 3)')
  await assert.rejects(store.update('search','instagram', change({ expectedRevision: 2 })))
  assert.equal((await store.get('search','instagram')).revision, 2)
  assert.equal((await store.get('search','instagram')).mode, 'priority')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM control.strategy_search_route_events')).rows[0].n, 2)
  // Database guards also reject invalid direct writes, independently of JS validation.
  await assert.rejects(db.query("UPDATE control.strategy_search_routes SET fallback_provider=primary_provider"))
  await assert.rejects(db.query("UPDATE control.strategy_search_routes SET mode='fixed'"))
  await assert.rejects(db.query("UPDATE control.strategy_search_routes SET primary_provider='rapidapi'"))
  await assert.rejects(db.query("UPDATE control.strategy_search_routes SET platform='facebook'"))
  assert.equal((await store.get('search','instagram')).revision, 2)
})

test('Twitter migration seeds once, preserves reviewed strategies and enforces platform-specific SQL constraints', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec('CREATE SCHEMA control')
  await db.exec(await readFile(new URL('../../migrations/150_strategy_search_routes.sql', import.meta.url), 'utf8'))
  const pool = { query: (sql, values) => db.query(sql, values), connect: async () => ({ query: (sql, values) => db.query(sql, values), release() {} }) }
  const store = new StrategySearchRoutingStore(pool)
  const instagram = await store.update('search', 'instagram', change({ mode: 'paused' }))
  const migration = await readFile(new URL('../../migrations/160_twitter_strategy_search.sql', import.meta.url), 'utf8')
  // An audit failure cannot leave a seeded route without its audit snapshot.
  await db.exec("ALTER TABLE control.strategy_search_route_events ADD CONSTRAINT reject_twitter_audit CHECK (platform <> 'twitter')")
  await assert.rejects(db.exec(migration))
  assert.equal((await db.query("SELECT count(*)::int AS n FROM control.strategy_search_routes WHERE platform='twitter'")).rows[0].n, 0)
  await db.exec('ALTER TABLE control.strategy_search_route_events DROP CONSTRAINT reject_twitter_audit')
  await db.exec(migration)
  const seed = await store.get('search', 'twitter')
  assert.equal(seed.primaryProvider, 'rapidapi')
  assert.equal(seed.fallbackProvider, 'tikhub')
  assert.equal(seed.mode, 'priority')
  assert.equal((await store.list()).length, 2)
  const twitter = await store.update('search', 'twitter', change({ mode: 'paused' }))
  await db.exec(migration)
  assert.deepEqual(await store.get('search', 'twitter'), twitter)
  assert.deepEqual(await store.get('search', 'instagram'), instagram)
  const events = (await db.query("SELECT actor,policy FROM control.strategy_search_route_events WHERE platform='twitter' ORDER BY revision")).rows
  assert.deepEqual(events.map(row => row.actor), ['migration-160', 'admin-token'])
  assert.equal(events[0].policy.primaryProvider, 'rapidapi')
  assert.equal(events[1].policy.mode, 'paused')
  await db.exec("ALTER TABLE control.strategy_search_route_events ADD CHECK (platform <> 'twitter' OR revision < 3)")
  await assert.rejects(store.update('search', 'twitter', change({ expectedRevision: 2 })))
  assert.deepEqual(await store.get('search', 'twitter'), twitter)
  for (const sql of [
    "UPDATE control.strategy_search_routes SET primary_provider='justone' WHERE platform='twitter'",
    "UPDATE control.strategy_search_routes SET primary_provider='rapidapi' WHERE platform='instagram'",
    "UPDATE control.strategy_search_routes SET mode='priority',fallback_provider='justone' WHERE platform='twitter'",
    "UPDATE control.strategy_search_routes SET mode='priority',fallback_provider='rapidapi' WHERE platform='instagram'",
    "UPDATE control.strategy_search_routes SET mode='priority',fallback_provider=primary_provider WHERE platform='twitter'",
    "UPDATE control.strategy_search_routes SET platform='facebook' WHERE platform='twitter'",
  ]) await assert.rejects(db.query(sql))
  assert.deepEqual(await store.get('search', 'twitter'), twitter)
})

test('Facebook account policies are independent, fixed to JustOne and revisioned', async () => {
  const store = new StrategySearchRoutingStore()
  const pause = change({ mode: 'paused', primaryProvider: 'justone' })
  await store.update('user-info', 'facebook', pause)
  assert.equal((await store.get('crawl', 'facebook')).mode, 'fixed')
  assert.equal((await store.get('search', 'instagram')).revision, 1)
  assert.equal(await store.get('search', 'facebook'), null)
  await assert.rejects(store.update('user-info', 'facebook', pause), { code: 'strategy_search_route_revision_conflict' })
  for (const invalid of [change(), change({ primaryProvider: 'rapidapi' }),
    change({ primaryProvider: 'justone', mode: 'priority', fallbackProvider: 'tikhub' })]) {
    await assert.rejects(store.update('crawl', 'facebook', invalid), { code: 'invalid_strategy_search_route' })
  }
  assert.equal(store.events[0].interface, 'user-info')
  await store.update('crawl', 'facebook', pause)
  await store.update('user-info', 'facebook', change({ primaryProvider: 'justone', expectedRevision: 2 }))
  assert.equal((await store.get('crawl', 'facebook')).mode, 'paused')
})

test('Facebook migration preserves other routes, enforces business scope and audits once', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA control')
  for (const file of ['150_strategy_search_routes.sql', '160_twitter_strategy_search.sql', '170_facebook_account_business_pause.sql']) {
    await db.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'))
  }
  const pool = { query: (sql, values) => db.query(sql, values), connect: async () => ({ query: (sql, values) => db.query(sql, values), release() {} }) }
  const store = new StrategySearchRoutingStore(pool)
  await store.update('crawl', 'facebook', change({ mode: 'paused', primaryProvider: 'justone' }))
  assert.equal((await store.get('user-info', 'facebook')).mode, 'fixed')
  assert.equal((await store.get('search', 'twitter')).mode, 'priority')
  assert.equal((await store.list()).length, 4)
  await db.exec(await readFile(new URL('../../migrations/170_facebook_account_business_pause.sql', import.meta.url), 'utf8'))
  assert.equal((await store.get('crawl', 'facebook')).mode, 'paused')
  assert.equal((await store.get('crawl', 'facebook')).revision, 2)
  for (const sql of ["UPDATE control.strategy_search_routes SET interface_key='search' WHERE platform='facebook'",
    "UPDATE control.strategy_search_routes SET primary_provider='tikhub' WHERE platform='facebook'",
    "UPDATE control.strategy_search_routes SET mode='priority',fallback_provider='tikhub' WHERE platform='facebook'"]) {
    await assert.rejects(db.query(sql))
  }
  const audit = await db.query("SELECT policy FROM control.strategy_search_route_events WHERE platform='facebook' ORDER BY id")
  assert.equal(audit.rows.length, 3)
  assert.equal(audit.rows[2].policy.interface, 'crawl')
  assert.equal(audit.rows[2].policy.mode, 'paused')
})
