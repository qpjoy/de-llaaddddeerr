#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptDir, '..');
const mxLauncherRoot = resolve(serverRoot, '..');
const [baseArg, siteIdArg, hostArg, modeArg = 'pipeline'] = process.argv.slice(2);
const baseUrl = (baseArg || process.env.MX_INTERNAL_BASE_URL || 'http://127.0.0.1:18090').replace(/\/+$/, '');
const internalOpsToken = (process.env.MX_INTERNAL_OPS_TOKEN || '').trim();
const siteId = siteIdArg || process.env.SITE_SLOT_ID || 'oversea-main';
const host = hostArg || process.env.SITE_SLOT_HOST || process.env.SITE_SLOT_SSH_HOST || '';
const mode = modeArg || 'pipeline';
const profileId = process.env.SITE_SLOT_SSH_PROFILE_ID || `sshprof_${siteId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const stageModes = {
  'dry-run': ['artifact-push-dry-run'],
  'plan-only': ['artifact-push-remote-ssh-plan'],
  readonly: ['remote-readonly-probe'],
  execute: ['artifact-push-remote-ssh'],
  pipeline: ['artifact-push-dry-run', 'artifact-push-remote-ssh-plan', 'remote-readonly-probe']
};

if (!host || !stageModes[mode]) {
  die('Usage: node server/scripts/site-slot-oversea-remote-test.mjs <base-url> <site-id> <host> [pipeline|dry-run|plan-only|readonly|execute]');
}

if (!internalOpsToken) {
  die('MX_INTERNAL_OPS_TOKEN is required for the managed Oversea deployment workflow.');
}

if (!process.env.SITE_SLOT_SSH_IDENTITY_FILE) {
  die('SITE_SLOT_SSH_IDENTITY_FILE is required for Oversea remote test');
}

if (!process.env.SITE_SLOT_SSH_KNOWN_HOSTS_FILE) {
  die('SITE_SLOT_SSH_KNOWN_HOSTS_FILE is required for Oversea remote test');
}

if (mode === 'execute' && process.env.SITE_SLOT_CONFIRM_OVERSEA_EXECUTE !== '1') {
  die('execute mode requires SITE_SLOT_CONFIRM_OVERSEA_EXECUTE=1 because it will run gated SSH/rsync/scp commands on the Oversea host.');
}

try {
  await materializeOverseaArtifacts();
  const profile = await upsertSshProfile();
  const readiness = await profileReadiness(profile.profileId);
  if (readiness.status !== 'ready' && readiness.status !== 'passed') {
    failJson('ssh profile readiness did not pass', { profile, readiness });
  }

  const plan = await createOverseaPlan(profile.profileId);
  const stages = [];
  for (const workerMode of stageModes[mode]) {
    stages.push(await runStage(plan.planId, workerMode, profile.profileId));
  }

  console.log(JSON.stringify({
    ok: stages.every((stage) => stage.workerRun.status === 'passed'),
    baseUrl,
    siteId,
    host,
    mode,
    profileId: profile.profileId,
    planId: plan.planId,
    access: plan.access,
    profileReadiness: {
      status: readiness.status,
      command: readiness.command,
      gateFailures: readiness.gateFailures
    },
    stages
  }, null, 2));

  if (stages.some((stage) => stage.workerRun.status !== 'passed')) process.exitCode = 1;
} catch (error) {
  die(error?.stack || error?.message || String(error));
}

async function materializeOverseaArtifacts() {
  const { stdout } = await execFileAsync(process.execPath, [
    resolve(serverRoot, 'scripts/site-slot-artifact-materializer.mjs'),
    'oversea'
  ], {
    cwd: mxLauncherRoot,
    env: process.env,
    maxBuffer: 8 * 1024 * 1024
  });
  return parseJson(stdout);
}

async function runStage(planId, workerMode, id) {
  const applyRun = await applyPlan(planId, workerMode);
  const runner = await createRemoteRunner(applyRun.runId, workerMode);
  if (runner.status !== 'queued') {
    failJson('remote runner is not queued', {
      workerMode,
      runner,
      remediation: [
        'For K8s shadow, run: bash scripts/manage.sh ops k8s-shadow remote-runner enable',
        'Then rerun the oversea-remote-test command.'
      ]
    });
  }
  const job = await createWorkerJob(runner.sessionId, workerMode);
  if (job.status !== 'ready') failJson('worker job is not ready', { workerMode, job });
  return {
    workerMode,
    applyRunId: applyRun.runId,
    runnerSessionId: runner.sessionId,
    workerJobId: job.jobId,
    workerRun: await runWorker(job.jobId, workerMode, id)
  };
}

async function upsertSshProfile() {
  const payload = await request('/internal/v1/config-center/site-slot-ssh-profiles', {
    method: 'POST',
    body: {
      profileId,
      siteId,
      kind: 'oversea',
      host,
      sshUser: process.env.SLOT_SSH_USER || process.env.SITE_SLOT_SSH_USER || 'root',
      sshPort: Number(process.env.SLOT_SSH_PORT || process.env.SITE_SLOT_SSH_PORT || '22'),
      identityFile: process.env.SITE_SLOT_SSH_IDENTITY_FILE,
      knownHostsFile: process.env.SITE_SLOT_SSH_KNOWN_HOSTS_FILE,
      hostKeyAlias: process.env.SITE_SLOT_SSH_HOST_KEY_ALIAS || siteId,
      strictHostKeyChecking: process.env.SITE_SLOT_SSH_STRICT_HOST_KEY_CHECKING || 'yes',
      connectTimeoutSeconds: Number(process.env.SITE_SLOT_SSH_CONNECT_TIMEOUT_SECONDS || '10'),
      batchMode: process.env.SITE_SLOT_SSH_BATCH_MODE || 'yes',
      status: 'active',
      requestedBy: process.env.USER || 'manage.sh',
      requestId: `oversea-remote-profile-${runStamp}`
    }
  });
  return payload.profile;
}

async function profileReadiness(id) {
  const payload = await request(`/internal/v1/config-center/site-slot-ssh-profiles/${encodeURIComponent(id)}/readiness-probe`, {
    method: 'POST',
    body: {
      confirmReadOnlyProbe: true,
      executeReadOnlyProbe: false,
      requestedBy: process.env.USER || 'manage.sh',
      requestId: `oversea-remote-profile-readiness-${runStamp}`
    }
  });
  return payload.readiness;
}

async function createOverseaPlan(id) {
  const payload = await request('/internal/v1/site-slots/plans', {
    method: 'POST',
    body: {
      kind: 'oversea',
      siteId,
      sshProfileId: id,
      hasDocker: true,
      hasOutboundInternet: true,
      internalBaseUrl: baseUrl,
      createdBy: process.env.USER || 'manage.sh',
      requestId: `oversea-remote-plan-${runStamp}`
    }
  });
  return payload.plan;
}

async function applyPlan(planId, workerMode) {
  const payload = await request(`/internal/v1/site-slots/plans/${encodeURIComponent(planId)}/apply`, {
    method: 'POST',
    body: {
      mode: 'manual',
      confirmApply: true,
      requestedBy: process.env.USER || 'manage.sh',
      requestId: `oversea-remote-apply-${workerMode}-${runStamp}`
    }
  });
  return payload.execution;
}

async function createRemoteRunner(runId, workerMode) {
  const payload = await request(`/internal/v1/site-slots/executions/${encodeURIComponent(runId)}/runner-sessions`, {
    method: 'POST',
    body: {
      mode: 'remote-ssh',
      confirmRemoteExecution: true,
      requestedBy: process.env.USER || 'manage.sh',
      requestId: `oversea-remote-runner-${workerMode}-${runStamp}`
    }
  });
  return payload.session;
}

async function createWorkerJob(sessionId, workerMode) {
  const now = Date.now();
  const payload = await request(`/internal/v1/site-slots/runner-sessions/${encodeURIComponent(sessionId)}/worker-jobs`, {
    method: 'POST',
    body: {
      workerId: process.env.SITE_SLOT_WORKER_ID || `worker-${siteId}-${workerMode}`,
      workerKind: 'oversea-site-agent',
      approvalId: process.env.SITE_SLOT_APPROVAL_ID || `approval-${siteId}-${workerMode}-${runStamp}`,
      changeWindowStart: new Date(now - 5 * 60 * 1000).toISOString(),
      changeWindowEnd: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      retryLimit: 1,
      rollbackStrategy: workerMode === 'artifact-push-remote-ssh' ? 'restore-previous-access-stack' : 'no-remote-mutation',
      requestedBy: process.env.USER || 'manage.sh',
      requestId: `oversea-remote-worker-job-${workerMode}-${runStamp}`
    }
  });
  return payload.job;
}

async function runWorker(jobId, workerMode, id) {
  const env = {
    ...process.env,
    MX_INTERNAL_BASE_URL: baseUrl,
    SITE_SLOT_ARTIFACT_BASE_DIR: resolve(mxLauncherRoot, 'artifacts/site-slots'),
    SITE_SLOT_SSH_PROFILE_ID: id,
    SITE_SLOT_WORKER_ID: process.env.SITE_SLOT_WORKER_ID || `worker-${siteId}-${workerMode}`,
    SITE_SLOT_WORKER_MESSAGE: `oversea remote test ${workerMode} ${siteId}`,
    SITE_SLOT_WORKER_REQUEST_ID: `oversea-remote-worker-run-${workerMode}-${runStamp}`
  };
  if (workerMode === 'artifact-push-remote-ssh-plan' || workerMode === 'artifact-push-remote-ssh') {
    env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION = '1';
  }
  if (workerMode === 'artifact-push-remote-ssh') {
    env.SITE_SLOT_WORKER_REMOTE_SSH = '1';
  }
  const { stdout } = await execFileAsync(process.execPath, [
    resolve(serverRoot, 'scripts/site-slot-worker-run.mjs'),
    baseUrl,
    jobId,
    workerMode
  ], {
    cwd: mxLauncherRoot,
    env,
    maxBuffer: 16 * 1024 * 1024
  });
  return parseJson(stdout);
}

async function request(path, options = {}) {
  const headers = new Headers(options.body ? { 'content-type': 'application/json' } : undefined);
  headers.set('x-mx-ops-token', internalOpsToken);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : {};
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

function failJson(message, details) {
  console.error(JSON.stringify({ ok: false, message, ...details }, null, 2));
  process.exit(1);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got: ${text}`);
  }
}

function die(message) {
  console.error(message);
  process.exit(1);
}
