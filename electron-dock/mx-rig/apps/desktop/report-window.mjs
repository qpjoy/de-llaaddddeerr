// 执行报告在桌面端里打开，不再交给系统浏览器（docs/21 M0）。
//
// The report is a page the Rig service renders, with that run's recordings
// and screenshots. It opens in a window of its own, in a session partition of
// its own, and the member's credential reaches the service the same way it
// does for every other desktop request: added by this (main) process, at the
// network layer, to exactly the requests the report needs — the report page
// and that run's artifacts. No script on the page can read it; a request for
// anything else carries nothing, and a request to anywhere else is refused.

import { BrowserWindow, session } from 'electron'
import { writeFile } from 'node:fs/promises'
import { REPORT_PATH, reportRequest } from './report-request.mjs'

export { REPORT_PATH, reportRequest }

// One window per report; opening it again brings it forward.
const open = new Map()

function parseReportPath(path) {
  const [pathname, query = ''] = String(path).split('?')
  const match = REPORT_PATH.exec(pathname)
  if (!match) throw new Error('不是执行报告的地址')
  return { pathname, runId: match[1], redacted: query === 'redacted=true' }
}

/** A session that reaches this run's report and artifacts, with the token added by this process. */
function reportSession({ partition, origin, runId, token }) {
  const ses = session.fromPartition(partition)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest((details, callback) => {
    const decision = reportRequest(details.url, { origin, runId, method: details.method })
    // DevTools and the page's own data: URLs are not network requests to worry about.
    callback({ cancel: !decision.allowed && !/^(devtools|data|blob):/.test(details.url) })
  })
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    delete headers.Authorization
    delete headers.authorization
    delete headers.Cookie
    if (reportRequest(details.url, { origin, runId, method: details.method }).credential)
      headers.Authorization = `Bearer ${token()}`
    callback({ requestHeaders: headers })
  })
  return ses
}

/**
 * Open (or bring forward) the report of one run.
 *
 * @param {object} options
 * @param {string} options.origin  the Rig service origin the desktop is signed in to
 * @param {string} options.path    `/api/v1/runs/<id>/report`, optionally with `?redacted=true`
 * @param {() => string} options.token  the current session token, read when each request leaves
 */
export async function openReport({ origin, path, token, parent = null }) {
  const { pathname, runId, redacted } = parseReportPath(path)
  const key = `${origin}|${runId}|${redacted}`
  const existing = open.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return existing
  }
  const partition = `rig-report-${runId}${redacted ? '-redacted' : ''}`
  const ses = reportSession({ partition, origin, runId, token })
  const window = new BrowserWindow({
    width: 1240,
    height: 880,
    minWidth: 720,
    minHeight: 520,
    title: `执行报告 · ${runId}${redacted ? '（对外版）' : ''}`,
    backgroundColor: '#0b1018',
    autoHideMenuBar: true,
    ...(parent ? { parent, modal: false } : {}),
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  })
  // A screenshot link in the report opens in a window like this one; anything else stays shut.
  window.webContents.setWindowOpenHandler(({ url }) =>
    reportRequest(url, { origin, runId }).allowed
      ? {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true }
          }
        }
      : { action: 'deny' }
  )
  window.webContents.on('will-navigate', (event, url) => {
    if (!reportRequest(url, { origin, runId }).allowed) event.preventDefault()
  })
  window.on('closed', () => {
    open.delete(key)
    ses.clearStorageData().catch(() => {})
  })
  open.set(key, window)
  await window.loadURL(`${origin}${pathname}${redacted ? '?redacted=true' : ''}`)
  return window
}

/**
 * Save a run's report as a PDF the member can send on — the 对外版 is meant
 * for people outside the project. The file is chosen first; the report is
 * then rendered in a hidden window under the same rules as the visible one.
 * Recordings do not print; results, errors and steps do.
 */
export async function saveReport({ origin, path, token, parent = null, dialog }) {
  const { pathname, runId, redacted } = parseReportPath(path)
  const chosen = await dialog.showSaveDialog(parent, {
    title: redacted ? '保存对外版执行报告' : '保存执行报告',
    defaultPath: `mx-rig-执行报告-${runId}${redacted ? '-对外版' : ''}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (chosen.canceled || !chosen.filePath) return { saved: false }
  const partition = `rig-report-save-${runId}${redacted ? '-redacted' : ''}`
  const ses = reportSession({ partition, origin, runId, token })
  const window = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1600,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  try {
    await window.loadURL(`${origin}${pathname}${redacted ? '?redacted=true' : ''}`)
    const pdf = await window.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    await writeFile(chosen.filePath, pdf)
    return { saved: true, bytes: pdf.length }
  } finally {
    window.destroy()
    ses.clearStorageData().catch(() => {})
  }
}
