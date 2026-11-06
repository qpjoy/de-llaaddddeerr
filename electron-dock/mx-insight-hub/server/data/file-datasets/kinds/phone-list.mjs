// Storage kind of "手机号库": text file, one phone number per line.
//
// Rows hold E.164 digits without "+". Indexes:
//   (digits)           exact number and country/area-code prefix
//   (reverse(digits))  last-digits suffix
// Both are plain B-trees, so every phone query is an index range scan.
import { PARSER_VERSION, PARTITION_COUNT, QUARANTINE_REASONS, classifyPhoneLine } from '../../phone-directory/contract.mjs'

export const phoneListKind = Object.freeze({
  name: 'phone-list',
  format: 'lines',
  parserVersion: PARSER_VERSION,
  partitions: PARTITION_COUNT,
  quarantineReasons: QUARANTINE_REASONS,
  partitionKey: 'digits',
  stageColumns: [['flags', 'smallint'], ['digits', 'text']],
  leafColumns: [['first_ordinal', 'bigint'], ['dup_count', 'integer'], ['flags', 'smallint'], ['digits', 'text']],
  classify(line) {
    const result = classifyPhoneLine(line)
    if (result.reason) return result
    return { values: { flags: result.flags, digits: result.digits } }
  },
  dedupeSelect: stageLeaf => `SELECT min(ordinal), count(*)::integer, bit_or(flags)::smallint, d
        FROM (SELECT ordinal, flags, digits COLLATE "C" AS d FROM ${stageLeaf}) source
        GROUP BY d`,
  indexes: [
    ['digits', '(digits text_pattern_ops)'],
    ['suffix', '(reverse(digits) text_pattern_ops)'],
  ],
  trigramFields: [],
  acceptance: {
    sample: 'digits',
    lookups: [
      (table, row) => [`SELECT 1 FROM ${table} WHERE digits = $1 LIMIT 1`, [row.digits]],
      (table, row) => [`SELECT 1 FROM ${table} WHERE reverse(digits) LIKE reverse($1) || '%' LIMIT 1`, [row.digits]],
    ],
  },
})
