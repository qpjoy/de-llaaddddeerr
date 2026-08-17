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
    return suite.engine === 'cypress'
      ? this.config.runnerImages.cypress
      : this.config.runnerImages.playwright
  }

  /**
   * The script a runner container executes.
   *
   * It ends by POSTing the summary with the real exit code. Note the `|| true`
   * after the test command and the explicit `$?` capture: a non-zero exit must
   * still reach the platform as a *reported result*, not as a Job that dies
   * silently and leaves the run hanging until its lease expires.
   */
  script({ app, suite, run, apiBase }) {
    const command = suite.command.length > 0 ? suite.command.join(' ') : 'echo "no command configured"; exit 2'
    return [
      'set -u',
      'export CI=1',
      `mkdir -p "$MXT_ARTIFACTS_DIR"`,
      app.repoUrl
        ? `git clone --depth 1 ${app.repoUrl} /work 2>/dev/null || { echo "clone failed"; exit 2; }`
        : 'mkdir -p /work',
      'cd /work',
      '[ -f package.json ] && (pnpm install --frozen-lockfile 2>/dev/null || npm install --no-audit --no-fund) || true',
      `${command}; MXT_EXIT=$?`,
      'SUMMARY="$MXT_ARTIFACTS_DIR/summary.json"',
      // A missing summary is itself a result: report it as blocked rather than
      // letting the run sit in `running` until the lease times out.
      '[ -f "$SUMMARY" ] || printf \'{"schemaVersion":2,"runId":"%s","app":"%s","status":"blocked","totals":{"tests":0},"blockedReason":"runner produced no summary.json"}\' "$MXT_RUN_ID" "$MXT_APP" > "$SUMMARY"',
      `printf '{"exitCode":%s,"summary":%s}' "$MXT_EXIT" "$(cat "$SUMMARY")" > /tmp/payload.json`,
      `curl -sS -X POST "${apiBase}/runner/v1/runs/$MXT_RUN_ID:complete" ` +
        `-H "authorization: Bearer $MXT_RUN_TOKEN" -H "content-type: application/json" ` +
        `--data @/tmp/payload.json || echo "failed to report result"`,
      'exit 0',
    ].join('\n')
  }

  manifest({ run, suite, app, env, runToken, apiBase }) {
    const name = `mxt-run-${run.id.replace(/[^a-z0-9-]/giu, '').toLowerCase()}`.slice(0, 63)
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
                args: [this.script({ app, suite, run, apiBase })],
                env: [
                  ...Object.entries(env).map(([key, value]) => ({ name: key, value: String(value) })),
                  { name: 'MXT_RUN_TOKEN', value: runToken },
                ],
                volumeMounts: [{ name: 'artifacts', mountPath: this.config.artifactsDir }],
                resources: {
                  requests: { cpu: '500m', memory: '2Gi' },
                  limits: { memory: '4Gi' },
                },
              },
            ],
            volumes: [
              {
                name: 'artifacts',
                persistentVolumeClaim: { claimName: 'mx-test-framework-artifacts' },
              },
            ],
          },
        },
      },
    }
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
