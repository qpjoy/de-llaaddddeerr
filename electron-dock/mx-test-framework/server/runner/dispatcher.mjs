import { readFile } from 'node:fs/promises'

// Turns a queued server-side run into a Kubernetes Job.
//
// Talks to the API server over plain HTTPS with the pod's ServiceAccount token
// rather than pulling in a client library: the platform needs exactly one verb
// on one resource in its own namespace, and a dependency that can do far more
// than that is a liability, not a convenience.

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'

export class KubernetesDispatcher {
  #token = null
  #ca = null

  constructor({ config, namespace, logger = console, fetchImpl = globalThis.fetch }) {
    this.config = config
    this.namespace = namespace
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.apiBase =
      process.env.KUBERNETES_SERVICE_HOST &&
      `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT || 443}`
  }

  get available() {
    return Boolean(this.apiBase)
  }

  async #credentials() {
    if (this.#token) return { token: this.#token, ca: this.#ca }
    this.#token = (await readFile(`${SA_DIR}/token`, 'utf8')).trim()
    this.#ca = await readFile(`${SA_DIR}/ca.crt`, 'utf8').catch(() => null)
    return { token: this.#token, ca: this.#ca }
  }

  imageFor(suite) {
    if (suite.runnerImage) return suite.runnerImage
    const image = this.config.runnerImages[suite.engine]
    if (!image) {
      // Refusing beats defaulting. Running a Python suite in a Cypress image
      // would fail somewhere deep inside the test command, and the reason would
      // be reported as a test failure rather than as configuration.
      throw new Error(
        `suite "${suite.slug}" 的引擎 ${suite.engine} 没有默认镜像，请在 suite 上指定 runnerImage`,
      )
    }
    return image
  }

  /**
   * The script a runner container executes.
   *
   * Three properties this script has to hold, each of them learned the hard way:
   *
   * 1. **No silent degradation.** Every step that can fail either succeeds or
   *    ends the run as `blocked`. A dependency tree installed by a different
   *    package manager than the lockfile describes is not the tree under test,
   *    so falling back from pnpm to npm is worse than stopping.
   * 2. **The checkout is named.** `git fetch` of an explicit ref plus
   *    `rev-parse HEAD` is what makes "which commit was that failure on"
   *    answerable. A bare `clone --depth 1` can only ever get the default
   *    branch tip, which is a different commit every time you look.
   * 3. **The suite command never touches a shell.** It is handed to
   *    `spawnSync(argv[0], argv.slice(1), { shell: false })`, so a suite whose
   *    command contains shell metacharacters gets a "command not found", not an
   *    execution. The API-side allowlist is the first gate; this is the second.
   */
  script({ apiBase }) {
    return `set -u
export CI=1
mkdir -p "$MXT_ARTIFACTS_DIR"
SUMMARY="$MXT_ARTIFACTS_DIR/summary.json"
export SUMMARY
WORK=/work/repo

# Written as files rather than inlined with -e so that neither the suite command
# nor the summary contents ever pass through a shell parser.
cat > /tmp/mxt-report.js <<'MXT_EOF'
const fs = require('node:fs')
const path = require('node:path')
let exitCode = Number(process.argv[2])
let summary

// The generic path. A suite that writes JUnit XML — pytest, Playwright,
// Cypress, k6, go test — needs no knowledge of this platform's own format, and
// the platform needs no knowledge of the suite's language. Only used when the
// suite did not write a summary.json, which carries strictly more.
const junitDir = path.join(process.env.MXT_ARTIFACTS_DIR, 'junit')
function readJunit() {
  let entries
  try {
    entries = fs.readdirSync(junitDir).filter((name) => name.toLowerCase().endsWith('.xml'))
  } catch {
    return null
  }
  const documents = []
  for (const name of entries.slice(0, 200)) {
    try {
      documents.push(fs.readFileSync(path.join(junitDir, name), 'utf8'))
    } catch {
      // A file that cannot be read is dropped rather than failing the whole
      // report: the rest of the run's results are still worth recording.
    }
  }
  return documents.length > 0 ? documents : null
}

if (!fs.existsSync(process.env.SUMMARY)) {
  const junit = readJunit()
  if (junit) {
    fs.writeFileSync('/tmp/payload.json', JSON.stringify({ exitCode, junit }))
    process.exit(exitCode)
  }
}

try {
  summary = JSON.parse(fs.readFileSync(process.env.SUMMARY, 'utf8'))
} catch (error) {
  // A summary that cannot be parsed is an infrastructure failure, not a pass.
  // The commonest cause is the container dying mid-write.
  summary = {
    schemaVersion: 2,
    runId: process.env.MXT_RUN_ID,
    app: process.env.MXT_APP,
    status: 'blocked',
    totals: { tests: 0 },
    blockedReason: \`summary.json unreadable: \${error.message}\`.slice(0, 400),
  }
  // The exit code has to move too. The platform resolves a disagreement between
  // the code and the summary in favour of the code, so leaving a 0 here would
  // turn a half-written summary into a green run — the exact false pass the
  // whole exit-code contract exists to prevent.
  exitCode = 2
}
if (process.env.MXT_SOURCE_SHA) {
  summary.sourceRef = {
    ...(summary.sourceRef || {}),
    ref: process.env.MXT_SOURCE_REF || null,
    gitSha: process.env.MXT_SOURCE_SHA,
  }
}
fs.writeFileSync('/tmp/payload.json', JSON.stringify({ exitCode, summary }))
// Hand the effective code back to the shell so the container exits with the
// code the platform was actually told about, not the one it started with.
process.exit(exitCode)
MXT_EOF

cat > /tmp/mxt-exec.js <<'MXT_EOF'
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const argv = JSON.parse(process.env.MXT_COMMAND_JSON)

// Credentials for the application under test reach only this child process.
//
// They are read from a file written by curl and merged here, so they never
// enter the shell's own environment — /proc/<shell pid>/environ stays clean,
// and nothing that inspects the wrapper sees them. The file is unlinked as
// soon as it is read.
const env = { ...process.env }
try {
  const raw = fs.readFileSync('/tmp/mxt-secrets.json', 'utf8')
  fs.unlinkSync('/tmp/mxt-secrets.json')
  for (const [name, value] of Object.entries(JSON.parse(raw).secrets ?? {})) {
    env[name] = value
  }
} catch {
  // No secrets file is the normal case for a suite that declared none.
}

const result = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', shell: false, env })
if (result.error) {
  console.error(\`[mxt] cannot execute \${argv[0]}: \${result.error.message}\`)
  process.exit(2)
}
process.exit(result.status === null ? 2 : result.status)
MXT_EOF

cat > /tmp/mxt-blocked.js <<'MXT_EOF'
const fs = require('node:fs')
fs.writeFileSync(process.env.SUMMARY, JSON.stringify({
  schemaVersion: 2,
  runId: process.env.MXT_RUN_ID,
  app: process.env.MXT_APP,
  status: 'blocked',
  totals: { tests: 0 },
  blockedReason: process.argv[2].slice(0, 400),
}))
MXT_EOF

# finish <exitCode> — hand the result to the platform, then leave.
# Reporting is retried because a run whose result never arrives sits in
# \`running\` until its lease expires, which reads as a hang rather than a result.
finish() {
  node /tmp/mxt-report.js "$1"
  effective=$?
  attempt=1
  while [ "$attempt" -le 3 ]; do
    if curl -sS -f -X POST "${apiBase}/runner/v1/runs/$MXT_RUN_ID:complete" \\
        -H "authorization: Bearer $MXT_RUN_TOKEN" \\
        -H "content-type: application/json" \\
        --data-binary @/tmp/payload.json; then
      exit "$effective"
    fi
    echo "[mxt] report attempt $attempt failed" >&2
    attempt=$((attempt + 1))
    sleep 5
  done
  # EX_TEMPFAIL: the run happened but the platform never heard about it. This is
  # the one case where the Job should show up as failed.
  echo "[mxt] giving up after 3 report attempts" >&2
  exit 75
}

# blocked <reason> — an infrastructure failure. Never a pass, never a red test.
blocked() {
  echo "[mxt] blocked: $1" >&2
  node /tmp/mxt-blocked.js "$1"
  finish 2
}

if [ -n "\${MXT_REPO_URL:-}" ]; then
  if [ -n "\${MXT_GIT_TOKEN:-}" ]; then
    # The token stays in the environment. Putting it in the remote URL would
    # write it into .git/config and expose it in the process table.
    git config --global credential.helper \\
      '!f() { echo username=x-access-token; echo "password=$MXT_GIT_TOKEN"; }; f' \\
      || blocked "cannot configure git credentials"
  fi
  mkdir -p "$WORK" || blocked "cannot create workspace"
  cd "$WORK" || blocked "cannot enter workspace"
  git init -q . || blocked "git init failed"
  git remote add origin "$MXT_REPO_URL" || blocked "cannot set git remote"
  git fetch -q --depth 1 origin "$MXT_SOURCE_REF" \\
    || blocked "git fetch of '$MXT_SOURCE_REF' failed (missing ref, or no credentials for a private repo)"
  git checkout -q FETCH_HEAD || blocked "git checkout failed"
  MXT_SOURCE_SHA=$(git rev-parse HEAD) || blocked "cannot resolve checked out commit"
  export MXT_SOURCE_SHA
  echo "[mxt] checked out $MXT_SOURCE_REF @ $MXT_SOURCE_SHA"
else
  mkdir -p "$WORK" || blocked "cannot create workspace"
  cd "$WORK" || blocked "cannot enter workspace"
fi

# The project root inside the checkout. Monorepos keep the lockfile and the
# suite somewhere other than the top level, and installing at the wrong level
# either fails or silently builds the wrong dependency tree.
if [ -n "\${MXT_WORKING_DIR:-}" ]; then
  cd "$MXT_WORKING_DIR" || blocked "working directory '$MXT_WORKING_DIR' not found in the checkout"
fi

# One lockfile, one package manager. No cross-fallback: installing with a
# package manager the lockfile was not written for produces a different
# dependency tree, and a test run against a different tree proves nothing.
if [ -f pnpm-lock.yaml ]; then
  command -v pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 \\
    || blocked "pnpm-lock.yaml present but pnpm is unavailable in this image"
  pnpm install --frozen-lockfile || blocked "pnpm install --frozen-lockfile failed"
elif [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund || blocked "npm ci failed"
elif [ -f yarn.lock ]; then
  yarn install --frozen-lockfile || blocked "yarn install --frozen-lockfile failed"
elif [ -f package.json ]; then
  blocked "package.json has no lockfile; refusing to install an unpinned dependency tree"
fi

# Credentials are fetched here, not injected into the Job manifest. A manifest
# is readable by anyone who can run \`kubectl get job -o yaml\`; the run token
# used below is scoped to this single run and dies with it.
#
# -o writes straight to a file so the values never become a shell variable, and
# -f makes a rejection an error rather than a file containing an error page.
# A failure is fatal: a suite that asked for credentials and silently started
# without them fails inside a login form, and the report then says "element not
# found" instead of "the secret is missing".
if ! curl -sS -f -o /tmp/mxt-secrets.json \\
    -H "authorization: Bearer $MXT_RUN_TOKEN" \\
    "${apiBase}/runner/v1/runs/$MXT_RUN_ID/secrets"; then
  blocked "无法获取被测应用的密钥"
fi

node /tmp/mxt-exec.js
MXT_EXIT=$?

# A command that reported nothing at all is blocked, not passed. Zero cases is
# never a pass — that rule is what stops a suite whose browser never started
# from looking like a clean run.
if [ ! -f "$SUMMARY" ] && [ -z "$(ls "$MXT_ARTIFACTS_DIR"/junit/*.xml 2>/dev/null)" ]; then
  blocked "runner produced neither summary.json nor junit/*.xml"
fi

finish "$MXT_EXIT"
`
  }

  /**
   * Which commit the run is pinned to.
   *
   * `HEAD` means "whatever the remote's default branch points at now", which is
   * the only honest way to describe an unpinned run. It is a fallback, not a
   * default worth relying on: the resolved sha is read back after checkout and
   * travels with the result either way.
   */
  static sourceRefFor(run, app, suite) {
    return (
      run?.sourceRef?.ref?.trim() ||
      suite?.defaultBranch?.trim() ||
      app?.defaultBranch?.trim() ||
      'HEAD'
    )
  }

  /** The repository holding this suite's test code — its own, or the app's. */
  static repoUrlFor(app, suite) {
    return suite?.repoUrl?.trim() || app?.repoUrl?.trim() || null
  }

  manifest({ run, suite, app, env, runToken, apiBase }) {
    const name = `mxt-run-${run.id.replace(/[^a-z0-9-]/giu, '').toLowerCase()}`.slice(0, 63)
    const jobEnv = [
      ...Object.entries(env).map(([key, value]) => ({ name: key, value: String(value) })),
      { name: 'MXT_RUN_TOKEN', value: runToken },
      { name: 'MXT_SOURCE_REF', value: KubernetesDispatcher.sourceRefFor(run, app, suite) },
      // The suite command travels as JSON in the environment, never as text
      // spliced into the script. See `script()`.
      { name: 'MXT_COMMAND_JSON', value: JSON.stringify(suite.command ?? []) },
    ]
    const repoUrl = KubernetesDispatcher.repoUrlFor(app, suite)
    if (repoUrl) {
      jobEnv.push({ name: 'MXT_REPO_URL', value: repoUrl })
    }
    if (suite.workingDir) {
      jobEnv.push({ name: 'MXT_WORKING_DIR', value: suite.workingDir })
    }
    if (this.config.gitTokenSecret) {
      jobEnv.push({
        name: 'MXT_GIT_TOKEN',
        valueFrom: {
          secretKeyRef: { name: this.config.gitTokenSecret, key: 'token', optional: true },
        },
      })
    }
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name,
        labels: {
          'app.kubernetes.io/part-of': 'mx-test-framework',
          'app.kubernetes.io/component': 'runner',
          'mxt.run-id': run.id,
        },
      },
      spec: {
        backoffLimit: 0, // Retries are the platform's decision, not the Job's.
        ttlSecondsAfterFinished: 3600,
        activeDeadlineSeconds: Math.floor(this.config.runLeaseMs / 1000),
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/part-of': 'mx-test-framework',
              'app.kubernetes.io/component': 'runner',
            },
          },
          spec: {
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'runner',
                image: this.imageFor(suite),
                command: ['/bin/sh', '-c'],
                args: [this.script({ apiBase })],
                env: jobEnv,
                volumeMounts: [
                  { name: 'artifacts', mountPath: this.config.artifactsDir },
                  // The checkout and its node_modules live here. An emptyDir is
                  // deleted with the Pod, so a workspace can never outlive the
                  // run that created it or accumulate on the artifacts volume.
                  { name: 'workspace', mountPath: '/work' },
                ],
                // Not `runAsNonRoot` / `readOnlyRootFilesystem` yet: the official
                // Cypress and Playwright images assume a writable root and their
                // entrypoints run as root. Tightening those needs a run on real
                // hardware to confirm the browsers still start, so it is a
                // follow-up rather than an untested guess shipped as a default.
                securityContext: {
                  allowPrivilegeEscalation: false,
                  seccompProfile: { type: 'RuntimeDefault' },
                },
                resources: {
                  requests: {
                    cpu: this.config.runnerResources.cpuRequest,
                    memory: this.config.runnerResources.memoryRequest,
                  },
                  limits: { memory: this.config.runnerResources.memoryLimit },
                },
              },
            ],
            volumes: [
              {
                name: 'artifacts',
                persistentVolumeClaim: { claimName: 'mx-test-framework-artifacts' },
              },
              {
                name: 'workspace',
                emptyDir: { sizeLimit: this.config.workspaceSizeLimit },
              },
            ],
          },
        },
      },
    }
  }

  /**
   * The Jobs this platform created, by run id.
   *
   * Only the platform's own label selector, and only in its own namespace — the
   * ServiceAccount is not granted anything wider.
   */
  async listJobs() {
    if (!this.available) return []
    const { token } = await this.#credentials()
    const response = await this.fetchImpl(
      `${this.apiBase}/apis/batch/v1/namespaces/${this.namespace}/jobs` +
        `?labelSelector=app.kubernetes.io%2Fcomponent%3Drunner`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (!response.ok) {
      throw new Error(`Kubernetes rejected the Job listing: ${response.status}`)
    }
    const body = await response.json()
    return (body.items ?? []).map((job) => ({
      runId: job.metadata?.labels?.['mxt.run-id'] ?? null,
      failed: Number(job.status?.failed ?? 0) > 0,
      succeeded: Number(job.status?.succeeded ?? 0) > 0,
      // Kubernetes states the reason on the Job condition when it gave up —
      // DeadlineExceeded, BackoffLimitExceeded — which is exactly the detail
      // that is otherwise lost when the Pod is garbage collected.
      reason:
        (job.status?.conditions ?? []).find((condition) => condition.type === 'Failed')?.reason ??
        null,
    }))
  }

  async dispatch({ run, suite, app, env, runToken, apiBase }) {
    if (!this.available) {
      throw new Error('Not running inside Kubernetes; no dispatcher available')
    }
    const { token } = await this.#credentials()
    const body = this.manifest({ run, suite, app, env, runToken, apiBase })
    // The API server's CA is trusted via NODE_EXTRA_CA_CERTS, which the
    // Deployment points at the ServiceAccount's ca.crt. Doing it there rather
    // than per-request keeps this from becoming a place where someone is
    // tempted to disable verification.
    const response = await this.fetchImpl(
      `${this.apiBase}/apis/batch/v1/namespaces/${this.namespace}/jobs`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Kubernetes rejected the Job: ${response.status} ${detail.slice(0, 400)}`)
    }
    this.logger?.log?.(`[dispatcher] created Job for ${run.id}`)
    return body.metadata.name
  }
}

/**
 * Dispatch every queued server-side run.
 *
 * A failure to dispatch marks the run `blocked` with the reason attached rather
 * than leaving it queued: a run that can never start should say so on the run
 * page, not look like it is still waiting its turn.
 */
/**
 * Close out runs whose Job died without reporting anything.
 *
 * A container that is OOMKilled, evicted or hits `activeDeadlineSeconds` never
 * reaches its own reporting step. Without this the run stays `running` until
 * the lease expires — which looks like a test that is still going, sometimes
 * for half an hour, rather than infrastructure that broke. The Job object is
 * the only remaining witness, so the platform has to go and ask.
 *
 * Only runs the platform itself dispatched are considered: a `mxt.run-id` label
 * is present on exactly those.
 */
export async function reconcileServerRuns({ store, dispatcher, logger = console }) {
  if (!dispatcher?.available) return []
  let jobs
  try {
    jobs = await dispatcher.listJobs()
  } catch (error) {
    // A listing failure must not stop the scheduler tick; the next one retries.
    logger?.error?.(`[reconcile] could not list Jobs: ${error.message}`)
    return []
  }

  const failedByRun = new Map()
  for (const job of jobs) {
    if (job.runId && job.failed) failedByRun.set(job.runId, job.reason)
  }
  if (failedByRun.size === 0) return []

  const reconciled = []
  for (const run of await store.listRuns({ status: 'running', limit: 100 })) {
    if (!failedByRun.has(run.id)) continue
    const reason = failedByRun.get(run.id)
    await store.updateRun(run.id, {
      status: 'blocked',
      finishedAt: new Date().toISOString(),
      blockedReason: `执行任务异常终止${reason ? `（${reason}）` : ''}，没有回报结果`.slice(0, 500),
      // Clearing the token stops a container that somehow survives from writing
      // a result into a run that has already been closed out.
      runTokenSha256: null,
    })
    logger?.log?.(`[reconcile] ${run.id} -> blocked (${reason ?? 'job failed'})`)
    reconciled.push(run.id)
  }
  return reconciled
}

export async function dispatchQueued({ store, dispatcher, config, buildEnv, issueRunToken, logger = console }) {
  if (!dispatcher?.available) return []
  const queued = await store.listRuns({ status: 'queued', limit: 10 })
  const dispatched = []

  for (const run of queued) {
    const suite = await store.getSuite(run.suiteId)
    if (!suite || suite.runnerKind !== 'server') continue
    const app = await store.getApp(run.appId)
    try {
      const runToken = await issueRunToken(run)
      await dispatcher.dispatch({
        run,
        suite,
        app,
        env: buildEnv({ run, suite, app }),
        runToken,
        apiBase: config.selfUrl,
      })
      await store.updateRun(run.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
        leaseUntil: new Date(Date.now() + config.runLeaseMs).toISOString(),
      })
      dispatched.push(run.id)
    } catch (error) {
      logger?.error?.(`[dispatcher] ${run.id} failed: ${error.message}`)
      await store.updateRun(run.id, {
        status: 'blocked',
        finishedAt: new Date().toISOString(),
        blockedReason: `无法创建执行任务：${error.message}`.slice(0, 500),
      })
    }
  }
  return dispatched
}
