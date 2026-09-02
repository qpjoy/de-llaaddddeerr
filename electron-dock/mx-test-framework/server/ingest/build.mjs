import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

import { AppError } from '../core/errors.mjs'

// Closing out a `kind: build` run.
//
// A build run is not a test run with zero tests. It succeeds when there is an
// artefact, and the whole result is that artefact plus its digest — there are
// no cases, no catalog to compare against, and no drift to report. Pushing it
// through the test pipeline would produce a run that says "0 tests" and a
// catalog report claiming every registered case went unexecuted, which is true
// but meaningless and would poison the drift numbers for the real suites.
//
// The one rule it does inherit is the platform's oldest one:
//
//   零用例不是通过  →  没有产物不是构建成功
//
// A build command that exits 0 without producing anything is `blocked`, for the
// same reason a test command that runs nothing is. Both are the case where the
// exit code says success and nothing happened.

/** Where a build run's artefact is expected, relative to the run directory. */
export const PACKAGE_DIR = 'package'

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Find the single artefact a build run produced.
 *
 * More than one is an error rather than a guess. "Which .exe did we test" has
 * to have one answer, and picking the first alphabetically would answer it
 * differently after a version bump.
 */
export async function findBuildArtifact(artifacts, runId) {
  const files = (await artifacts.list(runId).catch(() => [])).filter((entry) =>
    entry.path.startsWith(`${PACKAGE_DIR}/`),
  )
  if (files.length === 0) return null
  if (files.length > 1) {
    throw new AppError(
      400,
      'build_artifact_ambiguous',
      `产物目录里有 ${files.length} 个文件，无法确定哪个是安装包`,
      { hint: `收窄 suite 的 artifactPath。当前找到：${files.map((f) => f.path).join('、')}` },
    )
  }
  return files[0]
}

/**
 * @returns {{status, blockedReason, package}} the run's outcome
 */
export async function completeBuildRun({ store, artifacts, run, exitCode, config }) {
  if (exitCode !== 0) {
    return {
      status: exitCode === 2 ? 'blocked' : 'failed',
      blockedReason: exitCode === 2 ? '构建受阻（退出码 2）' : null,
      package: null,
    }
  }

  const file = await findBuildArtifact(artifacts, run.id)
  if (!file) {
    // The inherited rule. A build that exits 0 and produced nothing is the same
    // shape of lie as a test run that reports zero cases and calls it green.
    return {
      status: 'blocked',
      blockedReason: '构建命令成功退出，但没有找到产物。检查 suite 的 artifactPath 是否匹配实际输出路径。',
      package: null,
    }
  }

  // The platform hashes the bytes it received rather than trusting a digest the
  // runner calculated. The runner executes code from the repository under test;
  // its arithmetic is not more trustworthy than its output.
  const absolute = artifacts.resolveWithin(run.id, file.path)
  const sha256 = await sha256File(absolute)
  const filename = file.path.slice(`${PACKAGE_DIR}/`.length)

  const pkg = {
    // Served by the platform itself. A build that has not been published to a
    // release system yet still has to be testable, and requiring an external
    // artefact store before the first desktop test can run would stall the
    // whole chain on infrastructure nobody has stood up.
    url: `${(config?.publicUrl || config?.selfUrl || '').replace(/\/$/u, '')}/runner/v1/runs/${run.id}/package`,
    sha256,
    filename,
    sizeBytes: file.bytes ?? null,
    version: run.sourceRef?.gitSha ? String(run.sourceRef.gitSha).slice(0, 12) : null,
    gitSha: run.sourceRef?.gitSha ?? null,
    buildRunId: run.id,
    publishedAt: new Date().toISOString(),
  }
  await store.setLatestPackage(run.appId, pkg)
  return { status: 'passed', blockedReason: null, package: pkg }
}
