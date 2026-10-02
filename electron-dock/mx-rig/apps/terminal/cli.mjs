// `mx-rig` commands other than `station`.

import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { detectProject, renderRigFile, RIG_FILE } from '../../packages/runtime/project.mjs'
import { TerminalSession } from '../../packages/runtime/terminal.mjs'
import { connect, loadSession, login, logout, missionHome, rigHome } from './auth.mjs'
import { canShowBrowser, chromiumLauncher } from './launcher.mjs'
import { palette } from './render.mjs'
import { banner, execOnce, repl, siteLine } from './repl.mjs'

const USAGE = `MX Rig 终端：在项目目录里读代码、跑测试、定位失败、补测试；每条命令和每次改文件都先给你确认。

  mx-rig [目标]                         在当前目录开始会话；-c 接着这个项目最近一项任务
  mx-rig exec <目标> [--json] [--allow-command "<命令>"]… [--allow-edits]
                                        不交互地做一件事；没有事先允许的写操作一律不执行
  mx-rig init [--app <应用>] [--force]  识别测试栈，写 RIG.md（给 Agent 的项目说明）
  mx-rig login --server <地址> [--account <账号>] [--private-http]
  mx-rig logout | whoami | status
  mx-rig station enroll | watch | status  工位：领取并重放试验规程回归

选项：--cwd <目录> 指定项目目录；--headless / --headed 浏览器是否显示窗口；
      --sandbox off 不用命令沙箱（默认在 macOS 与装了 bubblewrap 的 Linux 上，命令只能写工作区、临时目录和工具缓存）。
环境变量：MX_RIG_URL + MX_RIG_TOKEN 代替 login（CI 用）；MX_RIG_HOME 配置目录（默认 ~/.mx-rig）；
MX_RIG_PASS_ENV=名字,… 把这些像密钥的环境变量也交给 Agent 运行的命令。`

/** Flags and positionals, the way this CLI uses them. */
export function parseArgs(argv) {
  const flags = new Map()
  const many = { 'allow-command': [] }
  const positional = []
  const BOOLEAN = new Set(['json', 'allow-edits', 'headless', 'headed', 'force', 'private-http', 'help', 'continue'])
  const SHORT = { '-c': '--continue', '-h': '--help' }
  for (let index = 0; index < argv.length; index += 1) {
    const entry = SHORT[argv[index]] ?? argv[index]
    if (!entry.startsWith('--')) {
      positional.push(entry)
      continue
    }
    const [name, inline] = entry.slice(2).split(/=(.*)/s)
    const value = inline ?? (BOOLEAN.has(name) ? true : argv[++index])
    if (name in many) many[name].push(value)
    else flags.set(name, value)
  }
  return { flags, many, positional }
}

function firstLine(input) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, terminal: false })
    rl.once('line', (line) => {
      // Before closing: `close` resolves too, and it would win.
      resolve(line)
      rl.close()
    })
    rl.once('close', () => resolve(''))
  })
}

/** A line typed with no echo; from a pipe, just the next line. */
async function readSecret(prompt, { input = process.stdin, output = process.stdout } = {}) {
  output.write(prompt)
  if (!input.isTTY) return firstLine(input)
  input.setRawMode(true)
  input.resume()
  input.setEncoding('utf8')
  let value = ''
  return new Promise((resolve, reject) => {
    const done = () => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      output.write('\n')
    }
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          done()
          return resolve(value)
        }
        if (char === '\u0003') {
          done()
          return reject(new Error('已取消'))
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    input.on('data', onData)
  })
}

async function openSession({ flags, env, interactive }) {
  const { client, principal, session } = await connect(env)
  const workspaceRoot = resolve(flags.get('cwd') ?? process.cwd())
  const headless = flags.has('headed') ? false : flags.has('headless') || !interactive || !canShowBrowser(env)
  const terminal = await new TerminalSession({
    client,
    owner: principal.id,
    home: missionHome(env, client.url, principal.id),
    workspaceRoot,
    launcher: await chromiumLauncher(),
    headless,
    // One copy per person, not per server and account.
    browsersDir: join(rigHome(env), 'browsers'),
    env,
    sandbox: (flags.get('sandbox') ?? env.MX_RIG_SANDBOX) === 'off' ? 'off' : 'auto'
  }).init()
  return { terminal, principal, server: client.url, workspaceRoot, session }
}

/** @returns {Promise<number>} the exit code */
export async function main(argv, env = process.env) {
  const { flags, many, positional } = parseArgs(argv)
  const out = (text) => process.stdout.write(text)
  const c = palette(process.stdout, env)
  const [command, ...rest] = positional

  if (flags.has('help') || command === 'help') {
    out(`${USAGE}\n`)
    return 0
  }

  if (command === 'login') {
    const server = flags.get('server') ?? env.MX_RIG_URL
    if (!server) throw new Error('需要 --server <Rig 服务地址>')
    let account = flags.get('account')
    if (!account) {
      account = process.stdin.isTTY
        ? await new Promise((done) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout })
            rl.question('账号：', (answer) => {
              rl.close()
              done(answer.trim())
            })
          })
        : ''
      if (!account) throw new Error('需要账号（--account，或在终端里输入）')
    }
    const password = await readSecret('密码：')
    const { server: origin, principal } = await login({
      server,
      account,
      password,
      privateHttp: flags.has('private-http') || env.MX_RIG_ALLOW_PRIVATE_HTTP === '1',
      env
    })
    out(c.green(`已登录 ${origin}：${principal.displayName ?? principal.id}（${principal.role}）\n`))
    return 0
  }

  if (command === 'logout') {
    const session = await logout(env)
    out(session ? '已退出登录。\n' : '本来就没有登录。\n')
    return 0
  }

  if (command === 'whoami') {
    const { principal, session } = await connect(env)
    out(`${principal.displayName ?? principal.id}（${principal.role}）@ ${session.server}${session.source === 'env' ? '（来自环境变量）' : ''}\n`)
    return 0
  }

  if (command === 'init') {
    const root = resolve(flags.get('cwd') ?? process.cwd())
    const project = await detectProject(root)
    let app = flags.get('app') ?? null
    // With a session, check the app exists — or suggest the one whose slug
    // matches the package name.
    if (await loadSession(env)) {
      try {
        const { client } = await connect(env)
        const { apps } = await client.request('/api/v1/apps')
        const slugs = apps.map((entry) => entry.slug)
        if (app && !slugs.includes(app))
          out(c.yellow(`提示：平台上还没有应用 ${app}；管理员接入后用例和执行才能记在它名下。\n`))
        if (!app) {
          const guess = String(project.name).toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]+/g, '-')
          app = slugs.find((slug) => slug === guess || guess.startsWith(`${slug}-`) || guess.endsWith(`-${slug}`)) ?? null
        }
      } catch {
        /* Offline is fine: RIG.md can be written without the service. */
      }
    }
    const target = join(root, RIG_FILE)
    if (project.rigFile && !flags.has('force')) {
      out(c.yellow(`${RIG_FILE} 已经存在，没有改动（要重新生成用 --force）。\n`))
    } else {
      await writeFile(target, renderRigFile(project, { app }))
      out(c.green(`已写入 ${target}\n`))
    }
    out(
      `识别到：${project.stacks.map((stack) => stack.name).join('、') || '没有识别出测试框架'}${
        project.baseUrls.length ? `；测试地址 ${project.baseUrls.join('、')}` : ''
      }${app ? `；Rig 应用 ${app}` : ''}\n请把 RIG.md 里括号中的内容补上，然后运行 mx-rig。\n`
    )
    return 0
  }

  if (command === 'status') {
    const { terminal, principal, server, workspaceRoot } = await openSession({ flags, env, interactive: false })
    try {
      const project = await detectProject(workspaceRoot)
      out(banner(terminal, { principal, server, project, c }))
      const status = terminal.status()
      out(`可用工具：${status.tools.join('、') || '无'}\n浏览器站点：${siteLine(status)}\n`)
    } finally {
      await terminal.close()
    }
    return 0
  }

  if (command === 'exec') {
    const goal = rest.join(' ').trim()
    if (!goal) throw new Error('用法：mx-rig exec "<目标>"')
    const { terminal } = await openSession({ flags, env, interactive: false })
    try {
      return await execOnce({
        session: terminal,
        goal,
        json: flags.has('json'),
        allowCommands: many['allow-command'],
        allowEdits: flags.has('allow-edits')
      })
    } finally {
      await terminal.close()
    }
  }

  const { terminal, principal, server, workspaceRoot } = await openSession({ flags, env, interactive: true })
  try {
    const project = await detectProject(workspaceRoot)
    let header = banner(terminal, { principal, server, project, c })
    if (flags.has('continue')) {
      const [last] = terminal.recent({ limit: 1 })
      if (last) {
        terminal.resume(last.id)
        header += c.dim(`接着上次的任务：「${last.goal.split('\n')[0].slice(0, 60)}」（${last.status}）\n\n`)
      } else header += c.dim('这个项目还没有终端任务，从新任务开始。\n\n')
    }
    await repl({
      session: terminal,
      first: positional.join(' '),
      header,
      historyFile: join(rigHome(env), 'history')
    })
  } finally {
    await terminal.close()
  }
  return 0
}
