#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { RigClient } from '../packages/runtime/client.mjs'
import { createMcpServer } from '../packages/mcp/server.mjs'

// No login, model keys, UI launch or mutation on startup. stdout is MCP only.
try {
  const { MX_RIG_URL: url, MX_RIG_TOKEN: token, MX_RIG_MCP_ALLOW_WRITES: writes } = process.env
  if (!url || !token)
    throw new Error('请设置 MX_RIG_URL 和 MX_RIG_TOKEN（当前账号的 Rig bearer token）')
  if (writes !== undefined && !['0', '1'].includes(writes))
    throw new Error('MX_RIG_MCP_ALLOW_WRITES 只能是 0 或 1')
  const client = new RigClient({ url, token })
  const connection = serveStdio(() => createMcpServer({ client, allowWrites: writes === '1' }), {
    onerror: () => console.error('[mx-rig-mcp] MCP transport error')
  })
  const shutdown = () => connection.close().catch(() => {})
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
} catch {
  console.error(
    '[mx-rig-mcp] 启动失败：检查 MX_RIG_URL、MX_RIG_TOKEN 和 MX_RIG_MCP_ALLOW_WRITES；远程服务须使用 HTTPS。'
  )
  process.exitCode = 1
}
