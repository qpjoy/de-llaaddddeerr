// AI 对话：提问后流式回答逐步出现并完成；分析服务出错时如实提示。
// 参考旧用例 core/ai-chat（public@48af490）。hdo_v2 在 Delta 关闭时走 /api/ai/chat/stream。

import { CHAT_SHELL, compassApi } from './fake-api.mjs'
import { signedIn } from './steps.mjs'

const QUESTION = '本周本地交通舆情有哪些需要关注？'
const ANSWER = ['本周需要关注三件事：', '\n\n1. 地铁新线开通后的票价讨论；', '\n2. 暴雨期间的道路积水；', '\n3. 早高峰公交调整。']

const sse = (events) =>
  events.map(({ event, data }) => `${event ? `event: ${event}\n` : ''}${String(data).split('\n').map((line) => `data: ${line}`).join('\n')}\n\n`).join('')


const answering = (events) => [
  'POST /api/ai/chat/stream',
  (request, { state }) => {
    state.asked = [...(state.asked ?? []), request.postData() ?? '']
    return { status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse(events) }
  }
]

async function ask({ page, step }) {
  await step('打开 AI 对话', async () => {
    await page.goto('/ai-chat')
    await page.getByPlaceholder('有问题，尽管问').waitFor()
  })
  await step('输入问题并发送', async () => {
    await page.getByPlaceholder('有问题，尽管问').fill(QUESTION)
    await page.getByRole('button', { name: '发送' }).click()
  })
  await step('问题出现在对话里', () => page.getByText(QUESTION).last().waitFor())
}

export default [
  {
    id: 'CPS-WEB-CHAT-001',
    title: '提问后回答逐段出现，并完整显示',
    backend: () => compassApi([...CHAT_SHELL, answering([{ event: 'start', data: '' }, ...ANSWER.map((data) => ({ data })), { event: 'done', data: '[DONE]' }])]),
    async run(context) {
      await signedIn(context)
      await ask(context)
      const { page, step, eventually } = context
      await step('回答显示全部三点', async () => {
        for (const line of ['本周需要关注三件事', '地铁新线开通后的票价讨论', '暴雨期间的道路积水', '早高峰公交调整'])
          await eventually(async () => (await page.getByText(line).count()) > 0, `回答里没有「${line}」`)
      })
      await step('回答结束后可以继续提问', () =>
        eventually(async () => (await page.getByRole('button', { name: '发送' }).count()) > 0, '回答结束后仍显示「停止生成」')
      )
    }
  },
  {
    id: 'CPS-WEB-CHAT-002',
    title: '分析服务出错时显示失败原因，不留下空白回答',
    backend: () => compassApi([...CHAT_SHELL, answering([{ event: 'start', data: '' }, { event: 'error', data: '分析服务暂时不可用，请稍后重试。' }])]),
    async run(context) {
      await signedIn(context)
      await ask(context)
      const { page, step, eventually } = context
      await step('显示失败原因', () =>
        eventually(async () => (await page.getByText('分析服务暂时不可用').count()) > 0, '没有显示分析服务出错的原因')
      )
    }
  }
]
