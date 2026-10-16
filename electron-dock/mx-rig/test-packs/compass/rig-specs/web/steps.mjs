// Steps more than one case takes, written once.

import { ACCOUNT } from './fake-api.mjs'

/** Fill the login form, solve the (fake) slider, and submit. */
export async function signIn({ page, step, eventually }, { account = ACCOUNT.account, password = ACCOUNT.password } = {}) {
  await step('打开登录页', async () => {
    await page.goto('/login')
    await page.getByPlaceholder('请输入账号').waitFor()
  })
  await step('填写账号和密码', async () => {
    await page.getByPlaceholder('请输入账号').fill(account)
    await page.getByPlaceholder('请输入密码').fill(password)
  })
  await step('拖动滑块完成验证', async () => {
    await page.getByRole('button', { name: '点击按钮进行验证' }).click()
    const handle = page.locator('.slider-button')
    await handle.waitFor()
    const box = await handle.boundingBox()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    // A person's drag: many small moves, never perfectly level.
    for (let i = 1; i <= 16; i += 1) {
      await page.mouse.move(x + i * 14, y + (i % 3) - 1)
      await page.waitForTimeout(25)
    }
    await page.mouse.up()
    await eventually(async () => (await page.getByText('验证成功').count()) > 0, '滑块验证没有显示「验证成功」')
  })
  await step('点击登录', async () => {
    // The button is always clickable; `is-ready` is how the page says the form is complete.
    const submit = page.locator('button.login-button')
    await eventually(async () => /\bis-ready\b/.test((await submit.getAttribute('class')) ?? ''), '账号、密码和验证都完成后，登录按钮没有进入可登录状态')
    await submit.click()
  })
}

/** Signed in and on the home page: what most cases start from. */
export async function signedIn(context) {
  await signIn(context)
  await context.step('进入系统', () =>
    context.eventually(async () => !new URL(context.page.url()).pathname.startsWith('/login'), '登录后仍停留在登录页')
  )
}
