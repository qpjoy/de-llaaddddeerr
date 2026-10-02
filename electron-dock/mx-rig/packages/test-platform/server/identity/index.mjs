import { AppError } from '../core/errors.mjs'
import { secureEqual } from '../core/ids.mjs'
import { LauncherIdentityClient } from './launcher-client.mjs'
import {
  LOCKOUT_MS,
  MAX_FAILED_LOGINS,
  burnVerification,
  generatePassword,
  hashPassword,
  isLocalPrincipal,
  isSessionToken,
  newSessionToken,
  normalizeAccount,
  principalIdFor,
  publicLocalAccount,
  requireAccount,
  requirePassword,
  sessionKey,
  verifyPassword,
} from './local-accounts.mjs'

// Authentication has two sources; authorization is always local.
//
// Rig's own accounts (local-accounts.mjs) make the product usable with nothing
// else running. mx-launcher federation is an optional second source: when
// configured, a Launcher account can sign in too. Either way the `mxt_members`
// table answers "what may they do here" — a broad role elsewhere must not imply
// the right to schedule jobs on real machines.

export const ROLES = ['viewer', 'operator', 'admin']

const RANK = { viewer: 1, operator: 2, admin: 3 }

const INVALID_CREDENTIALS = () => new AppError(401, 'invalid_credentials', '账号或密码不正确')

export function createIdentity({ store, config, logger = console }) {
  const launcher = new LauncherIdentityClient({ ...config.launcher, logger })
  const sessionTtlMs = config.sessionTtlMs ?? 12 * 3_600_000

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

  async function issueSession(principalId, source) {
    const token = newSessionToken()
    await store.pruneSessions?.()
    await store.createSession({
      tokenHash: sessionKey(token),
      principalId,
      source,
      expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
    })
    return token
  }

  async function localLogin(record, password, source) {
    const now = Date.now()
    if (record.lockedUntil && Date.parse(record.lockedUntil) > now) {
      await burnVerification(password)
      throw new AppError(429, 'account_locked', '密码错误次数过多，账号已临时锁定，请 5 分钟后再试')
    }
    if (!(await verifyPassword(password, record.passwordHash))) {
      await store.recordFailedLogin(record.account, {
        maxFailures: MAX_FAILED_LOGINS,
        lockoutMs: LOCKOUT_MS,
      })
      throw INVALID_CREDENTIALS()
    }
    // A disabled account is refused only after the password matched, so the
    // answer does not tell a stranger which accounts exist.
    if (record.disabledAt) throw new AppError(403, 'member_disabled', '该账号已被停用')
    if (record.failedLogins || record.lockedUntil) {
      await store.updateLocalAccount(record.account, { failedLogins: 0, lockedUntil: null })
    }
    const member = await store.touchMember(record.principalId)
    if (!member) throw INVALID_CREDENTIALS()
    const token = await issueSession(record.principalId, source)
    return {
      token,
      expiresIn: Math.floor(sessionTtlMs / 1000),
      // Same shape `resolve()` gives, so a UI can act on it before its next /me.
      member: {
        ...member,
        kind: 'local',
        mustChangePassword: record.mustChangePassword,
        local: publicLocalAccount(record),
      },
    }
  }

  async function localPrincipal(token) {
    const session = await store.getSession(sessionKey(token))
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) {
      throw new AppError(401, 'unauthorized', '登录已失效，请重新登录')
    }
    const [member, record] = await Promise.all([
      store.getMember(session.principalId),
      store.getLocalAccountByPrincipal(session.principalId),
    ])
    if (!member || !record) throw new AppError(401, 'unauthorized', '登录已失效，请重新登录')
    if (record.disabledAt) throw new AppError(403, 'member_disabled', '该账号已被停用')
    return {
      kind: 'local',
      id: member.principalId,
      subject: record.account,
      displayName: member.displayName,
      role: member.role,
      mustChangePassword: record.mustChangePassword,
      sessionExpiresAt: session.expiresAt,
    }
  }

  async function localRecordFor(principalId) {
    if (!isLocalPrincipal(principalId)) {
      throw new AppError(409, 'not_local_account', '只有 Rig 本地账号可以在这里管理密码与停用；Launcher 账号请在 Launcher 管理')
    }
    const record = await store.getLocalAccountByPrincipal(principalId)
    if (!record) throw new AppError(404, 'member_not_found', '找不到该成员')
    return record
  }

  return {
    launcher,
    get loginEnabled() {
      return true
    },
    get federated() {
      return launcher.enabled
    },

    async login({ username, password, source = null }) {
      // Keep the break-glass service administrator usable after Launcher is
      // enabled. Check it locally before OAuth so this secret is never sent to
      // another service as though it were a person's password.
      const usesAdminToken = Boolean(
        config.adminToken && secureEqual(password, config.adminToken),
      )
      if (usesAdminToken && launcher.enabled && username?.trim() !== 'admin') {
        throw new AppError(401, 'invalid_credentials', '服务 admin token 只能与账号 admin 一起使用')
      }
      if (usesAdminToken && (username?.trim() === 'admin' || !launcher.enabled)) {
        return {
          token: config.adminToken,
          expiresIn: null,
          member: {
            principalId: 'service-admin',
            displayName: '服务管理员',
            role: 'admin',
          },
        }
      }
      // Rig's own accounts come first: a local account is something an admin
      // created here on purpose, so it answers for its name even when a
      // Launcher account happens to share it.
      const account = normalizeAccount(username)
      const record = account ? await store.getLocalAccount?.(account) : null
      if (record) return localLogin(record, password, source)
      if (!launcher.enabled) {
        await burnVerification(password)
        throw new AppError(401, 'invalid_credentials', '账号或密码不正确', {
          hint: '请使用管理员为你开通的 Rig 账号；服务管理员使用账号 admin 与部署生成的 admin token。',
        })
      }
      const { token, expiresIn } = await launcher.passwordLogin({ username, password }, source)
      const principal = await launcher.introspect(token, source)
      if (isLocalPrincipal(principal.id)) {
        throw new AppError(502, 'launcher_contract', 'mx-launcher 返回了保留的本地账号标识')
      }
      const member = await memberFor(principal)
      return { token, expiresIn, member }
    },

    /** Revoke a session Rig issued. Other tokens are not Rig's to revoke. */
    async logout(token) {
      if (isSessionToken(token)) await store.revokeSession(sessionKey(token))
    },

    /**
     * Resolve a request's caller.
     *
     * The service admin token stays available for scripts and `manage.sh`;
     * Rig sessions resolve locally; a Launcher token is resolved through
     * introspection. Which one it is matters — `kind` is recorded on
     * everything they create.
     */
    async resolve(token, source = null) {
      if (!token) {
        throw new AppError(401, 'unauthorized', '需要登录', {
          hint: '在界面上用 Rig 账号登录，或用服务 admin token 调用 API。',
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
      if (isSessionToken(token)) return localPrincipal(token)
      if (!launcher.enabled) {
        throw new AppError(401, 'unauthorized', 'Token 无效', {
          hint: '未配置 Launcher 联邦登录，只接受 Rig 会话与服务 admin token。',
        })
      }
      const principal = await launcher.introspect(token, source)
      if (isLocalPrincipal(principal.id)) {
        throw new AppError(401, 'unauthorized', 'Token 无效')
      }
      const member = await memberFor(principal)
      if (member.role === 'disabled') {
        throw new AppError(403, 'member_disabled', '该账号已被停用')
      }
      return { ...principal, role: member.role }
    },

    // -- local account administration --------------------------------------

    /**
     * Create a Rig account. Without a password the service generates a
     * one-time one, returned exactly once; either way the member is asked to
     * change it at first sign-in.
     */
    async createLocalMember({ account, displayName, role, password }, actor) {
      const name = requireAccount(account)
      if (!ROLES.includes(role)) throw new AppError(400, 'invalid_role', `角色只能是 ${ROLES.join(' / ')}`)
      const initial = password == null ? generatePassword() : requirePassword(password)
      const created = await store.createLocalMember({
        member: {
          principalId: principalIdFor(name),
          displayName: displayName?.trim() || name,
          role,
        },
        account: {
          account: name,
          passwordHash: await hashPassword(initial),
          mustChangePassword: true,
          createdBy: actor?.id ?? null,
        },
      })
      return {
        member: { ...created.member, local: publicLocalAccount(created.account) },
        ...(password == null ? { initialPassword: initial } : {}),
      }
    },

    /** Replace a member's password with a one-time one and end every session. */
    async resetLocalPassword(principalId) {
      const record = await localRecordFor(principalId)
      const initial = generatePassword()
      const updated = await store.updateLocalAccount(record.account, {
        passwordHash: await hashPassword(initial),
        mustChangePassword: true,
        failedLogins: 0,
        lockedUntil: null,
      })
      const revoked = await store.revokeSessionsFor(principalId)
      return { local: publicLocalAccount(updated), initialPassword: initial, revokedSessions: revoked }
    },

    async setLocalDisabled(principalId, disabled) {
      const record = await localRecordFor(principalId)
      const updated = await store.updateLocalAccount(record.account, {
        disabledAt: disabled ? new Date().toISOString() : null,
      })
      const revoked = disabled ? await store.revokeSessionsFor(principalId) : 0
      return { local: publicLocalAccount(updated), revokedSessions: revoked }
    },

    /** A member changes their own password; other sessions end, this one stays. */
    async changePassword(principal, { current, next }, token) {
      if (principal.kind !== 'local') {
        throw new AppError(409, 'not_local_account', '只有 Rig 本地账号可以在这里修改密码')
      }
      const record = await localRecordFor(principal.id)
      if (!(await verifyPassword(current, record.passwordHash))) {
        await store.recordFailedLogin(record.account, {
          maxFailures: MAX_FAILED_LOGINS,
          lockoutMs: LOCKOUT_MS,
        })
        throw new AppError(401, 'invalid_credentials', '当前密码不正确')
      }
      requirePassword(next, '新密码')
      if (await verifyPassword(next, record.passwordHash)) {
        throw new AppError(400, 'weak_password', '新密码不能与当前密码相同')
      }
      const updated = await store.updateLocalAccount(record.account, {
        passwordHash: await hashPassword(next),
        mustChangePassword: false,
        passwordChangedAt: new Date().toISOString(),
        failedLogins: 0,
        lockedUntil: null,
      })
      const revoked = await store.revokeSessionsFor(principal.id, {
        exceptTokenHash: isSessionToken(token) ? sessionKey(token) : null,
      })
      return { local: publicLocalAccount(updated), revokedSessions: revoked }
    },

    /** Local account facts to show next to a member list. */
    async localAccounts() {
      const records = (await store.listLocalAccounts?.()) ?? []
      return new Map(records.map((record) => [record.principalId, publicLocalAccount(record)]))
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
