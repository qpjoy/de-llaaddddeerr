import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRuntime } from '../../packages/test-platform/server/index.mjs'
import { loadConfig } from '../../packages/test-platform/server/config.mjs'
import {
  readJson,
  sendJson,
  bearerToken,
  sessionCookie,
  clearSessionCookie,
  directClientAddress
} from '../../packages/test-platform/server/core/http.mjs'
import { requireRole } from '../../packages/test-platform/server/identity/index.mjs'
import { Settings } from './settings.mjs'
import { ModelGateway } from './model.mjs'
import { mapExternalEnvironment } from './environment.mjs'
import { RigError, safeMessage } from '../../packages/contracts/index.mjs'
import { MissionStore } from '../../packages/runtime/store.mjs'
import { RigRuntime } from '../../packages/runtime/engine.mjs'
import { RigClient } from '../../packages/runtime/client.mjs'
import { ToolExecutor } from '../../packages/runtime/tools.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const webRoot = fileURLToPath(new URL('../web/', import.meta.url))
export function configuration(env = process.env) {
  const mapped = mapExternalEnvironment(env, {})
  mapped.MXT_HOST ||= '127.0.0.1'
  mapped.MXT_PORT ||= '8791'
  mapped.MXT_ARTIFACTS_DIR ||= resolve(root, '.runtime/artifacts')
  mapped.MXT_SELF_URL ||= 'http://127.0.0.1:8791'
  const config = loadConfig(mapped)
  if (!config.adminToken)
    throw new RigError(
      'admin_required',
      '必须配置 MX_RIG_ADMIN_TOKEN；本地体验使用 npm run dev',
      500
    )
  return config
}

export async function start(env = process.env, options = {}) {
  const config = options.config || configuration(env)
  const kernel = await createRuntime(config, { schedule: options.schedule ?? true })
  const dataRoot = resolve(env.MX_RIG_STATE_DIR || resolve(root, '.runtime/control'))
  const settings = await new Settings(resolve(dataRoot, 'settings.json')).init()
  const missions = await new MissionStore(resolve(dataRoot, 'missions')).init()
  const gateway = new ModelGateway(settings, options.modelOptions)
  const sessions = new Map()
  let origin
  const runtimeFor = (principal) => {
    const owner = principal.id
    let entry = sessions.get(owner)
    if (!entry) throw new RigError('session_missing', '请重新登录', 401)
    return entry.runtime
  }
  const register = async (principal, token) => {
    const current = sessions.get(principal.id)
    if (current) {
      current.client.token = token
      return
    }
    if (sessions.size >= 40) throw new RigError('session_limit', '工作台会话已满', 429)
    const client = new RigClient({ url: origin, token })
    sessions.set(principal.id, {
      client,
      runtime: new RigRuntime({
        store: missions,
        client,
        executor: new ToolExecutor(client),
        owner: principal.id
      })
    })
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    if (path === '/') {
      res.writeHead(302, { location: '/rig/' })
      res.end()
      return
    }
    if (path === '/rig' || path.startsWith('/rig/')) {
      const files = {
        '/rig': 'index.html',
        '/rig/': 'index.html',
        '/rig/app.js': 'app.js',
        '/rig/style.css': 'style.css'
      }
      if (!files[path]) {
        res.writeHead(404)
        res.end()
        return
      }
      const file = files[path]
      try {
        const body = await readFile(resolve(webRoot, file))
        res.writeHead(200, {
          'content-type': file.endsWith('.css')
            ? 'text/css'
            : file.endsWith('.js')
              ? 'text/javascript'
              : 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          'x-content-type-options': 'nosniff'
        })
        res.end(body)
      } catch {
        res.writeHead(500)
        res.end()
      }
      return
    }
    // Preserve the complete, separately owned test API and classic console.
    if (!path.startsWith('/api/rig/')) {
      if (path === '/test-center/') req.url = '/'
      return kernel.app(req, res)
    }
    try {
      if (req.headers.origin && req.headers.origin !== `${config.publicUrl || origin}`)
        throw new RigError('origin_denied', '请求来源不允许', 403)
      if (
        req.method === 'POST' &&
        !String(req.headers['content-type'] || '').startsWith('application/json')
      )
        throw new RigError('json_required', '请求需要 JSON', 415)
      const source = directClientAddress(req)
      if (path === '/api/rig/v1/login' && req.method === 'POST') {
        const body = await readJson(req, 16_000)
        const result = await kernel.identity.login({
          username: body.account,
          password: body.password,
          source
        })
        const principal = await kernel.identity.resolve(result.token, source)
        await register(principal, result.token)
        // Browser clients only receive an HttpOnly cookie. Native login uses its own route below.
        sendJson(
          res,
          200,
          { member: result.member },
          { 'set-cookie': sessionCookie(result.token, { secure: config.secureCookies }) }
        )
        return
      }
      if (path === '/api/rig/v1/native-login' && req.method === 'POST') {
        if (req.headers.origin) throw new RigError('native_only', '使用工作台登录入口', 403)
        const body = await readJson(req, 16_000)
        const result = await kernel.identity.login({
          username: body.account,
          password: body.password,
          source
        })
        sendJson(res, 200, result)
        return
      }
      const token = bearerToken(req)
      const principal = await kernel.identity.resolve(token, source)
      if (path === '/api/rig/v1/me' && req.method === 'GET') {
        sendJson(res, 200, { principal })
        return
      }
      if (path === '/api/rig/v1/config' && req.method === 'GET') {
        sendJson(res, 200, settings.public())
        return
      }
      if (path === '/api/rig/v1/execution-config' && req.method === 'GET') {
        requireRole(principal, 'operator')
        sendJson(res, 200, settings.public())
        return
      }
      if (path === '/api/rig/v1/admin/config') {
        requireRole(principal, 'admin')
        if (req.method === 'GET') {
          sendJson(res, 200, settings.value)
          return
        }
        if (req.method === 'POST') {
          sendJson(res, 200, await settings.update(await readJson(req, 16_000)))
          return
        }
      }
      if (path === '/api/rig/v1/model/turn' && req.method === 'POST') {
        requireRole(principal, 'operator')
        const controller = new AbortController()
        res.on('close', () => {
          if (!res.writableEnded) controller.abort()
        })
        sendJson(
          res,
          200,
          await gateway.turn(principal.id, await readJson(req, 256_000), controller.signal)
        )
        return
      }
      if (path === '/api/rig/v1/logout' && req.method === 'POST') {
        await sessions.get(principal.id)?.runtime.close()
        sessions.delete(principal.id)
        sendJson(
          res,
          200,
          { ok: true },
          { 'set-cookie': clearSessionCookie({ secure: config.secureCookies }) }
        )
        return
      }
      if (path === '/api/rig/v1/missions' && req.method === 'GET') {
        sendJson(res, 200, { missions: missions.list(principal.id) })
        return
      }
      requireRole(principal, 'operator')
      await register(principal, token)
      const runtime = runtimeFor(principal)
      if (path === '/api/rig/v1/missions' && req.method === 'POST') {
        sendJson(res, 201, { mission: await runtime.start(await readJson(req, 16_000)) })
        return
      }
      const match = /^\/api\/rig\/v1\/missions\/([a-f0-9-]{36})\/(approve|cancel|followup)$/.exec(
        path
      )
      if (match && req.method === 'POST') {
        const body = await readJson(req, 4000)
        if (match[2] === 'approve' && typeof body.approved !== 'boolean')
          throw new RigError('invalid_input', 'approved 必须为布尔值')
        const mission =
          match[2] === 'followup'
            ? await runtime.followup(match[1], body)
            : match[2] === 'cancel'
              ? await runtime.cancel(match[1])
              : await runtime.approve(match[1], body.approvalId, body.approved)
        sendJson(res, 200, { mission })
        return
      }
      throw new RigError('not_found', '接口不存在', 404)
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        sendJson(res, error.status || 500, {
          error: {
            code: error.code || 'internal_error',
            message: error.status && error.status < 500 ? error.message : safeMessage(error)
          }
        })
    }
  })
  await new Promise((yes, no) => {
    server.once('error', no)
    server.listen(config.port, config.host, yes)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    server,
    kernel,
    settings,
    missions,
    origin,
    async close() {
      kernel.stopScheduler()
      await Promise.all([...sessions.values()].map((s) => s.runtime.close()))
      await new Promise((yes) => server.close(yes))
      await kernel.store.close()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await start()
  console.log(`MX Rig Internal service: ${runtime.origin}/rig/`)
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () =>
      runtime.close().catch(() => {
        process.exitCode = 1
      })
    )
}
