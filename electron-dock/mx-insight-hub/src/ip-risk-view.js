// Presentation only. Preserve the public envelope, input order and duplicate IPs.
export const IP_RISK_STATES = {
  success: { label: '查询成功', tone: 'complete', hint: '本次响应已通过校验；不代表所有字段齐全或 IP 无风险。' },
  partial: { label: '部分数据', tone: 'warning', hint: '部分字段缺失或不可用，已保留其余有效信息。' },
  no_data: { label: '暂无数据', tone: 'neutral', hint: '本次没有可用画像，不等于无风险。有效无数据响应仍按套餐计费。' },
  unknown: { label: '结果待核对', tone: 'warning', hint: '请求可能已执行。请保留请求或批次编号，先在用量与账单中核对，勿连续重试。' },
  forbidden: { label: '权限不足', tone: 'warning', hint: '请检查当前 Live Key、业务开通范围和 Key 权限。' },
  expired: { label: '身份已失效', tone: 'warning', hint: '请重新检查当前调用身份；不会自动重新发送查询。' },
  balance: { label: '余额不足', tone: 'warning', hint: '请检查账户余额和当前套餐后再主动查询。' },
  limited: { label: '达到限额', tone: 'warning', hint: '次数、频率或服务容量受限。请查看用量或稍后主动查询。' },
  not_dispatched: { label: '未派发', tone: 'neutral', hint: '批次时间预算不足，该项尚未派发，不会自动补跑。' },
  unavailable: { label: '服务未就绪', tone: 'neutral', hint: '服务暂不可用，请联系管理员检查运行配置。' },
  invalid: { label: '参数无效', tone: 'warning', hint: '请检查 IPv4 格式和数量。' },
  failed: { label: '查询失败', tone: 'danger', hint: '未获得可用画像，请根据错误码与请求编号核对。不会自动重试。' },
}

export const IP_RISK_FIELD_LABELS = {
  proxy_type: '代理类型', risk_score: '风险评分', risk_level: '风险等级',
  rapid_rotation_probability_percent: '秒拨概率', human_probability_percent: '真人概率', risk_tags: '风险标签',
}

export function parseIpRiskInput(text, batch = false) {
  const values = batch ? text.trim().split(/[\s,，;；]+/u).filter(Boolean) : (text.trim() ? [text.trim()] : [])
  const invalid = values.map((ip, index) => ({ ip, index })).filter(({ ip }) => !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(ip)
    || !ip.split('.').every(part => Number(part) <= 255 && String(Number(part)) === part))
  const duplicateCount = values.length - new Set(values).size
  const message = !values.length ? '请输入 IPv4 地址。' : values.length > 100 ? '每批最多 100 项，请拆分后查询。'
    : invalid.length ? `第 ${invalid.slice(0, 5).map(row => row.index + 1).join('、')} 项不是有效 IPv4${invalid.length > 5 ? `，共 ${invalid.length} 项无效` : ''}。不支持域名、IPv6 或网段。` : ''
  return { values, duplicateCount, invalid, message, valid: !message, body: batch ? { ips: values } : { ip: values[0] || '' } }
}

export function ipRiskErrorState(status, code = '') {
  // A transport loss without HTTP evidence, 409, and uncertain paid outcomes
  // are never presented as safe-to-retry failures.
  if (code === 'batch_deadline_not_dispatched') return 'not_dispatched'
  if (!status || status === 409 || /unknown|pending|in_progress|ip_response_(unusable|too_large)/u.test(code)
    || (status >= 500 && !['ip_query_rejected', 'ip_risk_unavailable'].includes(code))) return 'unknown'
  return ({ 400: 'invalid', 401: 'expired', 402: 'balance', 403: 'forbidden', 429: 'limited', 503: 'unavailable', 504: 'unknown' })[status] || 'failed'
}

export function ipRiskRows(result) {
  const payload = result.payload
  const batch = Array.isArray(payload?.data)
  const items = batch ? payload.data : [{ index: 0, ip: payload?.data?.ip || result.request?.ip, status: result.status || 200, response: payload }]
  return items.map((item, offset) => {
    const envelope = item.response
    const error = item.error || envelope?.error
    const status = !error && item.status === 200 && ['success', 'partial', 'no_data'].includes(envelope?.data?.status)
      ? envelope.data.status : !error && item.status === 200 ? 'unknown' : ipRiskErrorState(item.status, error?.code)
    return {
      id: `${result.localId}:${offset}`, index: item.index ?? offset, ip: item.ip,
      submissionId: result.localId, batchSize: batch ? result.request?.ips?.length || items.length : null,
      status, httpStatus: item.status, profile: envelope?.data?.data || null,
      warnings: envelope?.data?.warnings || [], errorCode: error?.code || null,
      requestId: envelope?.requestId || item.requestId || (!batch ? result.evidence?.requestId : null),
      batchId: batch ? payload.batchId : null, capturedAt: envelope?.meta?.capturedAt || null,
      receivedAt: result.receivedAt, elapsedMs: result.elapsedMs,
      sourceMode: payload?.meta?.sourceMode === 'idempotent_replay' ? 'idempotent_replay' : envelope?.meta?.sourceMode || payload?.meta?.sourceMode,
      raw: item, envelope,
    }
  })
}

export function ipRiskFailureRows(error, request, localId, receivedAt) {
  return (request.ips || [request.ip]).map((ip, index) => ({
    id: `${localId}:${index}`, index, ip, status: ipRiskErrorState(error.status, error.code),
    submissionId: localId, batchSize: request.ips?.length || null,
    httpStatus: error.status || null, profile: null, warnings: [], errorCode: error.code || 'transport_error',
    requestId: error.requestId || error.details?.requestId || null,
    batchId: error.details?.batchId || null, capturedAt: null, receivedAt,
    raw: { ip, error: { code: error.code || 'transport_error' }, requestId: error.requestId, batchId: error.details?.batchId },
  }))
}

export function ipRiskBatchRows(rows, active) {
  if (!active?.batchSize) return []
  return rows.filter(row => row.submissionId === active.submissionId).sort((a, b) => a.index - b.index)
}

export function ipRiskHistorySummary(item) {
  return { ...item, status: ['success', 'partial', 'no_data', 'unknown'].includes(item.state) ? item.state : item.httpStatus == null ? 'failed' : ipRiskErrorState(item.httpStatus, item.errorCode), warnings: [] }
}

export function ipRiskHistoryRows(detail) {
  const result = { ...detail, localId: `history:${detail.kind}:${detail.id}`, receivedAt: detail.createdAt }
  return ipRiskRows(result).map(row => ({ ...row,
    ...(detail.requestState === 'released' && !detail.hasStoredResponse ? { status: 'failed' } : {}),
    historical: true, createdAt: detail.createdAt }))
}

export function riskTone(level) {
  // Scores have no published universal range/threshold; never derive a level.
  return ({ '高风险': 'danger', '中风险': 'warning', '低风险': 'complete', high: 'danger', medium: 'warning', low: 'complete' })[String(level || '').toLowerCase()] || 'neutral'
}
export const riskValue = value => value == null || value === '' ? '未提供' : String(value)
export function riskTime(value) {
  if (!value) return '未提供'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
}
export function riskWarning(value) {
  const [code, field] = value.split(':')
  const label = IP_RISK_FIELD_LABELS[field] || field || value
  return code === 'FIELD_MISSING' ? `${label}缺失` : code === 'FIELD_INVALID' ? `${label}格式不可用` : value
}
export function filterIpRiskRows(rows, query, state = '', level = '') {
  const term = query.trim().toLowerCase()
  return rows.filter(row => (!state || row.status === state) && (!level || row.profile?.risk_level === level)
    && (!term || [row.ip, row.requestId, row.batchId, row.profile?.proxy_type, row.profile?.risk_level,
      ...(row.profile?.risk_tags || []).flatMap(tag => [tag.code, tag.name])].filter(Boolean).join(' ').toLowerCase().includes(term)))
}
export function ipRiskSummary(row) {
  const p = row.profile || {}
  return [`IP：${row.ip}`, `数据状态：${IP_RISK_STATES[row.status].label}`, `风险等级：${riskValue(p.risk_level)}`,
    `风险评分：${riskValue(p.risk_score)}`, `代理类型：${riskValue(p.proxy_type)}`,
    `秒拨概率：${p.rapid_rotation_probability_percent == null ? '未提供' : `${p.rapid_rotation_probability_percent}%`}`,
    `真人概率：${p.human_probability_percent == null ? '未提供' : `${p.human_probability_percent}%`}`,
    `风险标签：${p.risk_tags == null ? '未提供' : p.risk_tags.length ? p.risk_tags.map(tag => `${tag.name || tag.code || '未命名标签'}${tag.last_seen ? `（最后发现 ${tag.last_seen}）` : ''}`).join('；') : '返回空标签集合'}`,
    `查询时间：${riskTime(row.capturedAt)}`, `请求编号：${row.requestId || '未返回'}`,
    ...(row.batchId ? [`批次编号：${row.batchId}`] : []), '此画像仅反映本次查询结果，不代表绝对安全。'].join('\n')
}
function csvTable(rows) {
  const cell = value => {
    const text = value == null ? '' : String(value)
    // Spreadsheet exports may contain arbitrary supplier-provided text.
    return `"${(/^[\s]*[=+@\-]/u.test(text) || /^[\t\r\n]/u.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`
  }
  return '\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n')
}
export function ipRiskHistoryCsv(rows) {
  return csvTable([
    ['输入序号', 'IP', '数据状态', '风险等级', '风险评分', '代理类型', '提交时间', '原查询时间', '请求编号', '批次编号', '错误码'],
    ...rows.map(row => [row.index >= 0 ? row.index + 1 : '', row.ip, IP_RISK_STATES[row.status].label,
      row.profile?.risk_level, row.profile?.risk_score, row.profile?.proxy_type, row.createdAt, row.capturedAt,
      row.requestId, row.batchId, row.errorCode]),
  ])
}
export function ipRiskCsv(rows) {
  return csvTable([
    ['输入序号', 'IP', '数据状态', '风险等级', '风险评分', '代理类型', '秒拨概率(%)', '真人概率(%)', '风险标签(JSON)', '查询时间', '请求编号', '批次编号', '错误码', '字段警告(JSON)'],
    ...rows.map(row => [row.index + 1, row.ip, IP_RISK_STATES[row.status].label, row.profile?.risk_level, row.profile?.risk_score,
      row.profile?.proxy_type, row.profile?.rapid_rotation_probability_percent, row.profile?.human_probability_percent,
      row.profile?.risk_tags == null ? '' : JSON.stringify(row.profile.risk_tags), row.capturedAt, row.requestId, row.batchId, row.errorCode, JSON.stringify(row.warnings)]),
  ])
}
