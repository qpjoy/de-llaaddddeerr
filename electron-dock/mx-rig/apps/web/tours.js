// 演示一遍 (docs/24): tours as data. Each one walks a person through a flow in
// their own window — or does it for them — up to the point where the real
// flow begins, which the person starts. The desktop smoke replays the same
// lists, so a tour that no longer matches the page fails there, not in front
// of someone learning it. No imports: Node reads this file too.
//
// A step:
//   id        unique within the tour
//   say       what the panel says while the step is current
//   target    where the cursor points: a CSS selector
//   action    'look'   point only; it goes on with 下一步 (follow) or by itself
//             'click'  press the target
//             'select' choose `value` in the target
//             'fill'   type `fields` — [{ selector, value }] — into the form at
//                      the target; a value may name the tour's context as
//                      {{key}}. It is done once every field holds its value
//             'pick'   press the target, which opens a system dialog the
//                      person answers — a page cannot click those
//             'final'  point at the target and stop: the person presses it,
//                      and that is the real flow, not the tour
//   until     when the step counts as done. A selector that must be visible,
//             or { selector, value | valueIncludes | filled | text | notText },
//             or { state } read from the service. A step whose `until` already
//             holds is not acted on: a tour only does what is still missing.
//   skipIf    { state } or { absent: selector }: the step is not needed
//   writes    acting creates something; listed before the tour starts
//   optional  the person may skip it
//   wait      how long `until` may take after acting, in ms (default 15 s)
//   missing   what the panel says when the target cannot be found
//
// A tour may name a `context` the desktop answers before the first step (for
// now 'proving-ground': where the built-in proving ground lives).

export const STEP_ACTIONS = ['look', 'click', 'select', 'fill', 'pick', 'final']
export const TOUR_STATES = ['runner-running', 'proving-ground-running', /^workspace:[a-z0-9][a-z0-9-]{0,62}$/, /^app:[a-z0-9][a-z0-9-]{0,62}$/]
export const TOUR_CONTEXTS = ['proving-ground']

const built = { state: 'workspace:luopan' }

// 新项目 uses the built-in proving ground as the product under test: one case
// a person writes, and the implementation an Agent would draft for it.
const PG_CASE = {
  caseId: 'PG-WEB-ITEM-001',
  title: '登录后看到物资列表',
  steps: '1. 打开登录页，用户名填 rig，点「登录」\n2. 看物资列表',
  expected: '进入「物资列表」，表格里至少有一条物资'
}
const PG_SPEC = `import { test, expect } from '@playwright/test'

test('PG-WEB-ITEM-001 登录后看到物资列表', async ({ page }) => {
  await test.step('用 rig 登录', async () => {
    await page.goto('/login')
    await page.getByLabel('用户名').fill('rig')
    await page.getByRole('button', { name: '登录' }).click()
  })
  await test.step('看到物资列表', async () => {
    await expect(page.getByRole('heading', { name: '物资列表' })).toBeVisible()
    await expect(page.locator('table tbody tr').first()).toBeVisible()
  })
})
`
export const PG_IMPLEMENTATION = JSON.stringify(
  {
    summary: '物资列表：登录后看到列表（演示）',
    engine: 'playwright',
    platform: 'web',
    files: [{ path: 'tests/items.spec.ts', content: PG_SPEC }],
    mappings: [{ caseId: PG_CASE.caseId, path: 'tests/items.spec.ts', assertion: '出现「物资列表」标题，表格至少一行' }]
  },
  null,
  2
)
const pgProject = { state: 'app:proving-ground' }
// One task per walk-through: the time the tour started tells them apart.
const TASK_GOAL = '物资列表验收（演示 {{stamp}}）'

export const TOURS = [
  {
    id: 'compass-web-smoke',
    title: '罗盘 Web 冒烟：从验收包到第一次执行',
    summary:
      '建立罗盘的测试项目：源码快照、QA 仓库和执行计划。然后启动本机执行机，停在「主路径冒烟」的立即执行，那一下由你来按。',
    native: true,
    role: 'admin',
    creates: [
      '项目「罗盘」，以及它的执行方式和用例库',
      '被测源码的只读快照（原仓库只被读取，不切分支、不改文件）',
      '项目自己的 QA 仓库',
      '两个执行计划，指定在本机执行机上跑',
      '本机执行机（注册并启动）'
    ],
    finish: '正式流程开始了：计划卡片上点「最近一次执行」可以看它跑起来。跑完后，「读懂一次执行」会带你读结果。',
    steps: [
      {
        id: 'projects',
        say: '所有事情都从「项目与任务」开始：先选项目，再写用例、建计划、跑测试。',
        target: '[data-nav="projects"]',
        action: 'click',
        until: '[data-nav="projects"][aria-current="page"]'
      },
      {
        id: 'pack',
        say: '罗盘有现成的验收包，项目、执行方式、用例库和执行计划都在里面，不用一项项手配。',
        target: '#pack-creator > summary',
        action: 'click',
        until: '#pack-creator[open]',
        skipIf: built
      },
      {
        id: 'directory',
        say: '选被测项目所在的目录，例如 po-frontend。系统对话框要你自己点：Rig 只读取这个目录。',
        target: '#pack-pick-compass',
        action: 'pick',
        until: { selector: '#pack-directory-compass', notText: '还没有选择' },
        skipIf: built,
        wait: 600_000
      },
      {
        id: 'commit',
        say: '固定的提交默认是验收包验证过的那一个。要测别的提交就改这里；原项目继续开发，不影响已有测试。',
        target: '#pack-commit-compass',
        action: 'look',
        skipIf: built
      },
      {
        id: 'build',
        say: '建立：拉源码快照、建 QA 仓库、注册本机执行机、生成执行计划。只建东西，不会开始任何测试。',
        target: '#pack-submit-compass',
        action: 'click',
        writes: true,
        until: '#workspace-facts',
        skipIf: built,
        wait: 300_000
      },
      {
        id: 'project',
        say: '这是罗盘的项目页。',
        target: '#test-project',
        action: 'select',
        value: 'luopan',
        until: { selector: '#test-project', value: 'luopan' },
        missing: '还没有罗盘项目。'
      },
      {
        id: 'plans',
        say: '执行计划：跑什么、在哪跑、什么时候跑。',
        target: '[data-project-tab="plans"]',
        action: 'click',
        until: '[data-project-tab="plans"][aria-selected="true"]'
      },
      {
        id: 'workspace',
        say: '测试项目工作区：固定的提交、QA 仓库、本机执行机，都写在这里。原分支前进了，这里会提示，可以更新基准或做上线检查。',
        target: '#workspace-facts',
        action: 'look',
        missing: '这台电脑上还没有罗盘的工作区。'
      },
      {
        id: 'runner',
        say: '计划指定在这台电脑的执行机上跑，它要先启动；不启动，计划会一直等它。',
        target: '#workspace-runner-start',
        action: 'click',
        writes: true,
        optional: true,
        until: { state: 'runner-running' },
        skipIf: { state: 'runner-running' }
      },
      {
        id: 'run',
        say: '准备好了。按「立即执行」跑主路径冒烟：从这里开始是正式流程，结果、录像和报告都会留下来。',
        target: '[data-plan-name="罗盘 Web · 主路径冒烟"]',
        action: 'final',
        missing: '没有找到「罗盘 Web · 主路径冒烟」这个计划，可能被改名或删除了。'
      }
    ]
  },
  {
    id: 'new-project',
    title: '新项目：从用例到测试代码',
    summary:
      '拿 Rig 自带的试验场当被测应用，走一遍新项目的主线：登记项目、写一条用例、提供测试实现并批准、写进本机测试仓库、建执行计划。停在「执行这个提交」，那一下由你来按。',
    native: true,
    role: 'admin',
    context: 'proving-ground',
    creates: [
      '项目「试验场 · 星港物资台」（已经有就沿用）',
      '一个测试任务和它的一条用例（每走一遍新建一个任务）',
      '测试实现 r1，以及本机测试仓库里的一个提交',
      '一个指定在本机执行机上跑的执行计划',
      '在本机启动内置试验场（一个埋了已知缺陷的练手应用，只在这台电脑上）'
    ],
    finish:
      '正式流程开始了：在预览里核对后派发，执行结束后这个提交就有了结论。试验场还埋了 12 个已知缺陷，可以照这个样子再写用例去找它们。',
    steps: [
      {
        id: 'projects',
        say: '新项目也从「项目与任务」开始。',
        target: '[data-nav="projects"]',
        action: 'click',
        until: '[data-nav="projects"][aria-current="page"]'
      },
      {
        id: 'form',
        say: '「接入新项目」：名称、标识、被测端，再加上源码在哪里（本机目录或 Git 地址）。',
        target: '#project-form > summary',
        action: 'click',
        until: '#project-form[open]',
        skipIf: pgProject
      },
      {
        id: 'register',
        say: '这次的被测应用是 Rig 自带的试验场，源码就在 Rig 里。照着填，或者按「替我做这一步」。',
        target: '#project-form form',
        action: 'fill',
        fields: [
          { selector: '#project-name', value: '试验场 · 星港物资台' },
          { selector: '#project-slug', value: 'proving-ground' },
          { selector: '#project-source', value: '{{directory}}' },
          { selector: '#project-surfaces', value: 'web' }
        ],
        skipIf: pgProject
      },
      {
        id: 'save',
        say: '保存项目。登记只是把项目记下来，不会跑任何测试。',
        target: '#project-form button[type="submit"]',
        action: 'click',
        writes: true,
        until: { state: 'app:proving-ground' },
        skipIf: pgProject
      },
      {
        id: 'project',
        say: '这就是试验场的项目页。',
        target: '#test-project',
        action: 'select',
        value: 'proving-ground',
        until: { selector: '#test-project', value: 'proving-ground' }
      },
      {
        id: 'tasks',
        say: '「测试任务」：一次有目标的测试工作。用例、测试代码和执行结果都挂在任务上。',
        target: '[data-project-tab="tasks"]',
        action: 'click',
        until: '[data-project-tab="tasks"][aria-selected="true"]'
      },
      {
        id: 'goal',
        say: '写下这次要验证什么。',
        target: '.rig-task-create',
        action: 'fill',
        fields: [{ selector: '#test-task-goal', value: TASK_GOAL }]
      },
      {
        id: 'create',
        say: '建立测试任务。',
        target: '.rig-task-create button[type="submit"]',
        action: 'click',
        writes: true,
        // The new task's page, not one opened before the tour.
        until: { selector: '#view', text: TASK_GOAL }
      },
      {
        id: 'case',
        say: '写一条用例：编号、名称、怎么操作、期望看到什么。不用写代码。',
        target: '#test-case-editor',
        action: 'fill',
        fields: [
          { selector: '#case-caseId', value: PG_CASE.caseId },
          { selector: '#case-title', value: PG_CASE.title },
          { selector: '#case-steps', value: PG_CASE.steps },
          { selector: '#case-expected', value: PG_CASE.expected }
        ]
      },
      {
        id: 'add',
        say: '添加用例。每次保存都是一个新版本。',
        target: '#test-case-editor button[type="submit"]',
        action: 'click',
        writes: true,
        until: `[data-case-id="${PG_CASE.caseId}"]`
      },
      {
        id: 'confirm',
        say: '确认本次用例：之后的测试实现和执行都以这个版本为准。',
        target: '#confirm-task-cases',
        action: 'click',
        writes: true,
        until: { selector: '#confirm-task-cases', text: '已确认' }
      },
      {
        id: 'implementation',
        say: '「测试实现」：把用例变成能跑的测试代码。',
        target: '[data-test-tab="implementation"]',
        action: 'click',
        until: '[data-test-tab="implementation"][aria-selected="true"]'
      },
      {
        id: 'provide',
        say: '平时可以「让 Rig 起草测试实现」，由 Agent 写代码（需要接好模型）。这次用一份写好的示例。',
        target: '#provide-implementation',
        action: 'click',
        until: '#implementation-json'
      },
      {
        id: 'code',
        say: '实现是一段 JSON：测试文件的代码，加上每条用例由哪个文件、哪个断言来验证。',
        target: '#implementation-json',
        action: 'fill',
        fields: [{ selector: '#implementation-json', value: PG_IMPLEMENTATION }]
      },
      {
        id: 'draft',
        say: '保存为草稿。草稿不会执行。',
        target: '#save-implementation',
        action: 'click',
        writes: true,
        until: '#approve-implementation'
      },
      {
        id: 'approve',
        say: '审阅代码和用例映射，没问题就批准。只有批准过的实现才能写进测试仓库。',
        target: '#approve-implementation',
        action: 'click',
        writes: true,
        until: '#export-implementation'
      },
      {
        id: 'export',
        say: '写入本机测试仓库并执行。',
        target: '#export-implementation',
        action: 'click',
        until: '[data-test-tab="execution"][aria-selected="true"]'
      },
      {
        id: 'commit',
        say: '每个项目在这台电脑上有自己的测试仓库（一个 Git）。批准的实现写成这个任务分支上的一个提交。',
        target: '#repository-commit',
        action: 'click',
        writes: true,
        until: '#task-repository-facts'
      },
      {
        id: 'ground',
        say: '测试要打开一个被测地址。按「用内置试验场」，在本机启动试验场并填入它的地址。',
        target: '#repository-proving-ground',
        action: 'click',
        writes: true,
        until: { selector: '#repository-target', filled: true },
        skipIf: { absent: '#repository-plan-form' }
      },
      {
        id: 'plan',
        say: '建立本机执行计划：用这台电脑的执行机，跑测试仓库里的测试。',
        target: '#repository-plan-form button[type="submit"]',
        action: 'click',
        writes: true,
        until: '#repository-run',
        skipIf: { absent: '#repository-plan-form' }
      },
      {
        id: 'ground-up',
        say: '这个计划测的是内置试验场，它现在没有在运行：先启动它。',
        target: '#repository-proving-ground',
        action: 'click',
        writes: true,
        until: { state: 'proving-ground-running' },
        skipIf: { state: 'proving-ground-running' }
      },
      {
        id: 'runner',
        say: '执行机要先启动；不启动，执行会一直等它。',
        target: '#repository-runner-start',
        action: 'click',
        writes: true,
        optional: true,
        until: { state: 'runner-running' },
        skipIf: { state: 'runner-running' }
      },
      {
        id: 'run',
        say: '准备好了。按「用本机测试仓库执行这个提交」：先看预览，确认后才派发。从这里开始是正式流程。',
        target: '#repository-run',
        action: 'final'
      }
    ]
  },
  {
    id: 'read-a-run',
    title: '读懂一次执行',
    summary: '打开当前项目最近的一次执行，看结论、每条用例的证据和报告，最后可以交给 Agent 分析。全程只读。',
    native: false,
    role: 'viewer',
    creates: [],
    finish: '以后打开任何一次执行，都是这一页。',
    steps: [
      {
        id: 'projects',
        say: '执行结果跟着项目走，先到「项目与任务」。',
        target: '[data-nav="projects"]',
        action: 'click',
        until: '[data-nav="projects"][aria-current="page"]'
      },
      {
        id: 'runs',
        say: '「执行记录」：这个项目每一次执行都在这里，最新的在最上面。',
        target: '[data-project-tab="runs"]',
        action: 'click',
        until: '[data-project-tab="runs"][aria-selected="true"]',
        missing: '还没有项目。先登记一个项目，再来读它的执行。'
      },
      {
        id: 'open',
        say: '打开最近的一次。',
        target: '[data-run-open]',
        action: 'click',
        until: '#run-detail',
        missing: '这个项目还没有执行记录。先跑一次，再来读。'
      },
      {
        id: 'tiles',
        say: '先看结论和数字：通过、失败、受阻各几条，覆盖了多少用例。',
        target: '#run-tiles',
        action: 'look'
      },
      {
        id: 'cases',
        say: '每条用例的结果。失败的会自动展开，错误、步骤、截图和录像都在里面；点步骤右边的时间，录像就跳到那一刻。',
        target: '#run-case-section, #run-live',
        action: 'look'
      },
      {
        id: 'report',
        say: '完整报告可以打印或转给同事；对外版去掉了地址、账号和内部信息。',
        target: '#run-report',
        action: 'look'
      },
      {
        id: 'analyze',
        say: '拿不准失败的原因，可以让 Agent 读证据、给失败归类，并回答能不能上线。它只起草任务，你确认后才开始。',
        target: '#run-analyze',
        action: 'final',
        skipIf: { absent: '#run-analyze' }
      }
    ]
  }
]

/** The tours this person can take here, and why the others are not offered. */
export function availableTours({ native, role }) {
  const rank = { viewer: 0, operator: 1, admin: 2 }
  return TOURS.map((tour) => ({
    tour,
    blocked:
      tour.native && !native
        ? '要在桌面端演示：源码快照和本机执行机只在桌面端'
        : (rank[role] ?? -1) < rank[tour.role]
          ? '需要管理员'
          : null
  }))
}
