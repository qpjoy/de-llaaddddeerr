import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { AppError } from '../../core/errors.mjs'

export const TELEGRAM_SOURCE_CONTRACT_VERSION = 1
export const TELEGRAM_SOURCE_FUNCTION_HASHES = Object.freeze({
  telegram_monitor_advance_watermark: '9b5640a9480d351f96957efcbac7af31bc6b01d7703fb34e97e93fad3fa4c357',
  telegram_monitor_touch_updated_at: '919041b54147963164605e34608dfd12915b20ed70126b01fbee78b02c168833',
  telegram_monitor_deny_hard_delete: '5fb0b76dbe119d78c27a8363c1da99684fc4e7cbd039e2239fbcaeac433206ce',
})

const CONTRACT_KEY = 'telegram-monitor'
const SOURCE_LOCK_KEY = 'mx-insight-hub:telegram-monitor:source-prepare'
const SOURCE_CONNECTION_TIMEOUT_MS = 10_000
const SQL_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'sql')
const TABLES = Object.freeze([
  Object.freeze({
    role: 'chats',
    table: 'public.tg_monitor_chats',
    idColumn: 'chat_id',
    cursorIndexName: 'mx_insight_hub_tg_monitor_chats_cursor_idx',
    dropScript: 'drop-chats-cursor-index-v1.sql',
    createScript: 'prepare-chats-cursor-index-v1.sql',
  }),
  Object.freeze({
    role: 'messages',
    table: 'public.tg_monitor_messages',
    idColumn: 'id',
    cursorIndexName: 'mx_insight_hub_tg_monitor_messages_cursor_idx',
    dropScript: 'drop-messages-cursor-index-v1.sql',
    createScript: 'prepare-messages-cursor-index-v1.sql',
  }),
])

export function telegramSourceFunctionHash(source) {
  return createHash('sha256').update(String(source).trim().replace(/\s+/g, ' ')).digest('hex')
}

export function isTelegramSourceFunctionDefinition(name, source) {
  return TELEGRAM_SOURCE_FUNCTION_HASHES[name] === telegramSourceFunctionHash(source)
}

function directConnectionOptions(connection) {
  const sslMode = connection.sslMode ?? 'require'
  let ssl = false
  if (sslMode === 'require') ssl = { rejectUnauthorized: false }
  if (sslMode === 'verify-ca') {
    ssl = { rejectUnauthorized: true, checkServerIdentity: () => undefined }
  }
  if (sslMode === 'verify-full') ssl = { rejectUnauthorized: true }
  return {
    host: connection.host,
    port: connection.port ?? 5432,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    ssl,
  }
}

function safePrepareError(error, details = undefined) {
  if (error instanceof AppError) return error
  if (error?.code === '42501') {
    return new AppError(
      403,
      'source_prepare_insufficient_privileges',
      'The migration account cannot install the Telegram source contract',
      details,
    )
  }
  if (error?.code === '55P03') {
    return new AppError(
      409,
      'source_prepare_locked',
      'The Telegram source tables are locked; retry after upstream maintenance finishes',
      details,
    )
  }
  return new AppError(
    503,
    'source_prepare_failed',
    'Telegram source preparation failed; the pipeline remains paused',
    details,
  )
}

function uniqueIdIndex(definition, idColumn, unique, predicate) {
  if (!unique || predicate) return false
  const sql = String(definition).replace(/"/g, '')
  const order = '(?:\\s+(?:asc|desc))?(?:\\s+nulls\\s+(?:first|last))?'
  return new RegExp(`\\(\\s*${idColumn}\\s*${order}\\s*\\)`, 'i').test(sql)
}

function step(key, ready, neededMessage, readyMessage) {
  return {
    key,
    status: ready ? 'ready' : 'needed',
    message: ready ? readyMessage : neededMessage,
  }
}

function publicTableDefinition({ role, table, idColumn, cursorIndexName }) {
  return { role, table, idColumn, cursorIndexName }
}

function resultSteps({ tables, infrastructure, installedVersion, sourceIdentityChanged }) {
  const columnsReady = tables.every((table) => table.updatedAt.ready && table.stableId.ready)
  const triggersReady = tables.every((table) => (
    table.trigger.installed
    && table.trigger.enabledAlways
    && table.trigger.laterCompetingTriggers.length === 0
  ))
  const deletesReady = tables.every((table) => table.deleteGuard.installed && table.deleteGuard.enabledAlways)
  const indexesReady = tables.every((table) => table.cursorIndex.ready)
  return [
    step('tables', tables.every((table) => table.exists), 'Required TG tables must exist', 'Both fixed TG tables exist'),
    step('updated_at', columnsReady, 'Cursor and stable-ID columns need migration or repair', 'Cursor and stable-ID columns are safe'),
    step('watermark', infrastructure.ready, 'Shared watermark functions need installation', 'Shared source watermark is installed'),
    step('triggers', triggersReady, 'Writer triggers need installation', 'Writer triggers are ENABLE ALWAYS'),
    step('hard_delete_guard', deletesReady, 'Hard-delete guards need installation', 'DELETE and TRUNCATE guards are installed'),
    step('cursor_indexes', indexesReady, 'Valid cursor indexes need creation', 'Cursor indexes are valid and ready'),
    step(
      'contract_marker',
      installedVersion === TELEGRAM_SOURCE_CONTRACT_VERSION && !sourceIdentityChanged,
      'The source contract marker needs installation',
      `Source contract v${TELEGRAM_SOURCE_CONTRACT_VERSION} is recorded`,
    ),
  ]
}

/**
 * Installs the fixed TG source-side writer contract.
 *
 * This class is deliberately separate from DatabaseSourcePuller: the puller
 * remains read-only for its entire lifetime, while this workload exists only
 * behind the explicit Admin Token preparation action.
 */
export class TelegramMonitorSourcePreparer {
  constructor({ poolFactory = (options) => new pg.Pool(options) } = {}) {
    this.poolFactory = poolFactory
    this.scripts = new Map()
  }

  async #script(name) {
    if (!this.scripts.has(name)) {
      this.scripts.set(name, readFile(join(SQL_ROOT, name), 'utf8'))
    }
    return this.scripts.get(name)
  }

  #pool(connection, { writable }) {
    if (connection?.dsnEnv) {
      throw new AppError(
        400,
        'source_prepare_direct_credentials_required',
        'Telegram source preparation requires the saved direct connection or one-time migration credentials',
      )
    }
    return this.poolFactory({
      ...directConnectionOptions(connection),
      max: 1,
      application_name: writable
        ? 'mx-insight-hub-telegram-source-prepare'
        : 'mx-insight-hub-telegram-source-inspect',
      connectionTimeoutMillis: SOURCE_CONNECTION_TIMEOUT_MS,
      statement_timeout: 900_000,
      options: `-c default_transaction_read_only=${writable ? 'off' : 'on'} -c lock_timeout=5000`,
    })
  }

  async #identity(client) {
    const { rows } = await client.query(
      `SELECT current_database() AS database_name,
              current_user AS database_user,
              current_setting('server_version') AS server_version,
              current_setting('transaction_read_only') AS read_only,
              r.rolsuper AS is_superuser,
              pg_has_role(current_user, d.datdba, 'MEMBER') AS is_database_owner,
              has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema
         FROM pg_roles r
         JOIN pg_database d ON d.datname = current_database()
        WHERE r.rolname = current_user`,
    )
    return rows[0] || {}
  }

  async #contractMarker(client) {
    const exists = await client.query(
      `SELECT to_regclass('mx_insight_hub_source.telegram_monitor_contract') IS NOT NULL AS exists`,
    )
    if (!exists.rows[0]?.exists) return null
    try {
      const { rows } = await client.query(
        `SELECT version, generation, chats_table_oid::text, messages_table_oid::text,
                installed_at
           FROM mx_insight_hub_source.telegram_monitor_contract
          WHERE contract_key = $1`,
        [CONTRACT_KEY],
      )
      return rows[0] || null
    } catch (error) {
      if (error?.code === '42501') return null
      throw error
    }
  }

  async #infrastructure(client) {
    const [relations, functions] = await Promise.all([
      client.query(
        `SELECT
           to_regclass('mx_insight_hub_source.telegram_monitor_watermark') IS NOT NULL AS watermark_exists,
           EXISTS (
             SELECT 1
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'mx_insight_hub_source'
                AND c.relname = 'telegram_monitor_watermark'
                AND c.relkind = 'r'
                AND NOT c.relrowsecurity
                AND NOT c.relforcerowsecurity
                AND (SELECT count(*) FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) = 2
                AND EXISTS (
                  SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attname = 'singleton'
                     AND a.atttypid = 'boolean'::regtype AND a.attnotnull
                )
                AND EXISTS (
                  SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attname = 'last_updated_at'
                     AND a.atttypid = 'timestamp with time zone'::regtype AND a.attnotnull
                )
                AND EXISTS (
                  SELECT 1 FROM pg_constraint con
                   WHERE con.conrelid = c.oid AND con.contype = 'p'
                     AND pg_get_constraintdef(con.oid) = 'PRIMARY KEY (singleton)'
                )
                AND EXISTS (
                  SELECT 1 FROM pg_constraint con
                   WHERE con.conrelid = c.oid AND con.contype = 'c' AND con.convalidated
                     AND pg_get_expr(con.conbin, con.conrelid) = 'singleton'
                )
                AND EXISTS (
                  SELECT 1 FROM pg_constraint con
                   WHERE con.conrelid = c.oid AND con.contype = 'c' AND con.convalidated
                     AND pg_get_expr(con.conbin, con.conrelid) = 'isfinite(last_updated_at)'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                )
           ) AS watermark_structure_ready`,
      ),
      client.query(
        `SELECT p.proname AS name, p.prosecdef AS security_definer, p.prosrc AS source,
                p.proconfig AS config,
                p.proowner = c.relowner AS owner_matches_watermark,
                l.lanname AS language
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_language l ON l.oid = p.prolang
           LEFT JOIN pg_class c
             ON c.oid = to_regclass('mx_insight_hub_source.telegram_monitor_watermark')
          WHERE n.nspname = 'mx_insight_hub_source'
            AND p.proname IN (
              'telegram_monitor_advance_watermark',
              'telegram_monitor_touch_updated_at',
              'telegram_monitor_deny_hard_delete'
            )
            AND p.pronargs = 0
            AND p.prorettype = 'pg_catalog.trigger'::regtype`,
      ),
    ])
    const row = relations.rows[0] || {}
    let watermarkRowReady = false
    if (row.watermark_structure_ready === true) {
      try {
        const watermark = await client.query(
          `SELECT count(*)::integer AS row_count,
                  count(*) FILTER (
                    WHERE singleton IS TRUE AND isfinite(last_updated_at)
                  )::integer AS valid_row_count
             FROM mx_insight_hub_source.telegram_monitor_watermark`,
        )
        watermarkRowReady = Number(watermark.rows[0]?.row_count) === 1
          && Number(watermark.rows[0]?.valid_row_count) === 1
      } catch (error) {
        if (error?.code !== '42501') throw error
      }
    }
    const functionReady = (name, expectedSearchPath) => {
      const fn = functions.rows.find((candidate) => candidate.name === name)
      const config = Array.isArray(fn?.config) ? fn.config.join(',').replace(/\s+/g, '') : ''
      return fn?.security_definer === true
        && fn?.language === 'plpgsql'
        && fn?.owner_matches_watermark === true
        && config.includes(`search_path=${expectedSearchPath}`.replace(/\s+/g, ''))
        && isTelegramSourceFunctionDefinition(name, fn?.source)
    }
    const advanceFunctionExists = functionReady(
      'telegram_monitor_advance_watermark',
      'pg_catalog,mx_insight_hub_source',
    )
    const touchFunctionExists = functionReady(
      'telegram_monitor_touch_updated_at',
      'pg_catalog,mx_insight_hub_source',
    )
    const deleteFunctionExists = functionReady('telegram_monitor_deny_hard_delete', 'pg_catalog')
    return {
      watermarkExists: row.watermark_exists === true,
      watermarkStructureReady: row.watermark_structure_ready === true,
      watermarkRowReady,
      advanceFunctionExists,
      touchFunctionExists,
      deleteFunctionExists,
      ready: row.watermark_exists === true
        && row.watermark_structure_ready === true
        && watermarkRowReady
        && advanceFunctionExists
        && touchFunctionExists
        && deleteFunctionExists,
    }
  }

  async #table(client, definition) {
    const relation = await client.query(
      `SELECT c.oid::text AS oid,
              r.rolname AS owner,
              cr.rolsuper OR pg_has_role(current_user, c.relowner, 'MEMBER') AS can_alter
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
         JOIN pg_roles cr ON cr.rolname = current_user
        WHERE n.nspname = 'public' AND c.relname = $1
          AND c.relkind = 'r' AND NOT c.relispartition
          AND NOT EXISTS (
            SELECT 1 FROM pg_inherits i
             WHERE i.inhrelid = c.oid OR i.inhparent = c.oid
          )`,
      [definition.table.split('.')[1]],
    )
    const relationRow = relation.rows[0]
    if (!relationRow) {
      return {
        ...publicTableDefinition(definition),
        exists: false,
        ready: false,
        oid: null,
        canAlter: false,
        stableId: { exists: false, nullable: null, unique: false, ready: false },
        updatedAt: { exists: false, type: null, nullable: null, finite: false, ready: false },
        trigger: { installed: false, enabledAlways: false, laterCompetingTriggers: [] },
        deleteGuard: { installed: false, enabledAlways: false },
        cursorIndex: {
          exists: false, name: null, valid: false, ready: false, namedIndexExists: false,
        },
      }
    }

    const [columns, triggers, indexes, constraints] = await Promise.all([
      client.query(
        `SELECT attname AS name, atttypid::regtype::text AS type, NOT attnotnull AS nullable
           FROM pg_attribute
          WHERE attrelid = $1::oid AND attnum > 0 AND NOT attisdropped
            AND attname IN ('updated_at', $2)`,
        [relationRow.oid, definition.idColumn],
      ),
      client.query(
        `SELECT t.tgname AS name, t.tgenabled AS enabled, t.tgtype AS trigger_type,
                pn.nspname AS function_schema, p.proname AS function_name,
                p.prosecdef AS security_definer,
                t.tgqual IS NULL AS no_when_clause,
                t.tgattr = ''::int2vector AS no_column_filter,
                t.tgnargs = 0 AS no_arguments,
                (t.tgtype & 1) = 1 AS row_level,
                (t.tgtype & 2) = 2 AS before_trigger,
                (t.tgtype & 4) = 4 AS on_insert,
                (t.tgtype & 16) = 16 AS on_update
           FROM pg_trigger t
           JOIN pg_proc p ON p.oid = t.tgfoid
           JOIN pg_namespace pn ON pn.oid = p.pronamespace
          WHERE t.tgrelid = $1::oid AND NOT t.tgisinternal`,
        [relationRow.oid],
      ),
      client.query(
        `SELECT ci.relname AS name,
                i.indisvalid AS valid,
                i.indisready AS ready,
                i.indisunique AS is_unique,
                pg_get_expr(i.indpred, i.indrelid) AS predicate,
                am.amname AS access_method,
                i.indexprs IS NULL AS no_expressions,
                i.indpred IS NULL AS no_predicate,
                pg_get_indexdef(i.indexrelid, 1, true) AS first_key,
                pg_get_indexdef(i.indexrelid, 2, true) AS second_key,
                pg_get_indexdef(i.indexrelid) AS definition
           FROM pg_index i
           JOIN pg_class ci ON ci.oid = i.indexrelid
           JOIN pg_am am ON am.oid = ci.relam
          WHERE i.indrelid = $1::oid
          ORDER BY ci.relname`,
        [relationRow.oid],
      ),
      client.query(
        `SELECT conname AS name, convalidated AS validated,
                pg_get_expr(conbin, conrelid) AS expression
           FROM pg_constraint
          WHERE conrelid = $1::oid AND contype = 'c'`,
        [relationRow.oid],
      ),
    ])
    const updatedAt = columns.rows.find((column) => column.name === 'updated_at')
    const stableId = columns.rows.find((column) => column.name === definition.idColumn)
    const advanceTrigger = triggers.rows.find((trigger) => (
      trigger.name === 'mx_insight_hub_advance_watermark'
      && Number(trigger.trigger_type) === 22
      && trigger.function_schema === 'mx_insight_hub_source'
      && trigger.function_name === 'telegram_monitor_advance_watermark'
      && trigger.security_definer === true
      && trigger.no_when_clause === true
      && trigger.no_column_filter === true
      && trigger.no_arguments === true
    ))
    const touchTrigger = triggers.rows.find((trigger) => (
      trigger.name === 'zzzzzzzz_mx_insight_hub_touch_updated_at'
      && Number(trigger.trigger_type) === 23
      && trigger.function_schema === 'mx_insight_hub_source'
      && trigger.function_name === 'telegram_monitor_touch_updated_at'
      && trigger.security_definer === true
      && trigger.no_when_clause === true
      && trigger.no_column_filter === true
      && trigger.no_arguments === true
    ))
    const deleteTrigger = triggers.rows.find((trigger) => (
      trigger.name === 'mx_insight_hub_deny_hard_delete'
      && Number(trigger.trigger_type) === 42
      && trigger.function_schema === 'mx_insight_hub_source'
      && trigger.function_name === 'telegram_monitor_deny_hard_delete'
      && trigger.security_definer === true
      && trigger.no_when_clause === true
      && trigger.no_column_filter === true
      && trigger.no_arguments === true
    ))
    const laterCompetingTriggers = triggers.rows.filter((trigger) => (
      trigger.name > 'zzzzzzzz_mx_insight_hub_touch_updated_at'
      && trigger.row_level === true
      && trigger.before_trigger === true
      && (trigger.on_insert === true || trigger.on_update === true)
    )).map((trigger) => trigger.name)
    const compatibleCursorIndex = indexes.rows.find((index) => (
      index.valid === true
      && index.ready === true
      && index.access_method === 'btree'
      && index.no_expressions === true
      && index.no_predicate === true
      && String(index.first_key).replace(/"/g, '').trim() === 'updated_at'
      && String(index.second_key).replace(/"/g, '').trim() === definition.idColumn
    ))
    const namedCursorIndex = indexes.rows.find((index) => index.name === definition.cursorIndexName)
    const hasUniqueId = indexes.rows.some((index) => (
      index.valid === true
      && index.ready === true
      && uniqueIdIndex(index.definition, definition.idColumn, index.is_unique, index.predicate)
    ))
    const stableIdReady = Boolean(stableId) && stableId.nullable === false && hasUniqueId
    const finiteUpdatedAt = constraints.rows.some((constraint) => (
      constraint.validated === true
      && constraint.expression === 'isfinite(updated_at)'
    ))
    const updatedAtReady = updatedAt?.type === 'timestamp with time zone'
      && updatedAt.nullable === false
      && finiteUpdatedAt
    const triggerReady = Boolean(advanceTrigger)
      && advanceTrigger.enabled === 'A'
      && Boolean(touchTrigger)
      && touchTrigger.enabled === 'A'
      && laterCompetingTriggers.length === 0
    const deleteGuardReady = Boolean(deleteTrigger) && deleteTrigger.enabled === 'A'
    const cursorIndexReady = Boolean(compatibleCursorIndex)
    return {
      ...publicTableDefinition(definition),
      exists: true,
      ready: stableIdReady && updatedAtReady && triggerReady && deleteGuardReady && cursorIndexReady,
      oid: relationRow.oid,
      canAlter: relationRow.can_alter === true,
      stableId: {
        exists: Boolean(stableId),
        nullable: stableId?.nullable ?? null,
        unique: hasUniqueId,
        ready: stableIdReady,
      },
      updatedAt: {
        exists: Boolean(updatedAt),
        type: updatedAt?.type ?? null,
        nullable: updatedAt?.nullable ?? null,
        finite: finiteUpdatedAt,
        ready: updatedAtReady,
      },
      trigger: {
        installed: Boolean(advanceTrigger) && Boolean(touchTrigger),
        enabledAlways: advanceTrigger?.enabled === 'A' && touchTrigger?.enabled === 'A',
        laterCompetingTriggers,
      },
      deleteGuard: {
        installed: Boolean(deleteTrigger),
        enabledAlways: deleteTrigger?.enabled === 'A',
      },
      cursorIndex: {
        exists: Boolean(compatibleCursorIndex),
        name: compatibleCursorIndex?.name ?? namedCursorIndex?.name ?? null,
        valid: compatibleCursorIndex?.valid === true,
        ready: cursorIndexReady,
        namedIndexExists: Boolean(namedCursorIndex),
      },
    }
  }

  async #inspect(client, { applied = false, appliedKeys = [] } = {}) {
    const [identity, marker, infrastructure, ...tables] = await Promise.all([
      this.#identity(client),
      this.#contractMarker(client),
      this.#infrastructure(client),
      ...TABLES.map((definition) => this.#table(client, definition)),
    ])
    const installedVersion = marker?.version == null ? null : Number(marker.version)
    const canPrepare = (identity.is_superuser === true || identity.can_create_schema === true)
      && tables.every((table) => table.exists && table.canAlter)
    const sourceIdentityChanged = Boolean(marker) && tables.some((table) => (
      marker[`${table.role}_table_oid`] != null
      && marker[`${table.role}_table_oid`] !== table.oid
    ))
    const steps = resultSteps({
      tables,
      infrastructure,
      installedVersion,
      sourceIdentityChanged,
    }).map((entry) => (
      appliedKeys.includes(entry.key) && entry.status === 'ready'
        ? { ...entry, status: 'applied' }
        : entry
    ))
    const ready = steps.every((entry) => entry.status === 'ready' || entry.status === 'applied')
    const warnings = []
    if (identity.is_superuser === true || identity.is_database_owner === true) {
      warnings.push({
        code: 'elevated_migration_credential',
        message: 'Use this account only for source preparation; keep the saved ingest account read-only.',
      })
    }
    if (!canPrepare && !ready) {
      warnings.push({
        code: 'migration_privileges_required',
        message: 'A table owner or superuser with database CREATE privilege is required to prepare this source.',
      })
    }
    return {
      pipelineKey: CONTRACT_KEY,
      status: ready ? 'ready' : 'needs_prepare',
      ready,
      applied,
      source: {
        database: identity.database_name ?? null,
        user: identity.database_user ?? null,
        serverVersion: identity.server_version ?? null,
        readOnly: identity.read_only === 'on',
      },
      contract: {
        version: TELEGRAM_SOURCE_CONTRACT_VERSION,
        installedVersion,
        installedAt: marker?.installed_at ?? null,
        generation: marker?.generation ?? null,
        previousTableOids: marker
          ? { chats: marker.chats_table_oid, messages: marker.messages_table_oid }
          : null,
        infrastructure,
      },
      permissions: {
        canPrepare,
        isSuperuser: identity.is_superuser === true,
        isDatabaseOwner: identity.is_database_owner === true,
        canCreateSchema: identity.can_create_schema === true,
        currentSessionWritable: identity.read_only === 'off',
      },
      tables,
      steps,
      warnings,
      sourceIdentityChanged,
    }
  }

  async #withClient(connection, { writable }, operation) {
    const pool = this.#pool(connection, { writable })
    let client = null
    let locked = false
    try {
      client = await pool.connect()
      const lock = await client.query(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
        [SOURCE_LOCK_KEY],
      )
      locked = lock.rows[0]?.locked === true
      if (!locked) {
        throw new AppError(409, 'source_prepare_busy', 'Another Telegram source preparation is already running')
      }
      return await operation(client)
    } finally {
      if (client && locked) {
        await client.query(
          `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
          [SOURCE_LOCK_KEY],
        ).catch(() => {})
      }
      client?.release?.()
      await pool.end().catch(() => {})
    }
  }

  async inspect(connection) {
    try {
      return await this.#withClient(connection, { writable: false }, (client) => this.#inspect(client))
    } catch (error) {
      throw safePrepareError(error)
    }
  }

  async prepare(connection) {
    return this.#withClient(connection, { writable: true }, async (client) => {
      let before = null
      const appliedKeys = []
      try {
        before = await this.#inspect(client)
        if (before.contract.installedVersion > TELEGRAM_SOURCE_CONTRACT_VERSION) {
          throw new AppError(
            409,
            'source_prepare_newer_contract',
            'The Telegram source has a newer contract version; this Hub deployment will not downgrade it',
            { steps: before.steps, warnings: before.warnings },
          )
        }
        const chats = before.tables.find((table) => table.role === 'chats')
        const messages = before.tables.find((table) => table.role === 'messages')
        const incompatible = before.tables.some((table) => !table.exists || !table.stableId.ready)
          || !chats?.updatedAt.exists
          || (chats.updatedAt.exists && chats.updatedAt.type !== 'timestamp with time zone')
          || (messages?.updatedAt.exists && messages.updatedAt.type !== 'timestamp with time zone')
        if (incompatible) {
          throw new AppError(
            409,
            'source_prepare_incompatible_source',
            'Telegram source preparation requires two ordinary tables with stable unique IDs and the expected chats.updated_at type',
            { steps: before.steps, warnings: before.warnings },
          )
        }
        if (!before.permissions.canPrepare && !before.ready) {
          throw new AppError(
            403,
            'source_prepare_insufficient_privileges',
            'The migration account cannot install the Telegram source contract',
            { steps: before.steps, warnings: before.warnings },
          )
        }
        if (before.ready && !before.sourceIdentityChanged) return before

        await client.query(await this.#script('prepare-source-v1.sql'))
        appliedKeys.push('updated_at', 'watermark', 'triggers', 'hard_delete_guard', 'contract_marker')

        const afterCore = await this.#inspect(client)
        for (const table of afterCore.tables) {
          if (table.cursorIndex.ready) continue
          if (table.cursorIndex.namedIndexExists) {
            await client.query(await this.#script(TABLES.find((item) => item.role === table.role).dropScript))
          }
          await client.query(await this.#script(TABLES.find((item) => item.role === table.role).createScript))
        }
        if (afterCore.tables.some((table) => !table.cursorIndex.ready)) appliedKeys.push('cursor_indexes')

        const result = await this.#inspect(client, { applied: true, appliedKeys })
        if (!result.ready) {
          throw new AppError(
            409,
            'source_prepare_incomplete',
            'Telegram source preparation completed but its contract evidence is incomplete',
            { steps: result.steps, warnings: result.warnings },
          )
        }
        result.sourceIdentityChanged = result.sourceIdentityChanged || before.sourceIdentityChanged
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        let details
        try {
          const inspected = await this.#inspect(client)
          details = { steps: inspected.steps, warnings: inspected.warnings }
        } catch {
          details = before ? { steps: before.steps, warnings: before.warnings } : undefined
        }
        throw safePrepareError(error, details)
      }
    }).catch((error) => { throw safePrepareError(error) })
  }
}
