// Who the terminal is, and where it keeps things.
//
// A member signs in with their Rig account — the same one the workbench uses,
// never MX-H2I's — and the session token is kept in the member's home
// directory, readable only by them. CI and scripts can instead pass
// MX_RIG_URL and MX_RIG_TOKEN, as the MCP server takes them.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { RigError } from '../../packages/contracts/index.mjs'
import { RigClient } from '../../packages/runtime/client.mjs'

export function rigHome(env = process.env) {
  return resolve(env.MX_RIG_HOME || join(homedir(), '.mx-rig'))
}

const sessionFile = (env) => join(rigHome(env), 'session.json')

/** The session in force: the environment's, or the one `mx-rig login` saved. */
export async function loadSession(env = process.env) {
  if (env.MX_RIG_URL && env.MX_RIG_TOKEN)
    return {
      server: env.MX_RIG_URL,
      token: env.MX_RIG_TOKEN,
      privateHttp: env.MX_RIG_ALLOW_PRIVATE_HTTP === '1',
      source: 'env'
    }
  try {
    const saved = JSON.parse(await readFile(sessionFile(env), 'utf8'))
    if (saved?.server && saved?.token) return { ...saved, source: 'file' }
  } catch {
    /* Not signed in. */
  }
  return null
}

export async function login({ server, account, password, privateHttp = false, env = process.env }) {
  const client = new RigClient({ url: server, token: '', privateHttp })
  const { token } = await client.request('/api/rig/v1/native-login', { account, password })
  client.token = token
  const { principal } = await client.request('/api/rig/v1/me')
  const home = rigHome(env)
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(
    sessionFile(env),
    `${JSON.stringify(
      {
        server: client.url,
        token,
        privateHttp,
        principal: { id: principal.id, name: principal.displayName ?? principal.id, role: principal.role },
        at: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
  return { server: client.url, principal }
}

export async function logout(env = process.env) {
  const session = await loadSession(env)
  if (session?.source === 'file') {
    const client = new RigClient({ url: session.server, token: session.token, privateHttp: session.privateHttp })
    await client.request('/api/rig/v1/logout', {}).catch(() => {})
  }
  await rm(sessionFile(env), { force: true })
  return session
}

/** A client with the member's session, and who they are. */
export async function connect(env = process.env) {
  const session = await loadSession(env)
  if (!session)
    throw new RigError('login_required', '还没有登录：先运行 mx-rig login --server <Rig 服务地址>', 401)
  const client = new RigClient({ url: session.server, token: session.token, privateHttp: session.privateHttp })
  let principal
  try {
    principal = (await client.request('/api/rig/v1/me')).principal
  } catch (error) {
    if (error.status === 401)
      throw new RigError('login_required', '登录已失效：重新运行 mx-rig login', 401)
    throw error
  }
  return { client, principal, session }
}

/** Where one member's missions on one service live on this machine. */
export function missionHome(env, server, principalId) {
  const key = createHash('sha256').update(`${server}\n${principalId}`).digest('hex').slice(0, 32)
  return join(rigHome(env), 'workspaces', key)
}
