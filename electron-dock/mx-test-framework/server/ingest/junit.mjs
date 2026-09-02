import { XMLParser } from 'fast-xml-parser'

import { AppError } from '../core/errors.mjs'

// JUnit XML → the platform's v2 summary shape.
//
// This is what makes MXT a platform rather than a Cypress harness. Nothing in
// the world emits `summary.json` natively, so every stack that wanted onto the
// platform had to write an adapter first. JUnit XML is emitted natively by
// pytest (`--junitxml`), Playwright (`--reporter=junit`), Cypress (via
// mocha-junit-reporter), WebdriverIO, k6, go test, Maven Surefire, PHPUnit and
// most things older than they are.
//
// The result is deliberately converted into a v2 summary and then handed to
// `normalizeSummary` rather than written straight to the store: redaction,
// duplicate detection, exit-code arbitration and catalog comparison all live
// there, and a second path into the database would be a second place for them
// to drift apart.
//
// What JUnit cannot carry: steps, tracks, per-case artifacts. Suites that want
// a step timeline and a clickable recording keep writing `summary.json`. The
// trade is explicit — JUnit gets any framework onto the platform at case-level
// fidelity, and the native format buys back the extra detail.

const CASE_ID_IN_TEXT = /\b([A-Z][A-Z0-9]{1,9}(?:-[A-Z0-9]{1,10}){1,3}-\d{3})\b/u

// Attributes are prefixed so `name` (attribute) and a hypothetical `name`
// child element can never collide, and entities are decoded so an error
// message reading `expected <div>` survives the round trip.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: true,
  // Every testcase must be shaped the same way whether the document has one or
  // many, otherwise the caller ends up writing `Array.isArray` everywhere.
  isArray: (name) => ['testsuite', 'testcase', 'property', 'failure', 'error', 'skipped'].includes(name),
})

const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value])

/** Milliseconds from JUnit's `time`, which is fractional seconds. */
function durationMs(value) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 0
}

/** The text of `<failure>`/`<error>`: message attribute, body, or both. */
function failureText(node) {
  const message = typeof node?.['@message'] === 'string' ? node['@message'] : ''
  const body = typeof node?.['#text'] === 'string' ? node['#text'] : ''
  const type = typeof node?.['@type'] === 'string' ? node['@type'] : ''
  return [type && message ? `${type}: ${message}` : type || message, body]
    .filter(Boolean)
    .join('\n')
    .trim()
}

/**
 * The case id for one `<testcase>`.
 *
 * Three levels, most explicit first — the same ordering 03-case-catalog.md
 * defines. A test that matches none of them still gets an id so that it shows
 * up as `unmapped` in the drift report: silently dropping tests nobody
 * registered would hide exactly the thing drift detection exists to surface.
 */
export function caseIdFor(testcase) {
  for (const property of asArray(testcase?.properties?.property)) {
    const key = property?.['@name']
    if (key === 'caseId' || key === 'case_id' || key === 'testCaseId') {
      const value = property?.['@value']
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 64)
    }
  }
  const name = typeof testcase?.['@name'] === 'string' ? testcase['@name'] : ''
  const classname = typeof testcase?.['@classname'] === 'string' ? testcase['@classname'] : ''
  const matched = CASE_ID_IN_TEXT.exec(name) ?? CASE_ID_IN_TEXT.exec(classname)
  if (matched) return matched[1]

  const synthetic = [classname, name].filter(Boolean).join('::') || 'unnamed'
  return `~${synthetic}`.slice(0, 64)
}

function statusFor(testcase) {
  if (asArray(testcase.failure).length > 0 || asArray(testcase.error).length > 0) return 'failed'
  if (asArray(testcase.skipped).length > 0) return 'skipped'
  // Surefire's rerun elements: the test ended green but not on the first try.
  if (testcase.flakyFailure || testcase.flakyError || testcase.rerunFailure) return 'flaky'
  return 'passed'
}

function collectSuites(node, out = []) {
  for (const suite of asArray(node?.testsuite)) {
    out.push(suite)
    // Nested testsuites are legal and pytest emits them for parametrized
    // classes. Recurse rather than only reading the top level.
    collectSuites(suite, out)
  }
  return out
}

/**
 * @param {string|string[]} documents one or more JUnit XML documents
 * @returns {object} a schemaVersion-2 summary ready for `normalizeSummary`
 */
export function junitToSummary(documents) {
  const sources = (Array.isArray(documents) ? documents : [documents]).filter(
    (entry) => typeof entry === 'string' && entry.trim(),
  )
  if (sources.length === 0) {
    throw new AppError(400, 'junit_invalid', 'junit 里没有任何内容')
  }

  const cases = []
  let durationTotal = 0

  for (const source of sources) {
    // A DOCTYPE is the entry point for entity-expansion attacks and has no
    // legitimate use in a JUnit report. The runner is not a trusted source
    // (ADR-0005), so refuse rather than try to parse around it.
    if (/<!DOCTYPE/iu.test(source)) {
      throw new AppError(400, 'junit_invalid', 'junit 文档不允许包含 DOCTYPE')
    }
    let document
    try {
      document = parser.parse(source)
    } catch (error) {
      throw new AppError(400, 'junit_invalid', `junit 解析失败：${error.message}`.slice(0, 300))
    }

    // Both shapes occur in the wild: a <testsuites> root, or a bare <testsuite>.
    const suites = collectSuites(document.testsuites ?? document).concat(
      document.testsuites ? [] : asArray(document.testsuite),
    )
    const unique = [...new Set(suites)]

    for (const suite of unique) {
      const specPath =
        (typeof suite['@file'] === 'string' && suite['@file']) ||
        (typeof suite['@name'] === 'string' && suite['@name']) ||
        null
      for (const testcase of asArray(suite.testcase)) {
        const status = statusFor(testcase)
        const ms = durationMs(testcase['@time'])
        durationTotal += ms
        const failure = asArray(testcase.failure)[0] ?? asArray(testcase.error)[0] ?? null
        cases.push({
          caseId: caseIdFor(testcase),
          status,
          durationMs: ms,
          title: typeof testcase['@name'] === 'string' ? testcase['@name'] : null,
          spec: typeof testcase['@file'] === 'string' ? testcase['@file'] : specPath,
          error: failure ? failureText(failure) : null,
          // JUnit has no notion of a step. Left empty on purpose rather than
          // synthesised from the failure text, which would invent a timeline
          // that never existed.
          steps: [],
        })
      }
    }
  }

  const counted = (status) => cases.filter((entry) => entry.status === status).length
  return {
    schemaVersion: 2,
    // No status field: `normalizeSummary` derives it, and the exit code wins.
    // Zero cases therefore lands on the platform's `blocked` rule rather than
    // being reported here as a pass with nothing in it.
    totals: {
      tests: cases.length,
      passed: counted('passed'),
      failed: counted('failed'),
      skipped: counted('skipped'),
      flaky: counted('flaky'),
      durationMs: durationTotal,
    },
    cases,
  }
}
