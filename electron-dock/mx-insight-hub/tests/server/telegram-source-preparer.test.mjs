import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  isTelegramSourceFunctionDefinition,
  TelegramMonitorSourcePreparer,
} from '../../server/ingest/telegram/source-preparer.mjs'

const CONNECTION = Object.freeze({
  host: 'database.internal', port: 5432, database: 'night_all',
  username: 'mx_data', password: 'private', sslMode: 'disable',
})

test('Telegram source SQL serializes contract installation and bulk writes without per-row watermark updates', async () => {
  const root = new URL('../../server/ingest/telegram/sql/', import.meta.url)
  const sql = await readFile(new URL('prepare-source-v1.sql', root), 'utf8')
  const chatsIndex = await readFile(new URL('prepare-chats-cursor-index-v1.sql', root), 'utf8')
  const messagesIndex = await readFile(new URL('prepare-messages-cursor-index-v1.sql', root), 'utf8')

  assert.match(sql, /LOCK TABLE public\.tg_monitor_chats, public\.tg_monitor_messages\s+IN ACCESS EXCLUSIVE MODE/i)
  assert.match(sql, /c\.relkind = 'r' AND NOT c\.relispartition/i)
  assert.match(sql, /FROM pg_inherits i[\s\S]*i\.inhrelid = c\.oid OR i\.inhparent = c\.oid/i)
  assert.match(sql, /FOR EACH STATEMENT\s+EXECUTE FUNCTION mx_insight_hub_source\.telegram_monitor_advance_watermark/i)
  assert.match(sql, /FOR EACH ROW\s+EXECUTE FUNCTION mx_insight_hub_source\.telegram_monitor_touch_updated_at/i)
  assert.match(sql, /ENABLE ALWAYS TRIGGER mx_insight_hub_advance_watermark/i)
  assert.match(sql, /ENABLE ALWAYS TRIGGER zzzzzzzz_mx_insight_hub_touch_updated_at/i)
  assert.match(sql, /generation = EXCLUDED\.generation/i)
  assert.equal(sql.includes('session_user'), false)
  assert.match(sql, /'mx-insight-hub'::name/i)
  assert.match(sql, /REVOKE ALL ON SCHEMA mx_insight_hub_source FROM PUBLIC/i)
  assert.match(sql, /CHECK \(isfinite\(last_updated_at\)\)/i)
  assert.match(sql, /CHECK \(isfinite\(updated_at\)\) NOT VALID/gi)
  assert.match(sql, /GRANT SELECT ON mx_insight_hub_source\.telegram_monitor_watermark TO PUBLIC/i)
  assert.match(chatsIndex, /CREATE INDEX CONCURRENTLY/i)
  assert.match(messagesIndex, /CREATE INDEX CONCURRENTLY/i)
  for (const name of [
    'telegram_monitor_advance_watermark',
    'telegram_monitor_touch_updated_at',
    'telegram_monitor_deny_hard_delete',
  ]) {
    const match = sql.match(new RegExp(
      `CREATE OR REPLACE FUNCTION mx_insight_hub_source\\.${name}\\(\\)[\\s\\S]*?AS \\$mx\\$([\\s\\S]*?)\\$mx\\$;`,
    ))
    assert.ok(match, name)
    assert.equal(isTelegramSourceFunctionDefinition(name, match[1]), true, name)
  }
})

test('source inspection rejects lookalike triggers and never grants alter rights because the table owner is superuser', async () => {
  const options = []
  const client = {
    async query(sql, values = []) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] }
      if (/pg_advisory_unlock/.test(sql)) return { rows: [{ pg_advisory_unlock: true }] }
      if (/current_database\(\) AS database_name/.test(sql)) {
        return { rows: [{
          database_name: 'night_all', database_user: 'mx_data', server_version: '16.11',
          read_only: 'on', is_superuser: false, is_database_owner: false, can_create_schema: false,
        }] }
      }
      if (/to_regclass\('mx_insight_hub_source\.telegram_monitor_contract'\)/.test(sql)) {
        return { rows: [{ exists: false }] }
      }
      if (/watermark_exists/.test(sql)) {
        return { rows: [{
          watermark_exists: false, watermark_structure_ready: false,
        }] }
      }
      if (/FROM pg_proc p/.test(sql)) return { rows: [] }
      if (/FROM pg_class c/.test(sql)) {
        assert.match(sql, /NOT c\.relispartition/)
        assert.match(sql, /FROM pg_inherits i/)
        const table = values[0]
        return { rows: [{ oid: table.endsWith('chats') ? '101' : '102', owner: 'postgres', can_alter: false }] }
      }
      if (/FROM pg_attribute/.test(sql)) {
        const id = values[1]
        return { rows: [
          { name: 'updated_at', type: 'timestamp with time zone', nullable: false },
          { name: id, type: 'bigint', nullable: false },
        ] }
      }
      if (/FROM pg_trigger t/.test(sql)) {
        return { rows: [
          {
            name: 'mx_insight_hub_advance_watermark', enabled: 'A', trigger_type: 22,
            function_schema: 'public', function_name: 'lookalike', security_definer: true,
            row_level: false, before_trigger: true, on_insert: true, on_update: true,
          },
          {
            name: 'zzzzzzzz_mx_insight_hub_touch_updated_at', enabled: 'A', trigger_type: 23,
            function_schema: 'public', function_name: 'lookalike', security_definer: true,
            row_level: true, before_trigger: true, on_insert: true, on_update: true,
          },
          {
            name: 'mx_insight_hub_deny_hard_delete', enabled: 'A', trigger_type: 42,
            function_schema: 'public', function_name: 'lookalike', security_definer: true,
            row_level: false, before_trigger: true, on_insert: false, on_update: false,
          },
        ] }
      }
      if (/FROM pg_index i/.test(sql)) {
        const id = values[0] === '101' ? 'chat_id' : 'id'
        return { rows: [
          {
            name: `cursor-${id}`, valid: true, ready: true, is_unique: false, predicate: null,
            definition: `CREATE INDEX cursor_${id} ON public.t (${`updated_at, ${id}`})`,
          },
          {
            name: `unique-${id}`, valid: true, ready: true, is_unique: true, predicate: null,
            definition: `CREATE UNIQUE INDEX unique_${id} ON public.t (${id})`,
          },
        ] }
      }
      if (/FROM pg_constraint/.test(sql)) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    },
    release() {},
  }
  const preparer = new TelegramMonitorSourcePreparer({
    poolFactory: (poolOptions) => {
      options.push(poolOptions)
      return { connect: async () => client, end: async () => {} }
    },
  })
  const result = await preparer.inspect(CONNECTION)
  assert.match(options[0].options, /default_transaction_read_only=on/)
  assert.equal(result.ready, false)
  assert.equal(result.permissions.canPrepare, false)
  assert.equal(result.tables.every((table) => table.canAlter === false), true)
  assert.equal(result.tables.every((table) => !Object.hasOwn(table, 'owner')), true)
  assert.equal(result.tables.every((table) => table.trigger.installed === false), true)
  assert.equal(result.tables.every((table) => table.ready === false), true)
})
