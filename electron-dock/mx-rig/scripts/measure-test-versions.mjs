// How much space do published test versions take on the service (docs/23 §7)?
// A growing Playwright project goes through the real TestRepositories for N
// versions (default 200), bundled the way the desktop publishes them — full
// every tenth, incremental otherwise — and counted the way the service keeps
// them, with earlier increments dropped at each full version.
//
//   node scripts/measure-test-versions.mjs [versions]
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { TestRepositories } from '../packages/runtime/test-repository.mjs'

const VERSIONS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 200

const root = await mkdtemp(join(tmpdir(), 'rig-growth-'))
const repos = new TestRepositories(root)
await repos.ensure('big')
const pages = ['登录', '首页', '物资列表', '物资详情', '策略', '对话', '设置', '报表', '审批', '用户', '角色', '日志']
const spec = (n, rev) => {
  const page = pages[n % pages.length]
  const cases = Array.from({ length: 6 }, (_, i) => {
    const id = `BIG-WEB-${String(n).padStart(3, '0')}-${String(i + 1).padStart(3, '0')}`
    return `test('${id} ${page}：场景 ${i + 1} r${rev}', async ({ page }) => {
  await test.step('打开${page}', async () => {
    await page.goto('/${page}/${randomBytes(3).toString('hex')}')
    await expect(page.getByRole('heading', { name: '${page}' })).toBeVisible()
  })
  await test.step('填写并提交', async () => {
    await page.getByLabel('名称').fill('${randomBytes(6).toString('hex')}')
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByText('已保存')).toBeVisible({ timeout: ${1000 + ((n * 7 + i * 13 + rev) % 9) * 500} })
  })
})`
  })
  return `import { test, expect } from '@playwright/test'\nimport { signIn } from './helpers'\n\ntest.beforeEach(async ({ page }) => signIn(page))\n\n${cases.join('\n\n')}\n`
}
const revs = new Map()
let prev = null
let stored = []
let everything = 0
let peak = 0
const rows = []
for (let v = 1; v <= VERSIONS; v += 1) {
  // Each version touches 3 specs; every 4th version adds a new one.
  const count = revs.size
  const touch = new Set([count + (v % 4 === 1 ? 0 : -1), (v * 7) % Math.max(count, 1), (v * 13) % Math.max(count, 1)].filter((n) => n >= 0))
  const files = []
  const mappings = []
  for (const n of touch) {
    const rev = (revs.get(n) ?? 0) + 1
    revs.set(n, rev)
    files.push({ path: `tests/spec-${String(n).padStart(3, '0')}.spec.ts`, content: spec(n, rev) })
    mappings.push({ caseId: `BIG-WEB-${String(n).padStart(3, '0')}-001`, path: `tests/spec-${String(n).padStart(3, '0')}.spec.ts`, assertion: '保存成功' })
  }
  const written = await repos.commitImplementation('big', {
    missionId: randomUUID(),
    goal: `版本 ${v}`,
    implementation: { version: 1, caseRevision: 1, hash: randomBytes(32).toString('hex'), engine: 'playwright', platform: 'web', reviewedAt: new Date().toISOString(), files, mappings }
  })
  const merged = await repos.mergeToMain('big', written.commit)
  const commit = merged.commit ?? written.commit
  const checkpoint = v === 1 || v % 10 === 0
  const bundle = await repos.bundle('big', commit, checkpoint ? null : prev)
  const bytes = Buffer.byteLength(bundle, 'base64')
  everything += bytes
  if (checkpoint) stored = []
  stored.push(bytes)
  const now = stored.reduce((a, b) => a + b, 0)
  peak = Math.max(peak, now)
  await repos.tagVersion('big', v, commit)
  prev = commit
  if (v <= 2 || v % 50 === 0 || v === VERSIONS)
    rows.push({ v, specs: revs.size, kind: checkpoint ? 'full' : 'incremental', bundleKB: +(bytes / 1024).toFixed(1), storedKB: +(now / 1024).toFixed(1) })
}
console.table(rows)
console.log(`specs ${revs.size}, cases ${revs.size * 6}`)
console.log(`if nothing were pruned: ${(everything / 1024 / 1024).toFixed(2)} MB; stored after pruning: ${(stored.reduce((a, b) => a + b, 0) / 1024).toFixed(1)} KB; peak ${(peak / 1024).toFixed(1)} KB`)
await rm(root, { recursive: true, force: true })
