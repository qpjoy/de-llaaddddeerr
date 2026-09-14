import { MissionStore } from './store.mjs'
import { RigRuntime } from './engine.mjs'
import { RigClient } from './client.mjs'
import { ToolExecutor } from './tools.mjs'
import { BrowserTools } from './browser.mjs'
import { RigError, safeMessage } from '../contracts/index.mjs'
import { join } from 'node:path'

let runtime
process.on('message', async (message) => {
  if (!message || typeof message.id !== 'number') return
  try {
    let result
    if (message.method === 'init' && !runtime) {
      const { root, url, token, owner } = message.input
      const client = new RigClient({ url, token })
      const store = await new MissionStore(join(root, 'missions')).init()
      const browser = new BrowserTools(join(root, 'artifacts'))
      runtime = new RigRuntime({
        store,
        client,
        executor: new ToolExecutor(client, browser),
        owner
      })
      result = { ready: true }
    } else {
      if (!runtime) throw new RigError('not_ready', 'Runtime 尚未就绪')
      switch (message.method) {
        case 'list':
          result = { missions: runtime.list() }
          break
        case 'start':
          result = { mission: await runtime.start(message.input) }
          break
        case 'followup':
          result = { mission: await runtime.followup(message.input.id, message.input) }
          break
        case 'approve':
          result = {
            mission: await runtime.approve(
              message.input.id,
              message.input.approvalId,
              message.input.approved
            )
          }
          break
        case 'cancel':
          result = { mission: await runtime.cancel(message.input.id) }
          break
        case 'close':
          await runtime.close()
          result = { closed: true }
          break
        default:
          throw new RigError('invalid_method', '不支持的 Runtime 请求')
      }
    }
    process.send?.({ id: message.id, result })
  } catch (error) {
    process.send?.({
      id: message.id,
      error: { code: error.code || 'runtime_error', message: safeMessage(error) }
    })
  }
})
process.on('disconnect', () => {
  runtime
    ?.close()
    .finally(() => process.exit())
    .catch(() => process.exit(1))
})
