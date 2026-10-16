import { h } from './views.js'
const note = (text) => h('p', { class: 'qp-caption qp-muted', text })
const button = (text, onclick, props = {}) =>
  h('button', {
    type: 'button',
    class: 'qp-button qp-button--outline qp-button--sm',
    text,
    onclick,
    ...props
  })
const section = (title, ...children) =>
  h(
    'section',
    { class: 'qp-panel rig-section' },
    h('h2', { class: 'qp-heading-2', text: title }),
    ...children
  )
const editable = (proposal) =>
  Object.fromEntries(
    ['summary', 'engine', 'platform', 'files', 'mappings'].map((key) => [key, proposal[key]])
  )

export async function testImplementation(ctx, mount, mission, book) {
  const data = await ctx.api('task-implementation', { id: mission.id })
  const current = data.proposal
  const state = ctx.state
  if (state.implementation?.id !== mission.id)
    state.implementation = { id: mission.id, edit: null, historical: null, exported: null }
  const session = state.implementation
  if (session.historical?.proposal?.version === data.version) session.historical = null
  const source = state.native ? await ctx.api('source-status', { id: mission.id }) : null
  const connecting = Boolean(source?.busy || session.connecting)
  const sourceAction = (action) =>
    ctx.run(async () => {
      session.connecting = true
      const operation = ctx.api(action, { id: mission.id })
      // Observe rejections immediately while the source panel is rendering.
      const settled = operation.then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      try {
        await ctx.render()
        const result = await settled
        if (result.error) throw result.error
      } finally {
        session.connecting = false
        await ctx.render()
      }
    })
  const baseline = source?.baseline ?? (!state.native ? mission.sourceBaseline : null)
  const sourcePanel = section(
    '源码与测试工作区',
    note(
      source?.directory
        ? `本机已连接（只读）：${source.directory}`
        : '尚未连接本机源码。登记项目目录不代表已经读取，Web 服务不会读取服务器上的同名路径。'
    ),
    note(
      '读取的源码会进入当前模型对话；凭据文件受保护。批准的测试文件保存到 Rig 自己的 QA 目录，被测项目不变。'
    )
  )
  if (baseline)
    sourcePanel.append(
      note(
        `${state.native ? '当前源码基准' : '桌面最后记录的基准（不代表当前连接）'}：${baseline.kind === 'git' ? 'Rig 托管检出' : '本机目录'}`
      ),
      h('p', {
        class: 'rig-case-text',
        id: 'source-baseline-status',
        text: baseline.commit
          ? `提交：${baseline.commit}\n${baseline.branch || '分离 HEAD'} · ${baseline.dirty ? '存在未提交改动' : '未发现本目录的未提交改动'}`
          : '未获取 Git 提交（非仓库、空仓库或 Git 不可用）；仍会记录读取文件的哈希。'
      }),
      note(
        `采集于 ${baseline.capturedAt}。Git 状态不含忽略文件和子模块内部；源码基准不代表线上部署版本。`
      )
    )
  if (connecting) sourcePanel.append(note('正在连接源码；拉取最长约两分钟，完成前请稍候。'))
  if (state.native)
    sourcePanel.append(
      ...[
        button(
          source?.directory ? '更换只读源码目录' : '连接本机源码（只读）',
          () =>
            ctx.run(async () => {
              await ctx.api('source-connect', { id: mission.id })
              await ctx.render()
            }),
          { disabled: !ctx.canRun() || connecting }
        ),
        mission.workbench.repoUrl &&
          button('拉取任务登记的 Git 仓库', () => sourceAction('source-git-connect'), {
            id: 'connect-source-git',
            disabled: !ctx.canRun() || connecting
          }),
        source?.directory &&
          button(
            source.baseline?.kind === 'git' ? '重新拉取并更新源码基准' : '重新采集源码基准',
            () => sourceAction('source-refresh'),
            { id: 'refresh-source-baseline', disabled: !ctx.canRun() || connecting }
          ),
        connecting &&
          button(
            '取消源码连接',
            () =>
              ctx.run(async () => {
                await ctx.api('source-cancel', { id: mission.id })
                await ctx.render()
              }),
            { id: 'cancel-source-connection' }
          ),
        source?.directory &&
          button(
            '断开源码',
            () =>
              ctx.run(async () => {
                await ctx.api('source-disconnect', { id: mission.id })
                await ctx.render()
              }),
            { disabled: connecting }
          )
      ].filter(Boolean)
    )
  else
    sourcePanel.append(
      note('请在创建该任务的桌面端连接本机源码；Web 可以提交、编辑和审阅代码提案。')
    )
  if (mission.workbench.repoUrl)
    sourcePanel.append(
      note(
        `任务登记仓库：${mission.workbench.repoUrl} · ${mission.workbench.ref || '未指定分支'}。在桌面按此地址拉取；刷新页面不会自动拉取。`
      )
    )
  mount.append(sourcePanel)
  const actions = section(
    '测试实现提案',
    note(
      `依据当前用例 v${book.revision}；${book.confirmed ? '已确认' : '请先确认用例再起草实现'}。提案和文件保存都不会自动执行测试。`
    ),
    button(
      '让 Rig 起草测试实现',
      () => {
        state.draft = `请为本任务已确认的用例 v${book.revision} 起草测试实现。先读取已有提案；如果本机已连接源码，核实已有测试和页面实现，说明复用依据。通过 implementation_draft 提交代码和用例断言映射，缺信息先向我确认。`
        state.testTab = 'conversation'
        ctx.render()
      },
      { disabled: !ctx.canRun() || !book.confirmed || connecting }
    ),
    button('刷新提案', () => ctx.render()),
    button(
      current ? '修改当前提案' : '提供测试代码',
      () => {
        const proposal = current
          ? editable(current)
          : {
              summary: '本次测试实现',
              engine: 'playwright',
              platform: 'web',
              files: [{ path: 'tests/acceptance.spec.ts', content: '' }],
              mappings: []
            }
        session.edit = {
          version: data.version,
          caseRevision: book.revision,
          sourceBaseline: current?.sourceBaseline ?? null,
          value: JSON.stringify(proposal, null, 2)
        }
        ctx.render()
      },
      { disabled: !ctx.canRun() || !book.confirmed, id: 'provide-implementation' }
    )
  )
  if (!current)
    actions.append(note('尚无代码提案。可以让 Rig 根据需求生成，也可以提供已有测试代码。'))
  mount.append(actions)
  if (session.edit) {
    const edit = session.edit
    const input = h('textarea', {
      class: 'qp-textarea rig-implementation-editor',
      id: 'implementation-json',
      rows: 18,
      'aria-label': '测试实现 JSON',
      spellcheck: 'false'
    })
    input.value = edit.value
    input.oninput = () => {
      edit.value = input.value
    }
    mount.append(
      section(
        '修改测试实现',
        note(
          `保存为用例 v${edit.caseRevision} 对应的新实现版本，之前的批准不会自动沿用。JSON 包含 summary、engine、platform、files 和 mappings；源码写在 files[].content，预期断言写在 mappings[].assertion。`
        ),
        input,
        button(
          '保存实现草稿',
          () =>
            ctx.run(async () => {
              let proposal
              try {
                proposal = JSON.parse(edit.value)
              } catch {
                throw new Error('请提供合法的 JSON')
              }
              await ctx.api('task-implementation-save', {
                id: mission.id,
                expectedVersion: edit.version,
                caseRevision: edit.caseRevision,
                sourceBaseline: edit.sourceBaseline,
                proposal
              })
              session.edit = null
              session.historical = null
              await ctx.render()
            }),
          { disabled: !ctx.canRun(), id: 'save-implementation' }
        ),
        button('放弃本次编辑', () => {
          session.edit = null
          ctx.render()
        })
      )
    )
  }
  const shown = session.historical
    ? {
        ...session.historical,
        stale: session.historical.proposal.caseRevision !== book.revision || !book.confirmed
      }
    : data
  const proposal = shown.proposal
  if (proposal) {
    const old = proposal.version !== data.version
    const review = section(
      `实现 r${proposal.version} · 用例 v${proposal.caseRevision}`,
      note(
        `${proposal.engine} · ${proposal.platform} · ${proposal.reviewedAt ? '已批准' : '待审阅'}${old ? ' · 历史版本' : ''}${shown.stale ? ' · 用例版本已变化，需要重新核对' : ''}`
      ),
      h('p', { class: 'qp-body-2', text: proposal.summary }),
      note(
        `与${shown.baseVersion ? `已批准 r${shown.baseVersion}` : '空版本'}比较；差异最多显示 120 行，文件内可查看完整源码。`
      ),
      ...proposal.mappings.map((entry) =>
        h('p', {
          class: 'rig-case-text',
          text: `${entry.caseId} → ${entry.path}\n断言：${entry.assertion}`
        })
      ),
      shown.missingCaseIds.length
        ? note(`当前本平台尚未映射：${shown.missingCaseIds.join('、')}。批准本提案不代表全量覆盖。`)
        : note('本平台用例均有映射；映射声明仍需人工核对源码，尚不代表断言已执行。')
    )
    if (proposal.sourceBaseline) {
      review.append(
        note(
          `提案来源：${proposal.sourceBaseline.kind === 'git' ? '托管 Git' : '本机目录'} · ${proposal.sourceBaseline.commit || '未记录 Git 提交'} · ${proposal.sourceBaseline.observations.length} 次读取记录。${proposal.sourceBaseline.dirty ? '当时存在未提交改动。' : ''}`
        )
      )
      if (source?.baseline && source.baseline.id !== proposal.sourceBaseline.id)
        review.append(note('当前连接采用了新的源码基准；本提案保留原分析记录，请核对后再使用。'))
    }
    for (const file of shown.diffs)
      review.append(
        h(
          'details',
          { class: 'rig-project-form' },
          h('summary', { text: `差异 · ${file.path}` }),
          h('pre', { class: 'qp-code-block', text: file.diff })
        )
      )
    for (const file of proposal.files)
      review.append(
        h(
          'details',
          { class: 'rig-project-form' },
          h('summary', { text: `完整源码 · ${file.path}` }),
          h('pre', { class: 'qp-code-block', text: file.content })
        )
      )
    if (!old)
      review.append(
        button(
          '批准此实现版本',
          () =>
            ctx.run(async () => {
              if (session.edit) throw new Error('请先保存或放弃正在编辑的草稿，再批准已展示的版本')
              await ctx.api('task-implementation-approve', {
                id: mission.id,
                expectedVersion: data.version,
                hash: proposal.hash
              })
              await ctx.render()
            }),
          {
            id: 'approve-implementation',
            disabled:
              !ctx.canRun() || shown.stale || Boolean(proposal.reviewedAt) || Boolean(session.edit)
          }
        )
      )
    review.append(
      button(
        '以此版本建立新修订',
        () => {
          session.edit = {
            version: data.version,
            caseRevision: book.revision,
            sourceBaseline: proposal.sourceBaseline ?? null,
            value: JSON.stringify(editable(proposal), null, 2)
          }
          ctx.render()
        },
        { disabled: !ctx.canRun() || !book.confirmed }
      )
    )
    if (state.native && !old && proposal.reviewedAt && !shown.stale)
      review.append(
        button(
          '写入本机测试仓库并执行',
          () => {
            // docs/23: the approved implementation goes into the project's test
            // repository, and is run from 执行与结果.
            ctx.state.testTab = 'execution'
            ctx.render()
          },
          { id: 'export-implementation', disabled: !ctx.canRun() || Boolean(session.edit) }
        )
      )
    mount.append(review)
  }
  if (data.history.length)
    mount.append(
      section(
        '实现版本历史',
        ...data.history
          .slice()
          .reverse()
          .map((entry) =>
            button(
              `r${entry.version} · 用例 v${entry.caseRevision} · ${entry.reviewedAt ? '已批准' : '草稿'}`,
              () =>
                ctx.run(async () => {
                  session.historical = await ctx.api('task-implementation', {
                    id: mission.id,
                    revision: entry.version
                  })
                  await ctx.render()
                })
            )
          ),
        button('回到最新实现', () => {
          session.historical = null
          ctx.render()
        })
      )
    )
}
