export const TOKENIZE_CURL_TEMPLATE = [
  '(',
  '  exec 3</dev/tty || exit $?',
  "  printf 'API Key: ' >&2",
  '  IFS= read -r -s -u 3 MX_INSIGHT_API_KEY',
  '  MX_INSIGHT_READ_STATUS=$?',
  '  exec 3<&-',
  "  printf '\\n' >&2",
  '  [ "$MX_INSIGHT_READ_STATUS" -eq 0 ] || exit "$MX_INSIGHT_READ_STATUS"',
  '  printf \'header = "Authorization: Bearer %s"\\n\' "$MX_INSIGHT_API_KEY" | \\',
  '    curl --config - -sS -X POST "${MX_INSIGHT_HUB_URL:-https://hub.minsight-ai.com}/api/v1/tools/tokenize" \\',
  "      -H 'Content-Type: application/json' \\",
  '      -H "Idempotency-Key: ${MX_INSIGHT_IDEMPOTENCY_KEY:-tokenize-demo-001}" \\',
  "      --data '{\"text\":\"中文分词测试\"}'",
  '  MX_INSIGHT_CURL_STATUS=$?',
  '  unset MX_INSIGHT_API_KEY',
  '  exit "$MX_INSIGHT_CURL_STATUS"',
  ')',
].join('\n')

export async function copyText(text, {
  clipboard = globalThis.navigator?.clipboard,
  documentRef = globalThis.document,
} = {}) {
  try {
    if (typeof clipboard?.writeText === 'function') {
      await clipboard.writeText(text)
      return true
    }
  } catch {
    // HTTP-hosted Internal consoles may expose Clipboard API but reject it.
  }

  if (!documentRef?.body || typeof documentRef.createElement !== 'function') return false
  const textarea = documentRef.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  documentRef.body.appendChild(textarea)
  try {
    textarea.select()
    return documentRef.execCommand('copy') === true
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
