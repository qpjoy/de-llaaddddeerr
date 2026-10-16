import { RigError } from '../../packages/contracts/index.mjs'
import { requireRole } from '../../packages/test-platform/server/identity/index.mjs'
import { modelTurnBody, parseBody } from './schemas.mjs'

/**
 * The server-side Runtime's view of the service, without HTTP.
 *
 * It answers the same calls `RigClient` makes — execution config, model turns
 * and the test API — by running the same handlers in this process. The
 * desktop keeps using `RigClient`; the difference is only where the Runtime
 * lives.
 *
 * What it does not keep is a bearer token. It acts as the principal who
 * started the mission, and re-reads that member's role and account state on
 * every call: a role lowered, or an account disabled, mid-mission stops the
 * next tool call just as a revoked token used to.
 */
export class InProcessClient {
  constructor({
    principal,
    kernel,
    settings,
    gateway,
    caseBooks,
    missions,
    executions,
    implementations,
    source = 'rig-runtime'
  }) {
    this.principal = {
      kind: principal.kind,
      id: principal.id,
      displayName: principal.displayName,
      role: principal.role
    }
    this.kernel = kernel
    this.settings = settings
    this.gateway = gateway
    this.source = source
    this.caseBooks = caseBooks
    this.missions = missions
    this.executions = executions
    this.implementations = implementations
  }

  async #current() {
    if (this.principal.kind === 'service') return this.principal
    const member = await this.kernel.store.getMember(this.principal.id)
    if (!member) throw new RigError('forbidden', '账号已不存在，任务无法继续', 403)
    if (this.principal.kind === 'local') {
      const account = await this.kernel.store.getLocalAccountByPrincipal(this.principal.id)
      if (!account || account.disabledAt)
        throw new RigError('member_disabled', '该账号已被停用，任务无法继续', 403)
    }
    return { ...this.principal, role: member.role }
  }

  async request(path, body, signal) {
    signal?.throwIfAborted()
    const principal = await this.#current()
    try {
      return await (
        this.kernel.projectAccess?.scope.bind(this.kernel.projectAccess) ??
        ((_principal, action) => action())
      )(principal, async () => {
        const projectGate = /^\/api\/rig\/v1\/missions\/([a-f0-9-]{36})\/project-access$/.exec(path)
        if (projectGate) {
          const row = await this.missions.get(projectGate[1], principal.id)
          await this.kernel.projectAccess?.mission(row, 'write')
          return { allowed: true }
        }
        const implementation = /^\/api\/rig\/v1\/missions\/([a-f0-9-]{36})\/implementation$/.exec(
          path
        )
        if (implementation && this.implementations) {
          const row = await this.missions.get(implementation[1], principal.id)
          if (!row.workbench) throw new RigError('not_test_task', '任务未关联项目', 409)
          if (body === undefined) return await this.implementations.read(row.id)
          requireRole(principal, 'operator')
          await this.kernel.projectAccess?.mission(row, 'write')
          return await this.implementations.change(row.id, principal.id, 'edit', body)
        }
        const cases = /^\/api\/rig\/v1\/missions\/([a-f0-9-]{36})\/cases$/.exec(path)
        if (cases && body === undefined && this.caseBooks) {
          const row = await this.missions.get(cases[1], principal.id)
          if (!row.workbench) throw new RigError('not_test_task', '任务未关联项目', 409)
          return { book: await this.caseBooks.read(row.id) }
        }
        const results =
          /^\/api\/rig\/v1\/missions\/([a-f0-9-]{36})\/executions(?:\?run=([^&]+))?$/.exec(path)
        if (results && body === undefined && this.executions) {
          const row = await this.missions.get(results[1], principal.id)
          if (!row.workbench) throw new RigError('not_test_task', '任务未关联项目', 409)
          return await this.executions.list(row, results[2] ? decodeURIComponent(results[2]) : null)
        }
        if (path === '/api/rig/v1/execution-config') {
          requireRole(principal, 'operator')
          await this.settings.refresh()
          return JSON.parse(JSON.stringify(this.settings.public({ egressEndpoints: true })))
        }
        if (path === '/api/rig/v1/model/turn') {
          requireRole(principal, 'operator')
          return await this.gateway.turn(principal.id, parseBody(modelTurnBody, body), signal)
        }
        if (path.startsWith('/api/v1/'))
          return await this.kernel.app.invoke({
            method: body === undefined ? 'GET' : 'POST',
            path,
            body,
            principal,
            source: this.source
          })
        throw new RigError('invalid_path', '不允许的 API 路径', 400)
      })
    } catch (error) {
      throw asRigError(error)
    }
  }

  /** A model turn that reports text as it arrives; the same gateway call as HTTP. */
  async stream(path, body, signal, onDelta) {
    if (path !== '/api/rig/v1/model/turn:stream')
      throw new RigError('invalid_path', '不允许的 API 路径', 400)
    signal?.throwIfAborted()
    const principal = await this.#current()
    try {
      requireRole(principal, 'operator')
      return await this.gateway.turn(
        principal.id,
        parseBody(modelTurnBody, body),
        signal,
        (delta) => {
          try {
            onDelta?.(delta)
          } catch {
            /* Presentation only: losing a partial render must never lose the answer. */
          }
        }
      )
    } catch (error) {
      throw asRigError(error)
    }
  }
}

/** Kernel errors carry (status, code, message); the Runtime speaks RigError. */
function asRigError(error) {
  if (error instanceof RigError || error?.name === 'AbortError') return error
  if (typeof error?.status === 'number' && typeof error?.code === 'string')
    return new RigError(error.code, error.message, error.status)
  return error
}
