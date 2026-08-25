// This version identifies the exact deterministic attribution rules used by
// an assertion. Bump it whenever a rule pattern, candidate or confidence
// changes so historical assertions remain explainable.
export const INFORMATION_ATTRIBUTION_RULE_VERSION = 'information-attribution.2026-08.1'

const CROSS_STRAIT_FRONTLINE = /(?:台湾|臺灣|台海|臺海|台湾海峡|臺灣海峽)(?:方向|一线|前线|前沿)/u

function evidenceWindow(value, index, term, radius = 48) {
  const start = Math.max(0, index - radius)
  const end = Math.min(value.length, index + term.length + radius)
  return value.slice(start, end)
}

/**
 * Return reviewable related geography for phrases that name an area or
 * relationship but do not prove the physical event province.
 *
 * The result is deliberately not an event_admin1_code fact. For example,
 * "台湾一线" mentions Taiwan while the mainland operating area may be Fujian;
 * the title alone cannot decide between them.
 */
export function evaluateInformationAttributionRules(fields = []) {
  for (const field of fields) {
    const match = field.value.match(CROSS_STRAIT_FRONTLINE)
    if (!match) continue
    const index = match.index || 0
    return {
      ruleKey: 'cross_strait_frontline',
      ruleVersion: INFORMATION_ATTRIBUTION_RULE_VERSION,
      evidence: {
        path: field.path,
        quote: evidenceWindow(field.value, index, match[0]),
      },
      relatedAdmin1Codes: [
        { admin1Code: 'CN-TW', relation: 'mentioned_area' },
      ],
      confidence: 0.7,
    }
  }
  return null
}
