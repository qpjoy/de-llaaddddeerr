#!/usr/bin/env node
// 试验场 · 星港物资台 (Proving Ground): a small web app with known defects.
//
// It exists so Rig can be shown, measured and learned on something that
// never changes under it: every defect in defects.json can be switched on or
// off, so the same procedures run against a broken build (v1, all on) and a
// fixed one (v2, all off). A detector earns its keep by finding the first and
// staying quiet on the second.
//
// No dependencies: Node's http server, one HTML shell, one script, one
// stylesheet. Nothing here is product evidence — it is a fixture.
//
//   node test-packs/proving-ground/server.mjs [--port 4610] [--host 127.0.0.1] [--bugs all|none|PG-001,PG-003]

import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const here = (name) => new URL(`./${name}`, import.meta.url)

export const catalog = JSON.parse(await readFile(here('defects.json'), 'utf8'))
export const DEFECT_IDS = Object.freeze(catalog.defects.map((entry) => entry.id))

// How long the slow parts take. The KPI delay is the defect PG-009; saving is
// slow on purpose in both builds, so a double click lands while the first
// request is still in flight (PG-011) whoever is clicking.
const KPI_SLOW_MS = 2500
const SAVE_MS = 1200
const EXPORT_MS = 300
// A request the broken export holds open is let go after this, at the latest.
const HOLD_LIMIT_MS = 120_000

const PAGES = /^\/(login|items|items\/\d+|new|reports|settings)\/?$/

/** Which defects are on: `all`, `none`, or a comma-separated list of ids. */
export function readBugs(value = 'all') {
  const text = String(value ?? 'all').trim()
  if (text === 'all' || text === '') return new Set(DEFECT_IDS)
  if (text === 'none') return new Set()
  const ids = text.split(',').map((part) => part.trim().toUpperCase()).filter(Boolean)
  const unknown = ids.filter((id) => !DEFECT_IDS.includes(id))
  if (unknown.length) throw new Error(`未知的缺陷编号：${unknown.join('、')}（可用：${DEFECT_IDS.join('、')}）`)
  return new Set(ids)
}

const seedItems = () => [
  { id: 1, name: '不锈钢螺栓 M8', status: 'active', qty: 1200, owner: '王工' },
  { id: 2, name: '螺栓防松垫片', status: 'archived', qty: 0, owner: '李工' },
  // No owner on purpose: the detail page has to say so (PG-003).
  { id: 3, name: '防水密封圈', status: 'active', qty: 86 },
  { id: 4, name: '液压油 46#', status: 'active', qty: 40, owner: '赵工' },
  { id: 5, name: '旧款继电器', status: 'archived', qty: 3, owner: '钱工' }
]

const base64url = (value) => Buffer.from(value).toString('base64url')

/** A token shaped like a JWT, so a sensor that looks for one has something real to find. */
function issueToken(username, secret) {
  const head = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ sub: username, iat: Math.floor(Date.now() / 1000), nonce: randomBytes(6).toString('hex') }))
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${signature}`
}

function send(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return
  const json = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  })
  res.end(json)
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16_384) throw new Error('too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

/**
 * Start a proving ground. Each one has its own data, sessions and defects,
 * so parallel tests never see each other.
 *
 * @returns {Promise<{ origin: string, bugs: Set<string>, close: () => Promise<void> }>}
 */
export async function startProvingGround({ port = 0, host = '127.0.0.1', bugs = 'all' } = {}) {
  const on = bugs instanceof Set ? new Set(bugs) : readBugs(bugs)
  const bug = (id) => on.has(id)
  const [shell, script, style] = await Promise.all([
    readFile(here('index.html'), 'utf8'),
    readFile(here('app.js'), 'utf8'),
    readFile(here('style.css'), 'utf8')
  ])
  const secret = randomBytes(16)
  const sessions = new Set()
  const items = seedItems()
  const created = new Map()
  const held = new Set()
  let nextId = items.length + 1

  const page = shell.replace(
    '<!--CONFIG-->',
    `<script id="pg-config" type="application/json">${JSON.stringify({ bugs: [...on] })}</script>`
  )

  const authorized = (req) => {
    const header = String(req.headers.authorization ?? '')
    return header.startsWith('Bearer ') && sessions.has(header.slice(7))
  }

  async function api(req, res, url) {
    const path = url.pathname
    if (path === '/api/login' && req.method === 'POST') {
      const body = await readJson(req)
      const username = String(body.username ?? '').trim().slice(0, 40)
      if (!username) return send(res, 400, { error: '请填写用户名' })
      const token = issueToken(username, secret)
      sessions.add(token)
      return send(res, 200, { token, user: username })
    }
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })

    if (path === '/api/items' && req.method === 'GET') {
      const q = String(url.searchParams.get('q') ?? '').trim()
      const status = String(url.searchParams.get('status') ?? '')
      // PG-001: archived plus a keyword trips an unhandled branch on the server.
      if (bug('PG-001') && status === 'archived' && q) return send(res, 500, { error: 'internal error' })
      const found = items.filter((item) => (!q || item.name.includes(q)) && (!status || item.status === status))
      // PG-002: nothing found comes back as null, which the page then reads as a list.
      if (!found.length && bug('PG-002')) return send(res, 200, { items: null, total: 0 })
      return send(res, 200, { items: found, total: found.length })
    }
    const one = path.match(/^\/api\/items\/(\d+)$/)
    if (one && req.method === 'GET') {
      const item = items.find((entry) => entry.id === Number(one[1]))
      return item ? send(res, 200, { item }) : send(res, 404, { error: '没有这个物资' })
    }
    if (path === '/api/items' && req.method === 'POST') {
      const body = await readJson(req)
      const name = String(body.name ?? '').trim().slice(0, 80)
      if (!name) return send(res, 400, { error: '请填写名称' })
      const requestId = typeof body.requestId === 'string' ? body.requestId.slice(0, 80) : null
      await new Promise((resolve) => setTimeout(resolve, SAVE_MS))
      // The fixed build sends one id per form and the server keeps the first;
      // PG-011's page sends none, so every click is a new record.
      if (requestId && created.has(requestId)) return send(res, 200, { item: created.get(requestId), duplicate: true })
      const item = { id: nextId++, name, status: 'active', qty: 0, owner: body.owner ? String(body.owner).slice(0, 40) : '试验员' }
      items.push(item)
      if (requestId) created.set(requestId, item)
      return send(res, 201, { item, duplicate: false })
    }
    if (path === '/api/reports/kpi' && req.method === 'GET') {
      if (bug('PG-009')) await new Promise((resolve) => setTimeout(resolve, KPI_SLOW_MS))
      return send(res, 200, { outbound: 3280, inbound: 2960, stock: items.reduce((sum, item) => sum + item.qty, 0) })
    }
    if (path === '/api/reports/export' && req.method === 'GET') {
      // PG-007: the export never answers; the page's spinner never stops.
      if (bug('PG-007')) {
        const timer = setTimeout(() => send(res, 504, { error: 'timeout' }), HOLD_LIMIT_MS)
        held.add(res)
        res.on('close', () => {
          clearTimeout(timer)
          held.delete(res)
        })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, EXPORT_MS))
      return send(res, 200, { file: 'report-2026-10.csv', rows: items.length })
    }
    return send(res, 404, { error: 'not found' })
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://proving-ground.local')
      const path = url.pathname
      if (path.startsWith('/api/')) return await api(req, res, url)
      if (req.method !== 'GET') return send(res, 405, 'method not allowed')
      if (path === '/') return send(res, 302, '', { location: '/login' })
      if (path === '/favicon.ico') {
        res.writeHead(204)
        return res.end()
      }
      if (path === '/app.js') return send(res, 200, script, { 'content-type': 'text/javascript; charset=utf-8' })
      if (path === '/style.css') return send(res, 200, style, { 'content-type': 'text/css; charset=utf-8' })
      if (PAGES.test(path)) return send(res, 200, page, { 'content-type': 'text/html; charset=utf-8' })
      return send(res, 404, 'not found')
    } catch {
      return send(res, 400, { error: 'bad request' })
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  return {
    origin: `http://${host}:${address.port}`,
    bugs: on,
    async close() {
      for (const res of held) res.destroy()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`)
    return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback
  }
  const ground = await startProvingGround({
    port: Number(arg('port', 4610)),
    host: arg('host', '127.0.0.1'),
    bugs: arg('bugs', 'all')
  })
  const list = [...ground.bugs]
  console.log(`试验场已启动：${ground.origin}`)
  console.log(list.length ? `开启的缺陷（${list.length}）：${list.join('、')}` : '没有开启任何缺陷（修复版）')
  console.log('这是夹具：结果只说明检测能力，不作为任何真实产品的通过证据。按 Ctrl+C 停止。')
  const stop = () => ground.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
