import { fork } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { arch, hostname, platform } from 'node:os'
import { join } from 'node:path'
import { RigError } from '../../packages/contracts/index.mjs'

const OS_NAME = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform()] ?? 'linux'
const LOG_LINES = 200

/**
 * This computer as a runner, managed by the desktop.
 *
 * The runner itself is the platform's own `mxt-runner` — the same program a
 * person would install by hand — started as a child process. The desktop only
 * does what used to be three terminal commands: register the machine with the
 * member's session, keep the runner's credentials in its own profile, and
 * start or stop `watch`. Stopping is polite: the current job finishes first.
 *
 * Plain Node on purpose: the Electron main process wires it to buttons, and
 * the test suite drives the same code against a real runner.
 */
export class LocalRunner {
  constructor({
    dir,
    script,
    execPath = process.execPath,
    env = process.env,
    extraEnv = {},
    // What differs for a station (工位): the program's arguments, where it
    // reads its credentials from, and a capability set a person cannot widen.
    args = ['watch'],
    envFor = (folder) => ({
      MXT_RUNNER_CONFIG_DIR: folder,
      MXT_RUNNER_DATA_DIR: join(folder, 'data')
    }),
    capabilities = null,
    noun = '执行机'
  }) {
    this.dir = dir
    this.script = script
    this.execPath = execPath
    this.env = env
    this.extraEnv = extraEnv
    this.args = args
    this.envFor = envFor
    this.capabilities = capabilities
    this.noun = noun
    this.child = null
    this.log = []
    this.exited = null
  }
  get configFile() {
    return join(this.dir, 'runner.json')
  }
  async #config() {
    try {
      return JSON.parse(await readFile(this.configFile, 'utf8'))
    } catch {
      return {}
    }
  }
  async status() {
    const config = await this.#config()
    return {
      registered: Boolean(config.runnerToken),
      runnerId: config.runnerId ?? null,
      name: config.runnerName ?? null,
      server: config.server ?? null,
      engines: config.engines ?? [],
      surfaces: config.surfaces ?? [],
      running: Boolean(this.child),
      pid: this.child?.pid ?? null,
      exited: this.exited,
      log: this.log.slice(-80)
    }
  }
  /** Register with the member's own session; the runner token stays in this profile. */
  async register(client, input = {}) {
    if (this.child) throw new RigError('runner_running', `请先停止本机${this.noun}再重新注册`, 409)
    const name = String(input.name || hostname() || `${OS_NAME}-runner`).slice(0, 96)
    const engines =
      this.capabilities?.engines ??
      (input.engines?.length ? input.engines : ['cypress', 'playwright', 'playwright-electron'])
    const surfaces =
      this.capabilities?.surfaces ?? (input.surfaces?.length ? input.surfaces : ['web', 'electron'])
    const result = await client.request('/runner/v1/runners:register', {
      name,
      kind: 'local',
      os: OS_NAME,
      arch: arch(),
      engines,
      surfaces
    })
    await mkdir(this.dir, { recursive: true })
    await writeFile(
      this.configFile,
      `${JSON.stringify(
        {
          server: client.url,
          runnerId: result.runner.id,
          runnerToken: result.token,
          runnerName: result.runner.name ?? name,
          engines,
          surfaces
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )
    return this.status()
  }
  #line(text) {
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue
      this.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
    }
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES)
  }
  async start() {
    if (this.child) return this.status()
    const config = await this.#config()
    if (!config.runnerToken)
      throw new RigError('runner_unregistered', `这台电脑还没有注册为${this.noun}`, 409)
    this.exited = null
    const child = fork(this.script, this.args, {
      execPath: this.execPath,
      env: { ...this.env, ...this.extraEnv, ...this.envFor(this.dir) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    })
    child.stdout.on('data', (chunk) => this.#line(chunk))
    child.stderr.on('data', (chunk) => this.#line(chunk))
    child.on('exit', (code, signal) => {
      this.exited = { code, signal, at: new Date().toISOString() }
      this.#line(`${this.noun}进程已退出（${signal ?? code}）`)
      if (this.child === child) this.child = null
    })
    this.child = child
    return this.status()
  }
  /** Ask politely, wait for the current job, then insist. */
  async stop(timeoutMs = 20_000) {
    const child = this.child
    if (!child) return this.status()
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try {
      if (child.connected) child.send('stop')
    } catch {
      /* Already gone. */
    }
    const timer = new Promise((resolve) => setTimeout(resolve, timeoutMs, 'timeout'))
    if ((await Promise.race([exited, timer])) === 'timeout') {
      child.kill('SIGTERM')
      if ((await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000, 'timeout'))])) === 'timeout')
        child.kill('SIGKILL')
    }
    return this.status()
  }
  /**
   * Unregister from the platform and forget the credentials. Removing a
   * machine is its owner's act, so it is done with the member's session —
   * the runner's own token cannot delete itself.
   */
  async remove(client, { fetchImpl = fetch } = {}) {
    await this.stop()
    const config = await this.#config()
    let removed = false
    if (config.runnerId && client?.token) {
      const response = await fetchImpl(
        `${client.url}/api/v1/runners/${encodeURIComponent(config.runnerId)}`,
        { method: 'DELETE', headers: { authorization: `Bearer ${client.token}` }, redirect: 'error' }
      ).catch(() => null)
      removed = Boolean(response && (response.ok || response.status === 404))
    }
    await rm(this.configFile, { force: true })
    return { ...(await this.status()), unregistered: removed }
  }
}

/**
 * This computer on duty as a station (工位): procedure regression queued on
 * the service is replayed here, by `mx-rig station watch`, with a headless
 * browser of its own — not the one the member's missions use.
 */
export function localStation({ dir, script, execPath, env, extraEnv }) {
  return new LocalRunner({
    dir,
    script,
    execPath,
    env,
    extraEnv,
    args: ['station', 'watch'],
    envFor: (folder) => ({ MX_RIG_STATION_DIR: folder }),
    capabilities: { engines: ['rig-procedure'], surfaces: ['web'] },
    noun: '工位'
  })
}
