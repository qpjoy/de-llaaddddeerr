// 用例库、项目设置与“提升到用例库” (docs/21 M2). What the old test-management
// console did for a project, inside the workbench: the project's case library,
// how its tests run (执行方式), the secrets those runs receive, and removing
// the project. Shared by the desktop and the web workbench.

import { h, table, empty, ago, download, statusTag } from './views.js'
import { openRun } from './run-detail.js'

export const section = (title, ...children) =>
  h('section', { class: 'qp-panel rig-section' }, h('h2', { class: 'qp-heading-2', text: title }), ...children)
export const note = (text) => h('p', { class: 'qp-caption qp-muted', text })
export const button = (text, onclick, props = {}) =>
  h('button', { type: 'button', class: 'qp-button qp-button--outline qp-button--sm', text, onclick, ...props })
export const field = (label, input, hint = null) =>
  h(
    'label',
    { class: 'rig-case-field' },
    h('span', { class: 'qp-caption', text: label }),
    input,
    hint ? h('span', { class: 'qp-caption qp-muted', text: hint }) : null
  )
/** An input bound to a draft object: what is typed survives a redraw. */
export function bound(tag, draft, key, { options = [], ...props } = {}) {
  const input = h(tag, { class: tag === 'textarea' ? 'qp-textarea' : tag === 'select' ? 'qp-select' : 'qp-input', ...props })
  if (tag === 'select') for (const [value, label] of options) input.append(h('option', { value, text: label }))
  input.value = draft[key] ?? ''
  const save = () => {
    draft[key] = input.type === 'checkbox' ? input.checked : input.value
  }
  if (input.type === 'checkbox') input.checked = Boolean(draft[key])
  input.oninput = save
  input.onchange = save
  return input
}

// -- 用例库 ---------------------------------------------------------------------

const PRIORITY_OPTIONS = [
  ['P0', 'P0 —— 核心，坏了不能发版'],
  ['P1', 'P1 —— 重要'],
  ['P2', 'P2 —— 一般']
]

const blankCase = () => ({ caseId: '', title: '', priority: 'P1', preconditions: '', requirementRef: '', steps: [{ action: '', expect: '' }] })

/**
 * 用例库: the project's case baseline. Cases written here are the library's
 * own (界面登记); cases a repository catalogue owns stay read-only. Retiring
 * keeps the id for history.
 */
export async function catalogTab(ctx, mount, app, access) {
  const { state } = ctx
  const canWrite = access.canWrite && ['operator', 'admin'].includes(state.principal?.role)
  const { cases = [] } = await ctx.api('app-cases', { app: app.slug })
  const pending = cases.filter((entry) => !entry.implemented).length
  const editing = state.catalogEdit?.app === app.slug ? state.catalogEdit : null
  const history = state.catalogHistory?.app === app.slug ? state.catalogHistory : null
  const sync = h('input', { type: 'file', accept: '.json,application/json', hidden: true, id: 'catalog-sync-file' })
  sync.onchange = () =>
    ctx.run(async () => {
      const file = sync.files?.[0]
      if (!file) return
      let catalog
      try {
        catalog = JSON.parse(await file.text())
      } catch {
        throw new Error('目录文件不是有效的 JSON')
      }
      const result = await ctx.api('catalog-sync', { app: app.slug, catalog })
      ctx.notice(`已同步目录文件 ${result.catalogFile ?? ''}：新增 ${result.added?.length ?? 0}，更新 ${result.updated?.length ?? 0}，停用 ${result.retired?.length ?? 0}`)
      await ctx.render()
    })
  mount.append(
    section(
      '用例库',
      note(
        `项目的用例基线：${cases.length} 条${pending ? `，其中 ${pending} 条还没有实现` : ''}。测试任务从这里导入用例；任务里确认的用例可以「提升到项目用例库」。编号格式：<应用>-<端>-<业务域>-<三位序号>，例如 LP-FE-AUTH-001。`
      ),
      h(
        'div',
        { class: 'qp-row' },
        canWrite
          ? button(
              '写一条用例',
              () => {
                state.catalogEdit = { app: app.slug, mode: 'new', draft: blankCase() }
                ctx.render()
              },
              { class: 'qp-button qp-button--primary qp-button--sm', id: 'catalog-new' }
            )
          : null,
        button('导出目录文件', () =>
          ctx.run(async () => {
            const exported = await ctx.api('cases-export', { app: app.slug })
            download(`${app.slug}-catalog.json`, `${JSON.stringify(exported, null, 2)}\n`, 'application/json')
          })
        ),
        canWrite ? button('从目录文件同步', () => sync.click()) : null,
        sync
      ),
      editing ? caseForm(ctx, app, editing) : null,
      cases.length
        ? table(
            [
              { title: '编号', cell: (entry) => h('code', { class: 'qp-caption', text: entry.caseId }) },
              { title: '标题', cell: (entry) => h('span', { class: 'qp-body-2', text: entry.title }) },
              { title: '优先级', cell: (entry) => h('span', { class: 'qp-body-2', text: entry.priority ?? '—' }) },
              {
                title: '实现',
                cell: (entry) =>
                  entry.automationState === 'reference'
                    ? h('span', {
                        class: 'qp-tag',
                        text: '参考（不计入）',
                        title: '旧用例，只作参考：不执行、不计入分母，等重写成新用例或明确废弃'
                      })
                    : h('span', {
                        class: `qp-tag ${entry.implemented ? 'qp-tag--success' : 'qp-tag--warning'}`,
                        text: entry.implemented ? '已实现' : '待实现'
                      })
              },
              {
                title: '最近结果',
                cell: (entry) =>
                  entry.lastRunId
                    ? h(
                        'button',
                        { class: 'qp-button qp-button--ghost qp-button--sm', type: 'button', title: '打开这次执行', onclick: () => openRun(ctx, entry.lastRunId) },
                        statusTag(entry.lastStatus)
                      )
                    : h('span', { class: 'qp-body-2 qp-muted', text: '—' })
              },
              {
                title: '来源',
                cell: (entry) => h('span', { class: 'qp-body-2 qp-muted', text: entry.origin === 'platform' ? '界面登记' : '代码仓库' })
              },
              {
                title: '',
                cell: (entry) =>
                  h(
                    'span',
                    { class: 'qp-row' },
                    canWrite && entry.origin === 'platform'
                      ? button(
                          '编辑',
                          () => {
                            state.catalogEdit = {
                              app: app.slug,
                              mode: 'edit',
                              draft: {
                                caseId: entry.caseId,
                                title: entry.title ?? '',
                                priority: ['P0', 'P1', 'P2'].includes(entry.priority) ? entry.priority : 'P1',
                                preconditions: entry.preconditions ?? '',
                                requirementRef: entry.requirementRef ?? '',
                                steps: entry.steps?.length ? entry.steps.map((step) => ({ ...step })) : [{ action: '', expect: '' }]
                              }
                            }
                            ctx.render()
                          },
                          { class: 'qp-button qp-button--ghost qp-button--sm', 'data-case-edit': entry.caseId }
                        )
                      : null,
                    button(
                      '执行历史',
                      () =>
                        ctx.run(async () => {
                          const result = await ctx.api('case-history', { app: app.slug, caseId: entry.caseId })
                          state.catalogHistory = { app: app.slug, caseId: entry.caseId, history: result.history ?? [] }
                          await ctx.render()
                        }),
                      { class: 'qp-button qp-button--ghost qp-button--sm' }
                    ),
                    canWrite && entry.origin === 'platform'
                      ? button(
                          '停用',
                          () =>
                            ctx.run(async () => {
                              if (!window.confirm(`停用用例 ${entry.caseId}？它不再进入新的执行范围，历史结果保留。`)) return
                              await ctx.api('case-retire', { app: app.slug, caseId: entry.caseId })
                              ctx.notice(`已停用 ${entry.caseId}`)
                              await ctx.render()
                            }),
                          { class: 'qp-button qp-button--ghost qp-button--sm', 'data-case-retire': entry.caseId }
                        )
                      : null
                  )
              }
            ],
            cases,
            { layout: 'case-catalog' }
          )
        : empty('还没有用例。可以在这里写，也可以在测试任务里录入、导入或让 Rig 起草，确认后提升到用例库。'),
      history
        ? h(
            'section',
            { class: 'rig-section', id: 'case-history' },
            h('h3', { class: 'qp-body-1 qp-body-1--semibold', text: `${history.caseId} 的执行历史（最近 ${history.history.length} 次）` }),
            history.history.length
              ? h(
                  'ul',
                  { class: 'rig-step-results' },
                  ...history.history.map((entry) =>
                    h('li', {
                      'data-status': entry.status === 'passed' ? 'passed' : entry.status === 'failed' ? 'failed' : 'skipped',
                      text: `${entry.status} · ${ago(entry.finishedAt ?? entry.createdAt)} · ${entry.runId ?? ''}`
                    })
                  )
                )
              : note('这条用例还没有执行结果。'),
            button('收起', () => {
              state.catalogHistory = null
              ctx.render()
            })
          )
        : null
    )
  )
}

function caseForm(ctx, app, editing) {
  const { draft } = editing
  const rows = h('div', { class: 'rig-step-editor' })
  const paintRows = () => {
    rows.replaceChildren(
      ...draft.steps.map((step, index) =>
        h(
          'div',
          { class: 'qp-row rig-step-row' },
          h('span', { class: 'qp-caption', text: String(index + 1) }),
          bound('input', step, 'action', { placeholder: '做什么，例如：打开 /login', 'aria-label': `第 ${index + 1} 步操作` }),
          bound('input', step, 'expect', { placeholder: '应该看到什么', 'aria-label': `第 ${index + 1} 步期望` }),
          button('删除', () => {
            draft.steps.splice(index, 1)
            if (!draft.steps.length) draft.steps.push({ action: '', expect: '' })
            paintRows()
          }, { class: 'qp-button qp-button--ghost qp-button--sm' })
        )
      )
    )
  }
  paintRows()
  const form = h(
    'form',
    {
      class: 'rig-catalog-form',
      id: 'catalog-form',
      onsubmit: (event) => {
        event.preventDefault()
        ctx.run(async () => {
          const payload = {
            app: app.slug,
            caseId: draft.caseId.trim(),
            title: draft.title.trim(),
            priority: draft.priority,
            preconditions: draft.preconditions.trim() || undefined,
            requirementRef: draft.requirementRef.trim() || undefined,
            steps: draft.steps.filter((step) => step.action.trim() || step.expect.trim())
          }
          await ctx.api(editing.mode === 'new' ? 'case-create' : 'case-update', payload)
          ctx.notice(editing.mode === 'new' ? `已登记 ${payload.caseId.toUpperCase()}；有实现之前它在报告里显示「未执行」` : `已更新 ${payload.caseId}`)
          ctx.state.catalogEdit = null
          await ctx.render()
        })
      }
    },
    h('h3', { class: 'qp-body-1 qp-body-1--semibold', text: editing.mode === 'new' ? '写一条用例' : `编辑 ${draft.caseId}` }),
    h(
      'div',
      { class: 'qp-row' },
      field('用例编号', bound('input', draft, 'caseId', { id: 'catalog-case-id', readonly: editing.mode === 'edit', placeholder: 'LP-FE-AUTH-001', required: true })),
      field('优先级', bound('select', draft, 'priority', { options: PRIORITY_OPTIONS }))
    ),
    field('这条用例验证什么', bound('input', draft, 'title', { id: 'catalog-case-title', required: true, placeholder: '在什么情况下，应该发生什么' })),
    field('前置条件', bound('textarea', draft, 'preconditions', { rows: 2 })),
    h('span', { class: 'qp-caption', text: '测试步骤：左边写做什么，右边写应该看到什么' }),
    rows,
    button('+ 加一步', () => {
      draft.steps.push({ action: '', expect: '' })
      paintRows()
    }, { class: 'qp-button qp-button--ghost qp-button--sm' }),
    field('需求编号', bound('input', draft, 'requirementRef', { placeholder: '可留空；填了才算需求覆盖率' })),
    h(
      'div',
      { class: 'qp-row' },
      h('button', { type: 'submit', class: 'qp-button qp-button--primary qp-button--sm', text: editing.mode === 'new' ? '登记' : '保存' }),
      button('取消', () => {
        ctx.state.catalogEdit = null
        ctx.render()
      }, { class: 'qp-button qp-button--ghost qp-button--sm' })
    )
  )
  return form
}

// -- 提升到用例库 -----------------------------------------------------------------

/** Under a task's confirmed cases: write them into the project's case library. */
export function promotePanel(ctx, mission, book) {
  const { state } = ctx
  if (!book.confirmed) return null
  const result = state.promoteResult?.missionId === mission.id && state.promoteResult.revision === book.revision ? state.promoteResult : null
  return section(
    '提升到项目用例库',
    note(`第 ${book.revision} 版已确认。提升后，这些用例成为项目的基线，以后的任务可以从用例库导入；本任务的快照不受影响。来自代码仓库的用例以仓库为准，不会被覆盖。`),
    button(
      '提升到项目用例库',
      () =>
        ctx.run(async () => {
          const outcome = await ctx.api('task-cases-promote', { id: mission.id, expectedRevision: book.revision })
          state.promoteResult = { missionId: mission.id, revision: book.revision, ...outcome }
          ctx.notice(`已提升 ${outcome.promoted.length} 条${outcome.skipped.length ? `，${outcome.skipped.length} 条未提升` : ''}`)
          await ctx.render()
        }),
      { class: 'qp-button qp-button--primary qp-button--sm', id: 'promote-cases', disabled: !ctx.canRun() }
    ),
    result
      ? h(
          'ul',
          { class: 'rig-step-results', id: 'promote-result' },
          ...result.promoted.map((entry) =>
            h('li', { 'data-status': 'passed', text: `${entry.caseId} · ${entry.action === 'created' ? '已新增到用例库' : '已更新用例库里的同号用例'}` })
          ),
          ...result.skipped.map((entry) => h('li', { 'data-status': 'skipped', text: `${entry.caseId} · 未提升：${entry.reason}` }))
        )
      : null
  )
}

// -- 项目设置 ---------------------------------------------------------------------

const SUITE_TEMPLATES = {
  playwright: {
    label: 'Playwright · 网页',
    engine: 'playwright',
    surface: 'web',
    runnerKind: 'local',
    targetMode: 'external',
    runnerImage: '',
    command: 'npx playwright test'
  },
  cypress: {
    label: 'Cypress · 网页',
    engine: 'cypress',
    surface: 'web',
    runnerKind: 'server',
    targetMode: 'external',
    runnerImage: 'cypress/included:15.19.0',
    command: 'npx cypress run'
  },
  'playwright-electron': {
    label: 'Playwright · Electron 桌面',
    engine: 'playwright-electron',
    surface: 'electron',
    runnerKind: 'local',
    targetMode: 'self',
    runnerImage: '',
    command: 'pnpm test',
    os: 'windows'
  }
}

const suiteDraft = (template = 'playwright') => ({
  template,
  slug: '',
  displayName: '',
  repoUrl: '',
  defaultBranch: '',
  workingDir: '.',
  secretRefs: '',
  writesData: false,
  ...SUITE_TEMPLATES[template],
  os: SUITE_TEMPLATES[template].os ?? ''
})

/**
 * 设置: how this project's tests run, the secrets those runs receive, and
 * removing the project. Changing what runs on real machines is an
 * administrator's decision, recorded in the audit trail by the service.
 */
export async function settingsTab(ctx, mount, app, access) {
  const { state } = ctx
  const admin = state.principal?.role === 'admin'
  if (!admin) {
    mount.append(section('项目设置', note('执行方式、密钥和删除项目只对部署管理员开放。')))
    return
  }
  const [{ suites = [] }, { secrets = [] }] = await Promise.all([
    ctx.api('app-suites', { app: app.slug }),
    ctx.api('app-secrets', { app: app.slug })
  ])
  const editing = state.suiteEdit?.app === app.slug ? state.suiteEdit : null
  mount.append(
    section(
      '执行方式',
      note('执行方式说明这个项目的测试怎么跑：引擎、代码从哪里来、执行命令、在哪类执行机上跑。执行计划从这里选执行方式。命令只按空格分隔、不经过 shell；修改会记入审计。'),
      h(
        'div',
        { class: 'qp-row' },
        ...Object.entries(SUITE_TEMPLATES).map(([key, template]) =>
          button(`新建 · ${template.label}`, () => {
            state.suiteEdit = { app: app.slug, mode: 'new', draft: suiteDraft(key) }
            ctx.render()
          }, { 'data-suite-template': key })
        ),
        button('启用规程回放', () =>
          ctx.run(async () => {
            await ctx.api('procedure-suite', { app: app.slug })
            ctx.notice('已建立规程回放的执行方式；规程回归计划在「试验规程」页设置')
            await ctx.render()
          })
        )
      ),
      editing ? suiteForm(ctx, app, editing) : null,
      suites.length
        ? table(
            [
              {
                title: '执行方式',
                cell: (suite) =>
                  h('span', { class: 'qp-data-cell' }, h('strong', { class: 'qp-body-2', text: suite.displayName }), h('small', { class: 'qp-caption qp-muted', text: suite.slug }))
              },
              { title: '引擎', cell: (suite) => h('span', { class: 'qp-body-2', text: `${suite.engine} · ${suite.surface}` }) },
              {
                title: '在哪跑',
                cell: (suite) =>
                  h('span', {
                    class: 'qp-body-2 qp-muted',
                    text: `${suite.runnerKind === 'server' ? '服务器' : '执行机'}${suite.requirements?.os?.length ? ` · ${suite.requirements.os.join('/')}` : ''} · ${suite.targetMode === 'self' ? '自起目标' : '对地址运行'}`
                  })
              },
              { title: '命令', cell: (suite) => h('code', { class: 'qp-caption', text: (suite.command ?? []).join(' ') || '—' }) },
              {
                title: '',
                cell: (suite) =>
                  suite.engine === 'rig-procedure'
                    ? h('span', { class: 'qp-caption qp-muted', text: '由服务端维护' })
                    : h(
                        'span',
                        { class: 'qp-row' },
                        button('编辑', () => {
                          state.suiteEdit = {
                            app: app.slug,
                            mode: 'edit',
                            draft: {
                              template: suite.engine,
                              slug: suite.slug,
                              displayName: suite.displayName,
                              engine: suite.engine,
                              surface: suite.surface,
                              runnerKind: suite.runnerKind,
                              targetMode: suite.targetMode,
                              runnerImage: suite.runnerImage ?? '',
                              repoUrl: suite.repoUrl ?? '',
                              defaultBranch: suite.defaultBranch ?? '',
                              workingDir: suite.workingDir ?? '.',
                              command: (suite.command ?? []).join(' '),
                              secretRefs: (suite.secretRefs ?? []).join(', '),
                              writesData: Boolean(suite.writesData),
                              os: (suite.requirements?.os ?? []).join(',')
                            }
                          }
                          ctx.render()
                        }, { class: 'qp-button qp-button--ghost qp-button--sm' }),
                        button('删除', () =>
                          ctx.run(async () => {
                            if (!window.confirm(`删除执行方式「${suite.displayName}」？指向它的执行计划会一起失效。`)) return
                            try {
                              await ctx.api('suite-delete', { app: app.slug, suite: suite.slug })
                            } catch (error) {
                              if (!/执行记录/.test(error.message)) throw error
                              if (!window.confirm(`${error.message}。\n\n它的执行记录和指向它的执行计划都会一起删除，不能恢复。确定？`)) return
                              await ctx.api('suite-delete', { app: app.slug, suite: suite.slug, force: true })
                            }
                            ctx.notice(`已删除执行方式「${suite.displayName}」`)
                            await ctx.render()
                          }),
                          { class: 'qp-button qp-button--ghost qp-button--sm' }
                        )
                      )
              }
            ],
            suites,
            { layout: 'suites' }
          )
        : empty('还没有执行方式。从上面的模板新建一个，执行计划才有东西可选。')
    ),
    packageSection(ctx, app, suites),
    secretsSection(ctx, app, secrets),
    deleteSection(ctx, app)
  )
}

function suiteForm(ctx, app, editing) {
  const { draft } = editing
  const isNew = editing.mode === 'new'
  return h(
    'form',
    {
      class: 'rig-suite-form',
      id: 'suite-form',
      onsubmit: (event) => {
        event.preventDefault()
        ctx.run(async () => {
          const command = String(draft.command ?? '').trim().split(/\s+/).filter(Boolean)
          const os = String(draft.os ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
          const payload = {
            app: app.slug,
            displayName: draft.displayName.trim(),
            engine: draft.engine,
            surface: draft.surface,
            runnerKind: draft.runnerKind,
            targetMode: draft.targetMode,
            runnerImage: draft.runnerImage.trim() || undefined,
            repoUrl: draft.repoUrl.trim() || undefined,
            defaultBranch: draft.defaultBranch.trim() || undefined,
            workingDir: draft.workingDir.trim() || '.',
            command,
            requirements: os.length ? { os } : {},
            secretRefs: String(draft.secretRefs ?? '').split(/[,，\s]+/).filter(Boolean),
            writesData: Boolean(draft.writesData)
          }
          if (isNew) await ctx.api('suite-create', { ...payload, slug: draft.slug.trim() })
          else await ctx.api('suite-update', { ...payload, suite: draft.slug })
          ctx.notice(isNew ? `已新建执行方式「${payload.displayName}」` : `已更新执行方式「${payload.displayName}」`)
          ctx.state.suiteEdit = null
          await ctx.render()
        })
      }
    },
    h('h3', { class: 'qp-body-1 qp-body-1--semibold', text: isNew ? `新建执行方式 · ${SUITE_TEMPLATES[draft.template]?.label ?? draft.engine}` : `编辑执行方式 · ${draft.slug}` }),
    h(
      'div',
      { class: 'qp-row' },
      field('标识', bound('input', draft, 'slug', { id: 'suite-slug', readonly: !isNew, required: true, placeholder: 'web-smoke' }), '小写字母、数字、连字符'),
      field('名称', bound('input', draft, 'displayName', { id: 'suite-name', required: true, placeholder: 'Web 冒烟' }))
    ),
    h(
      'div',
      { class: 'qp-row' },
      field('代码仓库', bound('input', draft, 'repoUrl', { placeholder: '留空时用项目登记的仓库' })),
      field('分支', bound('input', draft, 'defaultBranch', { placeholder: 'main' })),
      field('仓库内目录', bound('input', draft, 'workingDir', { placeholder: '.' }))
    ),
    field('执行命令', bound('input', draft, 'command', { id: 'suite-command', required: true }), '按空格分隔成参数，不经过 shell'),
    h(
      'div',
      { class: 'qp-row' },
      field('在哪跑', bound('select', draft, 'runnerKind', { options: [['server', '服务器（不录像）'], ['local', '执行机（真实电脑，有录像）']] })),
      field('目标', bound('select', draft, 'targetMode', { options: [['external', '对地址运行'], ['self', '测试自己起被测目标']] })),
      field('服务器镜像', bound('input', draft, 'runnerImage', { placeholder: '只在服务器上跑时需要' }))
    ),
    h(
      'div',
      { class: 'qp-row' },
      field('执行机系统要求', bound('input', draft, 'os', { placeholder: 'windows,macos（可留空）' })),
      field('注入的密钥名', bound('input', draft, 'secretRefs', { placeholder: 'LUOPAN_TEST_ACCOUNT, LUOPAN_TEST_PASSWORD' }), '只写名字，值在下方「密钥」里设置'),
      h('label', { class: 'qp-choice qp-choice--checkbox' }, bound('input', draft, 'writesData', { type: 'checkbox' }), h('span', { class: 'qp-choice__control' }), h('span', { text: '会写入被测环境的数据' }))
    ),
    h(
      'div',
      { class: 'qp-row' },
      h('button', { type: 'submit', class: 'qp-button qp-button--primary qp-button--sm', text: isNew ? '新建' : '保存' }),
      button('取消', () => {
        ctx.state.suiteEdit = null
        ctx.render()
      }, { class: 'qp-button qp-button--ghost qp-button--sm' })
    )
  )
}

/** Write-only: a secret's value goes to the service and never comes back to a page. */
/**
 * 安装包：桌面端执行下载并校验的发行包（docs/19、docs/21 M6）。The service
 * keeps the latest one per project; a desktop run takes it when it is created,
 * and the runner checks the sha256 before launching anything.
 */
function packageSection(ctx, app, suites) {
  if (!suites.some((suite) => suite.surface === 'electron') && !(app.surfaces ?? []).includes('electron')) return null
  const latest = app.latestPackage ?? null
  const input = (id, placeholder, props = {}) => h('input', { class: 'qp-input', id, placeholder, autocomplete: 'off', ...props })
  const url = input('package-url', 'https://downloads.example.com/compass/Compass-Setup-2.0.6.exe', { required: true })
  const sha256 = input('package-sha256', '安装包文件的 sha256（64 位十六进制）', { required: true, pattern: '[0-9a-fA-F]{64}' })
  const filename = input('package-filename', '文件名（可留空）')
  const version = input('package-version', '版本，例如 2.0.6')
  const gitSha = input('package-gitsha', '构建它的提交（可留空）')
  return section(
    '安装包',
    note('桌面端的执行计划测的是安装包，不是源码。这里登记的最新安装包，会在每次桌面端执行创建时带上；执行机下载后先校验 sha256，不一致就记为受阻。下载地址请用域名，不要用裸 IP 的 https 地址（握手会失败）。'),
    latest
      ? h(
          'dl',
          { class: 'rig-workspace-facts', id: 'package-latest' },
          h('dt', { text: '当前安装包' }),
          h('dd', { text: [latest.filename, latest.version && `版本 ${latest.version}`].filter(Boolean).join(' · ') || latest.url }),
          h('dt', { text: 'sha256' }),
          h('dd', { text: latest.sha256 }),
          h('dt', { text: '构建提交' }),
          h('dd', { text: latest.gitSha || '未登记' }),
          h('dt', { text: '登记时间' }),
          h('dd', { text: latest.publishedAt ? new Date(latest.publishedAt).toLocaleString() : '—' })
        )
      : note('还没有登记安装包：桌面端的执行会因为没有可测的应用而受阻。'),
    h(
      'form',
      {
        class: 'rig-section',
        id: 'package-form',
        onsubmit: (event) => {
          event.preventDefault()
          const submit = event.submitter
          submit.disabled = true
          ctx.run(async () => {
            try {
              await ctx.api('package-publish', {
                app: app.slug,
                url: url.value.trim(),
                sha256: sha256.value.trim().toLowerCase(),
                ...(filename.value.trim() ? { filename: filename.value.trim() } : {}),
                ...(version.value.trim() ? { version: version.value.trim() } : {}),
                ...(gitSha.value.trim() ? { gitSha: gitSha.value.trim() } : {})
              })
              ctx.notice('已登记安装包；之后的桌面端执行会用它。')
              await ctx.render()
            } finally {
              submit.disabled = false
            }
          })
        }
      },
      field('下载地址', url),
      field('sha256', sha256, '在构建机上算：shasum -a 256 <文件>（macOS）或 Get-FileHash <文件>（Windows）。'),
      h('div', { class: 'rig-grid-2' }, field('文件名', filename), field('版本', version)),
      field('构建提交', gitSha),
      h('div', { class: 'qp-row' }, h('button', { class: 'qp-button qp-button--primary qp-button--sm', type: 'submit', text: latest ? '登记新的安装包' : '登记安装包' }))
    )
  )
}

function secretsSection(ctx, app, secrets) {
  const name = h('input', { class: 'qp-input', id: 'secret-name', placeholder: 'LUOPAN_TEST_PASSWORD', autocomplete: 'off' })
  const value = h('input', { class: 'qp-input', id: 'secret-value', type: 'password', placeholder: '值', autocomplete: 'new-password' })
  const description = h('input', { class: 'qp-input', id: 'secret-description', placeholder: '说明（可留空）' })
  return section(
    '密钥',
    note('执行时按执行方式里写的名字注入为环境变量，例如测试账号的密码。值只写不读：保存后任何页面都看不到它，日志和审计里也只有名字。'),
    h(
      'form',
      {
        class: 'qp-row',
        id: 'secret-form',
        onsubmit: (event) => {
          event.preventDefault()
          ctx.run(async () => {
            await ctx.api('secret-put', { app: app.slug, name: name.value.trim(), value: value.value, ...(description.value.trim() ? { description: description.value.trim() } : {}) })
            value.value = ''
            ctx.notice(`已保存密钥 ${name.value.trim()}`)
            await ctx.render()
          })
        }
      },
      name,
      value,
      description,
      h('button', { type: 'submit', class: 'qp-button qp-button--primary qp-button--sm', text: '保存密钥' })
    ),
    secrets.length
      ? table(
          [
            { title: '名字', cell: (entry) => h('code', { class: 'qp-caption', text: entry.name }) },
            { title: '说明', cell: (entry) => h('span', { class: 'qp-body-2 qp-muted', text: entry.description ?? '—' }) },
            { title: '更新', cell: (entry) => h('span', { class: 'qp-body-2 qp-muted', text: ago(entry.updatedAt) }) },
            {
              title: '',
              cell: (entry) =>
                button('删除', () =>
                  ctx.run(async () => {
                    if (!window.confirm(`删除密钥 ${entry.name}？引用它的执行方式之后拿不到这个值。`)) return
                    await ctx.api('secret-delete', { app: app.slug, name: entry.name })
                    ctx.notice(`已删除密钥 ${entry.name}`)
                    await ctx.render()
                  }),
                  { class: 'qp-button qp-button--ghost qp-button--sm', 'data-secret-delete': entry.name }
                )
            }
          ],
          secrets,
          { layout: 'secrets' }
        )
      : empty('还没有密钥。')
  )
}

function deleteSection(ctx, app) {
  const confirmText = h('input', { class: 'qp-input', id: 'project-delete-confirm', placeholder: `输入 ${app.slug} 确认`, autocomplete: 'off' })
  return section(
    '删除项目',
    note('删除项目会连同它的执行方式、执行计划和用例库一起删除；有执行记录时还会删除全部执行记录和录像，不能恢复。项目仍有关联的试验规程时不能删除。'),
    h(
      'div',
      { class: 'qp-row' },
      confirmText,
      button('删除这个项目', () =>
        ctx.run(async () => {
          if (confirmText.value.trim() !== app.slug) throw new Error(`请先输入项目标识 ${app.slug} 确认`)
          let result
          try {
            result = await ctx.api('project-delete', { app: app.slug })
          } catch (error) {
            if (!/执行记录/.test(error.message)) throw error
            if (!window.confirm(`${error.message}。\n\n它的全部执行记录、用例结果和录像都会一起删除，不能恢复。确定？`)) return
            result = await ctx.api('project-delete', { app: app.slug, force: true })
          }
          ctx.notice(result.runs ? `已删除项目，连同 ${result.runs} 次执行记录` : '已删除项目')
          ctx.state.projectSlug = null
          ctx.state.projectTab = 'tasks'
          await ctx.render()
        }),
        { class: 'qp-button qp-button--outline qp-button--sm rig-danger', id: 'project-delete' }
      )
    )
  )
}
