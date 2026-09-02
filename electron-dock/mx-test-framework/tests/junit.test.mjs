import assert from 'node:assert/strict'
import test from 'node:test'

import { junitToSummary, caseIdFor } from '../server/ingest/junit.mjs'
import { normalizeSummary } from '../server/ingest/summary.mjs'

// The point of these fixtures is that they are shaped the way each tool
// actually writes them, not the way a single spec says they should be. JUnit
// XML has no authoritative schema, and the differences between these four are
// exactly what an ingest claiming to be framework-agnostic has to absorb.

const PYTEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" time="2.51">
    <testcase classname="tests.test_agent" name="test_sql_generation" time="1.2">
      <properties><property name="caseId" value="HUB-API-SQL-001"/></properties>
    </testcase>
    <testcase classname="tests.test_agent" name="test_retrieval_ranking" time="0.9">
      <failure message="assert 0.61 &gt; 0.8">tests/test_agent.py:42: AssertionError</failure>
    </testcase>
    <testcase classname="tests.test_agent" name="test_slow_path" time="0.41">
      <skipped type="pytest.skip" message="needs GPU"/>
    </testcase>
  </testsuite>
</testsuites>`

// Playwright writes a <testsuites> root with one <testsuite> per spec file and
// carries the file path on the testcase itself.
const PLAYWRIGHT = `<testsuites id="" name="" tests="2" failures="1" time="4.10">
  <testsuite name="strategy.spec.ts" timestamp="2026-09-01T00:00:00.000Z" hostname="chromium" tests="2" failures="1" time="4.1">
    <testcase name="LP-FE-STRATEGY-001 保存草稿后可回填" classname="strategy.spec.ts" time="2.0" file="tests/strategy.spec.ts"/>
    <testcase name="策略中心筛选" classname="strategy.spec.ts" time="2.1" file="tests/strategy.spec.ts">
      <failure message="Timed out 5000ms" type="Error">Locator not found</failure>
    </testcase>
  </testsuite>
</testsuites>`

// mocha-junit-reporter, which is how Cypress emits JUnit. Bare <testsuite>
// root is legal and it writes a synthetic "Root Suite" with no cases.
const MOCHA = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" time="3.0" tests="2" failures="0">
  <testsuite name="Root Suite" timestamp="2026-09-01T00:00:00" tests="0" file="cypress/e2e/smoke/auth.cy.ts" time="0"/>
  <testsuite name="登录" timestamp="2026-09-01T00:00:00" tests="2" time="3.0">
    <testcase name="LP-FE-AUTH-001 未登录跳转登录页" time="1.5" classname="未登录跳转登录页"/>
    <testcase name="LP-FE-AUTH-002 密码错误提示" time="1.5" classname="密码错误提示"/>
  </testsuite>
</testsuites>`

// go test -json | go-junit-report: nested suites, error rather than failure.
const GOTEST = `<testsuites>
  <testsuite name="pkg/router" tests="1" failures="1" time="0.030">
    <testcase classname="pkg/router" name="TestRouteSelection" time="0.030">
      <error message="panic" type="panic">runtime error: index out of range</error>
    </testcase>
  </testsuite>
</testsuites>`

test('pytest output becomes cases with the right statuses', () => {
  const summary = junitToSummary(PYTEST)
  assert.equal(summary.schemaVersion, 2)
  assert.equal(summary.totals.tests, 3)
  assert.equal(summary.totals.passed, 1)
  assert.equal(summary.totals.failed, 1)
  assert.equal(summary.totals.skipped, 1)
  assert.equal(summary.totals.durationMs, 2510)

  const [first, second, third] = summary.cases
  // An explicit <property name="caseId"> is the strongest association and must
  // beat anything guessable from the test name.
  assert.equal(first.caseId, 'HUB-API-SQL-001')
  assert.equal(first.status, 'passed')
  assert.equal(second.status, 'failed')
  // The entity in `assert 0.61 &gt; 0.8` has to survive decoding.
  assert.match(second.error, /assert 0\.61 > 0\.8/u)
  assert.match(second.error, /test_agent\.py:42/u)
  assert.equal(third.status, 'skipped')
})

test('playwright output keeps the case id embedded in the test name', () => {
  const summary = junitToSummary(PLAYWRIGHT)
  assert.equal(summary.cases[0].caseId, 'LP-FE-STRATEGY-001')
  assert.equal(summary.cases[0].spec, 'tests/strategy.spec.ts')
  assert.equal(summary.cases[1].status, 'failed')
  // No case id anywhere: it still has to appear, tagged so the drift report can
  // call it unmapped rather than dropping it on the floor.
  assert.match(summary.cases[1].caseId, /^~/u)
})

test('a bare testsuite root and an empty suite are both handled', () => {
  const summary = junitToSummary(MOCHA)
  assert.equal(summary.totals.tests, 2)
  assert.deepEqual(
    summary.cases.map((entry) => entry.caseId),
    ['LP-FE-AUTH-001', 'LP-FE-AUTH-002'],
  )
})

test('go test errors count as failures, not as a separate thing', () => {
  const summary = junitToSummary(GOTEST)
  assert.equal(summary.totals.failed, 1)
  assert.match(summary.cases[0].error, /panic/u)
  assert.match(summary.cases[0].error, /index out of range/u)
})

test('several documents from one run are merged', () => {
  // Cypress and Playwright both write one file per spec.
  const summary = junitToSummary([PLAYWRIGHT, GOTEST])
  assert.equal(summary.totals.tests, 3)
  assert.equal(summary.totals.failed, 2)
})

// -- the platform's rules still apply -----------------------------------------

test('a JUnit report with no tests is blocked, never a pass', () => {
  // The whole reason the exit-code contract exists: a suite that ran nothing
  // must not be green. Going through normalizeSummary is what guarantees the
  // JUnit path obeys the same rule as the native one.
  const summary = junitToSummary('<testsuites></testsuites>'.replace('</testsuites>', '<testsuite name="x" tests="0"/></testsuites>'))
  const normalized = normalizeSummary(summary, 0)
  assert.equal(normalized.status, 'blocked')
  assert.equal(normalized.totals.tests, 0)
})

test('the exit code still overrides what the report claims', () => {
  const normalized = normalizeSummary(junitToSummary(PYTEST), 2)
  assert.equal(normalized.status, 'blocked')
})

test('failures in the report make the run fail even on exit code 0', () => {
  const normalized = normalizeSummary(junitToSummary(PYTEST), 0)
  assert.equal(normalized.status, 'failed')
})

test('error text is redacted on the way in', () => {
  const xml = `<testsuites><testsuite name="s" tests="1">
    <testcase classname="c" name="n" time="0.1">
      <failure message="request failed">authorization: Bearer sk-live-abcdefghijklmnop</failure>
    </testcase></testsuite></testsuites>`
  const normalized = normalizeSummary(junitToSummary(xml), 1)
  assert.ok(
    !normalized.cases[0].errorText.includes('sk-live-abcdefghijklmnop'),
    'a token pasted into an assertion message must not be stored verbatim',
  )
})

// -- untrusted input -----------------------------------------------------------

test('a DOCTYPE is refused rather than parsed around', () => {
  // The runner executes code from the repository under test, so its output is
  // untrusted input. Entity expansion is the classic way to turn an XML parser
  // into a file reader or a memory bomb.
  const xxe = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<testsuites><testsuite name="s" tests="1"><testcase name="&xxe;" classname="c"/></testsuite></testsuites>`
  assert.throws(() => junitToSummary(xxe), /DOCTYPE/u)
})

test('empty or non-XML input is a clear error, not a silent empty pass', () => {
  assert.throws(() => junitToSummary([]), /没有任何内容/u)
  assert.throws(() => junitToSummary(''), /没有任何内容/u)
})

test('a case id is always produced, even for a nameless test', () => {
  assert.equal(caseIdFor({ '@name': 'LP-FE-X-001 something' }), 'LP-FE-X-001')
  assert.equal(caseIdFor({ '@classname': 'a', '@name': 'b' }), '~a::b')
  assert.equal(caseIdFor({}), '~unnamed')
})
