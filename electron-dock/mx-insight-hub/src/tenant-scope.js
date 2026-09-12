export function selectVisibleTenantId(tenants, requestedTenantId, { aggregateWhenEmpty = false } = {}) {
  const items = Array.isArray(tenants) ? tenants : []
  const requested = String(requestedTenantId || '')
  if (!requested && aggregateWhenEmpty) return ''
  return items.some((tenant) => tenant?.id === requested) ? requested : items[0]?.id || ''
}

// Who gets the "my access" page, and where a session lands when the visitor
// asked for no particular page.
//
// The distinction is between a person and the break-glass admin token. The
// token is unscoped precisely because it belongs to no tenant, so "my access"
// would always be empty for it; it reads the operator console instead. A person
// who holds no membership yet does get the page, because "you are signed in and
// have not been granted access" is the one statement that fits their situation
// -- the alternative is a 403 on an operator page they cannot use.
export function showsOwnAccess(session) {
  // An unknown session is not a tenant session. The caller always has one by
  // the time it decides -- the session is stored before sign-in completes --
  // but defaulting the unknown case towards a tenant page would be wrong in
  // exactly the situation where the answer is not yet known.
  if (!session || session.kind === 'admin-token') return false
  return Boolean(session.memberships?.length) || !session.platformAdmin
}

// Platform admins keep the operator dashboard: they signed in to look at other
// people's tenants, and their own access is not the question they came with.
export function landingPathFor(session) {
  return !session?.platformAdmin && showsOwnAccess(session) ? '/my' : '/dashboard'
}
