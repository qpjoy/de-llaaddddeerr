import { MissionStore } from './store.mjs'
import { RigRuntime } from './engine.mjs'
import { RigClient } from './client.mjs'
import { ToolExecutor } from './tools.mjs'
import { BrowserTools } from './browser.mjs'
import { provisionFromEnv } from './browser-provision.mjs'
import { NativeStation } from './native.mjs'
import { ProcedureBench } from './procedure-bench.mjs'
import { MissionSync } from './sync.mjs'
import { RigError, safeMessage } from '../contracts/index.mjs'
import { join } from 'node:path'

let runtime
let sync

function assertTakeover(active, id) {
  const row = active.current
  if (!row || row.id !== id || row.status !== 'awaiting_approval' || row.pending?.name !== 'takeover')
    throw new RigError('not_in_takeover', '这项任务现在不在人工接管中', 409)
}
let stationBrowser
let provision
let bench
process.on('message', async (message) => {
  if (!message || typeof message.id !== 'number') return
  try {
    let result
    if (message.method === 'init' && !runtime) {
      const { root, url, token, owner, electronApps = [], privateHttp = false } = message.input
      const client = new RigClient({ url, token, privateHttp })
      // Every durable save is also queued for the service, so the web
      // workbench and the team's reports see what this desktop ran.
      const store = await new MissionStore(join(root, 'missions'), {
        onSaved: (row) => sync?.markDirty(row.id)
      }).init()
      sync = await new MissionSync({ store, client, file: join(root, 'sync-state.json') }).init()
      // The test browser: the installer's copy, or one downloaded once into
      // this computer's MX Rig data folder (main passes both locations).
      provision = provisionFromEnv(process.env)
      provision.onProgress = (info) => process.send?.({ event: 'provision', info })
      const browser = new BrowserTools(join(root, 'artifacts'), undefined, {
        native: new NativeStation(),
        provision
      })
      // Nothing on this computer yet: start fetching now, not at the first
      // browser step of the first mission.
      const status = provision.status()
      if (!status.ready && status.canDownload) provision.download().catch(() => {})
      browser.setElectronApps(electronApps)
      // The live pane: frames of whatever page the Agent is driving, with its
      // cursor, pushed up to the window as they come (throttled at the source).
      browser.onFrame = (frame) => process.send?.({ event: 'frame', frame })
      // A page asking for a file while a person has it: the window answers.
      browser.onChooser = (info) => process.send?.({ event: 'chooser', info })
      // A page's alert / confirm / prompt while a person has it: the window asks.
      browser.onDialog = (info) => process.send?.({ event: 'dialog', info })
      stationBrowser = browser
      runtime = new RigRuntime({
        store,
        client,
        executor: new ToolExecutor(client, browser),
        owner
      })
      bench = new ProcedureBench({ client, runtime, browser })
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
              message.input.approved,
              { note: typeof message.input.note === 'string' ? message.input.note : null }
            )
          }
          break
        // A person's input from the live pane, and files they picked. Only
        // for the mission this runtime has paused for them.
        case 'browser-input':
          assertTakeover(runtime, message.input.id)
          result = await stationBrowser.input(message.input.event)
          break
        case 'browser-files':
          assertTakeover(runtime, message.input.id)
          result = await stationBrowser.chooseFiles(message.input.paths ?? [])
          break
        case 'browser-dialog':
          assertTakeover(runtime, message.input.id)
          result = await stationBrowser.answerDialog({ accept: message.input.accept === true, text: message.input.text })
          break
        case 'browser-status':
          result = provision?.status() ?? { ready: false, canDownload: false }
          break
        case 'browser-download':
          // Answered at once; progress arrives as events.
          provision?.download({ force: message.input?.force === true }).catch(() => {})
          result = provision?.status() ?? { ready: false, canDownload: false }
          break
        case 'browser-copy':
          assertTakeover(runtime, message.input.id)
          result = await stationBrowser.copy()
          break
        case 'cancel':
          result = { mission: await runtime.cancel(message.input.id) }
          break
        case 'set-electron-apps':
          stationBrowser?.setElectronApps(message.input.apps ?? [])
          result = { ok: true }
          break
        case 'takeover':
          result = { mission: await runtime.takeover(message.input.id) }
          break
        case 'native-probe':
          // Only ever from a button: the first call may raise a macOS dialog.
          result = await (stationBrowser?.native?.probe() ?? { supported: false })
          break
        case 'export':
          result = { export: await runtime.exportMission(message.input.id) }
          break
        case 'procedure-fire':
          result = await bench.fire(message.input.id)
          break
        case 'procedure-fire-all':
          result = await bench.fireAll(message.input)
          break
        case 'procedure-capture':
          result = await bench.capture(message.input.missionId, message.input)
          break
        case 'procedure-repair':
          result = await bench.repair(message.input.id, message.input.runId)
          break
        case 'close':
          await runtime.close()
          await sync?.close()
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
  Promise.resolve(runtime?.close())
    .then(() => sync?.close())
    .finally(() => process.exit())
    .catch(() => process.exit(1))
})
