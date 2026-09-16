// ES parsing errors put the potentially huge value preview before caused_by.
// Persist the deepest cause first so the Admin/outbox 2,000-character limit
// cannot hide the actionable failure behind acquired business content.
export function describeBulkFailure(action, fallback) {
  const context = [
    action?._index && `index=${String(action._index).slice(0, 160)}`,
    action?._id && `id=${String(action._id).slice(0, 160)}`,
    action?.status && `status=${action.status}`,
  ].filter(Boolean).join(' ')
  const causes = []
  for (let cause = action?.error; cause && causes.length < 8; cause = cause.caused_by) {
    const reason = String(cause.reason || (typeof cause === 'string' ? cause : ''))
      .split(". Preview of field's value:")[0]
      .split(' for key starting with [')[0]
      .replace(/\s+/g, ' ')
      .slice(0, 500)
    const type = String(cause.type || 'elasticsearch_error').slice(0, 80)
    causes.push(reason ? `${type}: ${reason}` : type)
  }
  const detail = causes.length ? causes.reverse().join(' <- ') : fallback
  return [context, detail].filter(Boolean).join('; ').slice(0, 1_800)
}
