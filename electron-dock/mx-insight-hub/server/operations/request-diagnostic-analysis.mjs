// Interpret only the already projected, read-only request diagnostic DTO.
// No request/response bodies, arbitrary log text, I/O, or model invocation.
export function analyzeRequestDiagnostic(run) {
  const providers = Array.isArray(run.providerCalls) ? run.providerCalls : []
  const connectors = Array.isArray(run.connectorCalls) ? run.connectorCalls : []
  const findings = []
  const nextSteps = []
  const add = (code, certainty, title, detail, evidenceRefs) => {
    findings.push({ code, certainty, title, detail, evidenceRefs: evidenceRefs.slice(0, 8) })
  }
  const refs = (calls, predicate, field, fields) => calls.flatMap((call, index) => (
    predicate(call) ? fields.map(key => `${field}[${index}].${key}`) : []
  )).slice(0, 8)
  const timeout = call => call.failureKind === 'timeout'
  const unknown = call => call.outcome === 'unknown'
  const timeouts = refs(connectors, timeout, 'connectorCalls', ['failureKind', 'latencyMs', 'outcome'])
  const unknownCalls = [
    ...refs(providers, unknown, 'providerCalls', ['outcome']),
    ...refs(connectors, unknown, 'connectorCalls', ['outcome']),
  ]
  const successfulDelivery = run.status === 'committed' && run.hasResponseBody === true
    && Number.isInteger(run.responseStatus) && run.responseStatus >= 200 && run.responseStatus < 300
  let summary = '现有账本不足以确定故障原因，需核对关联证据。'

  if (run.status === 'unknown') {
    summary = timeouts.length
      ? '已记录连接器等待超时；上游最终结果仍未知。'
      : '请求结果仍未知，现有记录不能确定唯一根因。'
    add('request_outcome_unknown', 'confirmed', '请求账本记录为结果未知',
      'unknown 表示交付结果待核对，不能解释为请求已失败、未执行或可以免费重试。', ['status', 'errorCode'])
  } else if (successfulDelivery) {
    summary = 'Hub 已保存成功响应；业务内容的相关性尚未验证。'
    add('successful_response_saved', 'confirmed', 'Hub 已保存成功响应',
      '已提交且 HTTP 为 2xx，证明 Hub 保存了成功响应；不能据此确认返回内容匹配检索主体、全部关键词或业务目标。',
      ['status', 'responseStatus', 'hasResponseBody'])
  } else if (run.status === 'committed' && Number.isInteger(run.responseStatus) && run.responseStatus >= 400) {
    summary = 'Hub 已保存失败响应，需结合调用证据判断故障层。'
    add('failed_response_saved', 'confirmed', '已提交的是失败响应',
      'committed 表示响应已保存，不代表业务查询成功；历史响应不会因为诊断而重写。', ['status', 'responseStatus'])
  } else if (run.status === 'reserved') {
    summary = '请求账本仍为预留状态，需要核对执行进度。'
    add('request_reserved', 'confirmed', '账本尚未记录最终结果',
      'reserved 是保存的账本状态，不证明进程当前仍在运行；本查询不会回收租约或结束请求。', ['status'])
  } else if (run.status === 'released') {
    add('request_released', 'confirmed', '请求预留已释放',
      '请求状态为 released；客户扣费与供应商费用仍应分别查看对应账本。', ['status'])
  }

  if (timeouts.length) {
    add('connector_timeout_recorded', 'confirmed', '连接器记录了等待超时',
      'failureKind=timeout 确认 Hub 等待边界发生超时；不能仅凭耗时推断部署超时配置、下游停止、供应商失败或最终费用。', timeouts)
    nextSteps.push('按连接器关联 ID 与调用时间核对原下游记录及生效超时配置；仅凭相近时间的候选记录不能确认属于同一请求。')
  }
  if (unknownCalls.length) {
    add('call_outcome_unknown', 'confirmed', '部分调用最终结果未知',
      '调用账本仍为 unknown；即使已收到 HTTP 响应头，也不能据此确认响应体完整或业务成功。Hub 最终交付请另看请求状态。', unknownCalls)
  }
  if (run.status === 'unknown' || unknownCalls.length) {
    add('unknown_cause_unresolved', 'unresolved', '尚未确认唯一根因',
      timeouts.length
        ? '已确认等待超时，但尚不能区分下游处理慢、传输或响应读取停滞；下游最终结果需要原调用的明确记录，不能根据相近时间的其他请求补齐。'
        : '现有状态不能区分下游处理慢、传输中断、响应读取异常或证据持久化失败；需要原调用的明确记录，不能根据错误名称补齐。',
      ['status', 'errorCode', ...unknownCalls])
    nextSteps.push('保留原请求及任务身份，先核对最终结果与结算；不自动重发、换幂等键、解除 unknown 或释放冻结。')
  }

  const rejected = refs(providers, call => call.outcome === 'rejected', 'providerCalls', ['outcome', 'httpStatus', 'businessCode', 'errorCode'])
  if (rejected.length) {
    add('provider_rejection_recorded', 'confirmed', '已保存供应商拒绝证据',
      '调用账本记录 rejected；HTTP 与业务码需要一起阅读。若 Hub 交付了存量回退，这些拒绝不等于最终交付失败。具体原因以已核实错误说明及原调用记录为准。', rejected)
  }
  if (!providers.length && !connectors.length) {
    add('call_evidence_missing', 'unresolved', '没有可用的当次调用记录',
      '本查询未返回供应商或连接器记录；缺少记录不能单独证明没有外部调用，也不能确认未计费。', ['providerCalls', 'connectorCalls'])
  }
  if (connectors.some(call => !call.upstreamRequestId && !call.upstreamTraceId)) {
    add('connector_correlation_missing', 'unresolved', '部分连接器缺少上游关联 ID',
      '只能先按原调用时间查候选记录，再由管理员核对原业务身份和参数；不可把附近其他请求当作本次证据。',
      refs(connectors, call => !call.upstreamRequestId && !call.upstreamTraceId, 'connectorCalls', ['upstreamRequestId', 'upstreamTraceId', 'startedAt']))
  }
  if (run.customerCharge?.status === 'unknown' || run.customerCharge?.status === 'reserved') {
    add('customer_settlement_pending', 'confirmed', '客户结算尚未完成',
      'unknown/reserved 即使显示已扣 0，也不表示预占已释放、已退款或供应商费用为零。',
      ['customerCharge.status', 'customerCharge.chargedMinor', 'customerCharge.settledAt'])
  }
  if (run.customerCharge?.enforcementMode === 'shadow') {
    add('shadow_billing', 'confirmed', '客户账本为影子计费',
      'shadow 记录报价与模拟结算，不能当作钱包实际扣款；供应商费用另看采购证据。', ['customerCharge.enforcementMode'])
  }
  if (run.callsTruncated) {
    add('call_evidence_truncated', 'unresolved', '调用证据达到展示上限',
      '当前只显示有界调用列表；未显示的调用可能影响结论，本分析不代表完整调用链。', ['callsTruncated'])
  }
  if (successfulDelivery) {
    add('semantic_relevance_unassessed', 'unresolved', '搜索相关性尚未评估',
      '本诊断不读取查询参数或正文。主体遗漏、同名歧义及多关键词匹配方式，需要针对原请求的已保存内容另行核对；不能用 HTTP 200 或返回条数代替相关性验收。',
      ['responseStatus', 'hasResponseBody'])
    nextSteps.push('如排查搜索噪声，使用该原请求的已保存内容核对主体和关键词命中；记录明确反例，不以“未出现姓名”直接判定全部无关，不发起新的付费搜索。')
  }
  if (!nextSteps.length) nextSteps.push('依据原请求 ID、调用时间和已保存错误码核对对应历史记录；诊断不会自动验证或重新采集。')

  return {
    version: 1, mode: 'recorded_evidence', readOnly: true, modelInvoked: false,
    summary, findings: findings.slice(0, 12), nextSteps: nextSteps.slice(0, 6),
    semanticRelevance: 'not_assessed',
  }
}
