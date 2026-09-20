import { McpServer } from '@modelcontextprotocol/server'
import { fromJSONSchema } from 'zod'
import { DEFINITIONS, ToolExecutor } from '../runtime/tools.mjs'
import { RigError, safeMessage } from '../contracts/index.mjs'
import { PRODUCT_VERSION } from '../contracts/version.mjs'

/** Rig remains the authority; the MCP host owns planning and tool approval. */
export function createMcpServer({ client, allowWrites = false }) {
  const server = new McpServer({ name: 'mx-rig', version: PRODUCT_VERSION })
  const executor = new ToolExecutor(client)
  let active = 0
  let writing = false
  for (const def of DEFINITIONS.filter((entry) => entry.group === 'test')) {
    if (def.effect === 'write' && !allowWrites) continue
    const write = def.effect === 'write'
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: fromJSONSchema(def.parameters),
        annotations: {
          readOnlyHint: !write,
          destructiveHint: def.name === 'tests_cancel',
          idempotentHint: !write,
          openWorldHint: true
        }
      },
      async (args, ctx) => {
        if (active >= 8 || (write && writing))
          return failure(new RigError('tool_busy', '工具正在执行，请稍后重试', 429))
        active++
        if (write) writing = true
        try {
          const signal = ctx.mcpReq.signal
          const { policy } = await client.request('/api/rig/v1/execution-config', undefined, signal)
          const result = await executor.execute(def.name, args, {
            policy,
            signal,
            // Explicit host opt-in, then Internal policy + API operator role.
            // Tool annotations are hints for host UX, never authorization.
            approved: write && allowWrites
          })
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result
          }
        } catch (error) {
          return failure(error)
        } finally {
          active--
          if (write) writing = false
        }
      }
    )
  }
  return server
}

function failure(error) {
  const result = {
    error: {
      code: error instanceof RigError ? error.code : 'tool_error',
      message: safeMessage(error)
    }
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result
  }
}
