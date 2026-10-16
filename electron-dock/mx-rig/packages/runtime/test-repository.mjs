// A test project's repository on this computer (docs/23):
//
//   <root>/<app>/qa        one Git repository per test project
//     .rig/cases/<id>.json which test file covers a case, one file per case so
//                          two tasks covering different cases never conflict
//     main                 this computer's line: what has been verified here
//     task/<task>          a test task's approved implementations, one commit each
//     published            the service's versions, rig/v<N> tags
//
// It works without any Git server: publishing hands the service a git bundle,
// and pulling fetches bundles back. Commits are built with plumbing and an
// index of their own, so writing a task's tests never switches the branch a
// person may have checked out in this directory.

import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { RigError } from '../contracts/index.mjs'
import { sourceGit } from './source-repository.mjs'

const APP = /^[a-z0-9][a-z0-9-]{0,62}$/
const SHA = /^[a-f0-9]{40}$/
const ZERO = '0'.repeat(40)
const AUTHOR = ['-c', 'user.name=MX Rig', '-c', 'user.email=rig@localhost', '-c', 'commit.gpgsign=false']
const TEMPLATE = fileURLToPath(new URL('./qa-template/web/', import.meta.url))
const BRANCH = /^(?:main|published|task\/[a-f0-9]{8})$/

// What a published test version may carry (docs/23 §7). Tests, case mappings,
// small fixtures — yes. Recordings and screenshots are run artifacts and stay
// in the run; installers are registered as packages; installed dependencies,
// build output and secrets never belong in a test version.
// One upload to the service is at most `uploadBytes`; what a version adds is
// kept below it so that even incompressible content (images) fits.
export const PUBLISH_POLICY = Object.freeze({
  fileBytes: 2 * 1024 * 1024,
  versionBytes: 6 * 1024 * 1024,
  uploadBytes: 8 * 1024 * 1024,
  forbidden: [
    [/(^|\/)(node_modules|test-results|playwright-report|artifacts|dist|coverage)\//, '依赖、构建输出或执行产物'],
    [/(^|\/)\.env(\.|$)/, '环境变量文件（可能含密钥）'],
    [/\.(webm|mp4|mov|avi|mkv|m4v)$/i, '录像（执行产物，自动保存在执行记录里）'],
    [/\.(zip|tar|tgz|gz|7z|rar)$/i, '压缩包'],
    [/\.(exe|msi|dmg|pkg|appimage|deb|rpm|apk|ipa)$/i, '安装包（请登记在项目设置 → 安装包）']
  ]
})

const conflict = (code, message) => new RigError(code, message, 409)
const appSlug = (value) => {
  if (!APP.test(value ?? '')) throw new RigError('invalid_input', '项目标识无效')
  return value
}
export const taskBranch = (missionId) => {
  if (!/^[a-f0-9-]{36}$/.test(missionId ?? '')) throw new RigError('invalid_input', '任务编号无效')
  return `task/${missionId.replaceAll('-', '').slice(0, 8)}`
}

export class TestRepositories {
  constructor(root) {
    this.root = resolve(root)
    this.queues = new Map()
  }

  path(app) {
    return join(this.root, appSlug(app), 'qa')
  }

  git(app, args, options = {}) {
    return sourceGit(this.path(app), args, options)
  }

  /** One change per repository at a time. */
  async #serial(app, work) {
    const previous = this.queues.get(app) ?? Promise.resolve()
    const next = previous.then(work)
    const settled = next.catch(() => {})
    this.queues.set(app, settled)
    settled.then(() => {
      if (this.queues.get(app) === settled) this.queues.delete(app)
    })
    return next
  }

  async exists(app) {
    return Boolean(await lstat(join(this.path(app), '.git')).catch(() => null))
  }

  async project(app) {
    return JSON.parse(await readFile(join(this.path(app), '.rig', 'project.json'), 'utf8').catch(() => 'null'))
  }

  async #ref(app, ref) {
    const result = await this.git(app, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true })
    const sha = result.output.trim()
    return result.code === 0 && SHA.test(sha) ? sha : null
  }

  /** The repository of a project without a pack: the Playwright Web template, committed as main. */
  ensure(app) {
    appSlug(app)
    return this.#serial(app, async () => {
      if (await this.exists(app)) return this.status(app)
      await mkdir(join(this.root, app), { recursive: true })
      const staging = await mkdtemp(join(this.root, app, '.qa-'))
      try {
        await cp(TEMPLATE, staging, { recursive: true, filter: (path) => !path.includes('node_modules') })
        await rename(join(staging, 'gitignore'), join(staging, '.gitignore'))
        await mkdir(join(staging, '.rig'), { recursive: true })
        await writeFile(join(staging, '.rig', 'project.json'), JSON.stringify({ kind: 'generic', app, engine: 'playwright', platform: 'web' }, null, 2) + '\n')
        const git = (args) => sourceGit(staging, args)
        await git(['init', '--quiet', '--template=', '--initial-branch=main'])
        await git(['add', '--all'])
        await git([...AUTHOR, 'commit', '--quiet', '--no-verify', '-m', '初始：Rig 测试仓库（Playwright Web）'])
        await rename(staging, this.path(app))
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      return this.status(app)
    })
  }

  /** Write `files` (path → text) onto `branch` on top of `base`, as one commit. */
  async #commitFiles(app, { branch, base, files, message }) {
    const scratch = await mkdtemp(join(this.root, app, '.write-'))
    const indexFile = join(scratch, 'index')
    try {
      const git = (args, options = {}) => this.git(app, args, { indexFile, ...options })
      await git(base ? ['read-tree', base] : ['read-tree', '--empty'])
      for (const [index, [path, content]] of Object.entries(files).entries()) {
        const temp = join(scratch, `blob-${index}`)
        await writeFile(temp, content)
        const blob = (await git(['hash-object', '-w', '--', temp])).output.trim()
        await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`])
      }
      const tree = (await git(['write-tree'])).output.trim()
      const commit = (await git([...AUTHOR, 'commit-tree', tree, ...(base ? ['-p', base] : []), '-m', message])).output.trim()
      const current = await this.#ref(app, `refs/heads/${branch}`)
      await git(['update-ref', `refs/heads/${branch}`, commit, current ?? ZERO])
      return commit
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  /** The case → test file mappings at `ref`. */
  async #mappingsAt(app, ref) {
    if (!ref) return []
    const listed = await this.git(app, ['ls-tree', '--name-only', `${ref}:.rig/cases`], { allowFailure: true })
    if (listed.code !== 0) return []
    const rows = []
    for (const name of listed.output.split('\n').filter((entry) => entry.endsWith('.json')).slice(0, 500)) {
      const shown = await this.git(app, ['show', `${ref}:.rig/cases/${name}`], { allowFailure: true })
      try {
        if (shown.code === 0) rows.push(JSON.parse(shown.output))
      } catch {
        /* a file someone broke by hand is skipped, not fatal */
      }
    }
    return rows.sort((a, b) => String(a.caseId).localeCompare(String(b.caseId)))
  }

  /**
   * An approved implementation of a test task, committed to the task's branch.
   * The same implementation version written again changes nothing.
   */
  commitImplementation(app, { missionId, goal = '', implementation }) {
    appSlug(app)
    return this.#serial(app, async () => {
      if (!(await this.exists(app))) throw conflict('repository_missing', '这个项目在本机还没有测试仓库')
      const project = await this.project(app)
      if (project?.kind !== 'generic')
        throw conflict('repository_pack', '这个项目的测试仓库来自验收包，它的用例写在 rig-specs 里，不接收测试任务的实现')
      if (implementation?.engine !== 'playwright' || implementation?.platform !== 'web')
        throw conflict('implementation_engine', '本机测试仓库暂时只支持 Playwright Web 的实现')
      if (!implementation.reviewedAt) throw conflict('implementation_not_reviewed', '只有批准过的实现才能写入测试仓库')
      const branch = taskBranch(missionId)
      const head = await this.#ref(app, `refs/heads/${branch}`)
      const base = head ?? (await this.#startingPoint(app))
      const current = await this.#mappingsAt(app, base)
      if (head && implementation.mappings.every((entry) => current.some((row) => row.caseId === entry.caseId && row.hash === implementation.hash)))
        return { branch, commit: head, unchanged: true }
      const files = Object.fromEntries(implementation.files.map((file) => [file.path, file.content]))
      for (const entry of implementation.mappings) {
        if (!/^[A-Z0-9][A-Z0-9_.-]{0,63}$/.test(entry.caseId)) throw new RigError('invalid_input', `用例编号 ${entry.caseId} 不能作为文件名`)
        files[`.rig/cases/${entry.caseId}.json`] =
          JSON.stringify(
            {
              caseId: entry.caseId,
              path: entry.path,
              assertion: entry.assertion,
              missionId,
              version: implementation.version,
              caseRevision: implementation.caseRevision,
              hash: implementation.hash
            },
            null,
            2
          ) + '\n'
      }
      const commit = await this.#commitFiles(app, {
        branch,
        base,
        files,
        message: `测试任务「${String(goal).slice(0, 60)}」· 实现 r${implementation.version} · 用例 v${implementation.caseRevision}\n\nRig-Mission: ${missionId}\nRig-Implementation: ${implementation.hash}`
      })
      return { branch, commit, unchanged: false }
    })
  }

  /** Is `older` an ancestor of `newer` (or the same commit)? */
  async #behind(app, older, newer) {
    if (older === newer) return true
    return (await this.git(app, ['merge-base', '--is-ancestor', older, newer], { allowFailure: true })).code === 0
  }

  /** main as the template made it: nothing verified or written on this computer yet. */
  async #untouched(app, main) {
    const parents = (await this.git(app, ['rev-list', '--parents', '-n', '1', main])).output.trim().split(' ')
    return parents.length === 1 && (await this.#mappingsAt(app, main)).length === 0
  }

  /** Where a new task branch starts: this computer's main, or the service's version when that is newer. */
  async #startingPoint(app) {
    const main = await this.#ref(app, 'refs/heads/main')
    const published = await this.#ref(app, 'refs/heads/published')
    if (!published) return main
    if (!main || (await this.#behind(app, main, published)) || (await this.#untouched(app, main))) return published
    return main
  }

  /** Bring a verified commit into main: fast-forward, or a merge commit when the lines diverged. */
  mergeToMain(app, commit) {
    appSlug(app)
    if (!SHA.test(commit ?? '')) throw new RigError('invalid_input', '提交号无效')
    return this.#serial(app, async () => {
      if (!(await this.#ref(app, commit))) throw conflict('commit_missing', '本机测试仓库里没有这个提交')
      const main = await this.#ref(app, 'refs/heads/main')
      let next = commit
      if (main && main !== commit) {
        const ancestor = await this.git(app, ['merge-base', '--is-ancestor', main, commit], { allowFailure: true })
        const behind = await this.git(app, ['merge-base', '--is-ancestor', commit, main], { allowFailure: true })
        if (behind.code === 0) return { main, merged: false }
        if (ancestor.code !== 0) {
          const merged = await this.git(app, ['merge-tree', '--write-tree', '--name-only', main, commit], { allowFailure: true })
          // The tree, then (on a conflict) the conflicted paths up to a blank line.
          const [tree, ...rest] = merged.output.split('\n')
          if (merged.code !== 0 || !SHA.test(tree ?? '')) {
            const end = rest.indexOf('')
            const files = (end === -1 ? rest : rest.slice(0, end)).filter(Boolean)
            throw conflict('merge_conflict', `合入主线有冲突${files.length ? `：${files.slice(0, 8).join('、')}` : ''}。请在本机测试仓库里处理后再合入。`)
          }
          next = (await this.git(app, [...AUTHOR, 'commit-tree', tree, '-p', main, '-p', commit, '-m', `合入 ${commit.slice(0, 7)}`])).output.trim()
        }
      }
      await this.git(app, ['update-ref', 'refs/heads/main', next, main ?? ZERO])
      await this.#syncWorktree(app, main, next)
      return { main: next, merged: true }
    })
  }

  /** Keep a clean checkout of main in step; leave a person's uncommitted work alone. */
  async #syncWorktree(app, before, after) {
    const head = await this.git(app, ['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true })
    if (head.output.trim() !== 'refs/heads/main') return
    const changes = await this.git(app, ['diff-index', '--quiet', before ?? 'HEAD', '--'], { allowFailure: true })
    if (changes.code === 0) await this.git(app, ['reset', '--quiet', '--hard', after])
  }

  /** A git bundle of `commit`, without what `since` (the last published commit) already has. */
  bundle(app, commit, since = null) {
    appSlug(app)
    return this.#serial(app, async () => {
      if (!(await this.#ref(app, commit))) throw conflict('commit_missing', '本机测试仓库里没有这个提交')
      const scratch = await mkdtemp(join(this.root, app, '.bundle-'))
      try {
        await this.git(app, ['update-ref', 'refs/rig/outgoing', commit])
        const exclude = since && since !== commit && (await this.#ref(app, since)) ? [`^${since}`] : []
        const file = join(scratch, 'out.bundle')
        await this.git(app, ['bundle', 'create', '--quiet', file, 'refs/rig/outgoing', ...exclude])
        return (await readFile(file)).toString('base64')
      } finally {
        await this.git(app, ['update-ref', '-d', 'refs/rig/outgoing'], { allowFailure: true })
        await rm(scratch, { recursive: true, force: true })
      }
    })
  }

  /** Fetch a published version from its bundle: tag rig/v<N>, and move published to it. */
  importVersion(app, { version, commit, bundle }) {
    appSlug(app)
    if (!Number.isSafeInteger(version) || version < 1 || !SHA.test(commit ?? '')) throw new RigError('invalid_input', '版本信息无效')
    return this.#serial(app, async () => {
      if (!(await this.exists(app))) throw conflict('repository_missing', '这个项目在本机还没有测试仓库')
      if (!(await this.#ref(app, commit))) {
        const scratch = await mkdtemp(join(this.root, app, '.pull-'))
        try {
          const file = join(scratch, `v${version}.bundle`)
          await writeFile(file, Buffer.from(bundle, 'base64'))
          const verified = await this.git(app, ['bundle', 'verify', '--quiet', file], { allowFailure: true })
          if (verified.code !== 0) throw conflict('bundle_invalid', `服务器版本 v${version} 的内容与本机仓库接不上（缺少更早的版本，或文件损坏）`)
          await this.git(app, ['fetch', '--quiet', '--no-tags', file, `refs/rig/outgoing:refs/rig/incoming`], { localFetch: true })
          await this.git(app, ['update-ref', '-d', 'refs/rig/incoming'], { allowFailure: true })
        } finally {
          await rm(scratch, { recursive: true, force: true })
        }
      }
      if ((await this.#ref(app, commit)) !== commit) throw conflict('bundle_invalid', `服务器版本 v${version} 里没有提交 ${commit.slice(0, 7)}`)
      await this.git(app, ['update-ref', `refs/tags/rig/v${version}`, commit])
      await this.git(app, ['update-ref', 'refs/heads/published', commit])
      // main follows the service when it has nothing of its own: a fresh
      // computer, or one whose main the service's version already contains.
      const main = await this.#ref(app, 'refs/heads/main')
      let followed = false
      if (main && main !== commit && ((await this.#behind(app, main, commit)) || (await this.#untouched(app, main)))) {
        await this.git(app, ['update-ref', 'refs/heads/main', commit, main])
        await this.#syncWorktree(app, main, commit)
        followed = true
      }
      return { version, commit, followed }
    })
  }

  async status(app) {
    appSlug(app)
    if (!(await this.exists(app))) return { exists: false, app }
    const listed = await this.git(app, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(subject)%00%(committerdate:iso-strict)', 'refs/heads', 'refs/tags/rig'])
    const refs = listed.output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, commit, subject, at] = line.split('\0')
        return { ref, name: ref.replace(/^refs\/(heads|tags)\//, ''), commit, subject, at }
      })
    const project = await this.project(app)
    const main = refs.find((entry) => entry.ref === 'refs/heads/main')?.commit ?? null
    const branches = []
    for (const entry of refs.filter((row) => row.ref.startsWith('refs/heads/') && BRANCH.test(row.name)))
      branches.push({ ...entry, merged: Boolean(main) && (await this.#behind(app, entry.commit, main)) })
    return {
      exists: true,
      app,
      kind: project?.kind ?? (project?.pack ? 'pack' : null),
      directory: this.path(app),
      branches,
      versions: refs
        .filter((entry) => entry.ref.startsWith('refs/tags/rig/v'))
        .map((entry) => ({ ...entry, version: Number(entry.name.slice('rig/v'.length)) }))
        .sort((a, b) => b.version - a.version),
      mappings: await this.#mappingsAt(app, 'refs/heads/main')
    }
  }

  /** Is `older` contained in `newer`? False when either commit is not here. */
  async contains(app, older, newer) {
    if (!(await this.#ref(app, older)) || !(await this.#ref(app, newer))) return false
    return this.#behind(app, older, newer)
  }

  /**
   * What a publish of `commit` would add over `since`, against the policy:
   * every file any commit in between adds or changes — a bundle carries the
   * whole range, so a video committed and deleted again still travels — with
   * the sizes of their contents, and every reason to refuse.
   */
  async inspect(app, commit, since = null) {
    const range = since && since !== commit && (await this.#ref(app, since)) ? [commit, `^${since}`] : [commit]
    // Listings of this repository only; a long history may print more than the default cap.
    const listing = { maxOutputBytes: 64 * 1024 * 1024, timeoutMs: 120_000 }
    const raw = await this.git(app, ['log', '--raw', '-r', '-z', '--no-abbrev', '--no-renames', '--diff-filter=AMT', '--format=', ...range], listing)
    // `:<modes> <old> <new> <status>` then the path, NUL separated.
    const touched = new Map()
    const tokens = raw.output.split('\0')
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const meta = tokens[i].replace(/^\n+/, '')
      if (!meta.startsWith(':')) continue
      const blob = meta.split(' ')[3]
      const path = tokens[++i]
      if (path && !touched.has(path)) touched.set(path, new Set())
      if (path) touched.get(path).add(blob)
    }
    const sizes = new Map()
    const objects = await this.git(app, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], listing)
    for (const line of objects.output.split('\n')) {
      const [name, type, size] = line.split(' ')
      if (type === 'blob') sizes.set(name, Number(size))
    }
    const problems = []
    const counted = new Set()
    let bytes = 0
    for (const [path, blobs] of touched) {
      let largest = 0
      for (const blob of blobs) {
        const size = sizes.get(blob) ?? 0
        largest = Math.max(largest, size)
        if (!counted.has(blob)) {
          counted.add(blob)
          bytes += size
        }
      }
      const rule = PUBLISH_POLICY.forbidden.find(([pattern]) => pattern.test(path))
      if (rule) problems.push(`${path}：${rule[1]}`)
      else if (largest > PUBLISH_POLICY.fileBytes) problems.push(`${path}：${(largest / 1024 / 1024).toFixed(1)} MB，单个文件超过 2 MB`)
    }
    if (bytes > PUBLISH_POLICY.versionBytes)
      problems.push(`这次要带上的文件内容共 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过 ${PUBLISH_POLICY.versionBytes / 1024 / 1024} MB：请分成几个版本发布`)
    return { files: touched.size, bytes, problems }
  }

  /** Tag a version whose commit is already here (its content came inside a later full version). */
  async tagVersion(app, version, commit) {
    if ((await this.#ref(app, commit)) !== commit) return false
    await this.git(app, ['update-ref', `refs/tags/rig/v${version}`, commit])
    return true
  }

  /** Which cases a commit covers. */
  async cases(app, ref) {
    if (!(await this.exists(app))) return []
    return this.#mappingsAt(app, ref)
  }

  async has(app, commit) {
    return SHA.test(commit ?? '') && (await this.exists(app)) && (await this.#ref(app, commit)) === commit
  }
}
