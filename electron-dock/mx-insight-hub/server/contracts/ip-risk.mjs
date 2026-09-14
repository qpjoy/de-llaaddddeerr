import { isIPv4 } from 'node:net'
import { AppError } from '../core/errors.mjs'

export const IP_RISK_PLATFORM = 'ip_risk'
export const IP_RISK_OPERATION = 'ip.risk.query'
export const IP_RISK_PATH = '/api/v1/data/ip/risk'
export const IP_RISK_VERSION = 'mx-insight-hub.ip-risk.v1'

export function normalizeIpRiskRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'ip')
    || typeof body.ip !== 'string' || !isIPv4(body.ip.trim())) {
    throw new AppError(400, 'invalid_ip_request', 'Provide one IPv4 address in the ip field')
  }
  return { ip: body.ip.trim() }
}

// Business projection follows the delivered SDK 0.1.0. Raw evidence is stored
// separately; no remote message, provider identity or credential is public.
export function normalizeIpRiskResponse(payload, secret = '') {
  if (!payload || ![200, '200'].includes(payload.code)) return { status: 'unknown', data: null, warnings: [] }
  if (!Object.hasOwn(payload, 'data')) return { status: 'unknown', data: null, warnings: [] }
  const content = payload.data
  const risk = content && Object.hasOwn(content, 'risk') ? content.risk : content
  if (risk == null || (typeof risk === 'object' && Object.keys(risk).length === 0)) {
    return { status: 'no_data', data: null, warnings: [] }
  }
  if (typeof risk !== 'object' || Array.isArray(risk)) return { status: 'unknown', data: null, warnings: [] }
  const warnings = []
  const text = value => {
    if (value == null || value === '') return null
    if (typeof value !== 'string' || value.length > 256 || /ipdatacloud|ip\s*数据云|https?:\/\//iu.test(value)
      || (secret && value.toLowerCase().includes(secret.toLowerCase()))) throw new Error('invalid')
    return value
  }
  const numeric = (value, percent) => {
    if (value == null || value === '') return null
    if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !value.trim())) throw new Error('invalid')
    const number = Number(percent && typeof value === 'string' ? value.replace(/%$/u, '') : value)
    if (!Number.isFinite(number) || (percent && (number < 0 || number > 100))) throw new Error('invalid')
    return number
  }
  const fields = { proxy: 'proxy_type', risk_score: 'risk_score', risk_level: 'risk_level', mb_rate: 'rapid_rotation_probability_percent', real: 'human_probability_percent', risk_tag: 'risk_tags' }
  const data = {}
  for (const [source, target] of Object.entries(fields)) {
    data[target] = null
    if (!Object.hasOwn(risk, source)) { warnings.push(`FIELD_MISSING:${target}`); continue }
    try {
      const value = risk[source]
      if (source === 'risk_tag') {
        if (value == null) continue
        const tags = Array.isArray(value) ? value : typeof value === 'object' ? (Object.keys(value).length ? [value] : []) : null
        if (!tags || tags.length > 1000) throw new Error('invalid')
        data[target] = []
        for (const tag of tags) {
          if (!tag || typeof tag !== 'object' || Array.isArray(tag)) { warnings.push('FIELD_INVALID:risk_tags'); continue }
          const item = {}
          for (const [old, name] of [['label', 'code'], ['label_name', 'name'], ['last_time', 'last_seen']]) {
            try { item[name] = text(tag[old]) } catch { item[name] = null; warnings.push(`FIELD_INVALID:risk_tags.${name}`) }
          }
          if (Object.values(item).some(value => value !== null)) data[target].push(item)
          else warnings.push('FIELD_INVALID:risk_tags')
        }
      } else data[target] = ['risk_score', 'mb_rate', 'real'].includes(source) ? numeric(value, source !== 'risk_score') : text(value)
    } catch { warnings.push(`FIELD_INVALID:${target}`) }
  }
  const meaningful = Object.values(data).some(value => value != null && (!Array.isArray(value) || value.length))
  return { status: meaningful ? (warnings.length ? 'partial' : 'success') : warnings.length ? 'unknown' : 'no_data', data, warnings }
}
