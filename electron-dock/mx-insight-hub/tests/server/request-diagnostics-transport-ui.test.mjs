import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { projectTransportFailure } from '../../server/core/transport-failure-evidence.mjs'

const require = createRequire(import.meta.url)
const view = build({
  stdin: { contents: "export { RequestDiagnosticCall } from './request-diagnostics.jsx'", loader: 'js', resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)) },
  bundle: true, define: { 'import.meta.env': '{}' }, format: 'esm', jsx: 'automatic', platform: 'node', write: false,
  loader: { '.css': 'empty' },
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
}).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`))

async function render(transportFailure, transportFailureTooLarge = false) {
  const { RequestDiagnosticCall } = await view
  return renderToStaticMarkup(createElement(RequestDiagnosticCall, { provider: true,
    call: { id: 'call', provider: 'rapidapi', outcome: 'unknown', billed: null, hasArchive: true,
      transportFailure: projectTransportFailure(transportFailure), transportFailureTooLarge },
  }))
}

test('the request-stage card distinguishes transport evidence from final execution and billing', async () => {
  const html = await render({ phase: 'request', codes: ['UND_ERR_CONNECT_TIMEOUT', 'private-code'],
    elapsedMs: 4065, timeoutMs: 30000, deadlineExceeded: false, message: 'private-message', stack: 'private-stack' })
  assert.match(html, /请求阶段（尚未取得 HTTP 响应）/u)
  assert.match(html, /选路、连接、发送及等待响应头/u)
  assert.match(html, /UND_ERR_CONNECT_TIMEOUT/u)
  assert.match(html, /4065 ms/u)
  assert.match(html, /30000 ms/u)
  assert.match(html, /适配器总超时是否触发<\/dt><dd>否<\/dd>/u)
  assert.match(html, /未触发总超时仍可能有底层连接超时/u)
  assert.match(html, /结果未知/u)
  assert.match(html, /供应商实际计费<\/dt><dd>未知<\/dd>/u)
  assert.match(html, /此阶段仍需核对上游是否执行及最终费用/u)
  assert.match(html, /部分技术错误码未通过展示规则/u)
  assert.doesNotMatch(html, /private-|未派发|未发送|未产生供应商费用/u)
})

test('body-read failures show received-response context and preserve the recorded deadline flag', async () => {
  const html = await render({ phase: 'body', codes: ['UND_ERR_BODY_TIMEOUT'],
    elapsedMs: 30004, timeoutMs: 30000, deadlineExceeded: true })
  assert.match(html, /读取响应体/u)
  assert.match(html, /已取得 HTTP 响应，读取正文时失败/u)
  assert.match(html, /适配器总超时是否触发<\/dt><dd>是<\/dd>/u)
  assert.match(html, /30004 ms/u)
  assert.doesNotMatch(html, /尚未取得 HTTP 响应|未派发|未发送/u)
})

test('missing and oversized historical transport metadata do not invent a failure stage', async () => {
  const old = await render(null)
  assert.doesNotMatch(old, /传输失败证据|记录阶段|适配器总超时/u)
  const oversized = await render(null, true)
  assert.match(oversized, /传输失败元数据超过展示上限/u)
  assert.doesNotMatch(oversized, /记录阶段|适配器总超时/u)
  const partial = await render({ phase: 'other', deadlineExceeded: null, elapsedMs: 'private-time', timeoutMs: -1 })
  assert.match(partial, /保存的阶段未能识别/u)
  assert.match(partial, /适配器总超时是否触发<\/dt><dd>未记录<\/dd>/u)
  assert.doesNotMatch(partial, /private-time|false<\/dd>|true<\/dd>/u)
  const zero = await render({ phase: 'request', codes: [], deadlineExceeded: false, elapsedMs: 0, timeoutMs: 0 })
  assert.match(zero, /适配器配置超时<\/dt><dd>0 ms<\/dd>/u)
  assert.match(zero, /记录的传输耗时<\/dt><dd>0 ms<\/dd>/u)
  assert.match(zero, /适配器总超时是否触发<\/dt><dd>否<\/dd>/u)
})
