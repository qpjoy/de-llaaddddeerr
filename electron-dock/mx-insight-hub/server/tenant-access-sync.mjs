import { createHash } from 'node:crypto'
import { AppError } from './core/errors.mjs'

const fields = ['platforms', 'capabilities']
const sorted = values => [...new Set(values || [])].sort()
const difference = (a, b) => sorted(a).filter(value => !b.includes(value))

// Tenant scopes are a managed subset, never a replacement for a Key's scopes.
// Re-saving also fills gaps in Keys issued before tenant-wide synchronization.
export function tenantAccessPreview(tenantId, before, input, keys, consumerCount) {
  if (before.revision !== input.revision) throw new AppError(409, 'revision_conflict', '租户授权已变化，请重新读取后预览')
  const removed = Object.fromEntries(fields.map(field => [field, difference(before[field], input[field])]))
  const added = Object.fromEntries(fields.map(field => [field, difference(input[field], before[field])]))
  const changes = [...keys].sort((a, b) => a.id.localeCompare(b.id)).map(key => {
    const previous = { scopeMode: key.scopeMode, webSearchOrder: key.webSearchOrder || [], ...Object.fromEntries(fields.map(field => [field, sorted(key[field])])) }
    const next = { scopeMode: 'snapshot', ...Object.fromEntries(fields.map(field => [field, sorted([...key[field].filter(scope => !removed[field].includes(scope)), ...input[field]])])) }
    next.webSearchOrder = previous.webSearchOrder.filter(provider => next.capabilities.includes(`web.search.provider.${provider}`))
    const additions = Object.fromEntries(fields.map(field => [field, difference(next[field], previous[field])]))
    const removals = Object.fromEntries(fields.map(field => [field, difference(previous[field], next[field])]))
    const preserved = Object.fromEntries(fields.map(field => [field, difference(next[field], input[field])]))
    return { id: key.id, name: key.name, consumerId: key.consumerId, consumerName: key.consumerName, status: key.status, expiresAt: key.expiresAt,
      previous, next, added: additions, removed: removals, preserved,
      changed: ['scopeMode', 'webSearchOrder', ...fields].some(field => JSON.stringify(previous[field]) !== JSON.stringify(next[field])) }
  })
  const requiresRemovalConfirmation = fields.some(field => removed[field].length > 0)
  const configuration = { ...input, platforms: sorted(input.platforms), capabilities: sorted(input.capabilities) }
  // Include the complete Key inventory so new Keys, edits, revocations and
  // expiry changes invalidate a reviewed removal before any mutation occurs.
  const previewToken = createHash('sha256').update(JSON.stringify({ tenantId, before, configuration, changes, consumerCount })).digest('hex')
  return { tenantId, revision: before.revision, previewToken, consumerCount, keyCount: keys.length,
    changedKeyCount: changes.filter(key => key.changed).length, added, removed, requiresRemovalConfirmation, keys: changes }
}

export function assertTenantAccessReview(preview, review = {}) {
  if (review.previewToken && review.previewToken !== preview.previewToken) throw new AppError(409, 'tenant_access_preview_changed', '授权或 Key 清单已变化，请重新预览后提交')
  if (preview.requiresRemovalConfirmation && (!review.previewToken || review.confirmRemovals !== true)) throw new AppError(409, 'tenant_access_removal_confirmation_required', '移除权限前必须预览受影响的 Key 并明确确认')
}
