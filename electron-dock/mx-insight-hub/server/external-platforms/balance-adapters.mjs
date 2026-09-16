import { AppError } from '../core/errors.mjs'

// Registry owns fixed origins, response contracts and native currencies. A new
// supplier adds one adapter plus a seeded monitoring policy, not a new scheduler.
export const BALANCE_PROVIDERS = Object.freeze({
  justone: {
    name: 'JustOne', currency: 'CNY',
    url: 'https://api.justoneapi.com/user/get-balance', successCode: 0,
    data: payload => payload.data,
  },
  tikhub: {
    name: 'TikHub', currency: 'USD',
    url: 'https://api.tikhub.io/api/v1/tikhub/user/get_user_info', successCode: 200,
    data: payload => payload.user_data,
  },
})

export function balanceError(code) { return new AppError(502, code, code) }

export function decimalAmount(value) {
  if (!['string', 'number'].includes(typeof value)) throw balanceError('invalid_balance')
  const text = String(value).trim()
  if (!/^-?\d{1,12}(?:\.\d{1,12})?$/.test(text)) throw balanceError('invalid_balance')
  const [integer, fraction = ''] = text.replace(/^-/, '').split('.')
  const units = (BigInt(integer) * 10n ** 12n + BigInt(fraction.padEnd(12, '0'))) * (text.startsWith('-') ? -1n : 1n)
  return { text, units }
}

export function balanceLevel(balance, warning, critical) {
  const units = decimalAmount(balance).units
  return units < decimalAmount(critical).units ? 'critical'
    : units < decimalAmount(warning).units ? 'warning' : 'healthy'
}

export async function queryProviderBalance(provider, credential, { fetchImpl = fetch, signal } = {}) {
  const adapter = BALANCE_PROVIDERS[provider]
  if (!adapter) throw balanceError('balance_provider_unsupported')
  if (!credential) throw balanceError('balance_credential_missing')
  const url = new URL(adapter.url)
  const headers = { Accept: 'application/json' }
  if (provider === 'justone') url.searchParams.set('token', credential)
  else headers.Authorization = `Bearer ${credential}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetchImpl(url.href, {
      method: 'GET', headers, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    })
    if (!response.ok) { await response.body?.cancel(); throw balanceError('balance_http_error') }
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > 65_536) { controller.abort(); throw balanceError('balance_response_too_large') }
      chunks.push(Buffer.from(chunk))
    }
    let payload
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw balanceError('balance_invalid_json') }
    if (payload?.code !== adapter.successCode) throw balanceError('balance_remote_rejected')
    const data = adapter.data(payload)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw balanceError('balance_invalid_response')
    // TikHub's balance is USD; free_credit is a separate allowance, never cash.
    if ((provider === 'justone' || data.currency != null) && data.currency !== adapter.currency) {
      throw balanceError('balance_currency_mismatch')
    }
    return { balance: decimalAmount(data.balance).text, currency: adapter.currency }
  } catch (error) {
    // Never persist or log fetch errors: JustOne authenticates in the URL.
    if (error instanceof AppError) throw error
    throw balanceError('balance_network_error')
  } finally { clearTimeout(timeout) }
}
