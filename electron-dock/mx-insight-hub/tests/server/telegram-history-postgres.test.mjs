import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { decodeTelegramCursor, encodeTelegramCursor } from '../../server/data/telegram-monitor.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const options = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL queries and plans' }
const id = number => `40000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const time = fraction => `2026-10-18T12:00:00.${fraction}Z`

test('Telegram history executes bounded indexed pages with PostgreSQL timestamp semantics', options, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA core;
    CREATE TABLE core.canonical_records (
      id uuid PRIMARY KEY, dataset_id text NOT NULL, platform text NOT NULL,
      external_id text NOT NULL, object_type text NOT NULL, content_type text,
      url text, title text, body text, author_external_id text, author_name text,
      event_time timestamptz, collected_at timestamptz,
      first_seen_at timestamptz NOT NULL, deleted_at timestamptz,
      stable_fields jsonb NOT NULL DEFAULT '{}', current_revision integer NOT NULL DEFAULT 1
    );`)
  // Exercise the existing operational indexes, not a test-only query index.
  const maintenance = await readFile(new URL('../../scripts/canonical-context-serving-indexes.sql', import.meta.url), 'utf8')
  const indexStatements = [...maintenance.matchAll(/CREATE INDEX CONCURRENTLY canonical_(?:monitor|sqlite)_tg_messages_chat_time_idx[\s\S]*?;/g)]
  assert.equal(indexStatements.length, 2)
  for (const [sql] of indexStatements) await db.exec(sql.replace(' CONCURRENTLY', ''))
  let captured
  const store = new PostgresStore({ async query(sql, values) {
    captured = { sql, values }
    return db.query(sql, values)
  } })
  async function insert(number, {
    scope = 'monitor', objectType = 'message', event = null, collected = null,
    first = time('000001'), chatId = '-1001', deleted = null, platform = 'telegram',
    title = 'keyword', username = null,
  } = {}) {
    await db.query(`INSERT INTO core.canonical_records
      (id,dataset_id,platform,external_id,object_type,event_time,collected_at,first_seen_at,
       deleted_at,stable_fields,title,body)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
      id(number), `telegram.${scope}.${objectType === 'chat' ? 'chats' : 'messages'}.v1`,
      platform, objectType === 'chat' ? chatId : `${chatId}:${number}`, objectType,
      event, collected, first, deleted,
      { relations: { chatId }, attributes: { username, chatType: 'group' } },
      title, `keyword body ${number}`,
    ])
  }
  // Same-millisecond timestamps deliberately disagree with UUID order.
  await insert(1, { event: time('000900') })
  await insert(8, { scope: 'sqlite', event: time('000800') })
  await insert(7, { collected: time('000700') })
  await insert(6, { scope: 'sqlite', first: time('000600') })
  await insert(5, { event: time('000600') })
  await insert(4, { event: time('000500'), deleted: time('001000') })
  await insert(3, { event: time('000500'), chatId: '-other' })
  await insert(2, { event: time('000500'), platform: 'other' })
  await insert(100, { objectType: 'chat', event: time('000900'), username: 'monitor_chat' })
  await insert(101, { scope: 'sqlite', objectType: 'chat', collected: time('000800'), username: 'sqlite_chat' })

  await t.test('merged history preserves fallback times, microseconds and exact keyset boundaries', async () => {
    const seen = []
    let cursor = null
    for (let page = 0; page < 10; page += 1) {
      const rows = await store.listAdminTelegramMessages({ chatExternalId: '-1001', pageSize: 1, cursor })
      if (!rows.length) break
      seen.push(rows[0].id)
      assert.match(rows[0].sort_time, /\.\d{6}Z$/)
      if (rows.length <= 1) break
      cursor = decodeTelegramCursor(encodeTelegramCursor({ sortTime: rows[0].sort_time, id: rows[0].id }))
    }
    assert.deepEqual(seen, [1, 8, 7, 6, 5].map(id))
    assert.equal(new Set(seen).size, seen.length)
    const bounded = await store.listAdminTelegramMessages({
      chatExternalId: '-1001', pageSize: 10, from: time('000600'), to: time('000800'),
    })
    assert.deepEqual(bounded.map(row => row.id), [8, 7, 6, 5].map(id))
  })

  await t.test('source scope, unrelated chat, deleted rows and platform boundaries remain intact', async () => {
    for (const [sourceScope, expected] of [['monitor', [1, 7, 5]], ['sqlite', [8, 6]]]) {
      const rows = await store.listAdminTelegramMessages({ chatExternalId: '-1001', sourceScope, pageSize: 10 })
      assert.deepEqual(rows.map(row => row.id), expected.map(id))
    }
    const global = await store.listAdminTelegramMessages({ chatExternalId: null, pageSize: 10 })
    assert.deepEqual(global.map(row => row.id), [1, 8, 7, 6, 5, 3].map(id))
  })

  await t.test('directory, substring search and legacy pages retain exact timestamp cursor values', async () => {
    const chats = await store.listAdminTelegramChats({ pageSize: 10 })
    assert.deepEqual(chats.map(row => row.sort_time), [time('000900'), time('000800')])
    const search = await store.searchAdminTelegramMessages({ query: 'keyword', chatExternalId: '-1001', pageSize: 10 })
    assert.deepEqual(search.map(row => row.id), [1, 8, 7, 6, 5].map(id))
    assert.equal(search[0].sort_time, time('000900'))
    const legacy = await store.listCanonicalRecords({
      datasetId: 'telegram.monitor.messages.v1', platform: 'telegram', objectType: 'message',
      pageSize: 10, chatId: '-1001',
    })
    assert.deepEqual(legacy.map(row => row.sort_time), [time('000900'), time('000600')])
  })

  await t.test('qualified chat keys resolve the canonical primary key without alias collisions', async () => {
    // An external-ID alias must not override an explicit canonical chat key.
    await insert(102, { objectType: 'chat', chatId: id(100), event: time('000950') })
    assert.equal((await store.getAdminTelegramChat(`monitor:${id(100)}`)).id, id(100))
    assert.equal(await store.getAdminTelegramChat(`sqlite:${id(100)}`), null)
    assert.equal((await store.getAdminTelegramChat('@monitor_chat', 'monitor')).id, id(100))
    assert.equal((await store.getAdminTelegramChat('-1001', 'sqlite')).id, id(101))
  })

  await t.test('Admin substring matching treats percent, underscore and backslash as literal text', async () => {
    for (const [number, title] of [[201, '增长100%'], [202, '部署a_b'], [203, '目录a\\b']]) {
      await insert(number, { chatId: '-literal', event: time('000900'), title })
    }
    for (const [query, expected] of [['100%', 201], ['a_b', 202], ['a\\b', 203]]) {
      const rows = await store.searchAdminTelegramMessages({ query, chatExternalId: '-literal', pageSize: 10 })
      assert.deepEqual(rows.map(row => row.id), [id(expected)])
    }
    assert.deepEqual(await store.searchAdminTelegramMessages({ query: '%', chatExternalId: '-1001', pageSize: 10 }), [])
  })

  await t.test('large dated chats use existing partial indexes and hydrate only the final page', async () => {
    await db.exec(`INSERT INTO core.canonical_records
      (id,dataset_id,platform,external_id,object_type,event_time,first_seen_at,stable_fields,body)
      SELECT md5('large-message-' || n)::uuid,
             CASE WHEN n % 2 = 0 THEN 'telegram.monitor.messages.v1' ELSE 'telegram.sqlite.messages.v1' END,
             'telegram', '-large:' || n, 'message',
             '2026-10-18T00:00:00Z'::timestamptz + n * interval '1 microsecond',
             '2026-10-18T00:00:00Z', '{"relations":{"chatId":"-large"}}', repeat('wide body ', 200)
        FROM generate_series(1, 12000) n;
      ANALYZE core.canonical_records;`)
    const page = await store.listAdminTelegramMessages({ chatExternalId: '-large', pageSize: 2 })
    assert.equal(page.length, 3)
    const { rows } = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${captured.sql}`, captured.values)
    const plan = rows[0]['QUERY PLAN'][0].Plan
    const nodes = []
    function visit(node) { nodes.push(node); for (const child of node.Plans || []) visit(child) }
    visit(plan)
    for (const source of ['monitor', 'sqlite']) {
      assert.ok(nodes.some(node => node['Index Name'] === `canonical_${source}_tg_messages_chat_time_idx`),
        `existing ${source} chat/time index must serve the real query`)
    }
    const narrowPage = nodes.find(node => node['Subplan Name'] === 'CTE page')
    assert.equal(narrowPage['Actual Rows'], 3)
    assert.ok(narrowPage['Plan Width'] <= 32, 'materialized page contains UUID/time, not message bodies')
    assert.equal(nodes.filter(node => node['Index Cond']?.includes('event_time IS NOT NULL')).length, 2)
    assert.equal(nodes.filter(node => node['Index Cond']?.includes('event_time IS NULL')).length, 2)
    assert.ok(nodes.some(node => node['Index Name'] === 'canonical_records_pkey' && node['Actual Loops'] === 3))
  })
})
