import { REDDIT_DIAGNOSTIC_ISSUES } from '../../shared/platform-diagnostic-catalog.mjs'

// Match only saved DTO fields. Categories are investigation priorities, not a
// claim that an uninspected archive contains a particular widget or cursor.
export function platformDiagnosticAnalysis(run) {
  if (run.platform !== 'reddit') return null
  const calls = Array.isArray(run.providerCalls) ? run.providerCalls : []
  const priorities = new Set(), evidenceRefs = []
  const add = (ids, refs) => { ids.forEach(id => priorities.add(id)); evidenceRefs.push(...refs) }
  const classify = (code, refs) => {
    if (code === 'invalid_content_search_contract') {
      add(['reddit_widget_telemetry', 'reddit_unknown_widget', 'reddit_relay_pagination', 'reddit_search_notice'], refs)
    }
    if (code === 'invalid_content_search_entry') add(['reddit_widget_telemetry', 'reddit_unknown_widget'], refs)
    if (code === 'invalid_content_search_identity') add(['reddit_unknown_widget'], refs)
    if (['contradictory_content_search_continuation', 'missing_content_search_continuation', 'invalid_content_search_continuation'].includes(code)) add(['reddit_relay_pagination'], refs)
    if (code === 'upstream_search_error_message') add(['reddit_search_notice'], refs)
  }
  classify(run.errorCode, ['errorCode'])
  calls.forEach((call, index) => {
    if (call.provider !== 'tikhub' || call.operation !== 'native.t.reddit_app_fetch_dynamic_search') return
    classify(call.errorCode, [`providerCalls[${index}].errorCode`])
    if (call.httpStatus === 429 || call.errorCode === 'upstream_rate_limited' || ['rejected', 'unknown'].includes(call.outcome)) {
      add(['reddit_upstream_failure'], ['httpStatus', 'errorCode', 'outcome'].filter(key => Object.hasOwn(call, key)).map(key => `providerCalls[${index}].${key}`))
    }
  })
  if (run.responseStatus === 409 && ['external_platform_response_unusable', 'external_platform_pre_dispatch_failed'].includes(run.errorCode)) {
    add(['reddit_response_quarantine'], ['responseStatus', 'errorCode'])
  }
  const issueIds = [...priorities]
  return { platform: 'reddit', certainty: 'unresolved', issueIds,
    evidenceRefs: [...new Set(evidenceRefs)].slice(0, 8),
    summary: issueIds.length ? '已根据本请求记录排列 Reddit 优先排查项；具体节点与根因需核对原始归档。'
      : '当前证据未匹配 Reddit 专项规则，可从平台问题分类继续核对。',
    // Keep the allowlist explicit so arbitrary source text never becomes advice.
    suggestedChecks: issueIds.map(id => REDDIT_DIAGNOSTIC_ISSUES.find(issue => issue.id === id)?.check).filter(Boolean) }
}
