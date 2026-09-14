const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`
export const REQUEST_FORMATS = [
  { value: 'curl', label: 'cURL · macOS / Linux / Bash' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'fetch', label: 'fetch · 浏览器 JavaScript' },
  { value: 'node', label: 'fetch · Node.js 18+' },
]
export function requestSnippet({ format, url, body, credential, idempotencyKey }) {
  const headers = { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }
  const json = JSON.stringify(body)
  if (format === 'curl') return [
    `curl --request POST ${shellQuote(url)}`,
    ...Object.entries(headers).map(([name, value]) => `  --header ${shellQuote(`${name}: ${value}`)}`),
    `  --data-raw ${shellQuote(json)}`,
  ].join(' \\\n')
  if (format === 'powershell') return [
    '$headers = @{', ...Object.entries(headers).map(([name, value]) => `  ${psQuote(name)} = ${psQuote(value)}`), '}',
    `Invoke-RestMethod -Method Post -Uri ${psQuote(url)} -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes(${psQuote(json)}))`,
  ].join('\n')
  const call = `const response = await fetch(${JSON.stringify(url)}, ${JSON.stringify({ method: 'POST', headers, body: json }, null, 2)});\nconsole.log(response.status, await response.text());`
  if (format === 'fetch') return `(async () => {\n${call}\n})();`
  if (format === 'node') return `// 保存为 request.mjs，运行 node request.mjs\n${call}`
  throw new Error('Unsupported request format')
}
