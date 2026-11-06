// Storage kind of "Twitter 用户邮箱": one JSON object of username -> e-mail.
//
// The DDL, deduplication, indexes and acceptance lookups here are exactly
// what published version v1 was built with; changing them only affects
// versions built afterwards.
import { PARSER_VERSION, PARTITION_COUNT, QUARANTINE_REASONS, classifyPair } from '../../twitter-user-email/contract.mjs'

export const userEmailKind = Object.freeze({
  name: 'user-email',
  format: 'json-pairs',
  parserVersion: PARSER_VERSION,
  partitions: PARTITION_COUNT,
  quarantineReasons: QUARANTINE_REASONS,
  partitionKey: 'lower(username)',
  stageColumns: [['domain_id', 'integer'], ['flags', 'smallint'], ['username', 'text'], ['email_local', 'text']],
  leafColumns: [
    ['first_ordinal', 'bigint'], ['domain_id', 'integer'], ['dup_count', 'integer'],
    ['flags', 'smallint'], ['username', 'text'], ['email_local', 'text'],
  ],
  classify(pair) {
    const result = classifyPair(pair.key, pair.value)
    if (result.reason) return result
    return { domain: result.domain, values: { flags: result.flags, username: result.username, email_local: result.local } }
  },
  // Exact duplicates of (username, e-mail local part, domain) collapse into
  // one row; byte-wise "C" grouping keeps case variants apart and sorts fast.
  dedupeSelect: stageLeaf => `SELECT min(ordinal), domain_id, count(*)::integer, bit_or(flags)::smallint, u, l
        FROM (SELECT ordinal, domain_id, flags, username COLLATE "C" AS u, email_local COLLATE "C" AS l
              FROM ${stageLeaf}) source
        GROUP BY u, l, domain_id`,
  indexes: [
    ['user', '(lower(username) text_pattern_ops)'],
    ['local', '(lower(email_local) text_pattern_ops, domain_id)'],
    ['user_trgm', 'USING gin (lower(username) gin_trgm_ops)'],
    ['local_trgm', 'USING gin (lower(email_local) gin_trgm_ops)'],
  ],
  trigramFields: [['u', 'lower(username)'], ['l', 'lower(email_local)']],
  acceptance: {
    sample: 'username, email_local, domain_id',
    lookups: [
      (table, row) => [`SELECT 1 FROM ${table} WHERE lower(username) = lower($1) LIMIT 1`, [row.username]],
      (table, row) => [`SELECT 1 FROM ${table} WHERE lower(email_local) = lower($1) AND domain_id = $2 LIMIT 1`, [row.email_local, row.domain_id]],
    ],
  },
})
