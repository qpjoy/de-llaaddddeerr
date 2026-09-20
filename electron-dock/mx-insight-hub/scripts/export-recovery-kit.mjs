#!/usr/bin/env node
// Small encrypted configuration escrow. NOT a PostgreSQL/Elasticsearch backup.
// The only external write is the operator-selected local .age file.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const namespaces = ['mx-common', 'mx-insight-hub']
const kinds = 'secrets,configmaps,deployments,statefulsets,services,pvc,networkpolicies,cronjobs'
const required = [
  ['mx-common', 'mx-common-secrets', ['postgres-password']],
  ['mx-common', 'mx-common-db-mx-insight-hub', ['password', 'database', 'username']],
  ['mx-insight-hub', 'mx-insight-hub-secrets', ['DATABASE_URL', 'MX_INSIGHT_API_KEY_PEPPER', 'MX_INSIGHT_ADMIN_TOKEN']],
]
export function validateResources(resources) {
  for (const [namespace, name, keys] of required) {
    const secret = resources[namespace]?.items?.find(r => r.kind === 'Secret' && r.metadata?.name === name)
    if (!secret || keys.some(key => !secret.data?.[key])) throw new Error('required recovery credentials are missing; values withheld')
  }
  for (const namespace of namespaces) {
    if (resources[namespace].items.some(r => r.metadata?.namespace !== namespace)) throw new Error('unexpected recovery resource namespace')
  }
}
// Keep UIDs/resourceVersions as evidence, never emit a blindly applicable file.
// New-host restoration must strip old binding/cluster identity deliberately.
export function configurationFingerprint(resources) {
  return JSON.stringify(namespaces.flatMap(namespace => resources[namespace].items
    .filter(r => ['Secret', 'ConfigMap'].includes(r.kind))
    .map(r => [namespace, r.kind, r.metadata.name, r.metadata.uid, r.metadata.resourceVersion])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))))
}
export function privateFile(filename) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 4 * 1024 * 1024) {
    throw new Error('recovery input must be a private regular file (0600), at most 4 MiB')
  }
  return fs.readFileSync(filename, 'utf8')
}
const invoke = (command, args, input) => {
  try {
    return execFileSync(command, args, { input, encoding: input ? undefined : 'utf8', timeout: 60000,
      maxBuffer: 32 * 1024 * 1024, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
  } catch { throw new Error(`${command} failed; private output withheld`) }
}
export function collectKit({ run = invoke, envFile, receiptFile, now = new Date().toISOString() }) {
  const get = (namespace, resource, extras = []) => JSON.parse(run('kubectl', ['--request-timeout=20s',
    ...(namespace ? ['-n', namespace] : []), 'get', resource, ...extras, '-o', 'json']))
  const envText = privateFile(envFile)
  const receiptText = privateFile(receiptFile)
  const resources = Object.fromEntries(namespaces.map(n => [n, get(n, kinds)]))
  validateResources(resources)
  const pvs = get(null, 'pv').items.filter(pv => namespaces.includes(pv.spec?.claimRef?.namespace))
  const nodes = get(null, 'nodes')
  const runningImages = namespaces.flatMap(namespace => get(namespace, 'pods').items.flatMap(pod =>
    [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])]
      .map(c => ({ namespace, pod: pod.metadata.name, container: c.name, image: c.image, imageID: c.imageID }))))
  const after = Object.fromEntries(namespaces.map(n => [n, get(n, 'secrets,configmaps')]))
  if (configurationFingerprint(resources) !== configurationFingerprint(after)
    || envText !== privateFile(envFile) || receiptText !== privateFile(receiptFile)) {
    throw new Error('configuration changed during capture; retry outside deployment/credential rotation')
  }
  let revision = null; let gitDirty = null
  try {
    revision = run('git', ['-C', project, 'rev-parse', 'HEAD']).trim()
    gitDirty = !!run('git', ['-C', project, 'status', '--porcelain', '--', '.', '../mx-common']).trim()
  } catch { /* include nullable source provenance */ }
  const kit = {
    format: 'mx-hub-recovery-kit', version: 1, createdAt: now, gitCommit: revision, gitDirty,
    containsDatabaseBackup: false,
    warning: 'Encrypted operator evidence, NOT kubectl apply input. Original node names, UIDs, PV claimRefs and storage identity must not be replayed on a new cluster.',
    resources, persistentVolumes: pvs, nodes, runningImages,
    files: { '.env.internal': envText, 'storage-identity.json': receiptText },
    excluded: ['PGDATA/base/WAL', 'Elasticsearch data/snapshots', 'backup repository encryption keys held outside these namespaces', 'Launcher/auth/VPN data', 'external Night-All data', 'container images and model files'],
  }
  return Buffer.from(JSON.stringify(kit))
}
export function publishEncryptedKit({ plaintext, recipient, output, run = invoke }) {
  if (!/^age1[0-9a-z]{58}$/.test(recipient ?? '')) throw new Error('a native age public recipient is required; never supply a private identity')
  if (!path.isAbsolute(output) || !output.endsWith('.age') || fs.existsSync(output)) throw new Error('choose a new absolute .age output path')
  // Reject symlinked directories; publishing is atomic, exclusive and 0600.
  const directory = path.dirname(output)
  if (fs.realpathSync(directory) !== directory) throw new Error('output directory must be canonical')
  if (!Buffer.isBuffer(plaintext) || plaintext.length > 16 * 1024 * 1024) throw new Error('configuration bundle exceeds 16 MiB')
  const encrypted = run('age', ['--encrypt', '--recipient', recipient], plaintext)
  if (!Buffer.isBuffer(encrypted) || !encrypted.subarray(0, 22).toString().startsWith('age-encryption.org/v1\n')) {
    throw new Error('age did not return an encrypted file')
  }
  const temporary = path.join(directory, `.mx-recovery-kit-${randomUUID()}.partial`)
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.linkSync(temporary, output) // no overwrite, including concurrent writers
    const fdDir = fs.openSync(directory, 'r')
    try { fs.fsyncSync(fdDir) } finally { fs.closeSync(fdDir) }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  return { output, bytes: encrypted.length, sha256: createHash('sha256').update(encrypted).digest('hex'), containsDatabaseBackup: false }
}
export function parseArgs(args) {
  const options = { envFile: path.join(project, '.env.internal'), receiptFile: '/var/lib/mx-common/storage-identity.json' }
  const flags = { '--recipient': 'recipient', '--output': 'output', '--env-file': 'envFile', '--receipt-file': 'receiptFile' }
  const seen = new Set()
  for (let i = 0; i < args.length; i += 2) {
    const key = flags[args[i]]
    if (!key || seen.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid arguments; use --help')
    options[key] = args[i + 1]; seen.add(key)
  }
  if (!options.recipient || !options.output) throw new Error('--recipient and --output are required')
  return options
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/export-recovery-kit.mjs --recipient age1PUBLIC_KEY --output /private/kit.age\nOptional --env-file /private/.env.internal --receipt-file /var/lib/mx-common/storage-identity.json\nRequires age and kubectl. Exports encrypted CONFIGURATION ONLY; no database backup, upload or production changes.')
  } else {
    try {
      const options = parseArgs(process.argv.slice(2))
      const plaintext = collectKit(options)
      try { console.log(JSON.stringify(publishEncryptedKit({ ...options, plaintext }), null, 2)) }
      finally { plaintext.fill(0) }
    } catch (error) {
      // Never forward filesystem/JSON errors: they may include private input.
      console.error('Recovery kit export failed; check age recipient/tool, private input files, cluster access and a new output path. Private output withheld.')
      process.exitCode = 1
    }
  }
}
