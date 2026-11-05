import { execFileSync } from 'node:child_process'

const [namespace, productId, format = '--json', ...extra] = process.argv.slice(2)
if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(productId ?? '') || productId === 'mx-common'
  || !['--json', '--dsn'].includes(format) || extra.length) {
  console.error('usage: manage.sh pg-credentials <productId> [--dsn]')
  process.exit(2)
}

const secret = `mx-common-db-${productId}`
try {
  const record = JSON.parse(execFileSync('kubectl', ['-n', namespace, 'get', 'secret', secret, '-o', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }))
  const fields = {}
  for (const key of ['username', 'password', 'database']) {
    const value = record.data?.[key]
    if (typeof value !== 'string' || !value) throw new Error('Missing credential field')
    fields[key] = Buffer.from(value, 'base64').toString('utf8')
    if (!fields[key] || fields[key].includes('\0')) throw new Error('Invalid credential field')
  }
  if (['mx_common', 'postgres'].includes(fields.username)) throw new Error('Expected a product role')

  const host = '127.0.0.1'
  const port = 2345
  const { username, password, database } = fields
  console.log(format === '--dsn'
    ? `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`
    : JSON.stringify({ host, port, username, password, database }))
} catch {
  // JSON parse errors can quote the Secret. Report only the resource name.
  console.error(`[mx-common] ERROR: cannot read product credentials from ${namespace}/${secret}`)
  process.exitCode = 1
}
