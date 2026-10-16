// 测试版本：项目测试仓库发布到服务器的版本（docs/23）。
//
// The service runs no Git. A version is a git bundle the publishing desktop
// made, kept as an opaque file, plus what can be checked without Git: which
// commit it is, which version it builds on, and the run that proved it — a
// passed run of this project that tested exactly this commit. Versions are
// only ever appended: someone may already be building on v3.
//
// Space (docs/23 §7): bundles are binary files on the artifacts volume, not
// JSON. Each is incremental over the version before, and every tenth is a full
// bundle — a checkpoint. History on the service is linear (a version must
// contain the one before), so a checkpoint holds everything earlier versions
// did, and their increments are dropped when it arrives. What a project keeps
// is about one copy of its compressed history plus the increments since.
// The files sit under the artifacts root, so they count toward its total, and
// a publish never eats into the free space the artifacts store keeps back.

import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RigError } from '../../packages/contracts/index.mjs'
import { readTestInput } from '../../packages/runtime/test-workspace.mjs'
import { PUBLISH_POLICY } from '../../packages/runtime/test-repository.mjs'
import { documentFor } from './state-documents.mjs'

const SHA = /^[a-f0-9]{40}$/
const MAX_BUNDLE = PUBLISH_POLICY.uploadBytes
export const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024
const publishBody = z
  .object({
    commit: z.string().regex(SHA),
    parent: z.string().regex(SHA).nullable(),
    branch: z.string().regex(/^(?:main|published|task\/[a-f0-9]{8})$/),
    summary: z.string().trim().min(1).max(500),
    runId: z.string().regex(/^[A-Za-z0-9_-]{4,80}$/),
    cases: z.array(z.string().min(1).max(64)).max(500).default([]),
    // A full bundle: everything up to this commit, no earlier version needed.
    checkpoint: z.boolean().default(false),
    bundle: z.string().min(16).max(Math.ceil((MAX_BUNDLE * 4) / 3) + 8)
  })
  .strict()

/** The run that proves a commit: it belongs to the project, passed, and tested that commit. */
export function provesCommit(run, { appId, commit }) {
  if (!run || run.appId !== appId) return '这次执行不属于这个项目'
  if (!['passed', 'flaky'].includes(run.status)) return '只有通过的执行才能证明一个版本'
  const ref = run.sourceRef ?? {}
  if (ref.gitSha !== commit && ref.version !== `QA ${commit.slice(0, 7)}`) return '这次执行测的不是这个提交'
  return null
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export class TestVersions {
  /**
   * `sourceFor(key)` gives the metadata document; `blobRoot` is where bundle
   * files live (the artifacts volume); `quotaBytes` caps one project;
   * `minFreeBytes` is the disk space a publish must leave free.
   */
  constructor(sourceFor, { blobRoot = null, quotaBytes = DEFAULT_QUOTA_BYTES, minFreeBytes = 0, statfsImpl = statfs } = {}) {
    this.sourceFor = sourceFor
    this.blobRoot = blobRoot
    this.quotaBytes = quotaBytes
    this.minFreeBytes = minFreeBytes
    this.statfsImpl = statfsImpl
    this.documents = new Map()
    this.queues = new Map()
  }
  #document(key) {
    if (!this.documents.has(key)) this.documents.set(key, documentFor(this.sourceFor(key)))
    return this.documents.get(key)
  }
  #file(appId, version) {
    return join(this.blobRoot, appId, `v${version}.bundle`)
  }
  async #writeBundle(appId, version, base64) {
    if (!this.blobRoot) return this.#document(`bundle-${appId}-${version}`).save({ bundle: base64 }, 0)
    await mkdir(join(this.blobRoot, appId), { recursive: true })
    const temp = join(this.blobRoot, appId, `.v${version}.${randomUUID()}.part`)
    await writeFile(temp, Buffer.from(base64, 'base64'), { mode: 0o600 })
    await rename(temp, this.#file(appId, version))
  }
  async #ensureRoom(bytes) {
    if (!this.blobRoot || !this.minFreeBytes) return
    await mkdir(this.blobRoot, { recursive: true })
    const filesystem = await this.statfsImpl(this.blobRoot)
    const available = Number(filesystem.bavail) * Number(filesystem.bsize)
    if (!Number.isFinite(available) || available - bytes < this.minFreeBytes)
      throw new RigError('storage_low', '服务器磁盘已到保留区，暂时不能发布测试版本。请运维清理旧执行产物或扩容。', 507)
  }
  async #readBundle(appId, version) {
    if (this.blobRoot) {
      const bytes = await readFile(this.#file(appId, version)).catch(() => null)
      if (bytes) return bytes.toString('base64')
    }
    // Versions published before bundles became files (M7) are still documents.
    return (await this.#document(`bundle-${appId}-${version}`).load()).value?.bundle ?? null
  }
  async #dropBundle(appId, version) {
    if (this.blobRoot) await rm(this.#file(appId, version), { force: true })
  }
  usage(versions) {
    const kept = versions.filter((row) => !row.pruned)
    return {
      bytes: kept.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
      quotaBytes: this.quotaBytes,
      versions: versions.length,
      stored: kept.length,
      checkpoint: [...versions].reverse().find((row) => row.checkpoint)?.version ?? null
    }
  }
  async list(appId) {
    const { value } = await this.#document(`versions-${appId}`).load()
    const versions = value?.versions ?? []
    return { versions: [...versions].reverse(), head: versions.at(-1) ?? null, usage: this.usage(versions) }
  }
  async bundle(appId, version) {
    const { value } = await this.#document(`versions-${appId}`).load()
    const entry = (value?.versions ?? []).find((row) => row.version === version)
    if (!entry) throw new RigError('not_found', '没有这个版本', 404)
    if (entry.pruned)
      throw new RigError('version_pruned', `v${version} 的内容已合并进完整版本 v${entry.prunedBy}，从 v${entry.prunedBy} 同步`, 410)
    const bundle = await this.#readBundle(appId, version)
    if (!bundle) throw new RigError('not_found', '这个版本的内容不在了', 404)
    return { version, commit: entry.commit, parent: entry.parent, checkpoint: Boolean(entry.checkpoint), bundle }
  }
  /** Append a version. `run` is the evidence, already read by the caller. */
  async publish(appId, principal, input, run) {
    const body = readTestInput(publishBody, input)
    const bytes = Buffer.from(body.bundle, 'base64')
    if (bytes.length > MAX_BUNDLE) throw new RigError('bundle_too_large', '测试版本超过 8 MB；测试仓库里不要放录像、构建产物或依赖', 413)
    if (!/^# v[23] git bundle\n/.test(bytes.subarray(0, 20).toString('latin1'))) throw new RigError('bundle_invalid', '上传的内容不是 git bundle')
    const refused = provesCommit(run, { appId, commit: body.commit })
    if (refused) throw new RigError('version_unproven', refused, 409)
    const previous = this.queues.get(appId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const document = this.#document(`versions-${appId}`)
      const { value, version: revision } = await document.load()
      const versions = value?.versions ?? []
      const head = versions.at(-1) ?? null
      if ((head?.commit ?? null) !== body.parent)
        throw new RigError('version_conflict', head ? `服务器上已有更新的版本 v${head.version}，先同步再发布` : '服务器上还没有版本，这次发布不应基于别的版本', 409)
      if (versions.some((row) => row.commit === body.commit)) throw new RigError('version_exists', '这个提交已经发布过', 409)
      // The first version has nothing to build on: it is always complete.
      const checkpoint = body.checkpoint || !head
      const projected = checkpoint ? bytes.length : this.usage(versions).bytes + bytes.length
      if (projected > this.quotaBytes)
        throw new RigError(
          'quota_exceeded',
          `这个项目的测试版本将占用 ${megabytes(projected)}，超过上限 ${megabytes(this.quotaBytes)}。发布一个完整版本会合并旧版本；仍超过说明仓库里有不该放的大文件。`,
          413
        )
      const entry = {
        version: versions.length + 1,
        commit: body.commit,
        parent: body.parent,
        branch: body.branch,
        summary: body.summary,
        runId: body.runId,
        cases: body.cases,
        bytes: bytes.length,
        checkpoint,
        publishedBy: principal.id,
        publisherName: principal.displayName ?? principal.id,
        publishedAt: new Date().toISOString()
      }
      await this.#ensureRoom(bytes.length)
      // The content first: a listed version must always have it.
      await this.#writeBundle(appId, entry.version, body.bundle)
      const rows = versions.map((row) => (checkpoint && !row.pruned ? { ...row, pruned: true, prunedBy: entry.version } : row))
      await document.save({ versions: [...rows, entry] }, revision)
      // Only after the list says so: earlier increments are inside this checkpoint now.
      if (checkpoint) for (const row of versions) if (!row.pruned) await this.#dropBundle(appId, row.version)
      return entry
    })
    const settled = next.catch(() => {})
    this.queues.set(appId, settled)
    settled.then(() => {
      if (this.queues.get(appId) === settled) this.queues.delete(appId)
    })
    return next
  }
}

export async function testVersionRoutes({ req, res, path, principal, store, projectAccess, versions, readJson, sendJson, requireRole }) {
  const match = /^\/api\/rig\/v1\/projects\/([a-z0-9][a-z0-9-]{0,62})\/test-versions(?:\/(\d{1,6})\/bundle)?$/.exec(path)
  if (!match) return false
  const app = await store.getAppBySlug(match[1])
  if (!app) throw new RigError('not_found', '没有这个项目', 404)
  await projectAccess.require(app.id, 'read', principal)
  if (req.method === 'GET' && match[2]) {
    sendJson(res, 200, await versions.bundle(app.id, Number(match[2])))
  } else if (req.method === 'GET') {
    sendJson(res, 200, await versions.list(app.id))
  } else if (req.method === 'POST' && !match[2]) {
    requireRole(principal, 'operator')
    await projectAccess.require(app.id, 'write', principal)
    const body = await readJson(req, Math.ceil((MAX_BUNDLE * 4) / 3) + 64 * 1024)
    const run = typeof body?.runId === 'string' ? await store.getRun(body.runId).catch(() => null) : null
    sendJson(res, 201, { version: await versions.publish(app.id, principal, body, run) })
  } else throw new RigError('not_found', '接口不存在', 404)
  return true
}

/**
 * A runner fetching the published versions its run executes (docs/23 M7b).
 * Authorised by the run's own token, only while the run is running, and only
 * for a run of the published-versions suite: a runner can read the tests it
 * was asked to run, and nothing else.
 */
export async function runnerTestVersionRoutes({ req, path, token, store, versions }) {
  const match = /^\/runner\/v1\/runs\/([A-Za-z0-9_-]{4,80})\/test-versions(?:\/(\d{1,6})\/bundle)?$/.exec(path)
  if (!match) return null
  if (req.method !== 'GET') throw new RigError('not_found', '接口不存在', 404)
  if (!token) throw new RigError('unauthorized', '需要本次执行的 run token', 401)
  const run = await store.getRunByTokenHash(createHash('sha256').update(token).digest('hex'))
  if (!run || run.id !== match[1]) throw new RigError('forbidden', '取测试版本需要本次执行的 run token', 403)
  if (run.status !== 'running') throw new RigError('run_not_running', '这次执行已经结束', 409)
  const suite = await store.getSuite(run.suiteId)
  if (!/^rig-published:\/\//.test(suite?.repoUrl ?? '')) throw new RigError('forbidden', '这次执行不跑已发布的测试版本', 403)
  return match[2] ? versions.bundle(run.appId, Number(match[2])) : versions.list(run.appId)
}
