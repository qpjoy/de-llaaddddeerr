import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { LauncherIdentityClient } from './launcher-client.mjs'

export { LauncherIdentityClient } from './launcher-client.mjs'

// Hub roles, ordered from most to least privileged. Each role's capabilities are
// a superset of the ones below it.
const ROLE_CAPABILITIES = Object.freeze({
  owner: ['tenant.read', 'tenant.write', 'consumer.read', 'consumer.write', 'apikey.read', 'apikey.write', 'platform.write', 'usage.read', 'membership.write'],
  admin: ['tenant.read', 'consumer.read', 'consumer.write', 'apikey.read', 'apikey.write', 'platform.write', 'usage.read'],
  analyst: ['tenant.read', 'consumer.read', 'apikey.read', 'usage.read'],
  viewer: ['tenant.read', 'consumer.read', 'usage.read'],
})

const ALL_CAPABILITIES = Object.freeze([...new Set(Object.values(ROLE_CAPABILITIES).flat())])

/**
 * The break-glass principal.
 *
 * Unchanged behaviour for the admin token: full access, no tenant scoping. It
 * exists so a Launcher outage cannot lock operators out of the Hub console, and
 * so bootstrap (creating the first tenant and membership) is possible before any
 * federated identity exists.
 */
export function adminTokenPrincipal() {
  return {
    kind: 'admin-token',
    memberId: null,
    displayName: 'admin token',
    platformAdmin: true,
    tenantIds: null, // null means "unscoped", distinct from [] meaning "no access"
    capabilities: ALL_CAPABILITIES,
    memberships: [],
  }
}

export function capabilitiesForRole(role) {
  return ROLE_CAPABILITIES[role] || []
}

export class IdentityService {
  constructor({ store, client, adminScopes = [], logger = console }) {
    this.store = store
    this.client = client
    this.adminScopes = new Set(adminScopes)
    this.logger = logger
  }

  get enabled() {
    return Boolean(this.client?.enabled)
  }

  /**
   * Turn a Launcher token into a Hub principal, provisioning the member on first
   * sight.
   *
   * Just-in-time provisioning creates the member and the identity binding, and
   * nothing else. It never creates a tenant and never grants a membership: a
   * successful authentication proves who someone is, not what they may do. A
   * brand-new user therefore signs in successfully and sees an empty console
   * until an owner grants them access — which is the correct, boring outcome.
   *
   * The single exception is the platform-admin scope allowlist, which is an
   * explicit operator configuration rather than something a token can assert.
   */
  async resolve(token) {
    const introspection = await this.client.introspect(token)
    if (!introspection) return null

    const { issuer, subject, audience, principal } = introspection
    if (!issuer || !subject) {
      throw new AppError(502, 'launcher_invalid_response', 'Introspection is missing issuer or subject')
    }
    // Only humans get a console session. A Launcher service-account token
    // authenticates machine-to-machine calls and must not inherit a person's
    // tenant scope; Hub API consumers use Hub-issued API keys instead.
    if (principal.kind !== 'user') {
      throw new AppError(403, 'principal_kind_not_allowed', 'Only user principals may sign in to the Hub console')
    }

    const member = await this.store.upsertExternalIdentity({
      issuer,
      subject,
      audience,
      organizationId: principal.organizationIds[0] ?? null,
      launcherTenantId: principal.launcherTenantId,
      authProvider: introspection.authProvider,
      displayName: principal.displayName,
    })

    if (member.status !== 'active') {
      throw new AppError(403, 'member_suspended', 'This Hub membership is suspended')
    }

    const grantsAdmin = principal.scopes.some((scope) => this.adminScopes.has(scope))
    const platformAdmin = await this.store.syncPlatformAdmin(member.id, {
      granted: grantsAdmin,
      grantedVia: grantsAdmin
        ? `launcher-scope:${principal.scopes.find((scope) => this.adminScopes.has(scope))}`
        : null,
    })

    const memberships = await this.store.listTenantMemberships(member.id)
    const active = memberships
      .filter((membership) => membership.status === 'active')
      .map((membership) => ({
        ...membership,
        capabilities: [...capabilitiesForRole(membership.role)],
      }))

    return {
      kind: 'launcher-user',
      memberId: member.id,
      displayName: member.displayName || principal.displayName,
      subject,
      issuer,
      launcherPrincipalId: principal.principalId,
      // The scopes Launcher actually returned, alongside the allowlist they are
      // matched against. Without both, "why am I not a platform admin" is
      // unanswerable from outside the server: a scope name that matches nothing
      // produces exactly the same result as having no privileges at all.
      launcherScopes: principal.scopes,
      adminScopeAllowlist: [...this.adminScopes],
      platformAdmin,
      // A platform admin is unscoped; everyone else sees exactly their tenants.
      tenantIds: platformAdmin ? null : active.map((membership) => membership.tenantId),
      capabilities: platformAdmin
        ? ALL_CAPABILITIES
        : [...new Set(active.flatMap((membership) => membership.capabilities))],
      memberships: active,
    }
  }
}

/**
 * Authorization helpers used at the route boundary.
 *
 * Keeping enforcement here rather than inside HubService is deliberate: the
 * service already has a well-tested contract driven by the admin token, and
 * threading a principal through every method would put a scoping bug on the same
 * code path that serves Night-All traffic. A route-level guard is a smaller,
 * more auditable surface.
 */
export function requireCapability(principal, capability) {
  if (!principal.capabilities.includes(capability)) {
    throw new AppError(403, 'insufficient_capability', `This account lacks the ${capability} capability`)
  }
}

/** Require a platform-wide administrator (admin token or allowlisted Launcher scope). */
export function requirePlatformAdmin(principal) {
  if (!principal.platformAdmin) {
    throw new AppError(403, 'platform_admin_required', 'Only platform admins may perform this action')
  }
}

/**
 * Narrow a caller-supplied tenant filter to what the principal may see.
 *
 * Two distinct outcomes, and conflating them is the classic scoping bug:
 *   - asked for a tenant they cannot see  -> 403, an explicit denial
 *   - asked for nothing                   -> filter to their own tenants
 *
 * Silently rewriting the first case into the second would return an empty list
 * and let a caller probe which tenant ids exist by watching for the difference.
 */
export function scopeTenantFilter(principal, requestedTenantId) {
  if (principal.tenantIds === null) return requestedTenantId ?? null
  if (principal.tenantIds.length === 0) {
    throw new AppError(403, 'no_tenant_membership', 'This account has no active tenant membership')
  }
  if (requestedTenantId) {
    if (!principal.tenantIds.includes(requestedTenantId)) {
      throw new AppError(403, 'tenant_not_permitted', 'This account cannot access that tenant')
    }
    return requestedTenantId
  }
  return principal.tenantIds
}

function membershipHasCapability(membership, capability) {
  const capabilities = membership.capabilities || capabilitiesForRole(membership.role)
  return capabilities.includes(capability)
}

/** Require a capability from the role held in one specific tenant. */
export function requireTenantCapability(principal, tenantId, capability) {
  if (!tenantId) {
    throw new AppError(400, 'invalid_request', 'tenantId is required')
  }
  if (principal.platformAdmin) return tenantId

  scopeTenantFilter(principal, tenantId)
  const membership = principal.memberships.find((candidate) => candidate.tenantId === tenantId)
  if (!membership || !membershipHasCapability(membership, capability)) {
    throw new AppError(
      403,
      'insufficient_capability',
      `This account lacks the ${capability} capability in this tenant`,
    )
  }
  return tenantId
}

/**
 * Resolve an optional tenant filter to only tenants where the corresponding
 * membership role grants the requested capability.
 */
export function scopeTenantCapability(principal, requestedTenantId, capability) {
  if (principal.platformAdmin) return requestedTenantId ?? null
  const scope = scopeTenantFilter(principal, requestedTenantId)
  if (!Array.isArray(scope)) {
    requireTenantCapability(principal, scope, capability)
    return scope
  }

  const allowed = scope.filter((tenantId) => {
    const membership = principal.memberships.find((candidate) => candidate.tenantId === tenantId)
    return membership && membershipHasCapability(membership, capability)
  })
  if (allowed.length === 0) {
    throw new AppError(403, 'insufficient_capability', `This account lacks the ${capability} capability`)
  }
  return allowed
}

/** Post-filter records by the capability held in each record's tenant. */
export function filterByTenantCapability(principal, records, capability) {
  if (principal.platformAdmin) return records
  const allowed = new Set(scopeTenantCapability(principal, null, capability))
  return records.filter((record) => allowed.has(record.tenantId))
}

/** Post-filter a list of records that carry a `tenantId`. */
export function filterByTenant(principal, records) {
  if (principal.tenantIds === null) return records
  const allowed = new Set(principal.tenantIds)
  return records.filter((record) => allowed.has(record.tenantId))
}

export function createIdentityService({ store, launcher, logger = console }) {
  const client = new LauncherIdentityClient({
    baseUrl: launcher.baseUrl,
    audience: launcher.audience,
    timeoutMs: launcher.timeoutMs,
    cacheTtlMs: launcher.cacheTtlMs,
    logger,
  })
  return new IdentityService({ store, client, adminScopes: launcher.adminScopes, logger })
}

export function newMemberId() {
  return randomUUID()
}
