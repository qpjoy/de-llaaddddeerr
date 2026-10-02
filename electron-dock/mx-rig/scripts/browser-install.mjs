// The Chromium Playwright drives, into Playwright's own folder: the per-user
// cache, or PLAYWRIGHT_BROWSERS_PATH when the system disk is small.
//
// Same archive as `npx playwright install chromium`, but with a fallback the
// official command does not have: when Playwright's CDN (which redirects to
// storage.googleapis.com) cannot be reached, the npmmirror copy of Chrome for
// Testing is used. MX_RIG_BROWSER_MIRROR points at another mirror.

import {
  hostPlatform,
  installChromium,
  playwrightCache,
  progressLine
} from '../packages/runtime/browser-provision.mjs'

const dir = playwrightCache()
if (!dir || !hostPlatform()) {
  console.error(`这台电脑（${process.platform}-${process.arch}）没有可下载的 Chromium；可以安装 Google Chrome，MX Rig 会直接使用它。`)
  process.exit(1)
}
const seen = { step: -1 }
try {
  const { executablePath, source } = await installChromium({
    dir,
    onProgress: (event) => {
      const line = progressLine({ phase: 'downloading', ...event }, seen)
      if (line) console.log(line)
    }
  })
  console.log(source ? `已下载（来源 ${source}）：${executablePath}` : `已经装好：${executablePath}`)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
