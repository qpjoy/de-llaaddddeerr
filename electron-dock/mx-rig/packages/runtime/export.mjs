// Agent explores, scripts regress.
//
// A mission that walked a page left a trail of actions (with the role and
// name each one really resolved to) and deterministic assertions. This turns
// that trail into a Playwright spec a person reviews before it joins a test
// pack. Nothing here runs anything; the output is text.

const quote = (value) => JSON.stringify(String(value ?? ''))
const regexLiteral = (value) => `/${String(value).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`

function locator(target) {
  if (!target) return null
  if (target.label !== undefined) return `page.getByLabel(${quote(target.label)}, { exact: true })`
  const base = target.name
    ? `page.getByRole(${quote(target.role)}, { name: ${quote(target.name)}, exact: true })`
    : `page.getByRole(${quote(target.role)})`
  return target.nth !== undefined ? `${base}.nth(${target.nth})` : base
}

function actionLine(action) {
  const line = plainLine(action)
  // A confirm the action said yes to: answered the same way in the script.
  if (!line || action.dialog !== 'accept') return line
  return `page.once('dialog', (dialog) => dialog.accept(${action.dialogText ? quote(action.dialogText) : ''}))\n  ${line}`
}

function plainLine(action) {
  const where = locator(action.target)
  switch (action.tool) {
    case 'browser_open':
      return `await page.goto(${quote(action.url)})`
    case 'browser_click':
      return where && `await ${where}.click()`
    case 'browser_fill':
      return where && `await ${where}.fill(${quote(action.value)})`
    case 'browser_select':
      return where && `await ${where}.selectOption(${quote(action.option)})`
    case 'browser_check':
      return where && `await ${where}.setChecked(${action.checked ? 'true' : 'false'})`
    case 'browser_press':
      return `await page.keyboard.press(${quote(action.key)})`
    case 'browser_wait':
      if (action.text)
        return `await page.getByText(${quote(action.text)}).first().waitFor({ state: ${quote(action.state)} })`
      return where && `await ${where}.waitFor({ state: ${quote(action.state)} })`
    default:
      return null
  }
}

function assertionLine(assertion) {
  const where = locator(assertion.target)
  switch (assertion.kind) {
    case 'text_visible':
      return `await expect(page.getByText(${quote(assertion.expected)}).first()).toBeVisible()`
    case 'text_absent':
      return `await expect(page.getByText(${quote(assertion.expected)})).toHaveCount(0)`
    case 'url_contains':
      return `await expect(page).toHaveURL(${regexLiteral(assertion.expected)})`
    case 'title_contains':
      return `await expect(page).toHaveTitle(${regexLiteral(assertion.expected)})`
    case 'element_visible':
      return where && `await expect(${where}).toBeVisible()`
    case 'element_checked':
      return where && `await expect(${where}).toBeChecked()`
    case 'value_equals':
      return where && `await expect(${where}).toHaveValue(${quote(assertion.expected)})`
    default:
      return null
  }
}

/** A case id a reviewer can keep or rename: stable for the same mission. */
function suggestedCaseId(mission) {
  return `RIG-${String(mission.id ?? '').slice(0, 8).toUpperCase()}`
}

/**
 * The spec, plus what a reviewer needs next to it: how many steps made it in,
 * what was left out and why, and a Case Catalog entry to adapt.
 */
export function exportPlaywright(mission, { now = new Date() } = {}) {
  const steps = []
  const skipped = []
  let truncated = Boolean(mission.truncated)
  for (const event of mission.events ?? []) {
    if (event.kind === 'tool_result') {
      const result = event.data?.result
      const action = event.data?.action ?? result?.action
      if (result?.truncated && !action) truncated = true
      if (!action || result?.error) continue
      const line = actionLine(action)
      if (line) steps.push(line)
      else skipped.push(action.tool)
    } else if (event.kind === 'assertion') {
      const assertion = event.data?.assertion
      if (!assertion) continue
      const line = assertionLine(assertion)
      if (line) steps.push(assertion.passed ? line : `// 探索时未通过，请确认预期后再启用：\n  // ${line}`)
      else skipped.push(assertion.kind)
    }
  }
  const caseId = suggestedCaseId(mission)
  const title = String(mission.goal ?? '探索路径').replace(/\s+/g, ' ').slice(0, 120)
  const warnings = [
    ...(truncated ? ['同步记录里较早的工具输出已被省略，导出可能缺少开头的步骤；请在执行它的桌面端导出完整版本。'] : []),
    ...(skipped.length ? [`有 ${skipped.length} 个步骤无法转成脚本（${[...new Set(skipped)].join('、')}）。`] : []),
    ...(steps.length ? [] : ['这项任务没有可导出的浏览器动作或断言。'])
  ]
  const catalogEntry = {
    caseId,
    title,
    priority: 'P2',
    automationState: 'implemented',
    source: `mx-rig mission ${mission.id}`
  }
  const content = [
    "import { test, expect } from '@playwright/test'",
    '',
    `// 由 MX Rig 任务 ${mission.id} 的探索记录生成，${now.toISOString()}。`,
    '// 这是草稿：请审阅定位方式、测试数据与断言，确认后再加入测试包与用例目录。',
    `// 建议的用例目录条目：${JSON.stringify(catalogEntry)}`,
    ...warnings.map((line) => `// 注意：${line}`),
    '',
    `test(${quote(`${caseId} ${title}`)}, async ({ page }) => {`,
    ...(steps.length ? steps.map((line) => `  ${line}`) : ['  // （没有步骤）']),
    '})',
    ''
  ].join('\n')
  return {
    filename: `${caseId.toLowerCase()}.spec.ts`,
    content,
    steps: steps.length,
    warnings,
    catalogEntry
  }
}
