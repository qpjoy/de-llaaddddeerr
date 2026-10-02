// How a mission reads in a terminal: one line per step, the answer as text,
// every approval with the exact command or diff. Colour only on a TTY.

export function palette(stream = process.stdout, env = process.env) {
  const on = Boolean(stream.isTTY) && !env.NO_COLOR
  const wrap = (open, close) => (text) => (on ? `\u001b[${open}m${text}\u001b[${close}m` : String(text))
  return {
    on,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39)
  }
}

const clip = (text, max = 120) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A call in one line: `workspace_read src/app.ts:120` rather than JSON. */
export function describeCall(name, args) {
  const a = args ?? {}
  switch (name) {
    case 'workspace_list':
      return `列出 ${a.path ?? '.'}`
    case 'workspace_read':
      return `读取 ${a.path}${a.fromLine ? `:${a.fromLine}` : ''}`
    case 'workspace_search':
      return `搜索 /${a.pattern}/${a.glob ? ` ${a.glob}` : ''}${a.path && a.path !== '.' ? ` 于 ${a.path}` : ''}`
    case 'workspace_run':
      return `$ ${clip(a.command, 100)}`
    case 'workspace_write':
      return `${a.mode === 'append' ? '追加' : a.mode === 'overwrite' ? '覆盖' : '新建'} ${a.path}`
    case 'workspace_edit':
      return `修改 ${a.path}`
    case 'browser_open':
      return `打开 ${a.url}`
    case 'browser_click':
      return `点击 ${a.ref ?? a.name ?? ''}`
    case 'browser_fill':
      return `填写 ${a.ref ?? a.label ?? ''}`
    case 'browser_assert':
      return `断言 ${a.kind}${a.expected ? ` ${clip(a.expected, 60)}` : ''}`
    default: {
      const shown = Object.entries(a)
        .map(([key, value]) => `${key}=${clip(value, 40)}`)
        .join(' ')
      return `${name}${shown ? ` ${shown}` : ''}`
    }
  }
}

/** What came back, in a line or a few. */
export function describeResult(name, result, c) {
  if (!result || typeof result !== 'object') return ''
  if (result.error) return c.yellow(`未完成：${result.error.message ?? result.error.code}`)
  if (result.truncated && result.excerpt) return c.dim('（结果较长，已截断）')
  switch (name) {
    case 'workspace_list':
      return c.dim(`${result.entries?.length ?? 0} 项${result.truncated ? '（已截断）' : ''}`)
    case 'workspace_read':
      return c.dim(`第 ${result.fromLine}–${result.toLine} 行，共 ${result.totalLines} 行`)
    case 'workspace_search':
      return c.dim(`${result.matches?.length ?? 0} 处${result.truncated ? '以上' : ''}`)
    case 'workspace_run': {
      const ok = result.exitCode === 0 && !result.timedOut
      const head = result.timedOut
        ? c.red(`超时（${Math.round(result.durationMs / 1000)} 秒）`)
        : ok
          ? c.green(`退出码 0 · ${(result.durationMs / 1000).toFixed(1)} 秒`)
          : c.red(`退出码 ${result.exitCode ?? result.signal} · ${(result.durationMs / 1000).toFixed(1)} 秒`)
      const tail = String(result.output ?? '')
        .split('\n')
        .filter((entry) => entry.trim())
        .slice(-6)
        .map((line) => c.dim(`    ${clip(line, 160)}`))
      return [head, ...tail].join('\n')
    }
    case 'workspace_write':
      return c.dim(`${result.created ? '已新建' : '已写入'} ${result.path}（${result.bytes} 字节）`)
    case 'workspace_edit':
      return c.dim(`已修改 ${result.path}（${result.replaced} 处）`)
    case 'tests_run':
      return c.dim(`已派发 ${result.run?.id ?? ''}（派发不等于通过）`)
    case 'tests_result':
    case 'tests_wait':
      return c.dim(`${result.run?.id ?? ''} ${result.run?.status ?? ''}${result.wait?.timedOut ? '（仍在进行）' : ''}`)
    default:
      if (result.title || result.url) return c.dim(clip(`${result.title ?? ''} ${result.url ?? ''}`, 120))
      return ''
  }
}

/**
 * The renderer a session calls back. `write` gets whole lines (or the
 * streaming text as it comes); nothing here reads input.
 */
export function createRenderer({ write, c }) {
  let tool = null
  let midLine = false
  // Whether the model's own words are being printed: they get a blank line
  // before them, apart from the step lines.
  let speaking = false
  const line = (text) => {
    if (midLine) write('\n')
    midLine = false
    speaking = false
    write(`${text}\n`)
  }
  return (payload) => {
    if (payload.kind === 'delta') {
      if (!speaking) write(midLine ? '\n\n' : '\n')
      speaking = true
      write(payload.text)
      midLine = !payload.text.endsWith('\n')
      return
    }
    if (payload.kind === 'note') return line(c.dim(`  ${payload.text}`))
    if (payload.kind === 'auto') return line(c.dim(`  ✓ ${describeCall(payload.call.name, payload.call.args)}（${payload.reason}）`))
    const { event } = payload
    switch (event.kind) {
      case 'user':
      case 'approval':
      case 'approved':
        return
      case 'thinking':
        if (/压缩/.test(event.message)) line(c.dim(`  ${event.message}`))
        return
      case 'tool_start':
        tool = payload.call?.name ?? event.data?.tool
        return line(`${c.cyan('●')} ${describeCall(tool, payload.call?.args)}`)
      case 'tool_result': {
        const text = describeResult(tool, event.data?.result, c)
        if (text) line(text.replace(/^/gm, '  '))
        // What the page did by itself: a dialog, a download, a new tab, a
        // navigation stopped at the edge of this mission's sites.
        if (event.data?.result?.notice) line(c.yellow(`  ↳ ${event.data.result.notice}`))
        return
      }
      case 'tool_error':
        return line(c.yellow(`  ↳ ${event.message}`))
      case 'assertion':
        return line(event.data?.assertion?.passed ? c.green(`  ✓ ${event.message}`) : c.red(`  ✗ ${event.message}`))
      case 'case_draft':
        return line(c.magenta(`  ✎ ${event.message}（/cases 查看，/cases import 加入用例目录）`))
      case 'finding':
      case 'proposal':
        return line(c.magenta(`  ◆ ${event.message}`))
      case 'say':
      case 'answer': {
        const answer = String(event.message ?? '')
        const shown = payload.streamed ?? ''
        if (shown && answer.startsWith(shown)) {
          write(`${answer.slice(shown.length)}\n`)
          midLine = false
          speaking = false
        } else line(`\n${answer}`)
        return
      }
      case 'error':
        return line(c.red(`✗ ${event.message}`))
      case 'cancelled':
        return line(c.yellow(`■ ${event.message}`))
      default:
        return line(c.dim(`  ${event.message}`))
    }
  }
}

/** The approval as a person reads it before saying yes. */
export function approvalText(request, c) {
  const lines = [
    '',
    c.bold(c.yellow(`? ${request.title}`)) + c.dim(`  (${request.tool})`)
  ]
  if (request.preview)
    for (const entry of String(request.preview).split('\n'))
      lines.push(
        entry.startsWith('+ ')
          ? c.green(`  ${entry}`)
          : entry.startsWith('- ')
            ? c.red(`  ${entry}`)
            : `  ${entry}`
      )
  else lines.push(c.dim(`  ${JSON.stringify(request.args)}`))
  return lines.join('\n')
}

export function approvalChoices(request) {
  return request.always ? `  [y] 执行  [a] ${request.always}  [n] 不执行 › ` : '  [y] 执行  [n] 不执行 › '
}

/** y / a / n from what was typed; anything unclear is a no. */
export function readChoice(answer, request) {
  const value = String(answer ?? '').trim().toLowerCase()
  if (['y', 'yes', '是', '好'].includes(value)) return 'yes'
  if (request.always && ['a', 'always', '总是'].includes(value)) return 'always'
  return 'no'
}
