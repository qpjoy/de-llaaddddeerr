// 首页：提问入口、地区舆情榜与热点详情、历史对话。数据全部来自假后端。
// 参考旧用例 core/dashboard（public@48af490），hdo_v2 的首页已改为“AI 提问 + 地区舆情”。

import { CHAT_SHELL, compassApi } from './fake-api.mjs'
import { signedIn } from './steps.mjs'

const now = Date.now()
const HOTSPOTS = [
  { id: 'rig-h1', title: '某市地铁新线开通引发热议', summary: '<p>市民关注票价与换乘安排。</p>', heatScore: 9821, origin: { name: '本地新闻网', platform: 'news' } },
  { id: 'rig-h2', title: '暴雨预警期间多处道路积水', summary: '交通部门发布绕行提示。', heatScore: 7310, origin: { name: '交通广播', platform: 'news' } },
  { id: 'rig-h3', title: '高校毕业季招聘会人气旺', summary: '多家企业现场签约。', heatScore: 4120, origin: { name: '教育频道', platform: 'news' } }
]

// Answers for whichever province the page asks about, so the case does not
// depend on the page's default region.
const hotspots = ['GET /api/dashboard/public-opinion', (request, { url, state }) => {
  const province = url.searchParams.get('province') || '江苏'
  state.provinces = [...(state.provinces ?? []), province]
  return {
    code: 200,
    data: {
      total: HOTSPOTS.length,
      items: HOTSPOTS.map((item, index) => ({
        ...item,
        province: { name: province, code: '32' },
        url: `https://news.example.test/${item.id}`,
        publishedAt: new Date(now - (index + 1) * 3_600_000).toISOString(),
        collectedAt: new Date(now - index * 3_600_000).toISOString()
      }))
    }
  }
}]

const history = ['GET /api/ai/history', () => ({
  json: [
    { conversation_id: 'rig-c1', name: '本周交通舆情梳理', created_time: new Date(now - 86_400_000).toISOString() },
    { conversation_id: 'rig-c2', name: '毕业季就业话题跟踪', created_time: new Date(now - 2 * 86_400_000).toISOString() }
  ]
})]

export default [
  {
    id: 'CPS-WEB-HOME-001',
    title: '首页显示提问入口和地区舆情榜',
    backend: () => compassApi([hotspots]),
    async run(context) {
      await signedIn(context)
      const { page, step, eventually } = context
      await step('看到提问入口', () => page.getByRole('heading', { name: '今天想了解什么风险动态？' }).waitFor())
      await step('舆情榜列出 3 条热点，按热度排列', async () => {
        await page.getByText('3 条热点').waitFor()
        const rows = page.locator('.hotspot-ranking-row')
        await eventually(async () => (await rows.count()) === 3, '舆情榜没有列出 3 条热点')
        const first = await rows.nth(0).innerText()
        if (!first.includes(HOTSPOTS[0].title)) throw new Error(`第一条不是热度最高的「${HOTSPOTS[0].title}」：${first.split('\n')[0]}`)
      })
    }
  },
  {
    id: 'CPS-WEB-HOME-002',
    title: '点选热点后右侧显示它的摘要和来源',
    backend: () => compassApi([hotspots]),
    async run(context) {
      await signedIn(context)
      const { page, step, eventually } = context
      await step('点选第二条热点', async () => {
        await page.locator('.hotspot-ranking-row').nth(1).click()
      })
      await step('详情显示标题、摘要和来源', async () => {
        const detail = page.locator('.hotspot-featured-preview').first()
        await eventually(async () => (await detail.locator('h3').innerText()) === HOTSPOTS[1].title, '详情标题不是所选的热点')
        const text = await detail.innerText()
        for (const expected of ['交通部门发布绕行提示。', '交通广播'])
          if (!text.includes(expected)) throw new Error(`详情里没有「${expected}」`)
      })
    }
  },
  {
    id: 'CPS-WEB-HOME-003',
    title: '历史记录列出以前的对话，点开进入 AI 对话',
    backend: () => compassApi([hotspots, history, ...CHAT_SHELL]),
    async run(context) {
      await signedIn(context)
      const { page, step, eventually } = context
      await step('打开历史记录', () => page.getByRole('button', { name: '历史记录' }).click())
      await step('列出两条以前的对话', async () => {
        const panel = page.getByRole('complementary', { name: '历史记录' })
        await panel.getByText('本周交通舆情梳理').waitFor()
        await panel.getByText('毕业季就业话题跟踪').waitFor()
      })
      await step('点开一条进入 AI 对话', async () => {
        await page.getByText('本周交通舆情梳理').click()
        await eventually(async () => {
          const url = new URL(page.url())
          return url.pathname === '/ai-chat' && url.searchParams.get('conversationId') === 'rig-c1'
        }, '没有带着这条对话进入 AI 对话页')
      })
    }
  }
]
