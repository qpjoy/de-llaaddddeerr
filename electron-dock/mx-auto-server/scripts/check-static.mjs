import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const required = [
  'server/index.mjs',
  'server/migrate.mjs',
  'scripts/manage.sh',
  'deploy/k8s/internal/00-namespace.yaml',
  'deploy/k8s/internal/05-serviceaccount.yaml',
  'deploy/k8s/internal/08-resource-policy.yaml',
  'deploy/k8s/internal/10-artifacts-pvc.yaml',
  'deploy/k8s/internal/15-postgres.yaml',
  'deploy/k8s/internal/20-migration-job.yaml',
  'deploy/k8s/internal/30-server.yaml',
  'deploy/k8s/internal/35-nodeport.yaml',
  'deploy/k8s/internal/40-network-policy.yaml',
  'deploy/k8s/internal/kustomization.yaml'
]

for (const path of required) {
  if (!existsSync(resolve(root, path))) throw new Error(`missing required file: ${path}`)
}

const checks = [
  [process.execPath, ['--check', resolve(root, 'server/index.mjs')]],
  [process.execPath, ['--check', resolve(root, 'server/migrate.mjs')]],
  [process.execPath, ['--check', resolve(root, 'scripts/verify.mjs')]],
  [process.execPath, ['--check', resolve(root, 'scripts/onboard-compass.mjs')]],
  ['bash', ['-n', resolve(root, 'scripts/manage.sh')]]
]
for (const [command, args] of checks) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `${command} ${args.join(' ')} failed`)
}

const deployment = readFileSync(resolve(root, 'deploy/k8s/internal/30-server.yaml'), 'utf8')
if (/\bname:\s+MXT_/u.test(deployment)) {
  throw new Error('Kubernetes must expose MX_AUTO_* variables, not legacy MXT_* variables')
}

const rendered = spawnSync('kubectl', ['kustomize', resolve(root, 'deploy/k8s/internal')], {
  encoding: 'utf8'
})
if (rendered.error?.code === 'ENOENT') {
  console.log('static checks passed (kubectl kustomize skipped: kubectl not installed)')
} else if (rendered.status !== 0) {
  throw new Error(rendered.stderr || 'kubectl kustomize failed')
} else {
  if (!rendered.stdout.includes('name: mx-auto')) throw new Error('rendered manifests omit mx-auto')
  console.log('static checks and kubectl kustomize passed')
}
