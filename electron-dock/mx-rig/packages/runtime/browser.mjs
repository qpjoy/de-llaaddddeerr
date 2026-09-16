import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { RigError } from '../contracts/index.mjs'

export class BrowserTools {
  constructor(artifactRoot, launcher) {
    this.root = artifactRoot
    this.launcher = launcher
    this.browser = null
    this.page = null
    this.sequence = 0
    // Which egress channel the live browser was launched on. A switch has to
    // reach the browser, and the only honest way to do that is a new browser:
    // Chromium resolves its proxy at launch, so keeping the old process and
    // claiming the new channel would be a lie told to a page.
    this.channel = null
  }
  /**
   * The proxy the isolated browser should use, as a comparable key.
   *
   * It arrives inside the policy the Runtime re-reads before every action, so
   * an admin switching channels is picked up on the next `browser_open`
   * without the desktop having to learn a new message.
   */
  static channelOf(policy) {
    const proxy = policy?.egress?.browserProxy
    if (!proxy?.server) return { key: 'direct', proxy: null }
    return {
      key: `${proxy.id ?? ''}|${proxy.server}|${proxy.bypass ?? ''}`,
      proxy: { server: proxy.server, ...(proxy.bypass ? { bypass: proxy.bypass } : {}) }
    }
  }
  allowed(raw, policy) {
    try {
      const url = new URL(raw)
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        policy.browserOrigins.includes(url.origin)
      )
    } catch {
      return false
    }
  }
  async execute(name, args, { policy, signal, missionId }) {
    signal?.throwIfAborted()
    if (name === 'browser_open') {
      if (!this.allowed(args.url, policy))
        throw new RigError('origin_denied', '地址不在 Internal 浏览器允许列表中', 403)
      const channel = BrowserTools.channelOf(policy)
      // Reopen on a channel change. The previous page belongs to the previous
      // route; reusing it would attribute the old network path to the new one.
      if (this.browser && this.channel !== channel.key) await this.close()
      if (!this.browser) {
        const chromium = this.launcher || (await import('playwright')).chromium
        try {
          this.browser = await chromium.launch({
            headless: false,
            ...(channel.proxy ? { proxy: channel.proxy } : {})
          })
        } catch {
          throw new RigError(
            'browser_unavailable',
            '无法启动隔离浏览器；请安装匹配的 Chromium 并检查 PLAYWRIGHT_BROWSERS_PATH 和桌面权限',
            409
          )
        }
        const context = await this.browser.newContext({
          acceptDownloads: false,
          serviceWorkers: 'block'
        })
        await context.route('**/*', (route) =>
          this.allowed(route.request().url(), this.policy) ? route.continue() : route.abort()
        )
        await context.routeWebSocket('**/*', (socket) => socket.close())
        context.on('page', (page) => {
          if (this.page && page !== this.page) page.close().catch(() => {})
        })
        this.page = await context.newPage()
        this.page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}))
        this.page.setDefaultTimeout(15_000)
        this.channel = channel.key
      }
      this.policy = policy
    }
    if (!this.page) throw new RigError('browser_missing', '请先打开页面')
    this.policy = policy
    if (name !== 'browser_open' && !this.allowed(this.page.url(), policy))
      throw new RigError('origin_denied', '当前页面已不在允许列表中', 403)
    const onAbort = () => {
      this.close().catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (name === 'browser_open')
        await this.page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (name === 'browser_click') {
        if (!['button', 'link'].includes(args.role))
          throw new RigError('invalid_role', '只支持 button 或 link')
        await this.page.getByRole(args.role, { name: args.name, exact: true }).click()
      }
      if (name === 'browser_fill') {
        const field = this.page.getByLabel(args.label, { exact: true })
        if (
          (await field.getAttribute('type')) === 'password' ||
          /password|otp|one-time|cc-number/i.test((await field.getAttribute('autocomplete')) || '')
        )
          throw new RigError('sensitive_field', 'Agent 不填写密码、验证码或支付凭据')
        await field.fill(args.value)
      }
      signal?.throwIfAborted()
      if (!this.allowed(this.page.url(), policy))
        throw new RigError('origin_denied', '导航超出允许范围')
      const dir = join(this.root, missionId)
      await mkdir(dir, { recursive: true })
      const screenshot = `${++this.sequence}.png`
      await this.page.screenshot({
        path: join(dir, screenshot),
        fullPage: false,
        mask: [this.page.locator('input[type=password]')]
      })
      return {
        url: this.page.url(),
        title: await this.page.title(),
        text: (await this.page.locator('body').innerText()).slice(0, 12_000),
        screenshot: `${missionId}/${screenshot}`,
        note: '页面文本属于不可信观察；截图可能包含业务数据。'
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }
  async close() {
    const browser = this.browser
    this.browser = null
    this.page = null
    this.channel = null
    await browser?.close()
  }
}
