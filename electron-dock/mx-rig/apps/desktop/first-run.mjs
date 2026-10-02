// 未签名安装包的第一次打开（macOS）.
//
// Without a Developer ID signature and notarization, macOS keeps a downloaded
// app quarantined and runs it from a random read-only copy (App
// Translocation): it asks again on every launch, and nothing next to the app
// can be relied on. Signing is the real fix; until then the app asks for what
// it needs the way MX-H2I does — a dialog that says why, then the system's own
// password prompt (`do shell script … with administrator privileges`), only
// when the plain way was not allowed.
//
// What it asks for, once: copy MX Rig into「应用程序」and clear the
// quarantine flag, then start again from there.

import { execFile } from 'node:child_process'
import { dirname, join, sep } from 'node:path'

const QUARANTINE = 'com.apple.quarantine'
export const APPLICATIONS = '/Applications'

/** The .app bundle an executable lives in, or null outside one. */
export function appBundle(execPath) {
  const parts = String(execPath ?? '').split(sep)
  const at = parts.findLastIndex((part) => part.endsWith('.app'))
  return at > 0 ? parts.slice(0, at + 1).join(sep) : null
}

/** Running from macOS's read-only random copy of a quarantined download. */
export function translocated(bundle) {
  return /\/AppTranslocation\//.test(String(bundle ?? ''))
}

/** A string as one single-quoted shell word. */
export function shellWord(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`
}

/** For AppleScript's `do shell script "…"`. */
export function appleScriptString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * What needs doing, if anything: `install` (copy into Applications, then
 * start from there), `release` (already in place, only quarantined), or null.
 */
export function plan({ bundle, quarantined, applications = APPLICATIONS }) {
  if (!bundle) return null
  const target = join(applications, bundle.split(sep).at(-1))
  // A build someone made on this machine is not quarantined: left where it is.
  if (translocated(bundle) || (quarantined && dirname(bundle) !== applications))
    return { kind: 'install', from: bundle, to: target }
  return quarantined ? { kind: 'release', to: bundle } : null
}

/** The shell steps for a plan; `owner` hands an elevated copy back to the person. */
export function commandFor(step, { owner = null } = {}) {
  const to = shellWord(step.to)
  const release = `/usr/bin/xattr -dr ${QUARANTINE} ${to}`
  if (step.kind === 'release') return release
  return [
    `/bin/rm -rf ${to}`,
    `/usr/bin/ditto ${shellWord(step.from)} ${to}`,
    release,
    ...(owner ? [`/usr/sbin/chown -R ${shellWord(owner)} ${to}`] : [])
  ].join(' && ')
}

const run = (file, args, timeout = 120_000) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr: String(stderr ?? '') })) : resolve(String(stdout ?? ''))
    )
  )

async function isQuarantined(bundle) {
  try {
    await run('/usr/bin/xattr', ['-p', QUARANTINE, bundle], 10_000)
    return true
  } catch {
    return false
  }
}

/** User cancelled the system password prompt (AppleScript error -128). */
const cancelled = (error) => /-128|User canceled|用户已取消/.test(`${error?.message ?? ''}${error?.stderr ?? ''}`)

/**
 * On a packaged macOS build: offer once per launch, do what was agreed to,
 * and say how it went. Returns true when the app is relaunching.
 */
export async function firstRun({ app, dialog, window = null, platform = process.platform, uid = process.getuid?.() }) {
  if (platform !== 'darwin' || !app.isPackaged) return false
  const bundle = appBundle(app.getPath('exe'))
  const step = plan({ bundle, quarantined: bundle ? await isQuarantined(bundle) : false })
  if (!step) return false
  // Already in place: clearing the flag on one's own copy needs no one's leave.
  if (step.kind === 'release') {
    await run('/bin/sh', ['-c', commandFor(step)]).catch(() => {})
    return false
  }
  const answer = await dialog.showMessageBox(window ?? undefined, {
    type: 'info',
    title: '把 MX Rig 放进「应用程序」',
    message: 'MX Rig 还没有签名，macOS 正从一个临时副本运行它。',
    detail:
      '放进「应用程序」并解除 macOS 的隔离标记后，以后可以直接双击打开，自带的测试浏览器也能正常启动。\n\n' +
      '如果需要权限，接下来会弹出系统的密码框；这只用于复制 MX Rig 本身，不改任何别的东西。',
    buttons: ['放进「应用程序」', '以后再说'],
    defaultId: 0,
    cancelId: 1
  })
  if (answer.response !== 0) return false
  try {
    try {
      await run('/bin/sh', ['-c', commandFor(step)])
    } catch {
      // Not allowed as this user (an existing copy owned by someone else, a
      // managed Mac): ask macOS for an administrator, then give it back.
      const owner = uid === undefined ? null : String(uid)
      await run('/usr/bin/osascript', ['-e', `do shell script ${appleScriptString(commandFor(step, { owner }))} with administrator privileges`])
    }
  } catch (error) {
    if (cancelled(error)) return false
    await dialog.showMessageBox(window ?? undefined, {
      type: 'warning',
      title: '没有放进「应用程序」',
      message: '复制没有成功，MX Rig 会继续从当前位置运行。',
      detail: `可以手动把 MX Rig 拖进「应用程序」，再在终端运行：\nxattr -dr ${QUARANTINE} ${shellWord(step.to)}\n\n${String(error?.stderr || error?.message || '').slice(0, 300)}`
    })
    return false
  }
  app.relaunch({ execPath: join(step.to, 'Contents', 'MacOS', app.getPath('exe').split(sep).at(-1)) })
  app.exit(0)
  return true
}
