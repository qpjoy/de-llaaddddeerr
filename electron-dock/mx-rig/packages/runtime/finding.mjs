/**
 * 结构化结论：Agent 的判断，带上它引用的证据。
 *
 * The free-text answer stays — a paragraph is how a person actually reads a
 * verdict. What was missing is a *shape*: a verdict from a closed set, a
 * confidence, and the references the model claims to have read. Without it,
 * "这次大概是环境问题吧" and "environment-blocked, high, because trun_x 的
 * runner 全部离线" are the same kind of object to the product, and neither can
 * be counted, filtered or checked.
 *
 * Two rules make this honest rather than decorative:
 *
 * 1. **It is the model's claim, not the platform's verdict.** The taxonomy is
 *    about why a test did not pass; it never says a product is good. The UI
 *    labels it as the Agent's judgement, and it does not touch a test Run's
 *    status anywhere.
 * 2. **References are checked against this mission's own tool results.** A
 *    run id the model never actually read is marked as such. That is the one
 *    hallucination this product can catch cheaply, so it does.
 */
import { RigError } from '../contracts/index.mjs'

export const VERDICTS = Object.freeze({
  'product-defect': { label: '产品缺陷', tone: 'danger' },
  'environment-blocked': { label: '环境受阻', tone: 'warning' },
  'case-issue': { label: '用例问题', tone: 'warning' },
  flaky: { label: '不稳定（flaky）', tone: 'warning' },
  inconclusive: { label: '证据不足', tone: 'default' }
})

export const CONFIDENCE = Object.freeze({
  high: { label: '高', tone: 'success' },
  medium: { label: '中', tone: 'warning' },
  low: { label: '低', tone: 'default' }
})

export const VERDICT_KEYS = Object.keys(VERDICTS)
export const CONFIDENCE_KEYS = Object.keys(CONFIDENCE)

// The platform's own id shapes. Anything else in the evidence field is prose:
// it may well be true, but it is not something this product can verify, so it
// is not reported as verified either.
const REFERENCE =
  /\b(trun_[A-Za-z0-9_-]{2,60}|tsk_[A-Za-z0-9_-]{2,60}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g

export function normalizeFinding(args) {
  if (!VERDICT_KEYS.includes(args.verdict)) throw new RigError('invalid_finding', '结论类型无效')
  if (!CONFIDENCE_KEYS.includes(args.confidence))
    throw new RigError('invalid_finding', '置信度无效')
  return {
    verdict: args.verdict,
    confidence: args.confidence,
    summary: String(args.summary).trim().slice(0, 400),
    evidence: String(args.evidence).trim().slice(0, 400),
    nextStep: args.nextStep ? String(args.nextStep).trim().slice(0, 400) : '',
    at: new Date().toISOString()
  }
}

/**
 * Cross-check the claimed references against what this mission really read.
 *
 * `seen` means the id appears in a tool result recorded on this mission — not
 * that the id exists in the platform, and not that the reasoning is right.
 */
export function auditFinding(finding, { evidence = [], messages = [], testRunId = null } = {}) {
  // Agent missions keep tool output in the model transcript; authored
  // orchestrations keep it in `evidence`. Both are "what this mission read".
  const haystack = [
    ...evidence.map((entry) => `${entry.tool} ${entry.summary}`),
    ...messages
      .filter((entry) => entry.role === 'tool')
      .map((entry) => String(entry.content ?? '')),
    testRunId ?? ''
  ].join('\n')
  const ids = [...new Set((finding.evidence.match(REFERENCE) ?? []).slice(0, 12))]
  const references = ids.map((id) => ({ id, seen: haystack.includes(id) }))
  return {
    ...finding,
    references,
    // Counted separately so the UI can say "引用了 3 个 ID，其中 1 个没读过"
    // without re-deriving it, and so a report could aggregate it later.
    unverified: references.filter((entry) => !entry.seen).length,
    // No ids at all is not a failure: a coverage or environment judgement may
    // legitimately cite no run. It is reported as "没有可核对的引用".
    checkable: references.length > 0
  }
}
