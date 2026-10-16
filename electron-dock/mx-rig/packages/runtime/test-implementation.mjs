import { z } from 'zod'
import { createHash } from 'node:crypto'
import { RigError } from '../contracts/index.mjs'

// Proposals contain test source only. No shell command, package install or source edit.
export const testFilePath = z
  .string()
  .max(240)
  .regex(/^(?:tests|e2e|cypress\/e2e)\/[A-Za-z0-9_./-]+\.(?:spec|test|cy)\.(?:[cm]?js|tsx?)$/)
  .refine(
    (value) => value.split('/').every((part) => part && part !== '.' && part !== '..'),
    '只能使用测试目录内的相对文件路径'
  )
export const implementationBody = z
  .object({
    summary: z.string().trim().min(1).max(2000),
    engine: z.enum(['playwright', 'playwright-electron', 'cypress']),
    platform: z.enum(['web', 'electron']),
    files: z
      .array(z.object({ path: testFilePath, content: z.string().min(1).max(16000) }).strict())
      .min(1)
      .max(4),
    mappings: z
      .array(
        z
          .object({
            caseId: z.string().min(1).max(64),
            path: testFilePath,
            assertion: z.string().trim().min(1).max(1000)
          })
          .strict()
      )
      .min(1)
      .max(200)
  })
  .strict()
export const implementationEditBody = z
  .object({
    expectedVersion: z.number().int().min(0),
    caseRevision: z.number().int().min(1),
    proposal: implementationBody,
    sourceBaseline: z
      .object({
        id: z.uuid(),
        kind: z.enum(['local', 'git']),
        directory: z.string().min(1).max(4096),
        repoUrl: z.string().max(500).nullable(),
        ref: z.string().max(200).nullable(),
        commit: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .nullable(),
        branch: z.string().max(500).nullable(),
        dirty: z.boolean().nullable(),
        statusHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        capturedAt: z.iso.datetime(),
        observations: z
          .array(
            z
              .object({
                operation: z.enum(['read', 'list', 'search']),
                path: z.string().max(4096),
                hash: z.string().regex(/^[a-f0-9]{64}$/),
                fileHash: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional()
              })
              .strict()
          )
          .max(50)
      })
      .strict()
      .nullable()
      .optional()
  })
  .strict()
export const implementationApproveBody = z
  .object({
    expectedVersion: z.number().int().min(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
// JSONB reorders object keys; provenance must keep the same digest after storage.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value
export const implementationHash = (proposal) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        caseRevision: proposal.caseRevision,
        summary: proposal.summary,
        engine: proposal.engine,
        platform: proposal.platform,
        files: proposal.files,
        mappings: proposal.mappings,
        ...(proposal.sourceBaseline ? { sourceBaseline: canonical(proposal.sourceBaseline) } : {})
      })
    )
    .digest('hex')

export function checkImplementation(proposal, book) {
  if (!book.confirmed || proposal.caseRevision !== book.revision)
    throw new RigError('implementation_stale', '请先确认当前用例；代码提案必须对应这版用例', 409)
  if ((proposal.engine === 'playwright-electron') !== (proposal.platform === 'electron'))
    throw new RigError(
      'invalid_implementation',
      'Electron 使用 playwright-electron；Web 使用 Playwright 或 Cypress'
    )
  const paths = proposal.files.map((file) => file.path)
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length)
    throw new RigError('invalid_implementation', '测试文件路径不能重复（忽略大小写）')
  const ids = new Set()
  for (const mapping of proposal.mappings) {
    if (ids.has(mapping.caseId) || !paths.includes(mapping.path))
      throw new RigError('invalid_implementation', '用例映射不能重复，且必须指向提案中的文件')
    if (
      !book.cases.some(
        (entry) => entry.caseId === mapping.caseId && entry.platforms.includes(proposal.platform)
      )
    )
      throw new RigError(
        'invalid_implementation',
        `用例 ${mapping.caseId} 不在已确认的本平台范围内`
      )
    ids.add(mapping.caseId)
  }
  if (paths.some((path) => !proposal.mappings.some((mapping) => mapping.path === path)))
    throw new RigError('invalid_implementation', '每个测试文件都需要说明对应的用例和断言')
}
