import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { RigError } from '../contracts/index.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const fail = (code, message) => new RigError(code, message, 409)

/** No shell, prompts, hooks, fsmonitor, inherited Git options or raw credential-bearing errors. */
export async function sourceGit(
  directory,
  args,
  { signal, network = false, allowFailure = false, localFetch = false, timeoutMs = null, indexFile = null, maxOutputBytes = 1024 * 1024 } = {}
) {
  signal?.throwIfAborted()
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_|^SSH_ASKPASS/.test(key))
  )
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    // A snapshot of a repository on this computer reads it over file://
    // (the source repository is only read, never written).
    GIT_ALLOW_PROTOCOL: localFetch ? 'file' : 'https:http:ssh',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C'
  })
  // Building a commit without touching the checked-out branch uses an index of its own.
  if (indexFile) env.GIT_INDEX_FILE = indexFile
  // Only fetching may use the member's configured credential helper / proxy.
  if (!network) env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const child = spawn(
    'git',
    [
      '--no-optional-locks',
      '-c',
      `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'http.followRedirects=false',
      '-C',
      directory,
      ...args
    ],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    }
  )
  let output = '',
    bytes = 0,
    overflow = false,
    timeout = false
  const stop = () => {
    try {
      process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* exited */
    }
  }
  child.stdout.on('data', (data) => {
    bytes += data.length
    if (bytes > maxOutputBytes) {
      overflow = true
      stop()
    } else output += data.toString('utf8')
  })
  child.stderr.on('data', () => {})
  const timer = setTimeout(
    () => {
      timeout = true
      stop()
    },
    timeoutMs ?? (network ? 120_000 : 15_000)
  )
  signal?.addEventListener('abort', stop, { once: true })
  const { code, error } = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ error }))
    child.on('close', (code) => resolve({ code }))
  })
  clearTimeout(timer)
  signal?.removeEventListener('abort', stop)
  if (signal?.aborted) throw fail('source_cancelled', '源码连接已取消')
  if (error) throw fail('git_unavailable', '无法启动 Git，请先在本机安装 Git')
  if (timeout) throw fail('git_timeout', 'Git 操作超时，请检查网络和仓库大小后重试')
  if (overflow) throw fail('git_output_limit', 'Git 输出过大，无法记录可靠的源码基准')
  if (code !== 0 && !allowFailure)
    throw fail(
      'git_failed',
      network
        ? '拉取失败，请检查仓库、分支及本机 Git 凭据；SSH 主机须已受信任'
        : '无法读取或准备 Git 源码'
    )
  return { code, output }
}

export function sourceRemote(value, ref) {
  if (typeof value !== 'string' || value.length > 500 || /[\s\x00-\x1f]/.test(value))
    throw fail('invalid_repository', '请提供不含凭据的 HTTPS 或 SSH 仓库地址')
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+)$/.exec(value)
  let url
  try {
    url = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : value)
  } catch {
    throw fail('invalid_repository', '仓库地址须为 HTTPS、SSH 或 git@host:path')
  }
  if (
    !['https:', 'ssh:', 'http:'].includes(url.protocol) ||
    !url.hostname ||
    url.hostname.startsWith('-') ||
    url.password ||
    (url.protocol !== 'ssh:' && url.username) ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9._~/-]+$/.test(url.pathname) ||
    url.pathname.split('/').some((p) => p === '..') ||
    (url.username && !/^[A-Za-z0-9._-]+$/.test(url.username)) ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw fail('invalid_repository', '使用无令牌的 HTTPS/SSH 地址；HTTP 仅允许本机回环地址')
  if (
    typeof ref !== 'string' ||
    ref.length > 200 ||
    !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(ref) ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.split('/').some((p) => !p || p.startsWith('.') || p.endsWith('.lock') || p.endsWith('.')) ||
    (ref.startsWith('refs/') && !/^refs\/(heads|tags)\/.+/.test(ref))
  )
    throw fail('invalid_source_ref', '请指定分支、refs/tags/标签或完整 commit SHA')
  return {
    repoUrl: scp ? value : url.href,
    ref,
    fetchRef:
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref) || ref.startsWith('refs/')
        ? ref
        : `refs/heads/${ref}`
  }
}

/** Read only. Disable local filter commands before status, which can otherwise run clean filters. */
export async function sourceBaseline(directory, { signal } = {}) {
  const git = (args, options = {}) => sourceGit(directory, args, { signal, ...options })
  let head
  try {
    head = await git(['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true })
  } catch (error) {
    if (error.code === 'git_unavailable')
      return { commit: null, branch: null, dirty: null, statusHash: null }
    throw error
  }
  if (head.code !== 0) return { commit: null, branch: null, dirty: null, statusHash: null }
  const commit = head.output.trim()
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw fail('invalid_source_ref', '无法识别源码提交')
  const filters = await git(['config', '--local', '--name-only', '--get-regexp', '^filter\\.'], {
    allowFailure: true
  })
  const overrides = filters.output
    .split('\n')
    .filter((key) => /^filter\..+\.(clean|smudge|process|required)$/.test(key))
    .flatMap((key) => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`])
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })
  const status = await git([
    ...overrides,
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
    '--ignore-submodules=all',
    '--no-renames',
    '--',
    '.'
  ])
  return {
    commit,
    branch: branch.code === 0 ? branch.output.trim() : null,
    dirty: Boolean(status.output),
    statusHash: sha256(status.output)
  }
}
