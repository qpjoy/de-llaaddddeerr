import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function page() {
  return readFile(new URL('../../src/pages.jsx', import.meta.url), 'utf8')
}

function block(source, start, end) {
  const i = source.indexOf(start)
  assert.notEqual(i, -1, `${start} must exist`)
  return source.slice(i, source.indexOf(end, i))
}

test('every catalogued platform belongs to a declared group', async () => {
  const source = await page()
  const catalog = block(source, 'const PLATFORM_CATALOG = [', '\n]')
    .split('\n').slice(1)
    .map((line) => line.trim().replace(/['",]/gu, ''))
    .filter(Boolean)
  const groups = block(source, 'const PLATFORM_GROUPS = [', '\nfunction platformGroupOf')
  const members = new Set([...groups.matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]))
  const prefixes = [...groups.matchAll(/prefix: '([a-z_]+)'/gu)].map((match) => match[1])

  assert.ok(catalog.length >= 30, 'the catalog is large enough that grouping matters')

  // A platform nobody grouped falls into "其他", which is where things go to be
  // forgotten. Adding one should be a deliberate placement.
  const ungrouped = catalog.filter((platform) => (
    !members.has(platform) && !prefixes.some((prefix) => platform.startsWith(prefix))
  ))
  assert.deepEqual(ungrouped, [], 'these platforms need a group in PLATFORM_GROUPS')
})

test('the filter spans platforms and both capability tables', async () => {
  const source = await page()

  // Searching must not hide a platform while leaving its business operation
  // visible below, so one predicate feeds every section.
  assert.match(source, /const matchesFilter = \(\.\.\.fields\) =>/u)
  assert.match(source, /\.filter\(\(row\) => matchesFilter\(row\.platform, platformLabel\(row\.platform\)\)\)/u)
  assert.match(source, /const visibleCapabilityRows = capabilityRows\.filter\(\(row\) => matchesFilter\(/u)

  // Id and label both match, so either spelling finds the row.
  assert.match(source, /row\.capability, row\.metadata\.label, row\.metadata\.endpoint,/u)
})

test('the enabled counts describe the catalog, not the current filter', async () => {
  const source = await page()

  // A filtered view must not read as if grants changed, so the headline count
  // stays whole and the filtered size is reported separately.
  assert.match(source, /section\.total\.filter\(\(row\) => row\.enabled\)\.length\} \/ \$\{section\.total\.length\}/u)
  assert.match(source, /筛选后显示 \$\{section\.rows\.length\} 项/u)
})

test('an empty result says so instead of rendering nothing', async () => {
  const source = await page()
  assert.match(source, /groupedPlatformRows\.length === 0 \?/u)
  assert.match(source, /没有匹配「\{capabilityFilter\}」的开放项/u)
})
