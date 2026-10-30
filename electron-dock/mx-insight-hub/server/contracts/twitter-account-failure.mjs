const object = value => value && typeof value === 'object' && !Array.isArray(value)
const noErrors = value => value.error == null && (value.errors == null || Array.isArray(value.errors) && value.errors.length === 0)

// Only explicit account lookup results, never arbitrary nested tweet authors,
// free-text messages, HTTP/auth failures, or an empty/malformed profile.
export function twitterAccountFailure(payload) {
  if (!object(payload) || !noErrors(payload)) return null
  const root = object(payload.data) ? payload.data : payload
  if (!noErrors(root)) return null
  if (payload.userExists === false && object(payload.data) && Object.keys(payload.data).length === 0) {
    return { code: 'social_account_not_found', reason: 'not_found' }
  }
  if (root.users != null && !Array.isArray(root.users)) return null
  const containers = [root.users, root.user?.result, root.user_result_by_screen_name?.result, root.result]
    .filter(value => value != null)
  if (containers.length !== 1) return null
  const candidates = root.users ?? [containers[0]]
  if (candidates.length !== 1) return null
  const user = candidates[0]?.result ?? candidates[0]
  if (!object(user) || user.__typename !== 'UserUnavailable' || !noErrors(user)) return null
  // Contradictory usable profile/timeline evidence must still fail validation.
  if (['legacy', 'core', 'timeline', 'timeline_v2', 'tweets'].some(key => user[key] != null)) return null
  const reasons = { suspended: 'suspended', deactivated: 'deactivated', deleted: 'deleted',
    protected: 'protected', notfound: 'not_found', not_found: 'not_found', unavailable: 'unavailable' }
  const key = typeof user.reason === 'string' ? user.reason.toLowerCase() : ''
  const reason = Object.hasOwn(reasons, key) ? reasons[key] : null
  return { code: 'social_account_unavailable', reason: reason || 'unavailable' }
}
