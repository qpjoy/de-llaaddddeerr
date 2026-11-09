// Test adapter speaking the delivered adapter.py protocol: one JSON request on
// stdin, one JSON envelope on stdout, logs on stderr.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const params = request.params || {}
const envelope = (status, result = null) => ({ schema_version: '1.0', project_id: 'echo', source_id: 'echo', operation: request.operation,
  observed_at: new Date().toISOString(), status, result, error: status === 'error' ? { code: 'SOURCE_ERROR' } : null })
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`)

switch (params.mode) {
  case 'sleep':
    process.stderr.write(`sleeping via ${process.env.HTTPS_PROXY || 'direct'}\n`)
    setTimeout(() => out(envelope('success')), 60_000)
    break
  case 'child': {
    // A helper in the same process group; it must die with the adapter.
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
    mkdirSync(params.work_dir, { recursive: true })
    writeFileSync(`${params.work_dir}/helper.pid`, String(helper.pid))
    setTimeout(() => {}, 60_000)
    break
  }
  case 'garbage': process.stdout.write('not json\n'); break
  case 'big': process.stdout.write('x'.repeat(params.bytes || 1024)); break
  case 'crash': process.exit(3); break
  case 'env':
    out(envelope('success', { env: { HTTPS_PROXY: process.env.HTTPS_PROXY ?? null, proxyLength: process.env.HTTPS_PROXY?.length ?? 0,
      HOME: process.env.HOME, PYTHONPATH: process.env.PYTHONPATH,
      TOKEN: process.env.MX_RUNNER_TOKEN ?? null, keys: Object.keys(process.env).sort() }, cwd: process.cwd(), params }))
    break
  case 'status': out(envelope(params.status, { items: [] })); break
  // Stateful packages: one step stores, a later step reads the same run_dir.
  case 'store': {
    const dir = params.run_dir || params.work_dir
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/state.json`, JSON.stringify({ value: params.value }))
    out(envelope(params.status || 'success', { items: [{ stored: params.value }] }))
    break
  }
  case 'load': {
    const dir = params.run_dir || params.work_dir
    out(envelope('success', { items: [JSON.parse(readFileSync(`${dir}/state.json`, 'utf8'))], dir }))
    break
  }
  default: out(envelope('success', { items: [{ id: 1 }], params }))
}
