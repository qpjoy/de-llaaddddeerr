// Second-pass redaction, applied on ingest.
//
// Runners are expected to redact too (compass already does), but a runner
// executes code from the application repository under test, so the platform
// cannot treat its output as trusted. Everything that reaches the database goes
// through here first. See specs/05-tracks-and-artifacts.md.

const BEARER = /Bearer\s+[^\s,;"']+/giu
const LABELLED_SECRET =
  /\b(authorization|cookie|set-cookie|password|passwd|token|secret|api[-_ ]?key)\b(\s*[:=]\s*)([^\s,;"']+)/giu
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu

/** Strip credentials, query string and fragment from a URL. */
export function sanitizeUrl(value) {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/u, '')
  } catch {
    return ''
  }
}

export function redactText(value, limit = 4096) {
  if (typeof value !== 'string' || !value) return ''
  let text = value
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(LABELLED_SECRET, '$1$2[REDACTED]')
  text = text.replace(URL_PATTERN, (candidate) => sanitizeUrl(candidate) || '[REDACTED_URL]')
  return text.slice(0, limit)
}

/** Single-line variant for titles and labels, where newlines break table layout. */
export function redactLine(value, limit = 300) {
  return redactText(value, limit).replace(/[\r\n]+/gu, ' ').slice(0, limit)
}
