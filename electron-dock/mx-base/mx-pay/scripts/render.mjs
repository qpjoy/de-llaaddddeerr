import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCredentials } from '../server/config.mjs'

export const hash = value => createHash('sha256').update(value).digest('hex')
export function databaseEnv(filename) {
  const values = {}
  for (const line of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const match = /^([A-Z_]+)=(.*)$/.exec(line)
    if (!match || !['MX_PAY_DATABASE_URL','MX_PAY_DB_POOL_SIZE','MX_PAY_RUNTIME_ROLE'].includes(match[1]) || Object.hasOwn(values, match[1])) throw new Error('Database env file requires unique supported KEY=value lines, without shell quoting')
    values[match[1]] = match[2]
  }
  const url = new URL(values.MX_PAY_DATABASE_URL)
  if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || url.pathname === '/' || !url.username) throw new Error('Dedicated PostgreSQL URL required')
  if (['host','port','database','user','password'].some(key => url.searchParams.has(key))) throw new Error('Database identity fields must be in the URL authority/path, not query overrides')
  if (values.MX_PAY_DB_POOL_SIZE && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(values.MX_PAY_DB_POOL_SIZE)) throw new Error('Invalid pool size')
  if (values.MX_PAY_RUNTIME_ROLE && !/^[a-z_][a-z0-9_]{0,62}$/.test(values.MX_PAY_RUNTIME_ROLE)) throw new Error('Invalid runtime PostgreSQL role')
  return { values, identity: hash(`${url.hostname}:${url.port || '5432'}${url.pathname}`) }
}
export function render(env = process.env) {
  const namespace = env.MX_PAY_NAMESPACE || 'mx-pay'
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace)) throw new Error('Invalid namespace')
  const runtime = databaseEnv(env.MX_PAY_RUNTIME_ENV_FILE), migration = databaseEnv(env.MX_PAY_MIGRATION_ENV_FILE)
  if (runtime.identity !== migration.identity) throw new Error('Runtime and migration must target the same payment database')
  readCredentials(env.MX_PAY_CREDENTIALS_SOURCE)
  const credentialJson = readFileSync(env.MX_PAY_CREDENTIALS_SOURCE, 'utf8')
  const image = env.MX_PAY_IMAGE || '', replicas = Number(env.MX_PAY_REPLICAS || 2)
  const nodeLoaded=/^local\.mx\/mx-pay:[a-f0-9]{64}$/.test(image) && env.MX_PAY_IMAGE_DELIVERY==='nodes'
  if (!nodeLoaded && !/^[-a-zA-Z0-9.:/_]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Kubernetes requires an immutable image digest or a verified content-addressed node image')
  if (!Number.isInteger(replicas) || replicas < 2 || replicas > 20) throw new Error('MX_PAY_REPLICAS must be 2–20')
  const runtimeName = `mx-pay-runtime-${hash(JSON.stringify(runtime.values) + credentialJson).slice(0,16)}`
  const migrationName = `mx-pay-migration-${hash(JSON.stringify(migration.values)).slice(0,16)}`
  const labels = { 'app.kubernetes.io/name': 'mx-pay', 'app.kubernetes.io/part-of': 'mx-pay' }
  const base = (kind, name, apiVersion = 'v1') => ({ apiVersion, kind, metadata: { name, namespace, labels } })
  const envFrom = name => [{ secretRef: { name } }]
  const containerSecurity = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } }
  const podSecurity = { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } }
  const placement = { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [
    { key: 'node-role.kubernetes.io/control-plane', operator: 'DoesNotExist' }, { key: 'node-role.kubernetes.io/master', operator: 'DoesNotExist' },
  ] }] } } }
  if (nodeLoaded) {
    const nodes=JSON.parse(readFileSync(env.MX_PAY_IMAGE_NODES_FILE,'utf8'))
    if (!Array.isArray(nodes) || new Set(nodes).size<2 || nodes.some(n=>! /^[a-z0-9][a-z0-9.-]{0,252}$/.test(n))) throw new Error('At least two verified image nodes required')
    placement.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchFields=[{key:'metadata.name',operator:'In',values:nodes}]
  }
  const imagePullPolicy=nodeLoaded ? 'Never' : 'IfNotPresent'
  const pullSecrets = env.MX_PAY_IMAGE_PULL_SECRET ? [{ name: env.MX_PAY_IMAGE_PULL_SECRET }] : []
  if (pullSecrets.some(s => !/^[a-z0-9][-a-z0-9.]{0,251}[a-z0-9]$/.test(s.name))) throw new Error('Invalid image pull Secret')
  const secret = (name, values) => ({ ...base('Secret',name), immutable: true, type: 'Opaque', data: Object.fromEntries(Object.entries(values).map(([k,v]) => [k,Buffer.from(v).toString('base64')])) })
  const secrets = { apiVersion: 'v1', kind: 'List', items: [secret(runtimeName, { ...runtime.values, 'credentials.json': credentialJson }), secret(migrationName,migration.values)] }
  const jobName = env.MX_PAY_JOB_NAME
  if (!/^mx-pay-migrate-[a-z0-9-]+$/.test(jobName || '')) throw new Error('Invalid migration Job name')
  const job = { ...base('Job',jobName,'batch/v1'), spec: { backoffLimit: 0, activeDeadlineSeconds: 240, ttlSecondsAfterFinished: 86400,
    template: { metadata: { labels: { ...labels, 'mx-pay-role': 'migration' } }, spec: {
      automountServiceAccountToken: false, restartPolicy: 'Never', securityContext: podSecurity, affinity: placement, imagePullSecrets: pullSecrets,
      containers: [{ name: 'migrate', image, imagePullPolicy, command: ['node','server/migrate.mjs'], envFrom: envFrom(migrationName), securityContext: containerSecurity,
        resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } } }],
    } } } }
  const apiLabels = { ...labels, 'mx-pay-role': 'api' }
  const workload = { apiVersion: 'v1', kind: 'List', items: [
    { ...base('Service','mx-pay'), spec: { selector: apiLabels, ports: [{ name: 'http', port: 18230, targetPort: 'http' }] } },
    { ...base('PodDisruptionBudget','mx-pay','policy/v1'), spec: { minAvailable: 1, selector: { matchLabels: apiLabels } } },
    { ...base('Deployment','mx-pay','apps/v1'), spec: { replicas, revisionHistoryLimit: 5, minReadySeconds: 5, progressDeadlineSeconds: 300,
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }, selector: { matchLabels: apiLabels },
      template: { metadata: { labels: apiLabels }, spec: { automountServiceAccountToken: false, terminationGracePeriodSeconds: 35,
        securityContext: podSecurity, affinity: placement, imagePullSecrets: pullSecrets,
        topologySpreadConstraints: [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'DoNotSchedule', labelSelector: { matchLabels: apiLabels } }],
        volumes: [{ name: 'credentials', secret: { secretName: runtimeName, items: [{ key: 'credentials.json', path: 'credentials.json' }], defaultMode: 292 } }],
        containers: [{ name: 'api', image, imagePullPolicy, ports: [{ name: 'http', containerPort: 18230 }],
          env: Object.entries(runtime.values).map(([name]) => ({ name, valueFrom: { secretKeyRef: { name: runtimeName, key: name } } })).concat([{ name: 'MX_PAY_CREDENTIALS_FILE', value: '/run/mx-pay/credentials.json' }]),
          volumeMounts: [{ name: 'credentials', mountPath: '/run/mx-pay', readOnly: true }], securityContext: containerSecurity,
          resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1000m', memory: '384Mi' } },
          startupProbe: { httpGet: { path: '/health/ready', port: 'http' }, periodSeconds: 3, timeoutSeconds: 12, failureThreshold: 20 },
          readinessProbe: { httpGet: { path: '/health/ready', port: 'http' }, periodSeconds: 2, timeoutSeconds: 12 },
          livenessProbe: { httpGet: { path: '/health/live', port: 'http' }, periodSeconds: 10, timeoutSeconds: 2 },
        }],
      } },
    } },
  ] }
  const installation = { ...base('ConfigMap','mx-pay-installation'), data: { databaseIdentity: runtime.identity, lastAttemptImage: image, contractVersion: '2',
    runtimeSecret:runtimeName,migrationSecret:migrationName,imageRepository:env.MX_PAY_IMAGE_REPOSITORY || '',imageDelivery:nodeLoaded ? 'nodes' : 'registry',
    serviceURL:`http://mx-pay.${namespace}.svc.cluster.local:18230`,
  } }
  return { secrets, job, workload, installation }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2]
    if (mode === 'validate') {
      const runtime = databaseEnv(process.env.MX_PAY_RUNTIME_ENV_FILE), migration = databaseEnv(process.env.MX_PAY_MIGRATION_ENV_FILE)
      if (runtime.identity !== migration.identity) throw new Error('Different payment databases')
      readCredentials(process.env.MX_PAY_CREDENTIALS_SOURCE)
      console.log('Payment database and credentials configuration validated (values hidden)')
    } else if (mode === 'workers') {
      const nodes = JSON.parse(readFileSync(0,'utf8')).items
      const count = nodes.filter(n => !n.spec?.unschedulable && !Object.hasOwn(n.metadata.labels || {},'node-role.kubernetes.io/control-plane')
        && !Object.hasOwn(n.metadata.labels || {},'node-role.kubernetes.io/master') && n.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True')).length
      const minimum = Number(process.env.MX_PAY_MIN_READY_WORKERS || 2)
      if (!Number.isInteger(minimum) || minimum < 2 || count < minimum) throw new Error(`At least ${Math.max(2,minimum)} ready, schedulable worker nodes required; discovered ${count}. Deployment cannot create machines or silently reduce availability`)
      console.log(`Ready worker nodes: ${count}; workload scheduling and capacity will be verified by rollout`)
    } else if (mode === 'check-installation') {
      const previous = readFileSync(0,'utf8').trim()
      if (previous && JSON.parse(previous).data.databaseIdentity !== databaseEnv(process.env.MX_PAY_RUNTIME_ENV_FILE).identity) throw new Error('Database identity differs from retained installation; ordinary deploy cannot move databases')
    } else {
      const output = render()
      for (const [name,document] of Object.entries(output)) writeFileSync(resolve(process.argv[2], `${name}.json`), JSON.stringify(document), { mode: 0o600 })
    }
  } catch (error) {
    console.error(error instanceof SyntaxError || error instanceof TypeError ? 'mx-pay preflight: invalid configuration format (values hidden)' : `mx-pay preflight: ${error.message}`)
    process.exitCode = 1
  }
}
