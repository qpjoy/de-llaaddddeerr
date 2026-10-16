import { AsyncLocalStorage } from 'node:async_hooks'
import { AppError } from './core/errors.mjs'

const rank = { viewer: 1, operator: 2, admin: 3 }
export const legacyAccess = () => ({
  revision: 0,
  visibility: 'legacy-shared',
  ownerId: null,
  members: []
})
const missing = () => new AppError(404, 'not_found', '项目或资源不存在')
export function projectRole(app, principal) {
  if (!app || !rank[principal?.role]) return null
  const policy = app.access ?? legacyAccess()
  if (policy.visibility === 'legacy-shared') return principal.role
  if (policy.ownerId === principal.id) return principal.role
  if (policy.visibility === 'private') return null
  const member = policy.members.find((row) => row.principalId === principal.id)
  return member
    ? Object.keys(rank).find(
        (key) => rank[key] === Math.min(rank[principal.role], rank[member.role])
      )
    : null
}
export function initialAccess(principal, visibility) {
  // Existing service-token automation keeps its explicit deployment boundary.
  // Human-created projects and the new workbench default to private.
  visibility ??= principal.kind === 'service' ? 'legacy-shared' : 'private'
  if (!['private', 'members', 'legacy-shared'].includes(visibility))
    throw new AppError(400, 'invalid_request', '项目范围必须是 private、members 或 legacy-shared')
  return { revision: 1, visibility, ownerId: principal.id, members: [] }
}

/** One request scope for HTTP, native clients and in-process Agent tools.
 * Unscoped calls are trusted scheduler/runner operations, never a human API.
 * Every protected method re-reads policy; no replica-local membership cache.
 */
export class ProjectAccess {
  constructor(raw) {
    this.raw = raw
    this.context = new AsyncLocalStorage()
    this.store = new Proxy(raw, {
      get: (target, key) => {
        const value = target[key]
        if (typeof value !== 'function') return value
        return (...args) => this.call(key, args)
      }
    })
  }
  scope(principal, action) {
    return this.context.run(principal, action)
  }
  async current(principal = this.context.getStore()) {
    if (!principal) return null
    if (!['local', 'user'].includes(principal.kind)) return principal
    const member = await this.raw.getMember(principal.id)
    if (!member || !rank[member.role]) throw new AppError(403, 'member_disabled', '账号已不可用')
    if (principal.kind === 'local') {
      const account = await this.raw.getLocalAccountByPrincipal(principal.id)
      if (!account || account.disabledAt) throw new AppError(403, 'member_disabled', '账号已停用')
    }
    return { ...principal, role: member.role }
  }
  async can(appId, action = 'read', principal = this.context.getStore()) {
    if (!principal) return true
    const role = projectRole(await this.raw.getApp(appId), await this.current(principal))
    return Boolean(role && rank[role] >= { read: 1, write: 2, manage: 3 }[action])
  }
  async require(appId, action = 'read', principal = this.context.getStore()) {
    if (!(await this.can(appId, 'read', principal))) throw missing()
    if (!(await this.can(appId, action, principal)))
      throw new AppError(403, 'project_forbidden', '没有此项目的操作权限')
  }
  async filter(rows, appOf = (row) => row.appId) {
    const principal = await this.current()
    if (!principal) return rows
    const readable = new Set(
      (await this.raw.listApps()).filter((app) => projectRole(app, principal)).map((app) => app.id)
    )
    const permitted = await Promise.all(
      rows.map(async (row) => {
        const id = await appOf(row)
        return !id || readable.has(id)
      })
    )
    return rows.filter((_, index) => permitted[index])
  }
  async mission(row, action = 'read') {
    if (row?.workbench?.appId) await this.require(row.workbench.appId, action)
    return row
  }
  missions(raw) {
    return new Proxy(raw, {
      get: (target, key) => {
        const value = target[key]
        if (typeof value !== 'function') return value
        return (...args) => {
          if (!this.context.getStore()) return value.apply(target, args)
          if (key === 'get')
            return Promise.resolve(value.apply(target, args)).then((row) => this.mission(row))
          if (key === 'list' || key === 'recent')
            return Promise.resolve(value.apply(target, args)).then((rows) =>
              this.filter(rows, (row) => row.workbench?.appId)
            )
          if (key === 'create')
            return this.mission(args[1], 'write').then(() => value.apply(target, args))
          if (key === 'syncDesktop')
            return Promise.all(args[1].map((row) => this.mission(row, 'write'))).then(() =>
              value.apply(target, args)
            )
          return value.apply(target, args)
        }
      }
    })
  }
  procedures(raw) {
    this.procedureStore = raw
    const appOf = async (doc) => (doc.app ? (await this.raw.getAppBySlug(doc.app))?.id : null)
    const check = async (doc, action) => {
      const id = await appOf(doc)
      if (id) await this.require(id, action)
      return doc
    }
    return new Proxy(raw, {
      get: (target, key) => {
        const value = target[key]
        if (typeof value !== 'function') return value
        return async (...args) => {
          if (!this.context.getStore()) return value.apply(target, args)
          if (key === 'list') return this.filter(await value.apply(target, args), appOf)
          if (key === 'get') return check(await value.apply(target, args), 'read')
          if (key === 'insert') {
            await check(args[0], 'write')
            return value.apply(target, args)
          }
          if (key === 'update')
            return value.call(target, args[0], async (before) => {
              await check(before, 'write')
              const after = await args[1](before)
              if (before.app !== after.app && (await appOf(before)))
                throw new AppError(
                  409,
                  'project_binding_changed',
                  '已有项目规程不能改换项目，请创建独立副本'
                )
              await check(after, 'write')
              return after
            })
          return value.apply(target, args)
        }
      }
    })
  }
  async policy(id, principal) {
    await this.require(id, 'read', principal)
    const app = await this.raw.getApp(id)
    const policy = app.access ?? legacyAccess()
    const members = await Promise.all(
      policy.members.map(async (entry) => ({
        ...entry,
        displayName: (await this.raw.getMember(entry.principalId))?.displayName ?? entry.principalId
      }))
    )
    return {
      ...policy,
      members,
      canWrite: await this.can(id, 'write', principal),
      canManage: await this.can(id, 'manage', principal)
    }
  }
  async change(id, input, principal) {
    const keys = Object.keys(input ?? {})
    if (
      keys.some((key) => !['expectedRevision', 'visibility', 'members'].includes(key)) ||
      !Number.isSafeInteger(input?.expectedRevision) ||
      input.expectedRevision < 0 ||
      !['private', 'members', 'legacy-shared'].includes(input.visibility) ||
      !Array.isArray(input.members) ||
      input.members.length > 100
    )
      throw new AppError(400, 'invalid_request', '请提交项目范围、完整成员列表及当前权限版本')
    const members = []
    for (const entry of input.members) {
      if (
        !entry ||
        Object.keys(entry).some((key) => !['principalId', 'role'].includes(key)) ||
        typeof entry.principalId !== 'string' ||
        entry.principalId.length > 200 ||
        !rank[entry.role]
      )
        throw new AppError(400, 'invalid_request', '成员身份或角色无效')
      const member = await this.raw.getMember(entry.principalId)
      const local = await this.raw.getLocalAccountByPrincipal(entry.principalId)
      if (!member || !rank[member.role] || local?.disabledAt)
        throw new AppError(400, 'invalid_member', '请选择已开通且有效的 Rig 成员')
      if (members.some((row) => row.principalId === entry.principalId))
        throw new AppError(400, 'duplicate_member', '成员不能重复')
      members.push({ principalId: entry.principalId, role: entry.role })
    }
    if (input.visibility === 'private' && members.length)
      throw new AppError(400, 'invalid_request', '个人项目不能同时保留其他成员')
    // Authorization and CAS are checked inside the same locked policy update.
    return this.raw.changeProjectAccess(id, async (app) => {
      const actor = await this.current(principal)
      if (projectRole(app, actor) !== 'admin')
        throw new AppError(403, 'project_forbidden', '需要项目管理权限')
      const before = app.access ?? legacyAccess()
      if (before.revision !== input.expectedRevision)
        throw new AppError(409, 'project_access_conflict', '项目成员已更新，请重新读取并核对')
      const ownerId = before.ownerId ?? actor.id
      if (members.some((row) => row.principalId === ownerId))
        throw new AppError(400, 'invalid_member', '创建者已经拥有项目权限，无需重复添加')
      // Only the owner can change sharing scope; delegated managers manage members.
      if (actor.id !== ownerId && before.visibility !== input.visibility)
        throw new AppError(403, 'project_forbidden', '只有项目所有者可以修改共享范围')
      const after = {
        revision: before.revision + 1,
        visibility: input.visibility,
        ownerId,
        members
      }
      return {
        after,
        audit: {
          actorId: actor.id,
          actorName: actor.displayName,
          action: 'project.access_change',
          resourceType: 'app',
          resourceId: id,
          appId: id,
          before,
          after
        }
      }
    })
  }
  async call(name, args) {
    const raw = this.raw
    if (!this.context.getStore()) return raw[name](...args)
    if (name === 'createApp')
      return raw.createApp({
        ...args[0],
        access: initialAccess(await this.current(), args[0]?.access?.visibility)
      })
    if (name === 'listRuns') {
      const principal = await this.current()
      const allowedAppIds = (await raw.listApps())
        .filter((app) => projectRole(app, principal))
        .map((app) => app.id)
      return raw.listRuns({ ...args[0], allowedAppIds })
    }
    // Lists filter before presentation. Nested resources always resolve their
    // actual stored parent, never a parent id claimed by the request body.
    const listParents = {
      listApps: (row) => row.id,
      listTasks: (row) => row.appId,
      listRuns: (row) => row.appId,
      listAuditEvents: (row) => row.appId,
      listNotificationChannels: (row) => row.appId,
      listNotifications: async (row) =>
        row.runId
          ? (await raw.getRun(row.runId))?.appId
          : (await raw.getNotificationChannel(row.channelId))?.appId
    }
    if (listParents[name]) return this.filter(await raw[name](...args), listParents[name])
    const gets = {
      getApp: 'app',
      getAppBySlug: 'app',
      getSuite: 'suite',
      getTask: 'task',
      getRun: 'run',
      getNotificationChannel: 'channel'
    }
    if (gets[name]) {
      const row = await raw[name](...args)
      if (row) {
        const id = gets[name] === 'app' ? row.id : row.appId
        if (id) await this.require(id)
      }
      return row
    }
    const appReads = [
      'listSuites',
      'listCatalogs',
      'listCases',
      'getCase',
      'caseHistory',
      'listSecrets',
      'getWebhookSecret'
    ]
    const appWrites = ['syncCatalog', 'upsertCase', 'retireCase']
    const appManage = ['deleteApp', 'setLatestPackage', 'setWebhookSecret', 'deleteSecret']
    if ([...appReads, ...appWrites, ...appManage].includes(name)) {
      await this.require(
        args[0],
        appManage.includes(name) ? 'manage' : appWrites.includes(name) ? 'write' : 'read'
      )
    }
    // Procedures retain project slugs in their version history. Until they can
    // be deleted or rebound together, deleting the App must not turn them into
    // unregistered, deployment-shared assets.
    if (name === 'deleteApp' && this.procedureStore) {
      const app = await raw.getApp(args[0])
      if (app && (await this.procedureStore.list({ app: app.slug })).length)
        throw new AppError(
          409,
          'project_has_procedures',
          '项目仍有关联规程；暂不支持连同规程历史一起删除'
        )
    }
    const byRun = [
      'listRunCases',
      'listSteps',
      'listAllSteps',
      'listRunEvents',
      'countRunEvents',
      'updateRun',
      'completeRun',
      'appendRunEvents'
    ]
    const byTask = [
      'updateTask',
      'deleteTask',
      'findRunByTaskAndSha',
      'findPreviousFinishedRun',
      'findLastPassingRun'
    ]
    const bySuite = ['updateSuite', 'deleteSuite']
    const byChannel = ['updateNotificationChannel', 'deleteNotificationChannel']
    if ([...byRun, ...byTask, ...bySuite, ...byChannel].includes(name)) {
      const row = await raw[
        byRun.includes(name)
          ? 'getRun'
          : byTask.includes(name)
            ? 'getTask'
            : bySuite.includes(name)
              ? 'getSuite'
              : 'getNotificationChannel'
      ](args[0])
      if (row?.appId)
        await this.require(
          row.appId,
          /^(update|delete|complete|append)/.test(name) ? 'write' : 'read'
        )
      const newApp = args[1]?.appId
      if (newApp) await this.require(newApp, 'write')
    }
    if (
      ['createSuite', 'createTask', 'createRun', 'putSecret', 'createNotificationChannel'].includes(
        name
      ) &&
      args[0]?.appId
    )
      await this.require(args[0].appId, 'write')
    return raw[name](...args)
  }
}
