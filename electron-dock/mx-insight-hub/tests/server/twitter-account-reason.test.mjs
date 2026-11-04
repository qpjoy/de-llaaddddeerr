import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { twitterAccountFailureMessage } from '../../server/contracts/twitter-account-failure.mjs'

const require = createRequire(import.meta.url)
const environment = { tenant: false }
globalThis.__accountReasonView = environment
// The real ErrorState, with React hooks, portals, charts and icons stubbed out.
const view = build({
  stdin: { contents: "export { ErrorState } from './components.jsx'", loader: 'js', resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)) },
  bundle: true, format: 'esm', jsx: 'automatic', platform: 'node', write: false,
  plugins: [{ name: 'error-state-boundaries', setup(builder) {
    builder.onResolve({ filter: /^react\/jsx-runtime$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
    builder.onResolve({ filter: /^(?:react|react-dom|chart\.js\/auto|@phosphor-icons\/react)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents: path === 'react'
      ? 'const env=globalThis.__accountReasonView; const noop=()=>{}; export const createContext=value=>({value}), useContext=()=>env.tenant, useCallback=fn=>fn, useEffect=noop, useId=()=>"id", useLayoutEffect=noop, useMemo=fn=>fn(), useRef=value=>({current:value}), useState=value=>[value,noop]'
      : path === 'react-dom' ? 'export const createPortal=node=>node'
        : path === 'chart.js/auto' ? 'export default class Chart {}'
          : 'const icon=()=>null; export const ArrowClockwise=icon, CaretDown=icon, Check=icon, CheckCircle=icon, CircleNotch=icon, Copy=icon, Info=icon, MagnifyingGlass=icon, WarningCircle=icon, X=icon, XCircle=icon' }))
  } }],
}).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`))

const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree) ? tree.map(text).join('') : tree?.props ? text(tree.props.children) : ''
const failure = (code, details, message = 'The upstream provider reported that the Twitter account is unavailable') =>
  ({ code, message, requestId: 'd7853a32-d423-43d8-8214-010255efbe2b', details: { platform: 'twitter', stage: 'account_lookup', outcome: 'rejected', retryable: false, ...details } })

test('the public message names a reported account state and keeps the generic wording otherwise', () => {
  for (const [reason, state] of [['suspended', 'is suspended'], ['deactivated', 'is deactivated'], ['protected', 'is protected'],
    ['deleted', 'was deleted'], ['not_found', 'was not found'], ['unavailable', 'is unavailable'], [undefined, 'is unavailable'],
    ['toString', 'is unavailable'], [42, 'is unavailable']]) {
    assert.equal(twitterAccountFailureMessage({ errorCode: 'social_account_unavailable', accountReason: reason }),
      `The upstream provider reported that the Twitter account ${state}`, String(reason))
  }
  assert.equal(twitterAccountFailureMessage({ errorCode: 'social_account_not_found' }),
    'The upstream provider reported that the Twitter account was not found')
})

test('the admin error panel labels a Twitter account state in Chinese, beside the code and Request ID', async () => {
  const { ErrorState } = await view
  const render = error => text(ErrorState({ error }))
  for (const [reason, label] of [['suspended', '账号已被 Twitter 封禁（suspended）'], ['deactivated', '账号已停用（deactivated）'],
    ['protected', '账号受保护，资料不公开（protected）'], ['deleted', '账号已删除（deleted）'], ['not_found', 'Twitter 上没有该账号（not_found）'],
    ['unavailable', 'Twitter 报告账号不可用，未说明原因（unavailable）'], ['something_new', 'Twitter 报告账号不可用，未说明原因（unavailable）']]) {
    const shown = render(failure('social_account_unavailable', { reason }))
    assert.match(shown, new RegExp(`原因：${label.replace(/[()（）]/g, '.')}。这是平台上的账号状态，不是 Hub 故障`), reason)
    assert.match(shown, /错误码：social_account_unavailable · Request ID：d7853a32-d423-43d8-8214-010255efbe2b/)
  }
  // A historical body keeps its generic message; the label still comes from its saved details.
  assert.match(render(failure('social_account_unavailable', { reason: 'suspended' })), /^The upstream provider reported that the Twitter account is unavailable/)
  assert.match(render(failure('social_account_not_found', {}, 'The upstream provider reported that the Twitter account was not found')), /原因：Twitter 上没有该账号（not_found）/)
  for (const error of [
    failure('external_platform_rejected', { reason: 'suspended' }),
    { ...failure('social_account_unavailable', { reason: 'suspended' }), details: { platform: 'facebook', stage: 'account_lookup', reason: 'suspended' } },
    { code: 'social_account_unavailable', message: 'No details' },
  ]) assert.doesNotMatch(render(error), /原因：/)
})

test('tenant pages hide the supplier message but still show the account state', async () => {
  const { ErrorState } = await view
  environment.tenant = true
  try {
    const shown = text(ErrorState({ error: failure('social_account_unavailable', { reason: 'suspended' }, 'The upstream provider reported that the Twitter account is suspended') }))
    assert.doesNotMatch(shown, /upstream|provider/)
    assert.match(shown, /原因：账号已被 Twitter 封禁（suspended）/)
  } finally { environment.tenant = false }
})
