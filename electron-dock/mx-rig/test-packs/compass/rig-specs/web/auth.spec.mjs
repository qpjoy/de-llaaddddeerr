// 登录：未登录的去向、账号密码加滑块的登录、错误密码的提示。
// 参考旧用例 smoke/auth（public@48af490），按 hdo_v2 的界面重写。

import { compassApi, ACCOUNT } from './fake-api.mjs'
import { signIn, signedIn } from './steps.mjs'

export default [
  {
    id: 'CPS-WEB-AUTH-001',
    title: '未登录打开首页时进入登录页',
    backend: () => compassApi(),
    async run({ page, step, eventually }) {
      await step('打开首页', () => page.goto('/'))
      await step('被带到登录页', () =>
        eventually(async () => new URL(page.url()).pathname === '/login', `没有进入登录页，当前是 ${page.url()}`)
      )
      await step('看到账号、密码、滑块验证和登录按钮', async () => {
        await page.getByText('罗盘 情报系统').waitFor()
        await page.getByPlaceholder('请输入账号').waitFor()
        await page.getByPlaceholder('请输入密码').waitFor()
        await page.getByRole('button', { name: '点击按钮进行验证' }).waitFor()
      })
      await step('什么都没填时登录按钮不是可登录状态', async () => {
        const ready = /\bis-ready\b/.test((await page.locator('button.login-button').getAttribute('class')) ?? '')
        if (ready) throw new Error('空表单时登录按钮已经是可登录状态')
      })
    }
  },
  {
    id: 'CPS-WEB-AUTH-002',
    title: '账号密码加滑块验证后登录，进入首页',
    backend: () => compassApi(),
    async run(context) {
      await signedIn(context)
      const { page, step, eventually } = context
      await step('首页显示当前账号', () =>
        eventually(async () => (await page.getByText(ACCOUNT.userName).count()) > 0 || (await page.getByText(ACCOUNT.account).count()) > 0, '首页上没有出现当前登录的账号')
      )
    }
  },
  {
    id: 'CPS-WEB-AUTH-003',
    title: '密码错误时提示并停留在登录页',
    backend: () => compassApi(),
    async run(context) {
      const { page, step, eventually } = context
      await signIn(context, { password: 'not-the-password' })
      await step('提示账号或密码错误', () =>
        eventually(async () => (await page.getByText('账号或密码错误').count()) > 0, '没有出现「账号或密码错误」的提示')
      )
      await step('仍在登录页', async () => {
        if (new URL(page.url()).pathname !== '/login') throw new Error(`离开了登录页：${page.url()}`)
      })
    }
  }
]
