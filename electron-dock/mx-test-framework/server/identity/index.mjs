import { AppError } from '../core/errors.mjs'
import { secureEqual } from '../core/ids.mjs'
import { LauncherIdentityClient } from './launcher-client.mjs'

// Authentication is delegated to mx-launcher; authorization is local.
//
// Launcher answers "who is this", the `mxt_members` table answers "what may they
// do here". Keeping the second half local is the point: a broad launcher role
// must not imply the right to schedule jobs on real machines.

export const ROLES = ['viewer', 'operator', 'admin']

const RANK = { viewer: 1, operator: 2, admin: 3 }

export function createIdentity({ store, config, logger = console }) {
  const launcher = new LauncherIdentityClient({ ...config.launcher, logger })

  async function memberFor(principal) {
    const existing = await store.getMember(principal.id)
    if (existing) {
      await store.touchMember(principal.id)
      return existing
    }
    // First login provisions a viewer. Someone with an account can look; doing
    // anything requires an admin to raise the role, which is a deliberate,
    // auditable act rather than a default.
    const created = await store.upsertMember({
      principalId: principal.id,
      displayName: principal.displayName,
      launcherSub: principal.subject,
      role: config.defaultMemberRole,
    })
    logger?.log?.(`[identity] provisioned member ${principal.id} as ${created.role}`)
    return created
  }

  return {
    launcher,
    get loginEnabled() {
      return launcher.enabled
    },

    async login({ username, password }) {
      // Without a launcher there is no account system to ask, so the service
      // admin token doubles as the sign-in secret. This is what makes local
      // development and the very first boot usable; it is not a bypass, because
      // holding that token already grants full API access.
      if (!launcher.enabled) {
        if (config.adminToken && secureEqual(password, config.adminToken)) {
          return {
            token: config.adminToken,
            expiresIn: null,
            member: {
              principalId: 'service-admin',
              displayName: username || '服务管理员',
              role: 'admin',
            },
          }
        }
        throw new AppError(401, 'invalid_credentials', '未接入 mx-launcher，请用服务 admin token 作为密码登录', {
          hint: '配置 MXT_LAUNCHER_URL 后即可用 mx-launcher 账号登录。',
        })
      }
      const { token, expiresIn } = await launcher.passwordLogin({ username, password })
      const principal = await launcher.introspect(token)
      const member = await memberFor(principal)
      return { token, expiresIn, member }
    },

    /**
     * Resolve a request's caller.
     *
     * The service admin token stays available for scripts and `manage.sh`; a
     * human presenting a launcher token is resolved through introspection.
     * Which one it is matters — `kind` is recorded on everything they create.
     */
    async resolve(token) {
      if (!token) {
        throw new AppError(401, 'unauthorized', '需要登录', {
          hint: launcher.enabled
            ? '在界面上用 mx-launcher 账号登录，或用服务 admin token 调用 API。'
            : '未配置 MXT_LAUNCHER_URL，当前只接受服务 admin token。',
        })
      }
      if (config.adminToken && secureEqual(token, config.adminToken)) {
        return {
          kind: 'service',
          id: 'service-admin',
          displayName: '服务管理员',
          role: 'admin',
        }
      }
      if (!launcher.enabled) {
        throw new AppError(401, 'unauthorized', 'Token 无效', {
          hint: '未配置 MXT_LAUNCHER_URL，因此只有服务 admin token 可用。',
        })
      }
      const principal = await launcher.introspect(token)
      const member = await memberFor(principal)
      if (member.role === 'disabled') {
        throw new AppError(403, 'member_disabled', '该账号已被停用')
      }
      return { ...principal, role: member.role }
    },
  }
}

/** Throw unless the caller holds at least `required`. */
export function requireRole(principal, required) {
  if ((RANK[principal.role] ?? 0) < RANK[required]) {
    throw new AppError(403, 'forbidden', `需要 ${required} 权限，当前是 ${principal.role}`, {
      hint: '请让管理员在「成员」页面提升你的权限。',
    })
  }
  return principal
}
