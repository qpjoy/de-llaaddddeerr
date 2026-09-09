const SCOPE_TYPES = new Set(['platform', 'capability'])

function scopeFromPrimary(input) {
  if (input.platform) return { type: 'platform', key: input.platform }
  if (input.capability) return { type: 'capability', key: input.capability }
  return null
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError('requiredAuthorizationScopes entries must be objects')
  }
  const type = String(scope.type || '').trim()
  const key = String(scope.key || '').trim()
  if (!SCOPE_TYPES.has(type) || !key || key.length > 128 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new TypeError('requiredAuthorizationScopes entries require a valid type and key')
  }
  return { type, key }
}

export function authorizationScopeKey(scope) {
  return `${scope.type}:${scope.key}`
}

export function authorizationScopeLockKey(consumerId, scope) {
  return `${consumerId}:authorization:${authorizationScopeKey(scope)}`
}

export function requiredAuthorizationScopes(input) {
  const primary = scopeFromPrimary(input)
  if (!primary) {
    throw new TypeError('Usage reservation requires one primary accounting scope')
  }
  const supplied = input.requiredAuthorizationScopes
  const source = supplied == null ? [primary] : supplied
  if (!Array.isArray(source) || source.length === 0 || source.length > 16) {
    throw new TypeError('requiredAuthorizationScopes must contain 1-16 scopes')
  }
  const scopes = [...new Map(source.map((entry) => {
    const scope = normalizeScope(entry)
    return [authorizationScopeKey(scope), scope]
  })).values()].sort((left, right) => (
    (left.type === right.type ? 0 : left.type === 'platform' ? -1 : 1)
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  ))
  if (!scopes.some((scope) => scope.type === primary.type && scope.key === primary.key)) {
    throw new TypeError('requiredAuthorizationScopes must include the primary accounting scope')
  }
  return scopes
}
