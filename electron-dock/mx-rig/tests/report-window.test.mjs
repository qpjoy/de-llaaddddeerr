import test from 'node:test'
import assert from 'node:assert/strict'
import { REPORT_PATH, reportRequest } from '../apps/desktop/report-request.mjs'

// 桌面端在自己的窗口里打开执行报告：成员的凭据只加在这次执行的报告和产物请求上，
// 其他地址一律不发。

const origin = 'http://127.0.0.1:8791'
const runId = 'trun_abc123'
const ask = (url, method) => reportRequest(url, { origin, runId, method })

test('the report and its own artifacts carry the credential; nothing else does', () => {
  assert.deepEqual(ask(`${origin}/api/v1/runs/${runId}/report`), { allowed: true, credential: true })
  assert.deepEqual(ask(`${origin}/api/v1/runs/${runId}/report?redacted=true`), { allowed: true, credential: true })
  assert.deepEqual(ask(`${origin}/api/v1/runs/${runId}/artifacts/videos/a.mp4`), { allowed: true, credential: true })
  // The stylesheets the page links to are public: allowed, no credential.
  assert.deepEqual(ask(`${origin}/vendor/neon-void.css`), { allowed: true, credential: false })
  assert.deepEqual(ask(`${origin}/assets/report.css`), { allowed: true, credential: false })
  // neon-void.css opens with @import "./tokens.css": without it every colour is gone.
  assert.deepEqual(ask(`${origin}/vendor/tokens.css`), { allowed: true, credential: false })
})

test('another run, another API, another origin, a write or a path trick are refused', () => {
  const refused = { allowed: false, credential: false }
  assert.deepEqual(ask(`${origin}/api/v1/runs/trun_other/report`), refused)
  assert.deepEqual(ask(`${origin}/api/v1/runs/${runId}/artifacts/`), refused)
  assert.deepEqual(ask(`${origin}/api/v1/members`), refused)
  assert.deepEqual(ask(`${origin}/api/v1/runs/${runId}:cancel`), refused)
  assert.deepEqual(ask(`http://evil.test/api/v1/runs/${runId}/report`), refused)
  assert.deepEqual(ask(`http://user:pw@127.0.0.1:8791/api/v1/runs/${runId}/report`), refused)
  assert.deepEqual(ask(`${origin}/api/v1/runs/${runId}/report`, 'POST'), refused)
  assert.deepEqual(ask(`${origin}/vendor/neon-void.css?x=1`), refused)
  assert.deepEqual(ask('not a url'), refused)
  // URL parsing folds `..` away; what is left must still be this run's own.
  assert.deepEqual(ask(`${origin}/api/v1/runs/${runId}/artifacts/../../members`), refused)
})

test('only a run report path opens in the report window', () => {
  assert.equal(REPORT_PATH.exec(`/api/v1/runs/${runId}/report`)?.[1], runId)
  assert.equal(REPORT_PATH.test('/test-center/'), false)
  assert.equal(REPORT_PATH.test(`/api/v1/runs/${runId}/report/extra`), false)
})
