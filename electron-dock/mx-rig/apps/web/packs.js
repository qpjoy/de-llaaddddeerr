// 从验收包创建，以及测试项目工作区（docs/21 M5）。
//
// A pack defines a product's test project; creating from it registers the
// project, its execution methods and case library on the service. The
// snapshot of the code under test and the project's QA repository live on the
// computer that will run the tests, so on the desktop the same click also
// builds them and pins the plans to this computer's runner. In the browser
// only the service side happens, and the page says where to finish.

import { h, tourEntries } from './views.js'
import { button, field, note, section } from './project-settings.js'

const short = (sha) => (sha ? String(sha).slice(0, 7) : '—')
export const isWorkspaceSuite = (suite) => /^rig-workspace:\/\//.test(suite?.repoUrl ?? '')

function draftFor(ctx, pack) {
  ctx.state.packDrafts ??= {}
  ctx.state.packDrafts[pack.id] ??= {
    kind: ctx.state.native ? 'local' : 'git',
    directory: '',
    repoUrl: pack.source?.repoUrl ?? '',
    ref: pack.source?.ref ?? '',
    commit: pack.source?.commit ?? ''
  }
  return ctx.state.packDrafts[pack.id]
}

const sourceOf = (draft) =>
  draft.kind === 'local' ? { kind: 'local', directory: draft.directory } : { kind: 'git', repoUrl: draft.repoUrl.trim() }

/** This computer's runner: registered if it is not yet, so plans can be pinned to it. */
async function localRunnerId(ctx) {
  let runner = await ctx.api('runner-status')
  if (!runner.registered) runner = await ctx.api('runner-register', {})
  if (!runner.runnerId) throw new Error('本机执行机注册失败')
  return runner
}

/** Snapshot + QA repository here, then plans pinned to this computer. */
async function buildWorkspace(ctx, pack, app, draft) {
  if (draft.kind === 'local' && !draft.directory) throw new Error('请先选择被测项目所在的目录')
  const workspace = await ctx.api('workspace-create', {
    pack: pack.id,
    app,
    source: sourceOf(draft),
    ref: draft.ref.trim(),
    commit: draft.commit.trim()
  })
  const runner = await localRunnerId(ctx)
  const pinned = await ctx.api('pack-apply', { pack: pack.id, runnerId: runner.runnerId })
  return { workspace, runner, pinned }
}

function packForm(ctx, pack, { onDone, submitLabel = null, appSlug = null } = {}) {
  const draft = draftFor(ctx, pack)
  const native = Boolean(ctx.state.native)
  const kind = h(
    'select',
    { class: 'qp-select', id: `pack-source-kind-${pack.id}` },
    ...(native ? [h('option', { value: 'local', text: '本机目录（只读取，不改动原仓库）' })] : []),
    h('option', { value: 'git', text: 'Git 地址' })
  )
  kind.value = draft.kind
  const directory = h('div', { class: 'qp-row' },
    button('选择目录…', () =>
      ctx.run(async () => {
        const picked = await ctx.api('workspace-pick')
        if (picked.directory) {
          draft.directory = picked.directory
          await ctx.render()
        }
      }), { id: `pack-pick-${pack.id}` }),
    h('span', { class: 'qp-caption', id: `pack-directory-${pack.id}`, text: draft.directory || '还没有选择' })
  )
  const repo = h('input', { class: 'qp-input', id: `pack-repo-${pack.id}`, value: draft.repoUrl, maxlength: 500 })
  repo.oninput = () => (draft.repoUrl = repo.value)
  const ref = h('input', { class: 'qp-input', id: `pack-ref-${pack.id}`, value: draft.ref, maxlength: 200 })
  ref.oninput = () => (draft.ref = ref.value)
  const commit = h('input', { class: 'qp-input', id: `pack-commit-${pack.id}`, value: draft.commit, maxlength: 64 })
  commit.oninput = () => (draft.commit = commit.value)
  kind.onchange = () => {
    draft.kind = kind.value
    ctx.render()
  }
  const form = h(
    'form',
    {
      class: 'rig-section',
      id: `pack-form-${pack.id}`,
      onsubmit: (event) => {
        event.preventDefault()
        const submit = event.submitter
        submit.disabled = true
        ctx.run(async () => {
          try {
            const applied = appSlug ? null : await ctx.api('pack-apply', { pack: pack.id })
            const app = appSlug ?? applied.app.slug
            if (!native) {
              ctx.notice(`${applied.message} 源码快照和 QA 仓库要在桌面端建立：在桌面端打开这个项目的「执行计划」页。`)
            } else {
              const { workspace, runner, pinned } = await buildWorkspace(ctx, pack, app, draft)
              ctx.notice(
                `已建立：源码快照 ${workspace.snapshot?.ref ?? '本机目录'}@${short(workspace.pinned)}，QA 仓库 ${short(workspace.qa?.commit)}，` +
                  `${pinned.tasks.length} 个执行计划指定在本机执行机「${runner.name ?? '本机'}」上跑。没有开始任何测试。`
              )
            }
            ctx.state.projectSlug = app
            ctx.state.projectTab = 'plans'
            ctx.state.packOpen = false
            ctx.state.runDetail = null
            await onDone?.()
            await ctx.render()
          } finally {
            submit.disabled = false
          }
        })
      }
    },
    // The source is only fetched on a desktop; the browser registers the project.
    ...(native
      ? [
          field('被测源码从哪里来', kind),
          draft.kind === 'local'
            ? field('被测项目目录', directory, '选仓库里的项目目录（例如 po-frontend）。Rig 把要固定的提交拉进自己的目录，不在原仓库里切分支、改文件；没有 Git 的目录（复制来的代码）会整份复制成快照，下面的分支和提交不用填。')
            : field('Git 地址', repo, '不含凭据的 HTTPS 或 SSH 地址；需要完整的 40 位提交号。'),
          field('分支', ref),
          field('固定的提交', commit, '原项目继续开发不影响已有测试；之后可以在「执行计划」页显式更新基准。'),
          note('会在本机托管一个执行机（只跑指定给它的计划），执行计划都指定在它上面。')
        ]
      : [note('在浏览器里只登记项目、执行方式和用例库；源码快照、QA 仓库和执行计划要在桌面端建立。')]),
    h(
      'div',
      { class: 'qp-row' },
      h('button', {
        class: 'qp-button qp-button--primary qp-button--sm',
        type: 'submit',
        id: `pack-submit-${pack.id}`,
        text: submitLabel ?? (native ? `建立「${pack.title}」测试项目` : `登记「${pack.title}」测试项目`)
      })
    )
  )
  return form
}

/** 项目页的「从验收包创建」（管理员）。 */
export async function packCreator(ctx) {
  const { packs = [] } = await ctx.api('packs').catch(() => ({ packs: [] }))
  if (!packs.length) return null
  const details = h('details', { class: 'rig-project-form', id: 'pack-creator' }, h('summary', { text: '从验收包创建' }))
  details.open = Boolean(ctx.state.packOpen)
  details.ontoggle = () => {
    ctx.state.packOpen = details.open
  }
  for (const pack of packs)
    details.append(
      h(
        'article',
        { class: 'qp-panel qp-card rig-section', 'data-pack': pack.id },
        h('strong', { class: 'qp-body-1 qp-body-1--semibold', text: `${pack.title} · ${pack.version}` }),
        note(pack.description),
        h(
          'div',
          { class: 'rig-chips' },
          h('span', { class: 'rig-chip', text: `源码 ${pack.source?.ref ?? ''}@${short(pack.source?.commit)}` }),
          h('span', { class: 'rig-chip', text: `${pack.cases} 条用例` }),
          pack.references ? h('span', { class: 'rig-chip', text: `${pack.references} 条旧用例作参考（不计入）` }) : null,
          ...pack.plans.map((plan) => h('span', { class: 'rig-chip', text: plan.name }))
        ),
        pack.boundary ? note(`结论边界：${pack.boundary}`) : null,
        // 第一次建？光标带着走一遍 (docs/24).
        pack.id === 'compass' ? tourEntries(ctx, { compact: true, only: ['compass-web-smoke'] }) : null,
        packForm(ctx, pack)
      )
    )
  return details
}

/** 执行计划页上的「测试项目工作区」：只在项目有工作区执行方式时出现。 */
export async function workspacePanel(ctx, app, { suites, plans, admin }) {
  if (!suites.some(isWorkspaceSuite)) return null
  if (!ctx.state.native)
    return section(
      '测试项目工作区',
      note('这个项目的测试对固定提交的源码快照运行。快照和 QA 仓库在持有它们的电脑上；在桌面端打开这个项目可以查看、更新基准和生成执行计划。')
    )
  const { packs = [] } = await ctx.api('packs').catch(() => ({ packs: [] }))
  const pack = packs.find((entry) => entry.app?.slug === app.slug) ?? null
  const [state, runner] = await Promise.all([
    ctx.api('workspace-status', { app: app.slug }),
    ctx.api('runner-status').catch(() => null)
  ])
  if (!state.exists) {
    return section(
      '测试项目工作区',
      note('本机还没有这个项目的源码快照和 QA 仓库。建立后，执行计划指定在本机执行机上跑。'),
      pack && admin ? packForm(ctx, pack, { appSlug: app.slug, submitLabel: '在本机建立工作区' }) : note(pack ? '需要管理员在本机建立。' : '这台电脑上没有这个项目的验收包。')
    )
  }
  const snapshot = state.snapshot
  const behind = state.behind
  const workspacePlans = plans.filter((plan) => suites.some((suite) => suite.id === plan.suiteId && isWorkspaceSuite(suite)))
  const rebase = ctx.state.workspaceRebase?.app === app.slug ? ctx.state.workspaceRebase : null
  return section(
    '测试项目工作区',
    h(
      'dl',
      { class: 'rig-workspace-facts', id: 'workspace-facts' },
      h('dt', { text: '固定的提交' }),
      h('dd', { text: snapshot ? `${snapshot.ref ?? ''}@${short(snapshot.commit)} · 快照于 ${new Date(snapshot.capturedAt).toLocaleString()}` : '—' }),
      h('dt', { text: snapshot?.origin?.kind === 'copy' ? '原目录' : '原分支' }),
      h('dd', {
        id: 'workspace-behind',
        text: !behind
          ? '无法比较'
          : snapshot?.origin?.kind === 'copy'
            ? behind.changed === false
              ? '与快照一致'
              : behind.changed
                ? '已有改动（内容与快照不同）'
                : '原目录已不在'
            : behind.commits === 0
            ? '与固定的提交一致'
            : behind.commits == null
              ? `已有新提交（最新 ${short(behind.tip)}）`
              : `已前进 ${behind.commits} 个提交（最新 ${short(behind.tip)}）`
      }),
      h('dt', { text: 'QA 仓库' }),
      h('dd', { text: state.qa ? `${short(state.qa.commit)} · ${state.qa.subject ?? ''}` : '—' }),
      h('dt', { text: '保留的快照' }),
      h('dd', { text: `${state.snapshots.length} 个（旧快照和旧测试都保留，可以复跑）` }),
      h('dt', { text: '本机执行机' }),
      h('dd', {
        text: !runner?.registered ? '未注册' : runner.running ? `「${runner.name}」运行中` : `「${runner.name}」未启动：指定给它的计划会一直等待`
      })
    ),
    note('快照 + 假数据的结果只说明「这个提交的前端在这些数据下的行为」，不等于线上通过。'),
    h(
      'div',
      { class: 'qp-row' },
      runner?.registered && !runner.running
        ? button('启动本机执行机', () =>
            ctx.run(async () => {
              await ctx.api('runner-start')
              ctx.notice('本机执行机已启动，指定给它的计划会开始执行')
              await ctx.render()
            }), { class: 'qp-button qp-button--primary qp-button--sm', id: 'workspace-runner-start' })
        : null,
      pack && admin && !workspacePlans.length
        ? button('生成执行计划（本机执行机）', () =>
            ctx.run(async () => {
              const local = await localRunnerId(ctx)
              const pinned = await ctx.api('pack-apply', { pack: pack.id, runnerId: local.runnerId })
              ctx.notice(`已生成 ${pinned.tasks.length} 个执行计划，指定在「${local.name ?? '本机'}」上跑`)
              await ctx.render()
            }), { id: 'workspace-plans' })
        : null,
      pack && admin && snapshot && workspacePlans.length && releaseReady(snapshot, behind)
        ? button('上线检查', () => releaseCheck(ctx, app, pack, snapshot, behind, workspacePlans), {
            class: 'qp-button qp-button--primary qp-button--sm',
            id: 'workspace-release-check',
            title: '把基准更新到原分支（或原目录）现在的内容，然后跑一遍全部用例；结果出来后可以让 Agent 分析能不能上线'
          })
        : null,
      pack && admin
        ? button('更新基准…', () => {
            ctx.state.workspaceRebase = { app: app.slug, commit: behind?.tip ?? '' }
            ctx.render()
          }, { id: 'workspace-rebase' })
        : null,
      button('打开 QA 目录', () => ctx.run(() => ctx.api('workspace-open', { app: app.slug, which: 'qa' }))),
      snapshot ? button('打开快照目录', () => ctx.run(() => ctx.api('workspace-open', { app: app.slug, which: 'snapshot' })), { class: 'qp-button qp-button--ghost qp-button--sm' }) : null
    ),
    rebase && snapshot ? rebaseForm(ctx, app, pack, snapshot, rebase) : null
  )
}

/** Whether the source moved since the snapshot, so a release check has something new to test. */
function releaseReady(snapshot, behind) {
  if (!behind) return false
  return snapshot.origin?.kind === 'copy' ? behind.changed === true : Boolean(behind.tip) && behind.commits !== 0
}

/**
 * 上线检查 (docs/23 M7c): the branch about to ship is pinned as the new
 * baseline and the plan covering every case runs on it. The old snapshot
 * stays, so the previous result can still be compared and rerun.
 */
function releaseCheck(ctx, app, pack, snapshot, behind, plans) {
  return ctx.run(async () => {
    const copied = snapshot.origin.kind === 'copy'
    const source = snapshot.origin.kind === 'git' ? { kind: 'git', repoUrl: snapshot.origin.repoUrl } : { kind: 'local', directory: snapshot.origin.directory }
    const state = await ctx.api('workspace-create', { pack: pack.id, app: app.slug, source, ...(copied ? {} : { ref: snapshot.ref, commit: behind.tip }) })
    // The plan without a case filter is the one covering everything.
    const plan = plans.find((entry) => !entry.caseFilter) ?? plans[0]
    const { run } = await ctx.api('plan-run', { id: plan.id })
    ctx.notice(
      `上线检查已开始：基准更新到 ${copied ? '原目录现在的内容' : `${snapshot.ref ?? ''}@${short(state.pinned)}`}，「${plan.name}」正在执行。` +
        '结果出来后在执行详情里点「让 Agent 分析这次执行」，得到失败归类和能否上线的建议。'
    )
    ctx.state.runDetail = run?.id ?? null
    await ctx.render()
  })
}

function rebaseForm(ctx, app, pack, snapshot, rebase) {
  const copied = snapshot.origin.kind === 'copy'
  const commit = h('input', { class: 'qp-input', id: 'workspace-rebase-commit', value: rebase.commit ?? '', maxlength: 64, required: !copied })
  commit.oninput = () => (rebase.commit = commit.value)
  return h(
    'form',
    {
      class: 'rig-section',
      id: 'workspace-rebase-form',
      onsubmit: (event) => {
        event.preventDefault()
        const submit = event.submitter
        submit.disabled = true
        ctx.run(async () => {
          try {
            const source =
              snapshot.origin.kind === 'git'
                ? { kind: 'git', repoUrl: snapshot.origin.repoUrl }
                : { kind: 'local', directory: snapshot.origin.directory }
            const state = await ctx.api('workspace-create', { pack: pack.id, app: app.slug, source, ...(copied ? {} : { ref: snapshot.ref, commit: commit.value.trim() }) })
            ctx.state.workspaceRebase = null
            ctx.notice(`基准已更新到 ${snapshot.ref ?? ''}@${short(state.pinned)}，QA 仓库记录了这次更新，旧快照保留。建议先跑一遍「全部用例」，把差异记成修正任务。`)
            await ctx.render()
          } finally {
            submit.disabled = false
          }
        })
      }
    },
    copied
      ? note('原目录没有版本控制：会重新复制一份作为新快照（内容没变就沿用原快照）。现有用例不会自动改：先跑一遍，差异逐条修正后再形成新的 QA 版本。')
      : field('新的固定提交', commit, `默认是原分支 ${snapshot.ref ?? ''} 的最新提交。现有用例不会自动改：先跑一遍，差异逐条修正后再形成新的 QA 版本。`),
    h(
      'div',
      { class: 'qp-row' },
      h('button', { class: 'qp-button qp-button--primary qp-button--sm', type: 'submit', text: '拉取新快照并更新基准' }),
      button('取消', () => {
        ctx.state.workspaceRebase = null
        ctx.render()
      }, { class: 'qp-button qp-button--ghost qp-button--sm' })
    )
  )
}
