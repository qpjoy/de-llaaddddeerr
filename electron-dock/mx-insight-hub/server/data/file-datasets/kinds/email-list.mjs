// Storage kind of "邮箱库": text file, one e-mail address per line.
//
// Rows keep the local part as written plus a shared domain id. Indexes:
//   (lower(local), domain)  exact address and local-part prefix
//   (domain, lower(local))  every address at a domain, in keyset pages
//   trigram on lower(local) substring / similar spelling (with precheck)
import { PARSER_VERSION, PARTITION_COUNT, QUARANTINE_REASONS, classifyEmailLine } from '../../email-directory/contract.mjs'

export const emailListKind = Object.freeze({
  name: 'email-list',
  format: 'lines',
  parserVersion: PARSER_VERSION,
  partitions: PARTITION_COUNT,
  quarantineReasons: QUARANTINE_REASONS,
  partitionKey: 'lower(email_local)',
  stageColumns: [['domain_id', 'integer'], ['flags', 'smallint'], ['email_local', 'text']],
  leafColumns: [['first_ordinal', 'bigint'], ['domain_id', 'integer'], ['dup_count', 'integer'], ['flags', 'smallint'], ['email_local', 'text']],
  classify(line) {
    const result = classifyEmailLine(line)
    if (result.reason) return result
    return { domain: result.domain, values: { flags: result.flags, email_local: result.local } }
  },
  // Byte-wise grouping: "John@x.com" and "john@x.com" stay two rows.
  dedupeSelect: stageLeaf => `SELECT min(ordinal), domain_id, count(*)::integer, bit_or(flags)::smallint, l
        FROM (SELECT ordinal, domain_id, flags, email_local COLLATE "C" AS l FROM ${stageLeaf}) source
        GROUP BY l, domain_id`,
  indexes: [
    ['local', '(lower(email_local) text_pattern_ops, domain_id)'],
    ['domain', '(domain_id, lower(email_local) text_pattern_ops)'],
    ['local_trgm', 'USING gin (lower(email_local) gin_trgm_ops)'],
  ],
  trigramFields: [['l', 'lower(email_local)']],
  acceptance: {
    sample: 'email_local, domain_id',
    lookups: [
      (table, row) => [`SELECT 1 FROM ${table} WHERE lower(email_local) = lower($1) AND domain_id = $2 LIMIT 1`, [row.email_local, row.domain_id]],
      (table, row) => [`SELECT 1 FROM ${table} WHERE domain_id = $1 AND lower(email_local) = lower($2) LIMIT 1`, [row.domain_id, row.email_local]],
    ],
  },
})
