const list = value => Array.isArray(value) ? value : []

function issueMessages(...values) {
  return [...new Set(values.flatMap(value => (Array.isArray(value) ? value : [value])
    .filter(Boolean).flatMap(item => {
      if (typeof item === 'string') return [item]
      const messages = [item.code, item.message || item.reason].filter(Boolean)
      return messages.length ? messages : ['返回了未说明的错误']
    })))]
}

function matchResults(sourceKeys, result) {
  return [...new Set(sourceKeys)].map(sourceKey => {
    const matches = list(result?.tasks).filter(task => task?.sourceKey === sourceKey)
    return { sourceKey, task: matches.length === 1 ? matches[0] : null,
      missing: matches.length !== 1,
      issues: matches.length === 1 ? [] : [matches.length ? '返回了重复结果，请重新核对' : '未返回此分区结果'] }
  })
}

export function crawlerCheckFeedback(sourceKeys, result) {
  const rows = matchResults(sourceKeys, result).map(row => {
    const task = row.task
    const issues = [...row.issues, ...issueMessages(task?.error, task?.blocker, task?.issues, task?.configurationIssues)]
    // An empty or partial response is not evidence that a source probe passed.
    if (!row.missing && issues.length === 0 && (!Number.isFinite(task.totalRows) || task.totalRows < 0)) issues.push('核对结果不完整')
    return { ...row, issues, passed: !row.missing && issues.length === 0 }
  })
  return { rows, total: rows.length, passed: rows.filter(row => row.passed).length,
    blocked: rows.filter(row => !row.missing && !row.passed).length,
    missing: rows.filter(row => row.missing).length, checkedAt: result?.checkedAt || null }
}

export function crawlerRecoveryFeedback(sourceKeys, result) {
  const rows = matchResults(sourceKeys, result).map(row => {
    const issues = [...row.issues, ...issueMessages(row.task?.error)]
    if (!row.missing && !row.task?.error && typeof row.task?.resumed !== 'boolean') issues.push('恢复结果不完整')
    const status = row.missing ? 'missing' : issues.length ? 'failed' : row.task.resumed ? 'resumed' : 'unchanged'
    return { sourceKey: row.sourceKey, status, issues }
  })
  const resumed = rows.filter(row => row.status === 'resumed').length
  const failed = rows.filter(row => row.status === 'failed').length
  const missing = rows.filter(row => row.status === 'missing').length
  const unchanged = rows.filter(row => row.status === 'unchanged').length
  return { rows, resumed, failed, missing, unchanged,
    message: rows.length
      ? `已恢复 ${resumed} 个，恢复受阻 ${failed} 个，无需恢复 ${unchanged} 个${missing ? `，未确认 ${missing} 个` : ''}`
      : '未取得类别列表，无法确认恢复结果',
    tone: failed || missing || !rows.length ? 'warning' : resumed ? 'success' : 'info' }
}

export function isCrawlerPipelineSnapshot(value) {
  return value?.pipelineKey === 'night-all-saved-records'
    && typeof value.configured === 'boolean'
    && typeof value.status === 'string'
    && Array.isArray(value.tasks)
}
