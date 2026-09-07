import assert from 'node:assert/strict'
import test from 'node:test'

import { renderReport } from '../server/report.mjs'

function reportFor(testCase, artifacts) {
  return renderReport({
    run: {
      id: 'trun_report',
      appId: 'app_compass',
      status: 'passed',
      profile: 'mock',
      track: 'functional',
      durationMs: 100,
      queuedAt: '2026-09-07T00:00:00.000Z',
      catalog: { counts: {}, coverage: {} },
    },
    cases: [{
      status: 'passed',
      attempts: 1,
      durationMs: 100,
      steps: [{ seq: 1, label: 'ready', status: 'passed', offsetMs: 10 }],
      ...testCase,
    }],
    artifacts,
    app: { displayName: 'Compass' },
    suite: { displayName: 'Electron smoke' },
  })
}

test('an unmatched singleton recording is not presented as case evidence', () => {
  const html = reportFor(
    { caseId: 'CPS-EL-BOOT-002', specPath: 'tests/boot.spec.ts' },
    [{ path: 'videos/CPS-EL-BOOT-001.webm' }],
  )
  assert.doesNotMatch(html, /<video[^>]+CPS-EL-BOOT-001\.webm/u)
  assert.match(html, /这个用例没有录像/u)
})

test('an explicitly declared per-case recording wins without filename guessing', () => {
  const html = reportFor(
    {
      caseId: 'CPS-EL-AUTH-001',
      specPath: 'tests/login.spec.ts',
      artifacts: [{ kind: 'video', path: 'videos/opaque-recording.webm' }],
    },
    [{ path: 'videos/opaque-recording.webm' }],
  )
  assert.match(html, /<video[^>]+opaque-recording\.webm/u)
})

test('a JUnit-like case with no steps still renders its exactly matched recording', () => {
  const html = reportFor(
    {
      caseId: 'CPS-EL-BOOT-001',
      specPath: 'tests/boot.spec.ts',
      steps: [],
    },
    [{ path: 'videos/CPS-EL-BOOT-001.webm' }],
  )
  assert.match(html, /<video[^>]+CPS-EL-BOOT-001\.webm/u)
  assert.match(html, /没有上报步骤/u)
})
