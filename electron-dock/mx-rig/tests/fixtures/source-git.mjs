import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Real Git smart HTTP, bound to loopback; no external repository or credentials. */
export async function gitFixture(root) {
  const work = join(root, 'original'),
    bare = join(root, 'repo.git')
  await mkdir(work, { recursive: true })
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0'
  }
  for (const key of Object.keys(env))
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key))
      delete env[key]
  const git = async (...args) =>
    (await promisify(execFile)('git', ['-C', work, ...args], { env })).stdout.trim()
  await git('init', '-q', '--initial-branch=main', '--template=')
  await git('config', 'user.name', 'Rig fixture')
  await git('config', 'user.email', 'fixture@example.invalid')
  await git('init', '-q', '--bare', '--template=', bare)
  const commit = async (text = "export const workspaceTitle = '用户工作区'\n") => {
    await writeFile(join(work, 'login.ts'), text)
    await git('add', 'login.ts')
    await git('commit', '-qm', 'fixture')
    await git('push', '-q', bare, 'main')
    return git('rev-parse', 'HEAD')
  }
  const first = await commit()
  const backend = join(await git('--exec-path'), 'git-http-backend')
  const children = new Set()
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const child = spawn(backend, [], {
      env: {
        ...env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: req.headers['content-length'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
        GIT_PROTOCOL: req.headers['git-protocol'] ?? ''
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    children.add(child)
    const chunks = []
    child.stdout.on('data', (part) => chunks.push(part))
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {})
    req.pipe(child.stdin)
    child.on('close', () => {
      children.delete(child)
      const output = Buffer.concat(chunks),
        split = output.indexOf('\r\n\r\n')
      if (split < 0) {
        res.writeHead(500)
        res.end()
        return
      }
      const headers = {}
      let status = 200
      for (const line of output.subarray(0, split).toString().split('\r\n')) {
        const index = line.indexOf(':')
        if (index < 0) continue
        const key = line.slice(0, index),
          value = line.slice(index + 1).trim()
        if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0])
        else headers[key] = value
      }
      res.writeHead(status, headers)
      res.end(output.subarray(split + 4))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    work,
    bare,
    git,
    commit,
    first,
    repoUrl: `http://127.0.0.1:${server.address().port}/repo.git`,
    close: async () => {
      for (const child of children) child.kill()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
