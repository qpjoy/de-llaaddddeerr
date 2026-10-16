// A test project's workspace on this computer (docs/21 §5): a read-only
// snapshot of the code under test, pinned to one commit, and the project's own
// QA Git repository with the tests written for that commit.
//
//   <root>/<app>/source/<ref>@<short>/   snapshot (sparse: only the project's subdirectory)
//   <root>/<app>/qa/                     QA repository, branch main, never pushed
//
// The developer's repository is only ever read. A local source is fetched over
// file:// into a fresh repository of Rig's own; nothing is checked out,
// stashed, reset or written where the developer works. Updating the baseline
// is an explicit act that adds a snapshot next to the old one and records the
// change as a QA commit, so earlier results stay reproducible.

import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RigError } from '../contracts/index.mjs'
import { sourceGit, sourceRemote } from './source-repository.mjs'

const APP = /^[a-z0-9][a-z0-9-]{0,62}$/
const FULL_SHA = /^[a-f0-9]{40}$/
const SKIP = new Set(['node_modules', 'artifacts', '.DS_Store', '.git'])
const AUTHOR = ['-c', 'user.name=MX Rig', '-c', 'user.email=rig@localhost', '-c', 'commit.gpgsign=false']

const fail = (code, message) => new RigError(code, message, 409)
const inside = (root, path) => path === root || path.startsWith(root + sep)
const appSlug = (value) => {
  if (!APP.test(value ?? '')) throw new RigError('invalid_input', '项目标识无效')
  return value
}
const refSlug = (ref) => String(ref || 'detached').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)

// What a copy of a plain directory leaves out: installed packages, VCS data,
// build caches. Tracked-looking folders such as build/ stay.
const COPY_SKIP = new Set(['node_modules', '.git', '.DS_Store', 'dist', '.next', '.nuxt', '.quasar', '.cache', '.turbo', 'coverage', 'test-results', 'playwright-report'])
const COPY_LIMIT = { files: 50_000, bytes: 1024 * 1024 * 1024 }

/** A content fingerprint of a directory without Git: every file's path and bytes. */
export async function directoryFingerprint(root) {
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0
  const walk = async (dir) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (COPY_SKIP.has(entry.name) || entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        files += 1
        bytes += (await stat(path)).size
        if (files > COPY_LIMIT.files || bytes > COPY_LIMIT.bytes)
          throw new RigError('source_too_large', '这个目录太大（超过 5 万个文件或 1 GB），请选到具体的项目目录', 409)
        hash.update(`${relative(root, path).split(sep).join('/')}\0`)
        hash.update(createHash('sha256').update(await readFile(path)).digest())
      }
    }
  }
  await walk(root)
  return { hash: hash.digest('hex'), files, bytes }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function ownDirectory(path) {
  const info = await lstat(path).catch(() => null)
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw fail('outside_workspace', '测试项目工作区里的目录不能是符号链接')
  if (!info) await mkdir(path)
}

/** An acceptance pack shipped with the desktop: `<packs>/<id>/pack.json` and the directory it seeds from. */
export async function readPack(packs, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id ?? '')) throw new RigError('invalid_input', '验收包标识无效')
  const dir = join(resolve(packs), id)
  const pack = await readJson(join(dir, 'pack.json')).catch(() => null)
  if (!pack || pack.id !== id) throw new RigError('not_found', '这台电脑上没有这个验收包', 404)
  return { ...pack, dir }
}

export class ProjectWorkspaces {
  constructor(root) {
    this.root = resolve(root)
    this.pending = new Map()
  }

  async #base(app) {
    await mkdir(this.root, { recursive: true })
    const root = await realpath(this.root)
    const base = join(root, appSlug(app))
    await ownDirectory(base)
    await ownDirectory(join(base, 'source'))
    return base
  }

  /** One change per project at a time. */
  async #exclusive(app, work) {
    if (this.pending.has(app)) throw fail('busy', '这个项目的工作区正在更新，请稍候')
    const job = work().finally(() => this.pending.delete(app))
    this.pending.set(app, job)
    return job
  }

  /** Where the source comes from: a local repository (only read) or a remote one. */
  async #origin(source, ref, commit, { signal }) {
    if (source?.kind === 'local') {
      const directory = await realpath(String(source.directory || '')).catch(() => null)
      if (!directory || !(await lstat(directory)).isDirectory()) throw new RigError('invalid_input', '请选择被测项目所在的目录')
      const own = await realpath(this.root)
      if (inside(directory, own) || inside(own, directory)) throw new RigError('invalid_source', '被测项目目录与 Rig 数据目录不能重叠')
      const found = await sourceGit(directory, ['rev-parse', '--show-toplevel'], { signal, allowFailure: true })
      // Code copied onto this computer, with no Git: Rig copies it into a
      // snapshot of its own and pins that (docs/23).
      if (found.code !== 0) return { kind: 'copy', directory, label: basename(directory), commit: null, subdir: null }
      // Inside some repository, but nothing in it is versioned there (an
      // ignored folder, a copy dropped into a checkout): that is a copy too.
      const tracked = await sourceGit(directory, ['ls-files', '--', '.'], { signal, allowFailure: true })
      if (tracked.code !== 0 || !tracked.output.trim()) return { kind: 'copy', directory, label: basename(directory), commit: null, subdir: null }
      const top = await realpath(found.output.trim())
      const resolved = await sourceGit(top, ['rev-parse', '--verify', '--quiet', `${commit || ref}^{commit}`], { signal, allowFailure: true })
      const full = resolved.output.trim()
      if (resolved.code !== 0 || !FULL_SHA.test(full)) throw fail('invalid_source_ref', `这个仓库里没有 ${commit || ref}`)
      const subdir = relative(top, directory).split(sep).join('/')
      return { kind: 'local', top, url: pathToFileURL(top).href, label: basename(top), commit: full, subdir }
    }
    if (source?.kind === 'git') {
      if (!FULL_SHA.test(commit ?? '')) throw new RigError('invalid_input', '从 Git 地址建立快照时请填写完整的 40 位提交号')
      const remote = sourceRemote(source.repoUrl, commit)
      return { kind: 'git', url: remote.repoUrl, label: remote.repoUrl, commit, subdir: null }
    }
    throw new RigError('invalid_input', '请选择本机目录或填写 Git 地址')
  }

  async #snapshotOf(base, commit) {
    for (const entry of await readdir(join(base, 'source')).catch(() => [])) {
      const meta = await readJson(join(base, 'source', entry, '.rig-snapshot.json')).catch(() => null)
      if (meta?.commit === commit) return { dir: join(base, 'source', entry), ...meta }
    }
    return null
  }

  /**
   * A snapshot of a plain directory: copied into a repository of Rig's own and
   * committed, so it is pinned to a commit like any other. The same content is
   * never copied twice.
   */
  async #copySnapshot(base, origin, { subdir }) {
    const fingerprint = await directoryFingerprint(origin.directory)
    for (const entry of await readdir(join(base, 'source')).catch(() => [])) {
      const meta = await readJson(join(base, 'source', entry, '.rig-snapshot.json')).catch(() => null)
      if (meta?.contentHash === fingerprint.hash) return { dir: join(base, 'source', entry), ...meta }
    }
    const staging = await mkdtemp(join(base, 'source', '.copy-'))
    try {
      await cp(origin.directory, staging, { recursive: true, filter: (path) => !COPY_SKIP.has(basename(path)) })
      const git = (args) => sourceGit(staging, args, { timeoutMs: 300_000 })
      await git(['init', '--quiet', '--template=', '--initial-branch=snapshot'])
      await git(['add', '--all', '--force'])
      await git([...AUTHOR, 'commit', '--quiet', '--no-verify', '-m', `快照：本机目录 ${origin.label}（无版本控制）`])
      const commit = (await git(['rev-parse', 'HEAD'])).output.trim()
      const meta = {
        commit,
        ref: null,
        subdir: subdir || null,
        origin: { kind: 'copy', label: origin.label, directory: origin.directory },
        contentHash: fingerprint.hash,
        files: fingerprint.files,
        capturedAt: new Date().toISOString()
      }
      // Written after the commit and never added: it is not part of the source.
      await writeFile(join(staging, '.rig-snapshot.json'), JSON.stringify(meta, null, 2))
      const target = join(base, 'source', `copy@${commit.slice(0, 7)}`)
      await rename(staging, target)
      return { dir: target, ...meta }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /** A snapshot of `commit`, made once; the same commit is never fetched twice. */
  async #snapshot(base, origin, { ref, subdir }, signal) {
    const existing = await this.#snapshotOf(base, origin.commit)
    if (existing) return existing
    const staging = await mkdtemp(join(base, 'source', '.fetch-'))
    const target = join(base, 'source', `${refSlug(ref)}@${origin.commit.slice(0, 7)}`)
    try {
      const git = (args, options = {}) => sourceGit(staging, args, { signal, ...options })
      await git(['init', '--quiet', '--template='])
      await git(['fetch', '--quiet', '--depth=1', '--no-tags', '--', origin.url, origin.commit], {
        network: origin.kind === 'git',
        localFetch: origin.kind === 'local',
        timeoutMs: 300_000
      })
      // Only the project's directory: a monorepo's other projects are not ours to copy.
      if (subdir) await git(['sparse-checkout', 'set', '--no-cone', `/${subdir}/`])
      await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { timeoutMs: 120_000 })
      const head = (await git(['rev-parse', 'HEAD'])).output.trim()
      if (head !== origin.commit) throw fail('source_changed', '拉到的提交与要固定的提交不一致')
      const meta = {
        commit: origin.commit,
        ref: ref ?? null,
        subdir: subdir || null,
        origin: { kind: origin.kind, label: origin.label, ...(origin.kind === 'local' ? { directory: origin.top } : { repoUrl: origin.url }) },
        capturedAt: new Date().toISOString()
      }
      await writeFile(join(staging, '.rig-snapshot.json'), JSON.stringify(meta, null, 2))
      await rename(staging, target)
      return { dir: target, ...meta }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  async #qaGit(base, args, options = {}) {
    return sourceGit(join(base, 'qa'), args, options)
  }

  /** Create the QA repository from the pack's seed, or record a new baseline in it. */
  async #qa(base, { app, pack, snapshot }) {
    const qa = join(base, 'qa')
    const exists = Boolean(await lstat(join(qa, '.git')).catch(() => null))
    const project = {
      pack: pack.id,
      packVersion: pack.version,
      app,
      source: { ref: snapshot.ref, commit: snapshot.commit, subdir: snapshot.subdir, origin: snapshot.origin.label }
    }
    if (!exists) {
      await ownDirectory(qa)
      for (const entry of pack.seed ?? []) {
        await cp(join(pack.dir, entry), join(qa, entry), {
          recursive: true,
          filter: (path) => !SKIP.has(basename(path))
        })
      }
      await writeFile(join(qa, '.gitignore'), 'node_modules/\nartifacts/\n')
      await mkdir(join(qa, '.rig'), { recursive: true })
      await writeFile(join(qa, '.rig', 'project.json'), JSON.stringify(project, null, 2) + '\n')
      await this.#qaGit(base, ['init', '--quiet', '--template=', '--initial-branch=main'])
      await this.#qaGit(base, ['add', '--all'])
      await this.#qaGit(base, [...AUTHOR, 'commit', '--quiet', '--no-verify', '-m', `初始：验收包 ${pack.id} ${pack.version}；源码 ${snapshot.ref ?? ''}@${snapshot.commit.slice(0, 7)}`])
      return
    }
    const current = await readJson(join(qa, '.rig', 'project.json')).catch(() => null)
    if (current?.source?.commit === snapshot.commit) return
    await writeFile(join(qa, '.rig', 'project.json'), JSON.stringify({ ...current, ...project }, null, 2) + '\n')
    await this.#qaGit(base, ['add', '.rig/project.json'])
    await this.#qaGit(base, [
      ...AUTHOR,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      `更新基准：${current?.source?.commit?.slice(0, 7) ?? '无'} → ${snapshot.ref ?? ''}@${snapshot.commit.slice(0, 7)}`
    ])
  }

  /**
   * Build (or bring up to date) the workspace of `app` from `pack`.
   * `source` is `{ kind: 'local', directory }` or `{ kind: 'git', repoUrl }`.
   */
  async create({ app, pack, source, ref = pack?.source?.ref, commit = pack?.source?.commit }, { signal } = {}) {
    appSlug(app)
    if (!pack?.dir) throw new RigError('invalid_input', '验收包无效')
    return this.#exclusive(app, async () => {
      const base = await this.#base(app)
      const origin = await this.#origin(source, ref, commit, { signal })
      let snapshot
      if (origin.kind === 'copy') {
        // A copied folder may be the project itself or contain it.
        const inner = pack.source?.subdir && (await lstat(join(origin.directory, pack.source.subdir)).catch(() => null))?.isDirectory()
        snapshot = await this.#copySnapshot(base, origin, { subdir: inner ? pack.source.subdir : null })
      } else {
        // A chosen subdirectory wins; a repository root falls back to the pack's.
        const subdir = origin.subdir || pack.source?.subdir || null
        snapshot = await this.#snapshot(base, origin, { ref, subdir }, signal)
      }
      await this.#qa(base, { app, pack, snapshot })
      return this.status(app)
    })
  }

  async status(app) {
    const base = join(this.root, appSlug(app))
    const snapshots = []
    for (const entry of await readdir(join(base, 'source')).catch(() => [])) {
      const meta = await readJson(join(base, 'source', entry, '.rig-snapshot.json')).catch(() => null)
      if (meta) snapshots.push({ name: entry, dir: join(base, 'source', entry), ...meta })
    }
    snapshots.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
    let qa = null
    const project = await readJson(join(base, 'qa', '.rig', 'project.json')).catch(() => null)
    if (project) {
      const log = await this.#qaGit(base, ['log', '-1', '--format=%H%x00%s%x00%cI'], { allowFailure: true }).catch(() => null)
      const [commit, subject, at] = (log?.output ?? '').trim().split('\0')
      qa = { commit: FULL_SHA.test(commit ?? '') ? commit : null, subject: subject ?? null, at: at ?? null, project }
    }
    const pinned = project?.source?.commit ?? null
    return {
      app,
      exists: Boolean(qa || snapshots.length),
      busy: this.pending.has(app),
      pinned,
      snapshot: snapshots.find((entry) => entry.commit === pinned) ?? null,
      snapshots,
      qa
    }
  }

  /**
   * How far the pinned commit is behind its branch. Read-only on a local
   * source; a remote one only says whether the branch moved.
   */
  async behind(app, { signal } = {}) {
    const state = await this.status(app)
    const snapshot = state.snapshot
    if (snapshot?.origin?.kind === 'copy') {
      // No branch to compare with: say whether the folder still holds what was copied.
      const current = await directoryFingerprint(snapshot.origin.directory).catch(() => null)
      return { tip: null, commits: null, changed: current ? current.hash !== snapshot.contentHash : null }
    }
    if (!snapshot?.ref) return null
    if (snapshot.origin.kind === 'local') {
      const top = snapshot.origin.directory
      const tip = await sourceGit(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${snapshot.ref}^{commit}`], { signal, allowFailure: true })
      if (tip.code !== 0) return { tip: null, commits: null }
      const count = await sourceGit(top, ['rev-list', '--count', `${snapshot.commit}..${tip.output.trim()}`], { signal, allowFailure: true })
      return { tip: tip.output.trim(), commits: count.code === 0 ? Number(count.output.trim()) : null }
    }
    const remote = await sourceGit(this.root, ['ls-remote', '--', snapshot.origin.repoUrl, `refs/heads/${snapshot.ref}`], { signal, network: true, allowFailure: true })
    const tip = remote.output.trim().split(/\s+/)[0] || null
    return { tip, commits: tip && tip !== snapshot.commit ? null : 0 }
  }

  async close() {
    await Promise.allSettled([...this.pending.values()])
  }
}
