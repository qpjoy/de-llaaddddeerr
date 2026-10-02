// The interactive terminal: a prompt, a mission per conversation, an approval
// line whenever the Agent wants to run or change something. And `exec`, the
// same thing with no one to ask — every write it was not told to allow is
// refused.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { totalTokens } from '../../packages/runtime/context.mjs'
import { detectProject } from '../../packages/runtime/project.mjs'
import { workspaceChanges } from '../../packages/runtime/terminal.mjs'
import {
  approvalChoices,
  approvalText,
  createRenderer,
  describeCall,
  palette,
  readChoice
} from './render.mjs'

const INTERRUPT = Symbol('interrupt')
const EDIT_TOOLS = new Set(['workspace_write', 'workspace_edit'])

/**
 * Lines from a TTY or a pipe, one at a time, whenever asked. readline's own
 * `question` drops lines that arrive before it is called, which is every
 * line of piped input; this keeps them.
 */
class LineReader {
  constructor(input, output, { historyFile = null } = {}) {
    this.output = output
    this.tty = Boolean(input.isTTY && output.isTTY)
    // Up-arrow history across sessions, on a TTY only; newest first, as readline keeps it.
    let history = []
    if (this.tty && historyFile)
      try {
        history = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).slice(0, 500)
      } catch {
        /* First session. */
      }
    this.rl = createInterface({ input, output, terminal: this.tty, history, historySize: 500 })
    if (this.tty && historyFile)
      this.rl.on('history', (entries) => {
        // Synchronous and small: the process may exit right after the last line.
        try {
          writeFileSync(historyFile, entries.join('\n'), { mode: 0o600 })
        } catch {
          /* History is a convenience. */
        }
      })
    this.queue = []
    this.waiting = null
    this.closed = false
    this.onInterrupt = null
    // A paste arrives as several lines in one burst; on a TTY they are one message.
    this.burst = []
    this.burstTimer = null
    this.rl.on('line', (line) => {
      if (!this.waiting) {
        this.queue.push(line)
        return
      }
      if (!this.tty) {
        // A pipe does not echo; show what was answered, as a TTY would.
        this.output.write(`${line}\n`)
        this.#settle(line)
        return
      }
      this.burst.push(line)
      clearTimeout(this.burstTimer)
      this.burstTimer = setTimeout(() => {
        const text = this.burst.join('\n')
        this.burst = []
        this.#settle(text)
      }, 25)
    })
    this.rl.on('close', () => {
      this.closed = true
      this.#settle(null)
    })
    this.rl.on('SIGINT', () => {
      if (this.waiting) this.#settle(INTERRUPT)
      else this.onInterrupt?.()
    })
  }
  #settle(value) {
    if (!this.waiting) return
    const resolve = this.waiting
    this.waiting = null
    resolve(value)
  }
  next(prompt) {
    if (this.queue.length) {
      const line = this.queue.shift()
      if (!this.tty) this.output.write(`${prompt}${line}\n`)
      return Promise.resolve(line)
    }
    if (this.closed) return Promise.resolve(null)
    this.rl.setPrompt(prompt)
    this.rl.prompt()
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
  close() {
    this.rl.close()
  }
}

const HELP = `命令：
  /help                 这份说明
  /status               服务、账号、工作区、可用工具
  /new                  下一句话开始一项新任务（否则接着当前任务聊）
  /history              这个项目最近的终端任务；/resume <序号> 接着其中一项继续（启动时 mx-rig -c 接着最近一项）
  /sandbox [on|off]     命令沙箱：开时命令只能写工作区、临时目录和工具缓存
  /cases                当前任务起草的用例；/cases import [序号,…] 加入用例目录
  /export [路径]        把当前任务的浏览器步骤导出为 Playwright 测试草稿，写进工作区
  /replay               把当前任务的浏览器步骤做成回放（光标移动、点击、断言），在浏览器里自动播放
  /capture <标题>       把当前任务的浏览器步骤固化为试验规程草稿
  /procedures           试验规程列表
  /fire <规程编号|all>   在本机试车
  /repair <规程编号>     把失败的规程交给规程维护员，修正经重放验证后由你决定是否批准
  /runs                 最近的测试执行
  /exit                 退出
Ctrl-C：任务进行中时取消任务；等待确认时等于「不执行」；空闲时连按两次退出。`

export function banner(session, { principal, server, project, c }) {
  const status = session.status()
  const lines = [
    c.bold(`MX Rig · ${status.agent?.displayName ?? '终端 Agent（未启用测试工程师，使用全部允许的工具）'}`),
    c.dim(`服务 ${server} · ${principal.displayName ?? principal.id}（${principal.role}）`),
    c.dim(
      `工作区 ${status.workspace} · ${project.rigFile ? 'RIG.md ✓' : '没有 RIG.md（mx-rig init 生成）'}${
        project.stacks.length ? ` · ${project.stacks.map((stack) => stack.name).join('、')}` : ''
      }`
    )
  ]
  lines.push(
    status.sandbox.on
      ? c.dim(`命令沙箱：开（${status.sandbox.reason}；/sandbox off 关闭）`)
      : c.yellow(`命令沙箱：关（${status.sandbox.reason}）——确认过的命令能写你的账号能写的任何地方`)
  )
  if (!status.model?.configured) lines.push(c.red('模型未配置：请管理员在 Agent 中心配置 Provider。'))
  if (status.missing.length)
    lines.push(
      c.yellow(
        `未被 Internal 允许的工具：${status.missing.join('、')}。需要时请管理员在「工具与边界」里允许；每次使用仍会逐条确认。`
      )
    )
  lines.push(c.dim('直接说要做什么；/help 查看命令，Ctrl-C 取消。'), '')
  return lines.join('\n')
}

async function slash(line, { session, reader, write, c, render, decide }) {
  const [command, ...rest] = line.slice(1).trim().split(/\s+/)
  const arg = rest.join(' ').trim()
  switch (command) {
    case 'help':
      return write(`${HELP}\n`)
    case 'sandbox': {
      if (arg === 'on' || arg === 'off') await session.setSandbox(arg === 'on' ? 'auto' : 'off')
      const { sandbox } = session.status()
      return write(
        sandbox.on ? c.green(`命令沙箱：开（${sandbox.reason}）\n`) : c.yellow(`命令沙箱：关（${sandbox.reason}）\n`)
      )
    }
    case 'history': {
      const rows = session.recent()
      if (!rows.length) return write(c.dim('这个项目还没有终端任务。\n'))
      rows.forEach((row, index) =>
        write(
          `${index + 1}. ${row.id === session.missionId ? c.cyan('●') : ' '} ${row.goal.split('\n')[0].slice(0, 60)}  ${c.dim(`${row.status} · ${new Date(row.createdAt).toLocaleString()}`)}\n`
        )
      )
      return
    }
    case 'resume': {
      const row = session.recent()[Number(arg) - 1]
      if (!row) return write(c.yellow('用法：/resume <序号>，序号见 /history\n'))
      session.resume(row.id)
      return write(c.dim(`下一句话接着「${row.goal.split('\n')[0].slice(0, 60)}」继续。\n`))
    }
    case 'new':
      session.reset()
      return write(c.dim('下一句话将开始一项新任务。\n'))
    case 'status': {
      await session.refresh()
      const status = session.status()
      write(
        [
          `Agent：${status.agent?.displayName ?? '未指定'}`,
          `工作区：${status.workspace}`,
          `当前任务：${status.mission ?? '无'}`,
          `模型：${status.model?.configured ? status.model.name : '未配置'}`,
          `命令沙箱：${status.sandbox.on ? '开' : '关'}（${status.sandbox.reason}）`,
          `可用工具：${status.tools.join('、') || '无'}`,
          `未被允许：${status.missing.join('、') || '无'}`,
          `浏览器站点：${siteLine(status)}`,
          ''
        ].join('\n')
      )
      return
    }
    case 'cases': {
      if (rest[0] === 'import') {
        const pick = rest[1]
          ? rest[1]
              .split(/[,，]/)
              .map(Number)
              .filter((value) => Number.isInteger(value) && value > 0)
          : null
        const { results } = await session.importDrafts(pick)
        for (const entry of results)
          write(entry.ok ? c.green(`✓ ${entry.caseId} 已加入用例目录\n`) : c.red(`✗ ${entry.caseId}：${entry.error}\n`))
        return
      }
      const drafts = session.drafts()
      if (!drafts.length) return write(c.dim('当前任务没有起草用例。\n'))
      drafts.forEach((draft, index) =>
        write(`${index + 1}. ${draft.caseId} [${draft.priority}] ${draft.title}（${draft.steps.length} 步）\n`)
      )
      return write(c.dim('/cases import 全部加入，/cases import 1,3 只加入选中的。\n'))
    }
    case 'export': {
      const spec = await session.exportSpec()
      if (!spec.steps) return write(c.yellow('当前任务没有可导出的浏览器步骤。\n'))
      const project = await detectProject(session.workspace.root)
      const target = arg || (project.testDirs[0] ? `${project.testDirs[0]}/${spec.filename}` : spec.filename)
      if (existsSync(join(session.workspace.root, target))) {
        const answer = await reader.next(c.yellow(`${target} 已存在，覆盖？[y/N] › `))
        if (readChoice(answer, {}) !== 'yes') return write(c.dim('没有写入。\n'))
      }
      await session.workspace.write({ path: target, content: spec.content, mode: 'overwrite' })
      write(c.green(`已写入 ${target}（${spec.steps} 步）\n`))
      for (const warning of spec.warnings ?? []) write(c.yellow(`  ! ${warning}\n`))
      return
    }
    case 'replay': {
      const { path, frames } = await session.replay()
      write(c.green(`回放已生成（${frames} 步）：${path}\n`))
      if (!process.env.MX_RIG_NO_OPEN) openFile(path)
      return
    }
    case 'capture': {
      if (!arg) return write(c.yellow('用法：/capture <规程标题>\n'))
      const { procedure, warnings } = await session.capture({ title: arg })
      write(c.green(`已固化为规程草稿 ${procedure.id}「${procedure.title}」（${procedure.steps.length} 步）\n`))
      for (const warning of warnings ?? []) write(c.yellow(`  ! ${warning}\n`))
      return write(c.dim(`/fire ${procedure.id} 试车；通过后在网页或桌面端启用。\n`))
    }
    case 'procedures': {
      const { procedures } = await session.client.request('/api/rig/v1/procedures')
      if (!procedures.length) return write(c.dim('还没有规程。\n'))
      for (const entry of procedures)
        write(
          `${entry.id}  ${entry.title}  ${c.dim(`${entry.status} · 第 ${entry.revision} 版${entry.lastRun ? ` · 最近 ${entry.lastRun.verdict}` : ''}`)}\n`
        )
      return
    }
    case 'fire': {
      if (!arg) return write(c.yellow('用法：/fire <规程编号> 或 /fire all\n'))
      if (arg === 'all') {
        const { results, passed, total } = await session.fireAll()
        for (const entry of results)
          write(`${entry.verdict === 'passed' ? c.green('✓') : c.red('✗')} ${entry.title}${entry.failedStep !== null && entry.failedStep !== undefined ? c.dim(` —— 第 ${entry.failedStep + 1} 步`) : ''}\n`)
        return write(`${passed}/${total} 通过\n`)
      }
      const { run } = await session.fire(arg)
      if (run.verdict === 'passed') return write(c.green(`✓ 通过（${run.durationMs} 毫秒）\n`))
      write(c.red(`✗ ${run.verdict}：第 ${run.failedStep + 1} 步 ${run.failure?.message ?? ''}\n`))
      if (run.repairable) write(c.dim(`/repair ${arg} 交给规程维护员提出修正。\n`))
      return
    }
    case 'repair': {
      if (!arg) return write(c.yellow('用法：/repair <规程编号>\n'))
      write(c.dim('重放到失败的那一步之前，交给规程维护员……\n'))
      const { mission, proposal } = await session.repair(arg, { onEvent: render, decide })
      if (!proposal)
        return write(c.yellow(`规程维护员没有提交判断（任务${mission.status === 'completed' ? '已结束' : `：${mission.status}`}）。\n`))
      if (!proposal.steps) return write(`判断：${proposal.verdict}——${proposal.rationale}\n规程没有改动。\n`)
      const proven = proposal.validation?.verdict === 'passed'
      write(
        `${proven ? c.green('修正已通过验证试车') : c.red(`修正没有通过验证试车（${proposal.validation?.verdict ?? '未验证'}）`)}：${proposal.rationale}\n`
      )
      if (!proven) return write(c.dim('未经证明的修正不能批准；可以在网页或桌面端查看详情。\n'))
      const answer = await reader.next(c.bold('批准这个修正、生成新版本？[y/N] › '))
      if (readChoice(answer, {}) !== 'yes') return write(c.dim('没有批准；修正留在待审列表里。\n'))
      const { procedure } = await session.decideProposal(arg, proposal.id, true)
      return write(c.green(`已批准：「${procedure.title}」现在是第 ${procedure.revision} 版。\n`))
    }
    case 'runs': {
      const { runs } = await session.client.request('/api/v1/runs?limit=10')
      for (const run of runs) write(`${run.id}  ${run.status}  ${c.dim(run.finishedAt ?? run.createdAt ?? '')}\n`)
      return
    }
    default:
      return write(c.yellow(`没有 /${command}；/help 查看命令。\n`))
  }
}

/** Hand a file to the system's default app — the browser, for a replay. */
function openFile(path) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [path]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', path]]
        : ['xdg-open', [path]]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
  } catch {
    /* The path is printed; opening it is a convenience. */
  }
}

/**
 * The interactive loop. Returns when the person leaves; the caller closes
 * the session.
 */
export async function repl({
  session,
  input = process.stdin,
  output = process.stdout,
  first = '',
  header = '',
  historyFile = null
}) {
  const c = palette(output)
  const write = (text) => output.write(text)
  const reader = new LineReader(input, output, { historyFile })
  const render = createRenderer({ write, c })
  let running = false
  let lastInterrupt = 0
  reader.onInterrupt = () => {
    if (running) {
      write(c.yellow('\n■ 正在取消……\n'))
      session.cancel().catch(() => {})
    }
  }
  if (header) write(header)
  const decide = async (request) => {
    if (request.takeover) {
      // The browser window is the person's until they come back here.
      write(
        `\n${c.bold(c.yellow(`✋ ${request.title}`))}${request.reason ? `：${request.reason}` : ''}\n${c.dim(
          '  在浏览器窗口里完成后回到这里：直接回车交还；写一句话再回车，Agent 会收到这句话；输入 q 结束这一段。你在浏览器里输入的内容不会记录，也不会给 Agent。'
        )}\n`
      )
      const answer = await reader.next('  交还 › ')
      if (answer === INTERRUPT || answer === null) return 'no'
      const text = answer.trim()
      if (text === 'q' || text === 'Q') return 'no'
      return { answer: 'yes', note: text || null }
    }
    write(`${approvalText(request, c)}\n`)
    const answer = await reader.next(approvalChoices(request))
    if (answer === INTERRUPT || answer === null) return 'no'
    return readChoice(answer, request)
  }
  let pending = first
  try {
    for (;;) {
      const line = pending || (await reader.next(c.bold('› ')))
      pending = ''
      if (line === null) break
      if (line === INTERRUPT) {
        if (Date.now() - lastInterrupt < 2000) break
        lastInterrupt = Date.now()
        write(c.dim('（再按一次 Ctrl-C 退出，或输入 /exit）\n'))
        continue
      }
      const text = line.trim()
      if (!text) continue
      if (text === '/exit' || text === '/quit') break
      try {
        running = true
        if (text.startsWith('/')) await slash(text, { session, reader, write, c, render, decide })
        else {
          const row = await session.ask(text, { onEvent: render, decide })
          const changed = workspaceChanges(row, { since: session.lastAskFrom ?? 0 })
          if (changed.files.length)
            write(
              `${c.bold(`改动 ${changed.files.length} 个文件`)} ${c.green(`+${changed.added}`)} ${c.red(`−${changed.removed}`)}  ${c.dim(
                changed.files.map((entry) => `${entry.path}${entry.created ? '（新建）' : ''}`).join('、')
              )}\n`
            )
          const tokens = totalTokens(row)
          if (tokens)
            write(
              c.dim(`（本任务累计${row.usage?.estimated ? '约 ' : ' '}${tokens.toLocaleString()} tokens · ${row.usage?.calls ?? 0} 次模型调用）\n`)
            )
          if (row.status === 'blocked') write(c.dim('（任务受阻；可以补充说明后继续，或 /new 重新开始）\n'))
          if (row.status === 'cancelled') write(c.dim('（已停下；说下一步怎么做，Agent 会接着这项任务继续）\n'))
        }
      } catch (error) {
        write(c.red(`✗ ${error.message}\n`))
      } finally {
        running = false
      }
      write('\n')
    }
  } finally {
    reader.close()
  }
}

/**
 * One goal, no one to ask. Progress goes to stderr, the answer to stdout.
 *
 * @returns {Promise<number>} exit code: 0 answered, 1 blocked or failed,
 *   2 stopped because an action needed a confirmation it was not given
 */
export async function execOnce({
  session,
  goal,
  json = false,
  allowCommands = [],
  allowEdits = false,
  stdout = process.stdout,
  stderr = process.stderr
}) {
  const c = palette(stderr)
  const render = createRenderer({ write: (text) => stderr.write(text), c })
  const allowed = new Set(allowCommands)
  let refused = null
  const decide = async (request) => {
    if (request.takeover) {
      refused = request
      stderr.write(c.yellow(`✗ Agent 请人来操作浏览器（${request.reason ?? '人工接管'}），非交互模式下没有人可以接手\n`))
      return 'no'
    }
    if (request.tool === 'workspace_run' && allowed.has(request.args.command)) return 'yes'
    if (EDIT_TOOLS.has(request.tool) && allowEdits) return 'yes'
    refused = request
    stderr.write(
      c.yellow(
        `✗ 需要确认的动作没有执行：${describeCall(request.tool, request.args)}（非交互模式；可用 --allow-command "<命令>" 或 --allow-edits 事先允许）\n`
      )
    )
    return 'no'
  }
  const row = await session.ask(goal, {
    onEvent: (payload) => {
      if (payload.kind === 'delta' || payload.event?.kind === 'answer') return
      render(payload)
    },
    decide
  })
  if (json) stdout.write(`${JSON.stringify(row, null, 2)}\n`)
  else if (row.result) stdout.write(`${row.result}\n`)
  if (row.status === 'completed') return 0
  if (refused && row.status === 'cancelled') return 2
  return 1
}

/** Where the browser may go, in one line for `/status`. */
export function siteLine(status) {
  const listed = status.browserOrigins.join('、')
  if (status.browserSites === 'list') return listed ? `只允许 ${listed}` : '管理员设置为只允许列表内的站点，但列表是空的'
  return listed ? `预先允许 ${listed}；其他站点第一次打开时问你` : '任何站点第一次打开时问你（生产环境禁区除外）'
}
