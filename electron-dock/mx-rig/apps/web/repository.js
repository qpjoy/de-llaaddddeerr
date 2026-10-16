// 测试仓库（docs/23）：本机的测试版本，与服务器上的发布版本。
//
// On the desktop a project's tests live in a Git repository of its own: each
// test task's approved implementation is a commit on its branch, a commit a
// run has passed may go into main and be published, and other computers pull
// published versions. In the browser only the service's versions are shown.

import { h } from './views.js'
import { button, field, note, section } from './project-settings.js'
import { openRun } from './run-detail.js'
import { commitVerdict } from './project-model.js'

export const WORKSPACE_SUITE = 'rig-tests-web'
export const PUBLISHED_SUITE = 'rig-tests-web-published'
const short = (sha) => (sha ? String(sha).slice(0, 7) : '—')
const VERDICT = { verified: '已验证', failed: '最近一次失败', blocked: '最近一次受阻', unverified: '未验证' }
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—')
const ranAt = (run) => when(run?.finishedAt ?? run?.queuedAt)

function verdictChip(verdict) {
  return h('span', {
    class: 'rig-chip',
    'data-verification': verdict.state,
    text: verdict.active ? '正在执行' : VERDICT[verdict.state]
  })
}

function versionsList(ctx, server) {
  if (!server.versions?.length) return note('服务器上还没有发布过测试版本。')
  return h(
    'ol',
    { class: 'rig-version-list', id: 'test-versions' },
    ...server.versions.map((entry) =>
      h(
        'li',
        { 'data-version': String(entry.version) },
        h('strong', { class: 'qp-body-2', text: `v${entry.version}` }),
        h('code', { text: short(entry.commit) }),
        h('span', { class: 'qp-body-2 rig-version-list__summary', text: entry.summary }),
        h('span', { class: 'qp-caption qp-muted', text: `${entry.publisherName ?? entry.publishedBy} · ${when(entry.publishedAt)} · ${entry.cases?.length ?? 0} 条用例` }),
        button('证据', () => openRun(ctx, entry.runId), { class: 'qp-button qp-button--ghost qp-button--sm', title: `证明这个版本的执行 ${entry.runId}` })
      )
    )
  )
}

async function publish(ctx, app, { commit, branch, runId, summary }) {
  const { version } = await ctx.api('repository-publish', { app: app.slug, commit, branch, runId, summary })
  ctx.notice(`已发布为服务器版本 v${version.version}（${short(commit)}）；其他电脑「同步服务器版本」后就能看到。`)
}

/**
 * 团队执行计划（M7b）：已发布的最新版本，由任意执行机来跑。The same tests on
 * every machine, so a nightly plan does not depend on one person's computer.
 */
function teamPlan(ctx, app, { suites, plans, server }) {
  if (!server.versions?.length) return null
  const suite = suites.find((entry) => entry.slug === PUBLISHED_SUITE)
  const existing = suite ? plans.filter((plan) => plan.suiteId === suite.id) : []
  if (existing.length)
    return note(`团队执行计划：${existing.map((plan) => plan.name).join('、')}——任意执行机从服务器取已发布的最新版本来跑；在下面的执行计划里立即执行、验证后定时。`)
  if (!ctx.canRun()) return null
  const target = h('input', { class: 'qp-input', id: 'team-plan-target', placeholder: 'https://test.example.internal', maxlength: 2000 })
  return h(
    'form',
    {
      class: 'rig-section',
      id: 'team-plan-form',
      onsubmit: (event) => {
        event.preventDefault()
        ctx.run(async () => {
          const { suite: created } = await ctx.api('published-suite', { app: app.slug })
          const { task } = await ctx.api('plan-create', {
            app: app.slug,
            suite: created.slug,
            name: '已发布测试版本 · 团队',
            targetUrl: target.value.trim(),
            runsOn: 'any-runner',
            schedule: { kind: 'manual' }
          })
          ctx.notice(`已建立团队执行计划「${task.name}」：任意执行机跑服务器上的最新版本；先立即执行一次，通过后再开启定时。`)
          await ctx.render()
        })
      }
    },
    h('h3', { class: 'qp-body-1 qp-body-1--semibold', text: '团队执行计划' }),
    field('被测地址', target, '任意执行机从服务器取已发布的最新版本来跑，不需要作者的电脑开着。'),
    h('div', { class: 'qp-row' }, h('button', { class: 'qp-button qp-button--primary qp-button--sm', type: 'submit', text: '建立团队执行计划' }))
  )
}

/** 项目「执行计划」页上的测试仓库：本机分支与验证状态、服务器版本、同步。 */
export async function repositoryPanel(ctx, app, { suites, runs, plans = [] }) {
  const hasSuite = suites.some((suite) => suite.slug === WORKSPACE_SUITE || suite.slug === PUBLISHED_SUITE)
  if (!ctx.state.native) {
    if (!hasSuite) return null
    const server = await ctx.api('repository-versions', { app: app.slug }).catch(() => ({ versions: [] }))
    return section(
      '测试仓库',
      note('这个项目的测试写在它自己的测试仓库里：草稿在作者的电脑上，验证通过后发布到服务器。在桌面端可以同步、合入和发布。'),
      teamPlan(ctx, app, { suites, plans, server }),
      versionsList(ctx, server)
    )
  }
  const { local, server } = await ctx.api('repository-status', { app: app.slug })
  if (!local.exists && !hasSuite && !server.versions?.length) return null
  const head = server.head
  const synced = local.versions?.[0]?.version ?? null
  const rows = (local.branches ?? []).map((branch) => ({ ...branch, verdict: commitVerdict(runs, branch.commit) }))
  const published = new Set((server.versions ?? []).map((entry) => entry.commit))
  return section(
    '测试仓库',
    note(
      local.kind === 'pack'
        ? '验收包的测试仓库：rig-specs 在这里演进。通过的提交可以发布到服务器，其他电脑同步后用同一版测试。'
        : '每个测试任务批准的实现写在 task/ 分支上；执行通过的提交可以合入本机主线、发布到服务器。服务器版本只追加，不改写。'
    ),
    h(
      'dl',
      { class: 'rig-workspace-facts', id: 'repository-facts' },
      h('dt', { text: '服务器最新' }),
      h('dd', { text: head ? `v${head.version} · ${short(head.commit)} · ${head.summary}` : '还没有发布' }),
      server.usage ? h('dt', { text: '服务器占用' }) : null,
      server.usage
        ? h('dd', {
            id: 'repository-usage',
            text: `${(server.usage.bytes / 1024 / 1024).toFixed(2)} MB / ${Math.round(server.usage.quotaBytes / 1024 / 1024)} MB · 保存 ${server.usage.stored} 个版本的内容${server.usage.checkpoint ? `，最近的完整版本 v${server.usage.checkpoint}` : ''}`,
            title: '每 10 个版本发布一次完整版本，更早的增量随之合并；录像、截图在执行记录里，按保留期清理，不占这里'
          })
        : null,
      h('dt', { text: '本机已同步' }),
      h('dd', { id: 'repository-synced', text: synced ? `到 v${synced}` : local.exists ? '还没有同步过' : '本机还没有测试仓库' }),
      local.exists ? h('dt', { text: '目录' }) : null,
      local.exists ? h('dd', { class: 'qp-caption', text: local.directory }) : null
    ),
    rows.length
      ? h(
          'ol',
          { class: 'rig-version-list', id: 'repository-branches' },
          ...rows.map((row) =>
            h(
              'li',
              { 'data-branch': row.name },
              h('strong', { class: 'qp-body-2', text: row.name }),
              h('code', { text: short(row.commit) }),
              h('span', { class: 'qp-body-2 rig-version-list__summary', text: row.subject }),
              row.name === 'published' ? h('span', { class: 'rig-chip', text: '服务器版本' }) : verdictChip(row.verdict),
              published.has(row.commit) && row.name !== 'published' ? h('span', { class: 'rig-chip', text: '已发布' }) : null,
              row.verdict.run ? button('执行', () => openRun(ctx, row.verdict.run.id), { class: 'qp-button qp-button--ghost qp-button--sm' }) : null,
              row.name.startsWith('task/') && row.merged ? h('span', { class: 'rig-chip', text: '已合入主线' }) : null,
              row.name.startsWith('task/') && row.verdict.state === 'verified' && !row.merged
                ? button('合入主线', () =>
                    ctx.run(async () => {
                      const merged = await ctx.api('repository-merge', { app: app.slug, commit: row.commit })
                      ctx.notice(merged.merged ? `已合入本机主线：main @ ${short(merged.main)}` : '主线已经包含这个提交')
                      await ctx.render()
                    }), { 'data-merge': row.name })
                : null,
              row.name !== 'published' && row.verdict.state === 'verified' && !published.has(row.commit)
                ? button('发布到服务器', () =>
                    ctx.run(async () => {
                      await publish(ctx, app, { commit: row.commit, branch: row.name, runId: row.verdict.run.id, summary: row.subject })
                      await ctx.render()
                    }), { class: 'qp-button qp-button--primary qp-button--sm', 'data-publish': row.name })
                : null
            )
          )
        )
      : null,
    h(
      'div',
      { class: 'qp-row' },
      button('同步服务器版本', () =>
        ctx.run(async () => {
          const { pulled } = await ctx.api('repository-pull', { app: app.slug })
          ctx.notice(pulled.length ? `已同步 ${pulled.length} 个服务器版本，到 v${pulled.at(-1).version}${pulled.some((entry) => entry.followed) ? '；本机主线已跟上' : ''}` : '本机已经是服务器最新版本')
          await ctx.render()
        }), { id: 'repository-pull' }),
      local.exists ? button('打开测试仓库目录', () => ctx.run(() => ctx.api('repository-open', { app: app.slug })), { class: 'qp-button qp-button--ghost qp-button--sm' }) : null
    ),
    teamPlan(ctx, app, { suites, plans, server }),
    h('h3', { class: 'qp-body-1 qp-body-1--semibold', text: '服务器版本' }),
    versionsList(ctx, server)
  )
}

/**
 * 测试任务「执行与结果」顶部：把批准的实现写进本机测试仓库，用本机执行机跑这个
 * 提交，通过后合入主线或发布。Returns what the plan picker needs to preselect.
 */
const PROVING_GROUND = 'http://127.0.0.1:4610'
const sameOrigin = (url, origin) => {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/** Rig's built-in proving ground, started on this computer (docs/24 M8b). */
async function startGround(ctx) {
  const started = await ctx.api('proving-ground-start')
  ctx.notice(`内置试验场在本机运行：${started.origin}。它埋了已知缺陷，用来练手和演示，结果不代表任何真实产品。`)
  return started
}

export async function taskRepositoryPanel(ctx, mission, { tasks, runs, onRun }) {
  if (!ctx.state.native || !mission.workbench?.appSlug) return null
  const app = { slug: mission.workbench.appSlug }
  const [{ local, server, task }, implementation, runner, ground] = await Promise.all([
    ctx.api('repository-status', { app: app.slug, missionId: mission.id }),
    ctx.api('task-implementation', { id: mission.id }).catch(() => null),
    ctx.api('runner-status').catch(() => null),
    ctx.api('proving-ground-status').catch(() => null)
  ])
  const proposal = implementation?.proposal ?? null
  const children = [note('批准的实现写进这个项目的测试仓库（task/ 分支），用本机执行机跑这个提交；通过后可以合入本机主线、发布到服务器。')]
  if (local.kind === 'pack') return section('本机测试仓库', note('这个项目的测试仓库来自验收包，用例写在 rig-specs 里；测试任务的实现不写进去。'))
  if (!proposal?.reviewedAt || implementation.stale) {
    children.push(note('先在「测试实现」批准一个对应当前用例的实现。'))
    return section('本机测试仓库', ...children)
  }
  if (proposal.engine !== 'playwright' || proposal.platform !== 'web') {
    children.push(note('测试仓库暂时只支持 Playwright Web 的实现；这个实现请接入已有的执行方式。'))
    return section('本机测试仓库', ...children)
  }
  const written = task?.commit && task.cases.some((entry) => entry.hash === proposal.hash)
  if (!written) {
    children.push(
      h(
        'div',
        { class: 'qp-row' },
        button(`写入本机测试仓库（实现 r${proposal.version}）`, () =>
          ctx.run(async () => {
            const result = await ctx.api('repository-commit', { app: app.slug, missionId: mission.id })
            ctx.notice(result.unchanged ? '这个实现已经在测试仓库里' : `已写入 ${result.branch} @ ${short(result.commit)}`)
            await ctx.render()
          }), { class: 'qp-button qp-button--primary', id: 'repository-commit' })
      )
    )
    return section('本机测试仓库', ...children)
  }
  const plan = tasks.find((entry) => entry.suite?.slug === WORKSPACE_SUITE && entry.runnerId === runner?.runnerId) ?? null
  const verdict = commitVerdict(runs, task.commit)
  children.push(
    h(
      'dl',
      { class: 'rig-workspace-facts', id: 'task-repository-facts' },
      h('dt', { text: '测试仓库' }),
      h('dd', { text: `${task.branch} @ ${short(task.commit)} · 实现 r${proposal.version}` }),
      h('dt', { text: '这个提交' }),
      h('dd', {}, verdictChip(verdict), verdict.run ? ` ${ranAt(verdict.run)}` : ''),
      h('dt', { text: '本机执行机' }),
      h('dd', { text: !runner?.registered ? '未注册' : runner.running ? `「${runner.name}」运行中` : `「${runner.name}」未启动` })
    )
  )
  if (!plan) {
    // Kept across redraws: the page redraws under a half-filled form.
    const targets = (ctx.state.repositoryTargets ??= {})
    const target = h('input', { class: 'qp-input', id: 'repository-target', placeholder: 'https://test.example.internal', maxlength: 2000 })
    target.value = targets[app.slug] ?? ''
    target.oninput = () => (targets[app.slug] = target.value)
    children.push(
      h(
        'form',
        {
          class: 'rig-section',
          id: 'repository-plan-form',
          onsubmit: (event) => {
            event.preventDefault()
            ctx.run(async () => {
              const result = await ctx.api('repository-ensure', { app: app.slug, targetUrl: target.value.trim() })
              ctx.notice(`已建立执行计划「${result.plan?.name ?? ''}」，指定在本机执行机上跑`)
              await ctx.render()
            })
          }
        },
        field('被测地址', target, '测试打开的地址；执行计划会指定在本机执行机上跑，只跑测试仓库里的测试。'),
        h(
          'div',
          { class: 'qp-row' },
          h('button', { class: 'qp-button qp-button--primary qp-button--sm', type: 'submit', text: '建立本机执行计划' }),
          ground
            ? button('用内置试验场', () =>
                ctx.run(async () => {
                  const started = await startGround(ctx)
                  target.value = started.origin
                  targets[app.slug] = started.origin
                }), { class: 'qp-button qp-button--ghost qp-button--sm', id: 'repository-proving-ground', title: '在本机启动 Rig 自带的试验场（一个埋了已知缺陷的练手应用），并把它的地址填进来' })
            : null
        )
      )
    )
    return section('本机测试仓库', ...children)
  }
  const actions = h('div', { class: 'qp-row' })
  // A plan on the built-in proving ground needs it running on this computer.
  if (ground && !ground.running && sameOrigin(plan.targetUrl, PROVING_GROUND))
    actions.append(
      button('启动内置试验场', () =>
        ctx.run(async () => {
          await startGround(ctx)
          await ctx.render()
        }), { id: 'repository-proving-ground' })
    )
  if (runner?.registered && !runner.running)
    actions.append(
      button('启动本机执行机', () =>
        ctx.run(async () => {
          await ctx.api('runner-start')
          await ctx.render()
        }), { id: 'repository-runner-start' })
    )
  actions.append(
    button('用本机测试仓库执行这个提交', () => onRun({ plan, qaRef: { branch: task.branch, commit: task.commit }, bindings: Object.fromEntries(task.cases.map((entry) => [entry.caseId, entry.path])) }), {
      class: 'qp-button qp-button--primary',
      id: 'repository-run'
    })
  )
  if (verdict.state === 'verified') {
    if (task.merged) actions.append(h('span', { class: 'rig-chip', text: '已合入本机主线' }))
    else actions.append(
      button('合入本机主线', () =>
        ctx.run(async () => {
          const merged = await ctx.api('repository-merge', { app: app.slug, commit: task.commit })
          ctx.notice(merged.merged ? `已合入本机主线：main @ ${short(merged.main)}` : '主线已经包含这个提交')
          await ctx.render()
        }), { id: 'repository-merge' })
    )
    if (!(server.versions ?? []).some((entry) => entry.commit === task.commit))
      actions.append(
        button('发布到服务器', () =>
          ctx.run(async () => {
            await publish(ctx, app, { commit: task.commit, branch: task.branch, runId: verdict.run.id, summary: proposal.summary })
            await ctx.render()
          }), { class: 'qp-button qp-button--primary', id: 'repository-publish' })
      )
    else actions.append(h('span', { class: 'rig-chip', text: '已发布' }))
  }
  children.push(actions)
  return section('本机测试仓库', ...children)
}
