import { AppError } from '../core/errors.mjs'

export function parseNewsQueryTimeoutMs(value) {
  if (value == null || value === '') return 15_000
  const milliseconds = Number(value)
  if (!['string', 'number'].includes(typeof value)
    || !Number.isInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 60_000) {
    throw new AppError(500, 'invalid_configuration',
      'MX_INSIGHT_NEWS_QUERY_TIMEOUT_MS must be an integer between 1000 and 60000')
  }
  return milliseconds
}
