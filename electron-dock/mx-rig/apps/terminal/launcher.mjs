// The Chromium a terminal session or a station drives.
//
// Headless runs on the full Chromium (the "new" headless mode), not the
// separate headless shell: `npm run browser:install` installs only the former,
// and it is the browser people actually use.
//
// Playwright's own signal handling is off: by default it closes the browser
// on SIGTERM / SIGINT, which would end a batch a polite stop is waiting for —
// mid-step, with the wrong verdict and no evidence. The caller closes its
// browser itself when it stops.

export async function chromiumLauncher() {
  const { chromium } = await import('playwright')
  return {
    launch: (options) =>
      chromium.launch({
        ...options,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        ...(options.headless ? { channel: 'chromium' } : {})
      })
  }
}

/** Whether a browser window can be shown here at all. */
export function canShowBrowser(env = process.env) {
  if (env.CI) return false
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
}
