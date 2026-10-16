import { h, missionDetail, composer, runsTable } from './views.js'
import { testImplementation } from './test-implementation.js'
import { testExecution } from './test-execution.js'
import { catalogTab, promotePanel, settingsTab } from './project-settings.js'
import { planTab } from './plans.js'
import { openRun, runDetail } from './run-detail.js'
import { packCreator } from './packs.js'
import { setupChecklist } from './checklist.js'

const section = (title, ...children) =>
  h(
    'section',
    { class: 'qp-panel rig-section' },
    h('h2', { class: 'qp-heading-2', text: title }),
    ...children
  )
const note = (text) => h('p', { class: 'qp-caption qp-muted', text })
const button = (text, onclick, props = {}) =>
  h('button', {
    type: 'button',
    class: 'qp-button qp-button--outline qp-button--sm',
    text,
    onclick,
    ...props
  })
const field = (label, input) =>
  h('label', { class: 'rig-case-field' }, h('span', { class: 'qp-caption', text: label }), input)
const emptyCase = () => ({
  caseId: '',
  title: '',
  preconditions: '',
  steps: '',
  expected: '',
  priority: 'P1',
  platforms: ['web'],
  requirementRef: '',
  specPath: '',
  suiteSlug: '',
  source: 'user'
})

const PROJECT_TABS = [
  ['tasks', '测试任务'],
  ['catalog', '用例库'],
  ['plans', '执行计划'],
  ['runs', '执行记录'],
  ['access', '成员与访问'],
  ['settings', '设置']
]

function projectTabs(ctx, current) {
  return h(
    'div',
    { class: 'rig-test-tabs rig-project-tabs', role: 'tablist', 'aria-label': '项目视图' },
    ...PROJECT_TABS.map(([key, title]) =>
      button(
        title,
        () => {
          ctx.state.projectTab = key
          ctx.state.runDetail = null
          ctx.render()
        },
        {
          role: 'tab',
          'data-project-tab': key,
          'aria-selected': current === key ? 'true' : 'false',
          class: `qp-button ${current === key ? 'qp-button--primary' : 'qp-button--ghost'}`
        }
      )
    )
  )
}

/** Project and case-first entry, shared by the desktop and the web workbench. */
export async function projects(ctx, mount) {
  const { state } = ctx
  const { apps } = await ctx.api('apps')
  const app = apps.find((entry) => entry.slug === state.projectSlug) ?? apps[0]
  state.projectSlug = app?.slug ?? null
  const picker = h(
    'select',
    { class: 'qp-select', id: 'test-project', 'aria-label': '被测项目' },
    ...apps.map((entry) => h('option', { value: entry.slug, text: entry.displayName }))
  )
  if (app) picker.value = app.slug
  picker.onchange = () => {
    state.projectSlug = picker.value
    state.projectTask = null
    state.runDetail = null
    state.caseEdit = null
    state.testTab = 'cases'
    ctx.render()
  }
  mount.append(
    section(
      '被测项目',
      apps.length
        ? picker
        : note('先接入项目，再建立测试任务。准备用户用例无需配置模型或执行引擎。'),
      app &&
        note(
          `项目目录：${app.sourceDirectory || '未登记'}${app.sourceDirectory ? '（登记信息；实际读取范围见任务的测试实现页）' : ''}`
        ),
      app?.repoUrl &&
        note(
          `登记仓库：${app.repoUrl} · ${app.defaultBranch || '未指定分支'}（在桌面任务的测试实现页连接）`
        ),
      state.principal.role === 'admin'
        ? [projectForm(ctx), await packCreator(ctx)]
        : note('项目由管理员接入；测试成员可以在已有项目下建立任务。')
    )
  )
  if (!app) return
  const { access } = await ctx.api('project-access', { app: app.slug })
  const canRun = ctx.canRun
  ctx = { ...ctx, canRun: () => canRun() && access.canWrite }

  // The project's own pages (docs/21 §4): tasks first, then what the project
  // owns — its case library, execution plans, runs, and who may see it.
  const projectTab = PROJECT_TABS.some(([key]) => key === state.projectTab) ? state.projectTab : 'tasks'
  mount.append(await setupChecklist(ctx, app), projectTabs(ctx, projectTab))
  // A run opened from any tab shows in its place; 返回 goes back to that tab.
  if (state.runDetail) {
    await runDetail(ctx, mount, state.runDetail)
    return
  }
  if (projectTab === 'catalog') {
    await catalogTab(ctx, mount, app, access)
    return
  }
  if (projectTab === 'settings') {
    await settingsTab(ctx, mount, app, access)
    return
  }
  if (projectTab === 'plans') {
    await planTab(ctx, mount, app, access)
    return
  }
  if (projectTab === 'runs') {
    const { runs = [] } = await ctx.api('app-runs', { app: app.slug })
    mount.append(
      section(
        '执行记录',
        note('这个项目最近 50 次执行，来自执行计划、测试任务和规程回归。'),
        runs.length ? runsTable(ctx, runs) : note('还没有执行记录。')
      )
    )
    return
  }
  if (projectTab === 'access') {
    mount.append(await projectAccessPanel(ctx, app, access))
    return
  }

  const tasks = state.missions.filter((entry) => entry.workbench?.appId === app.id)
  const mission = tasks.find((entry) => entry.id === state.projectTask)
  const goal = h('input', {
    class: 'qp-input',
    id: 'test-task-goal',
    placeholder: '例如：本次发布的 Web 与桌面端登录验收',
    maxlength: 8000,
    required: true
  })
  goal.value = state.testTaskGoal ?? ''
  goal.oninput = () => {
    state.testTaskGoal = goal.value
  }
  const create = h(
    'form',
    {
      class: 'rig-task-create',
      onsubmit: (event) => {
        event.preventDefault()
        const submit = event.submitter
        submit.disabled = true
        ctx.run(async () => {
          try {
            const { mission: created } = await ctx.api('test-task-create', {
              app: app.slug,
              goal: goal.value
            })
            state.projectTask = created.id
            state.selected = created.id
            state.testTab = 'cases'
            state.testTaskGoal = ''
            state.caseEdit = null
            await ctx.refresh()
            await ctx.render()
          } finally {
            submit.disabled = false
          }
        })
      }
    },
    goal,
    h('button', {
      class: 'qp-button qp-button--primary',
      type: 'submit',
      text: '建立测试任务',
      disabled: !ctx.canRun()
    })
  )
  const list = h(
    'div',
    { class: 'rig-test-task-list' },
    ...tasks.map((entry) =>
      button(
        entry.goal,
        () => {
          state.projectTask = entry.id
          state.selected = entry.id
          state.caseEdit = null
          state.caseHistory = null
          state.testTab = 'cases'
          ctx.render()
        },
        {
          class: `qp-button qp-button--outline ${mission?.id === entry.id ? 'is-selected' : ''}`,
          'aria-pressed': mission?.id === entry.id ? 'true' : 'false'
        }
      )
    )
  )
  mount.append(section('项目下的测试任务', create, list))
  if (!mission) return

  const { book } = await ctx.api('task-cases', { id: mission.id })
  const tab = state.testTab ?? 'cases'
  const tabs = h(
    'div',
    { class: 'rig-test-tabs', role: 'tablist', 'aria-label': '测试任务视图' },
    ...[
      ['cases', '用例'],
      ['conversation', '对话'],
      ['implementation', '测试实现'],
      ['execution', '执行与结果'],
      ['history', '版本历史']
    ].map(([key, title]) =>
      button(
        title,
        () => {
          state.testTab = key
          ctx.render()
        },
        {
          role: 'tab',
          'data-test-tab': key,
          'aria-selected': tab === key ? 'true' : 'false',
          class: `qp-button ${tab === key ? 'qp-button--primary' : 'qp-button--ghost'}`
        }
      )
    )
  )
  mount.append(
    section(
      mission.goal,
      tabs,
      note(
        `${book.cases.length} 条用例 · ${book.revision ? `v${book.revision}` : '尚未保存用例'} · ${book.confirmed ? '已确认，尚不代表已执行' : '待确认'}`
      )
    )
  )
  if (tab === 'conversation') {
    mount.append(
      note(
        'Rig 测试助手围绕当前用例和本任务的执行结果与你协作。用例草稿由你审阅确认，测试在「执行与结果」中预览后派发。'
      )
    )
    mount.append(missionDetail(ctx, mission), composer(ctx, mission))
    return
  }
  if (tab === 'history') {
    const history = section(
      '用例版本历史',
      ...book.history
        .slice()
        .reverse()
        .map((entry) =>
          button(
            `v${entry.revision} · ${entry.count} 条 · ${entry.confirmedAt ? '已确认' : '草稿'} · ${new Date(entry.createdAt).toLocaleString()}`,
            () =>
              ctx.run(async () => {
                const { book: snapshot } = await ctx.api('task-cases', {
                  id: mission.id,
                  revision: entry.revision
                })
                state.caseHistory = { id: mission.id, book: snapshot }
                await ctx.render()
              })
          )
        )
    )
    if (!book.history.length) history.append(note('保存第一版用例后，历史会显示在这里。'))
    if (state.caseHistory?.id === mission.id)
      history.append(
        h('pre', {
          class: 'qp-code-block',
          text: JSON.stringify(state.caseHistory.book.cases, null, 2)
        }),
        note('恢复会创建新的待确认草稿，原版本与执行记录保留。'),
        button(
          '将此用例版本恢复为新草稿',
          () =>
            ctx.run(async () => {
              await save(ctx, mission, book, state.caseHistory.book.cases)
              state.caseHistory = null
              state.testTab = 'cases'
              await ctx.render()
            }),
          { disabled: !ctx.canRun() }
        )
      )
    mount.append(history)
    return
  }
  if (tab === 'implementation') {
    await testImplementation(ctx, mount, mission, book)
    return
  }
  if (tab === 'execution') {
    await testExecution(ctx, mount, mission, book)
    return
  }
  mount.append(caseList(ctx, mission, book))
  const promote = promotePanel(ctx, mission, book)
  if (promote) mount.append(promote)
  if (mission.caseDrafts?.length) mount.append(agentDrafts(ctx, mission, book))
  mount.append(caseEditor(ctx, mission, book), importPanel(ctx, mission, book))
}

function projectForm(ctx) {
  const details = h('details', { class: 'rig-project-form', id: 'project-form' }, h('summary', { text: '接入新项目' }))
  const displayName = h('input', {
    class: 'qp-input',
    id: 'project-name',
    required: true,
    maxlength: 200
  })
  const slug = h('input', {
    class: 'qp-input',
    id: 'project-slug',
    required: true,
    pattern: '[a-z0-9](?:[a-z0-9]|-)*',
    maxlength: 63,
    placeholder: 'luopan'
  })
  const directory = h('input', {
    class: 'qp-input',
    id: 'project-source',
    maxlength: 2000,
    placeholder: '/path/to/project'
  })
  const repo = h('input', {
    class: 'qp-input',
    id: 'project-repo',
    maxlength: 500,
    placeholder: 'https://example.com/team/project.git'
  })
  const branch = h('input', {
    class: 'qp-input',
    id: 'project-branch',
    maxlength: 200,
    placeholder: '例如 main 或 release/1.0'
  })
  const visibility = h(
    'select',
    { class: 'qp-select', id: 'project-visibility' },
    h('option', { value: 'private', text: '个人项目：仅创建者可见' }),
    h('option', { value: 'members', text: '团队项目：仅指定成员可见' })
  )
  const surface = h(
    'select',
    { class: 'qp-select', id: 'project-surfaces' },
    h('option', { value: 'both', text: 'Web 与桌面端' }),
    h('option', { value: 'web', text: 'Web' }),
    h('option', { value: 'electron', text: '桌面端' })
  )
  const form = h(
    'form',
    {
      class: 'rig-section',
      onsubmit: (event) => {
        event.preventDefault()
        const submit = event.submitter
        submit.disabled = true
        ctx.run(async () => {
          try {
            if (!directory.value.trim() && !repo.value.trim())
              throw new Error('请提供本机项目目录或 Git 地址')
            if (repo.value.trim() && !branch.value.trim())
              throw new Error('请同时提供需要测试的分支或引用')
            const { app } = await ctx.api('project-create', {
              visibility: visibility.value,
              slug: slug.value,
              displayName: displayName.value,
              sourceDirectory: directory.value || undefined,
              repoUrl: repo.value || undefined,
              defaultBranch: branch.value || undefined,
              surfaces: surface.value === 'both' ? ['web', 'electron'] : [surface.value]
            })
            ctx.state.projectSlug = app.slug
            ctx.state.projectTask = null
            await ctx.render()
          } finally {
            submit.disabled = false
          }
        })
      }
    },
    field('项目名称', displayName),
    field('项目标识', slug),
    field('项目可见范围', visibility),
    field('项目目录', directory),
    ctx.state.native &&
      button('选择目录', () =>
        ctx.run(async () => {
          const selected = await ctx.api('project-directory')
          if (selected.directory) directory.value = selected.directory
        })
      ),
    field('Git 地址（可选）', repo),
    field('Git 分支 / 引用', branch),
    note(
      '本机目录和 Git 地址可单独提供。建任务后，在桌面的测试实现页连接已有目录或拉取登记仓库；Web 当前可登记、审阅，尚未接入远程源码工位。'
    ),
    field('被测端', surface),
    h('button', {
      type: 'submit',
      class: 'qp-button qp-button--primary rig-inline-action',
      text: '保存项目'
    })
  )
  details.append(form)
  return details
}

async function save(ctx, mission, book, cases) {
  await ctx.api('task-cases-save', { id: mission.id, expectedRevision: book.revision, cases })
  ctx.state.caseEdit = null
  ctx.state.caseHistory = null
  await ctx.render()
}

function showEditor(ctx, edit) {
  ctx.state.caseEdit = edit
  // The old form remains visible while the shared renderer fetches data.
  // Disable it immediately so a quick keystroke cannot land in the previous draft.
  for (const control of document.querySelectorAll(
    '#test-case-editor input, #test-case-editor textarea, #test-case-editor select, #test-case-editor button'
  ))
    control.disabled = true
  ctx.run(async () => {
    await ctx.render()
    document.getElementById('case-title')?.focus()
  })
}

function caseEditor(ctx, mission, book) {
  const editing = ctx.state.caseEdit?.id === mission.id ? ctx.state.caseEdit : null
  const draft = editing?.value ?? emptyCase()
  if (!editing)
    ctx.state.caseEdit = { id: mission.id, revision: book.revision, originalId: null, value: draft }
  const session = ctx.state.caseEdit
  const form = h('form', {
    id: 'test-case-editor',
    class: 'rig-case-grid',
    onsubmit: (event) => {
      event.preventDefault()
      const submit = event.submitter
      submit.disabled = true
      ctx.run(async () => {
        try {
          if (session.revision !== book.revision)
            throw new Error('编辑期间用例已更新，请复制当前内容后刷新，核对差异再保存。')
          if (
            book.cases.some(
              (entry) => entry.caseId === draft.caseId && entry.caseId !== session.originalId
            )
          )
            throw new Error('该用例编号已存在，请使用列表中的“编辑”修改。')
          const cases = session.originalId
            ? book.cases.map((entry) => (entry.caseId === session.originalId ? draft : entry))
            : [...book.cases, draft]
          await save(ctx, mission, book, cases)
        } finally {
          submit.disabled = false
        }
      })
    }
  })
  for (const [key, label, multiline, max] of [
    ['caseId', '用例编号', false, 64],
    ['title', '用例名称', false, 300],
    ['preconditions', '前置条件', true, 4000],
    ['steps', '操作步骤', true, 8000],
    ['expected', '预期结果', true, 8000],
    ['requirementRef', '需求引用（可选）', false, 1000],
    ['specPath', '已有脚本路径（可选）', false, 500],
    ['suiteSlug', '已有套件标识（可选）', false, 80]
  ]) {
    const input = h(multiline ? 'textarea' : 'input', {
      class: multiline ? 'qp-textarea' : 'qp-input',
      id: `case-${key}`,
      rows: multiline ? 3 : null,
      maxlength: max,
      required: ['caseId', 'title'].includes(key),
      disabled: !ctx.canRun()
    })
    input.value = draft[key]
    input.oninput = () => {
      draft[key] = input.value
    }
    form.append(field(label, input))
  }
  const priority = h(
    'select',
    { class: 'qp-select', id: 'case-priority', disabled: !ctx.canRun() },
    ...['P0', 'P1', 'P2', 'P3'].map((value) => h('option', { value, text: value }))
  )
  priority.value = draft.priority
  priority.onchange = () => {
    draft.priority = priority.value
  }
  const platform = h(
    'select',
    { class: 'qp-select', id: 'case-platforms', disabled: !ctx.canRun() },
    h('option', { value: 'web', text: 'Web' }),
    h('option', { value: 'electron', text: '桌面端' }),
    h('option', { value: 'both', text: 'Web 与桌面端' })
  )
  platform.value = draft.platforms.length === 2 ? 'both' : draft.platforms[0]
  platform.onchange = () => {
    draft.platforms = platform.value === 'both' ? ['web', 'electron'] : [platform.value]
  }
  form.append(
    field('优先级', priority),
    field('适用平台', platform),
    h(
      'div',
      { class: 'qp-row rig-case-actions' },
      h('button', {
        class: 'qp-button qp-button--primary',
        type: 'submit',
        text: session.originalId ? '保存用例修订' : '添加用例',
        disabled: !ctx.canRun()
      }),
      button('清空编辑', () => {
        ctx.state.caseEdit = null
        ctx.render()
      })
    )
  )
  return section(
    session.originalId ? `编辑 ${session.originalId}` : '录入测试用例',
    note('可以先保存不完整的草稿；确认本次用例前需补齐操作步骤和预期结果。每次保存形成新版本。'),
    form
  )
}

function importPanel(ctx, mission, book) {
  const details = h(
    'details',
    { class: 'qp-panel rig-section' },
    h('summary', { text: '导入用户用例或选择项目用例' })
  )
  const input = h('textarea', {
    class: 'qp-textarea',
    id: 'case-import-json',
    rows: 6,
    'aria-label': '用例 JSON',
    placeholder:
      '[{"caseId":"LOGIN-001","title":"正常登录","steps":"输入有效账号并登录","expected":"进入首页"}]'
  })
  input.value = ctx.state.caseImport ?? ''
  input.oninput = () => {
    ctx.state.caseImport = input.value
  }
  const file = h('input', {
    type: 'file',
    accept: '.json,application/json',
    'aria-label': '选择用例 JSON 文件',
    disabled: !ctx.canRun()
  })
  file.onchange = () =>
    ctx.run(async () => {
      const selected = file.files[0]
      if (!selected) return
      if (selected.size > 1024 * 1024) throw new Error('用例文件不能超过 1 MB')
      input.value = await selected.text()
      ctx.state.caseImport = input.value
    })
  details.append(
    note('导入 JSON 数组，只追加新编号；重复编号会拒绝整批导入。已有用例请在列表中编辑。'),
    file,
    input,
    button(
      '导入为任务草稿',
      () =>
        ctx.run(async () => {
          const entries = JSON.parse(input.value)
          if (!Array.isArray(entries) || !entries.length)
            throw new Error('请输入非空的用例 JSON 数组')
          const merged = [...book.cases, ...entries.map((entry) => ({ ...entry, source: 'user' }))]
          await save(ctx, mission, book, merged)
          ctx.state.caseImport = ''
        }),
      { disabled: !ctx.canRun() }
    )
  )
  const catalog = h('div', { class: 'rig-section' })
  details.append(
    button('读取项目用例库', () =>
      ctx.run(async () => {
        const { cases } = await ctx.api('app-cases', { app: mission.workbench.appSlug })
        catalog.replaceChildren(
          note('选择后加入当前任务草稿。用例库未提供步骤或预期结果时，需补充后再确认。'),
          ...cases.map((entry) =>
            button(
              `${entry.caseId} · ${entry.title}`,
              () =>
                ctx.run(async () => {
                  await save(ctx, mission, book, [
                    ...book.cases,
                    {
                      ...emptyCase(),
                      caseId: entry.caseId,
                      title: entry.title,
                      priority: entry.priority || 'P1',
                      specPath: entry.specPath || '',
                      suiteSlug: entry.suiteSlug || '',
                      requirementRef: entry.requirementRef || '',
                      source: 'catalog'
                    }
                  ])
                }),
              {
                disabled: !ctx.canRun() || book.cases.some((value) => value.caseId === entry.caseId)
              }
            )
          )
        )
        if (!cases.length) catalog.append(note('项目用例库暂无用例。'))
      })
    ),
    catalog
  )
  return details
}

function agentDrafts(ctx, mission, book) {
  const latest = new Map(
    mission.caseDrafts
      .filter((entry) => entry.app === mission.workbench.appSlug)
      .map((entry) => [entry.caseId, entry])
  )
  return section(
    'Rig 提出的用例草稿',
    note('采纳只更新任务草稿，不确认用例，也不启动测试。相同编号会作为该用例的修订。'),
    ...[...latest.values()].map((entry) =>
      h(
        'details',
        { class: 'rig-case-draft' },
        h('summary', { text: `${entry.caseId} · ${entry.title}` }),
        note(entry.preconditions || '无前置条件'),
        entry.baseCaseRevision !== book.revision &&
          note(
            `此建议基于 v${entry.baseCaseRevision ?? '未知'}，当前为 v${book.revision}；请核对后再采纳。`
          ),
        h('pre', {
          class: 'qp-code-block',
          text: entry.steps
            .map((step) => `${step.action} ⇒ ${step.expect || '待补充预期结果'}`)
            .join('\n')
        }),
        button(
          book.cases.some((value) => value.caseId === entry.caseId)
            ? '载入修订供我审阅'
            : '载入草稿供我审阅',
          () => {
            const existing = book.cases.find((value) => value.caseId === entry.caseId)
            showEditor(ctx, {
              id: mission.id,
              revision: book.revision,
              originalId: existing?.caseId ?? null,
              value: {
                ...(existing ?? emptyCase()),
                caseId: entry.caseId,
                title: entry.title,
                preconditions: entry.preconditions || '',
                priority: entry.priority || 'P1',
                requirementRef: entry.requirementRef || '',
                steps: entry.steps.map((step) => step.action).join('\n'),
                expected: entry.steps
                  .map((step) => step.expect || '')
                  .filter(Boolean)
                  .join('\n'),
                source: 'agent'
              }
            })
          },
          { disabled: !ctx.canRun() }
        )
      )
    )
  )
}

function caseList(ctx, mission, book) {
  const list = section(
    '本次任务用例',
    button(
      book.confirmed ? `已确认 v${book.revision}` : `确认本次用例${book.revision ? ` v${book.revision}` : ''}`,
      () =>
        ctx.run(async () => {
          await ctx.api('task-cases-confirm', { id: mission.id, expectedRevision: book.revision })
          await ctx.render()
        }),
      { id: 'confirm-task-cases', disabled: !ctx.canRun() || !book.cases.length || book.confirmed }
    )
  )
  if (!book.cases.length)
    list.append(note('还没有用例。可在下方录入或导入，也可切到“对话”让 Rig 辅助起草。'))
  for (const entry of book.cases)
    list.append(
      h(
        'article',
        { class: 'rig-test-case', 'data-case-id': entry.caseId },
        h(
          'div',
          { class: 'qp-row qp-row--between' },
          h('strong', { text: `${entry.caseId} · ${entry.title}` }),
          h('span', {
            class: 'qp-tag',
            text: `${entry.priority} · ${entry.platforms.map((value) => (value === 'web' ? 'Web' : '桌面端')).join(' / ')}`
          })
        ),
        note(
          `来源：${{ user: '用户', agent: 'Rig 草稿', catalog: '项目用例库' }[entry.source]}${entry.steps.trim() && entry.expected.trim() ? '' : ' · 步骤或预期结果待补充'}`
        ),
        h('p', {
          class: 'rig-case-text',
          text: `步骤：${entry.steps || '待补充'}\n预期：${entry.expected || '待补充'}`
        }),
        h(
          'div',
          { class: 'qp-row' },
          button(
            '编辑',
            () => {
              showEditor(ctx, {
                id: mission.id,
                revision: book.revision,
                originalId: entry.caseId,
                value: structuredClone(entry)
              })
            },
            { disabled: !ctx.canRun(), 'aria-label': `编辑 ${entry.caseId}` }
          ),
          button(
            '移出本次范围',
            () =>
              ctx.run(() =>
                save(
                  ctx,
                  mission,
                  book,
                  book.cases.filter((value) => value.caseId !== entry.caseId)
                )
              ),
            { disabled: !ctx.canRun(), 'aria-label': `移出 ${entry.caseId}` }
          )
        )
      )
    )
  return list
}

async function projectAccessPanel(ctx, app, access) {
  const labels = {
    private: '仅创建者可见',
    members: '仅指定成员可见',
    'legacy-shared': '整个 Rig 服务共享（历史兼容）'
  }
  const panel = h(
    'details',
    { class: 'rig-project-form', id: 'project-access-panel' },
    h('summary', { text: `项目成员与访问 · ${labels[access.visibility]}` }),
    note(
      `所有者：${access.ownerId || '尚未指定'} · 权限版本 ${access.revision}。项目成员可查看项目执行报告；各人的对话任务仍单独保存。`
    )
  )
  if (!access.canManage) {
    panel.append(
      note(access.canWrite ? '你可以在这个项目中建立测试任务。' : '你在这个项目中只有查看权限。')
    )
    return panel
  }
  ctx.state.projectAccessEdits ??= {}
  const draft = ctx.state.projectAccessEdits[app.id] ?? {
    expectedRevision: access.revision,
    visibility: access.visibility,
    members: access.members.map(({ principalId, role }) => ({ principalId, role }))
  }
  const remember = () => {
    ctx.state.projectAccessEdits[app.id] = draft
  }
  const scope = h(
    'select',
    { class: 'qp-select', id: 'project-access-scope' },
    ...Object.entries(labels).map(([value, text]) => h('option', { value, text }))
  )
  scope.value = draft.visibility
  scope.onchange = () => {
    draft.visibility = scope.value
    remember()
  }
  const list = h('div', { id: 'project-access-members', class: 'rig-section' })
  const memberName = (id) => access.members.find((row) => row.principalId === id)?.displayName ?? id
  const renderMembers = () =>
    list.replaceChildren(
      ...draft.members.map((member) => {
        const role = h(
          'select',
          { class: 'qp-select', 'aria-label': `${memberName(member.principalId)} 的项目权限` },
          h('option', { value: 'viewer', text: '查看' }),
          h('option', { value: 'operator', text: '编辑与执行' }),
          h('option', { value: 'admin', text: '管理成员' })
        )
        role.value = member.role
        role.onchange = () => {
          member.role = role.value
          remember()
        }
        return h(
          'div',
          { class: 'rig-section', 'data-project-member': member.principalId },
          h('span', { class: 'qp-body-2', text: memberName(member.principalId) }),
          role,
          button('移除成员', () => {
            draft.members = draft.members.filter((row) => row !== member)
            remember()
            renderMembers()
          })
        )
      })
    )
  renderMembers()
  // Deployment administrators can pick existing accounts. Delegated project
  // managers do not receive the deployment's full member directory.
  let memberInput
  if (ctx.state.principal.role === 'admin') {
    const { members } = await ctx.api('members')
    memberInput = h(
      'select',
      { class: 'qp-select', id: 'project-member' },
      h('option', { value: '', text: '选择已有 Rig 成员' }),
      ...members
        .filter(
          (row) =>
            row.principalId !== access.ownerId && !row.local?.disabled && row.role !== 'disabled'
        )
        .map((row) =>
          h('option', {
            value: row.principalId,
            text: `${row.displayName || row.principalId}（${row.principalId}）`
          })
        )
    )
  } else
    memberInput = h('input', {
      class: 'qp-input',
      id: 'project-member',
      placeholder: '已有成员的主体 ID'
    })
  panel.append(
    field('项目可见范围', scope),
    note(
      '选择整个服务共享会让所有 Rig 成员看到项目和运行证据。改为个人项目之前，请先移除成员；已下载的内容不会被收回。'
    ),
    list,
    field('添加已有成员', memberInput),
    button(
      '添加到成员列表',
      () => {
        const id = memberInput.value.trim()
        if (!id || draft.members.some((row) => row.principalId === id)) return
        draft.members.push({ principalId: id, role: 'viewer' })
        draft.visibility = 'members'
        scope.value = 'members'
        remember()
        renderMembers()
      },
      { id: 'add-project-member' }
    ),
    note(
      '新增成员默认只能查看；编辑、执行和成员管理还受账号本身的权限限制。添加至列表后需要保存。'
    ),
    ...(access.revision !== draft.expectedRevision
      ? [
          note(
            `服务器已更新到权限版本 ${access.revision}，此草稿仍基于 ${draft.expectedRevision}。请核对后重新载入成员，保存不会覆盖他人的修改。`
          )
        ]
      : []),
    button(
      '保存成员与范围',
      () =>
        ctx.run(async () => {
          remember()
          await ctx.api('project-access-save', { app: app.slug, ...draft })
          delete ctx.state.projectAccessEdits[app.id]
          await ctx.render()
        }),
      { id: 'save-project-access' }
    ),
    button('重新载入成员', () => {
      delete ctx.state.projectAccessEdits[app.id]
      ctx.render()
    })
  )
  return panel
}
