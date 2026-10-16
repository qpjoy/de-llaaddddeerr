// 策略配置：已有策略的列表（名称、白话、状态、总数），以及按关键词查找。
// 参考旧用例 core/strategy（public@48af490）。hdo_v2 的列表在服务端筛选：
// 关键词作为 { field: 'name' } 条件随请求发出。

import { compassApi } from './fake-api.mjs'
import { signedIn } from './steps.mjs'

const day = 86_400_000
const STRATEGIES = [
  { id: 'rig-s1', name: '交通出行舆情', description: '关注地铁、公交和道路的投诉与突发', status: 'online', duration: '30', publisher: 'Rig 测试员' },
  { id: 'rig-s2', name: '校园安全', description: '关注校园周边的安全事件', status: 'offline', duration: '7', publisher: 'Rig 测试员' },
  { id: 'rig-s3', name: '暴雨天气应对', description: '汛期积水与出行提示', status: 'draft', has_draft: true, duration: '3', publisher: 'Rig 测试员' }
].map((entry, index) => ({
  ...entry,
  created_at: new Date(Date.now() - (index + 3) * day).toISOString(),
  updated_at: new Date(Date.now() - index * day).toISOString()
}))

const strategyRoutes = () => [
  ['GET /api/strategy/quota/me', () => ({ code: 200, data: { maxOnlineStrategyGroups: 5, onlineStrategyGroups: 1, maxStrategiesPerGroup: 10, canCreateStrategy: true } })],
  [
    'POST /api/strategy/list',
    (_request, { body, state }) => {
      const conditions = Array.isArray(body) ? body : []
      state.searches = [...(state.searches ?? []), conditions]
      const name = conditions.find((entry) => entry.field === 'name')?.value
      const list = name ? STRATEGIES.filter((entry) => entry.name.includes(name)) : STRATEGIES
      return { code: 200, data: { total: list.length, list } }
    }
  ]
]

async function openStrategies({ page, step }) {
  await step('打开策略配置', async () => {
    await page.goto('/strategy')
    await page.getByRole('heading', { name: '已有策略' }).waitFor()
  })
}

export default [
  {
    id: 'CPS-WEB-STRAT-001',
    title: '策略列表显示名称、白话、状态和总数',
    backend: () => compassApi(strategyRoutes()),
    async run(context) {
      await signedIn(context)
      await openStrategies(context)
      const { page, step, eventually } = context
      await step('列出三条策略和它们的白话', async () => {
        for (const entry of STRATEGIES) {
          await page.getByText(entry.name, { exact: true }).waitFor()
          await page.getByText(entry.description, { exact: true }).waitFor()
        }
      })
      await step('状态分别是启用、停用、草稿', async () => {
        for (const [name, label] of [['交通出行舆情', '启用'], ['校园安全', '停用'], ['暴雨天气应对', '草稿']]) {
          const row = page.locator('.strategy-row').filter({ hasText: name })
          await eventually(async () => (await row.innerText()).includes(label), `「${name}」的状态不是「${label}」`)
        }
      })
      await step('底部显示共 3 条策略', () => page.getByText('共 3 条策略').waitFor())
    }
  },
  {
    id: 'CPS-WEB-STRAT-002',
    title: '按关键词查找策略，只列出匹配的一条',
    backend: () => compassApi(strategyRoutes()),
    async run(context) {
      await signedIn(context)
      await openStrategies(context)
      const { page, step, eventually } = context
      await step('输入「校园」并回车', async () => {
        await page.getByPlaceholder('关键词搜索').fill('校园')
        await page.getByPlaceholder('关键词搜索').press('Enter')
      })
      await step('列表只剩「校园安全」', async () => {
        await eventually(async () => (await page.getByText('交通出行舆情', { exact: true }).count()) === 0, '查找后仍列出不匹配的策略')
        await page.getByText('校园安全', { exact: true }).waitFor()
        await page.getByText('共 1 条策略').waitFor()
      })
      await step('关键词作为名称条件发给了服务端', async () => {
        const sent = context.backend.state.searches ?? []
        if (!sent.at(-1)?.some((entry) => entry.field === 'name' && entry.value === '校园'))
          throw new Error('查找请求里没有 { field: name, value: 校园 } 条件')
      })
    }
  },
  {
    // 韧性：页面先取平台列表再取策略列表（Strategy.vue onMounted 依次 await），
    // 平台接口一失败，策略列表就不再加载。这一条记录的是期望的行为。
    id: 'CPS-WEB-STRAT-003',
    title: '平台列表取不到时，策略列表仍然加载',
    backend: () => compassApi([...strategyRoutes(), ['GET /api/account/platforms', () => ({ json: { code: 500, message: '平台服务暂时不可用', data: null }, status: 500 })]]),
    async run(context) {
      await signedIn(context)
      await openStrategies(context)
      const { page, step, eventually } = context
      await step('仍然列出三条策略', () =>
        eventually(async () => (await page.getByText('交通出行舆情', { exact: true }).count()) > 0, '平台接口失败后，策略列表没有加载（显示为空）')
      )
    }
  }
]
