// Launcher 模式的自动更新（docs/25 P2）：版本由 Launcher 的 Release Center 决定。
//
// The Launcher SDK's application updater does the work — resolving Rig's
// release identity from its package name, the check, the download with its
// size and SHA-256 checks, staging under userData, and the queue that keeps
// clicks from overlapping. This module only supplies what is Rig's:
//
//   - where Release Center is: Launcher Internal behind Rig's own VIP, read
//     from the product network each time, and only while it is ready;
//   - what may be installed: full installers only (see UPDATE_CANDIDATES);
//   - what happens around an install: Rig stops its own things, then exits
//     while the installer takes over;
//   - what the page sees: a projection with fixed texts. The controller's
//     state carries URLs, file paths and raw errors; they stay in this
//     process (and its log), never reach the page.
//
// Checking and downloading never touch the network: no reconnect, no route
// change, nothing of MX-H2I's.

export const PACKAGE_NAME = '@qpjoy/mx-rig'

// Full installers (DMG / NSIS) only. An app-asar hot update would need the
// installed app to start through an ASAR bootstrap that can also find the
// installer's node_modules — Rig's main process is unbundled ESM with
// Playwright, which must stay on the real file system — so until that exists
// a staged .asar would never load. Asking only for installers means a
// mistaken ASAR plan is never downloaded.
export const UPDATE_CANDIDATES = Object.freeze([Object.freeze({ componentKind: 'app-installer' })])

const BUSY = new Set(['checking', 'downloading', 'verifying', 'installing'])
const CHECKABLE = new Set(['idle', 'needs-network', 'up-to-date', 'blocked', 'cancelled', 'error', 'available'])

// A failure, named by kind only: the raw message may hold an Internal URL, an
// HTTP body or a local path.
function errorHint(reason) {
  const text = String(reason ?? '')
  if (/context changed|check again/i.test(text)) return '网络或账号刚刚变过，请重新检查。'
  if (/network is not ready|network state is/i.test(text)) return '内网连接不稳定，连上后再试。'
  if (/sha-?256|digest|sizeBytes|content-length|size mismatch/i.test(text)) return '更新包没通过校验，已丢弃，请稍后重试。'
  if (/resolve|identity|namespace|requested channel|\b40[45]\b/i.test(text)) return 'Release Center 里还没有可用的 MX Rig 发布身份，请联系管理员。'
  if (/openInstaller|无法打开安装程序/.test(text)) return '打不开安装程序，请到下载目录手动运行。'
  if (/timed? ?out|timeout/i.test(text)) return '下载超时，请稍后重试。'
  return '请稍后重试。'
}

function phaseText(state, platform) {
  const version = state.targetVersion
  switch (state.phase) {
    case 'idle':
      return '可以检查更新。'
    case 'unsupported':
      return '这个包不自动更新（开发版或免安装版）。'
    case 'needs-network':
      return '连上内网后才能检查更新。'
    case 'checking':
      return '正在检查更新……'
    case 'up-to-date':
      return '已是最新版本。'
    case 'blocked':
      return '新版本还在验证，暂不提供。'
    case 'available':
      return `发现新版本 ${version}。`
    case 'downloading':
      return `正在下载 ${version}……`
    case 'verifying':
      return '正在校验更新包……'
    case 'staged':
    case 'ready':
      return platform === 'darwin'
        ? `${version} 已下载并校验。点「安装」会关闭 MX Rig 并打开安装盘，把 MX Rig 拖进「应用程序」替换旧版。`
        : `${version} 已下载并校验。点「安装」会关闭 MX Rig 并运行安装程序。`
    case 'installing':
      return '正在打开安装程序，MX Rig 即将关闭……'
    case 'cancelled':
      return '已取消更新。'
    case 'error':
      return `更新失败：${errorHint(state.error ?? state.reason)}`
    default:
      return ''
  }
}

/**
 * What the page may see of the controller's state. `origin` says whether the
 * last action was a person's (show its outcome) or the automatic check after
 * connecting (show only what can be acted on).
 */
export function publicUpdate(state, { installId = null, origin = 'auto', platform = process.platform } = {}) {
  const phase = state.phase
  const downloading = phase === 'downloading' || phase === 'verifying'
  return {
    phase,
    text: phaseText(state, platform),
    origin,
    currentVersion: state.currentVersion,
    targetVersion: state.targetVersion ?? null,
    notes: state.releaseNotes ?? null,
    checkedAt: state.checkedAt ?? null,
    installId,
    // Unknown totals stay unknown: an indeterminate bar, never "0%".
    progress: downloading
      ? {
          bytes: Number.isFinite(state.bytesReceived) ? state.bytesReceived : 0,
          total: Number.isFinite(state.totalBytes) ? state.totalBytes : null,
          percent: Number.isFinite(state.percent) ? Math.max(0, Math.min(100, state.percent)) : null
        }
      : null,
    actions: {
      check: CHECKABLE.has(phase),
      download: phase === 'available',
      cancel: phase === 'checking' || downloading,
      install: phase === 'ready'
    },
    busy: BUSY.has(phase)
  }
}

export class LauncherUpdates {
  /**
   * `sdk` provides createElectronLauncherApplicationUpdater (the desktop
   * hands in @qpjoy/electron-launcher/application-updater); `network` is the
   * LauncherNetwork; `cleanup` stops Rig's own resources before the installer
   * takes over; `exit` ends the app.
   */
  constructor({
    sdk,
    network,
    baseDir,
    appVersion,
    distribution = 'installed',
    channel = 'stable',
    platform = process.platform,
    arch = process.arch,
    fetchImpl,
    openInstaller,
    cleanup = async () => {},
    exit,
    onChange = () => {},
    log = () => {}
  }) {
    this.network = network
    this.platform = platform
    this.onChange = onChange
    this.log = log
    this.origin = 'auto'
    this.controller = sdk.createElectronLauncherApplicationUpdater({
      baseDir,
      packageName: PACKAGE_NAME,
      currentVersion: appVersion,
      channel,
      distribution,
      platform,
      arch,
      componentCandidates: UPDATE_CANDIDATES,
      getContext: () => network.releaseContext(),
      networkGate: () => network.updateGate(),
      ...(fetchImpl ? { fetchImpl } : {}),
      downloadTimeoutMs: 10 * 60_000,
      openInstaller,
      // Only after the installer opened: Rig's own runtime, runners and
      // tunnel — the same as quitting.
      beforeInstallCleanup: async ({ signal }) => {
        if (!signal.aborted) await cleanup()
      },
      exit: (code) => exit(code),
      onState: (state) => {
        this.log(state)
        this.onChange(this.#project(state))
      }
    })
  }

  #project(state) {
    return publicUpdate(state, { installId: this.network.state?.installId ?? null, origin: this.origin, platform: this.platform })
  }

  status() {
    return this.#project(this.controller.getState())
  }

  /** Called on every network change; the controller checks once per network, account and version. */
  networkChanged(snapshot) {
    if (snapshot?.status !== 'ready') return
    if (BUSY.has(this.controller.getState().phase)) return
    this.origin = 'auto'
    void this.controller.handleNetworkReady().catch(() => {})
  }

  async #act(operation) {
    this.origin = 'user'
    return this.#project(await operation())
  }

  check() {
    return this.#act(() => this.controller.check())
  }

  download() {
    return this.#act(() => this.controller.download())
  }

  install() {
    return this.#act(() => this.controller.install())
  }

  cancel() {
    this.origin = 'user'
    return this.#project(this.controller.cancel('user-requested'))
  }
}
