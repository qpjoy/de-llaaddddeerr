#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptDir, '..');
const mxLauncherRoot = resolve(serverRoot, '..');
const [baseArg, siteIdArg, hostArg] = process.argv.slice(2);
const baseUrl = (baseArg || process.env.MX_INTERNAL_BASE_URL || 'http://127.0.0.1:18090').replace(/\/+$/, '');
const siteId = siteIdArg || process.env.SITE_SLOT_ID || 'oversea-main';
const host = hostArg || process.env.SITE_SLOT_HOST || process.env.SITE_SLOT_SSH_HOST || '';
const profileId = process.env.SITE_SLOT_SSH_PROFILE_ID || `sshprof_${siteId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
const now = new Date();
const runStamp = now.toISOString().replace(/[:.]/g, '-');

if (!host) {
  die('Usage: node server/scripts/site-slot-oversea-readonly-test.mjs <base-url> <site-id> <host>');
}

if (!process.env.SITE_SLOT_SSH_IDENTITY_FILE) {
  die('SITE_SLOT_SSH_IDENTITY_FILE is required for Oversea readonly test');
}

if (!process.env.SITE_SLOT_SSH_KNOWN_HOSTS_FILE) {
  die('SITE_SLOT_SSH_KNOWN_HOSTS_FILE is required for Oversea readonly test');
}

try {
  const profile = await upsertSshProfile();
  const readiness = await profileReadiness(profile.profileId);
  if (readiness.status !== 'ready' && readiness.status !== 'passed') {
    failJson('ssh profile readiness did not pass', { profile, readiness });
  }

  const plan = await createOverseaPlan(profile.profileId);
  const applyRun = await applyPlan(plan.planId);
  const runner = await createRemoteRunner(applyRun.runId);
  if (runner.status !== 'queued') {
    failJson('remote runner is not queued', {
      runner,
      remediation: [
        'For K8s shadow, run: bash scripts/manage.sh ops k8s-shadow remote-runner enable',
        'Then rerun this oversea-readonly-test command.'
      ]
    });
  }

  const job = await createWorkerJob(runner.sessionId);
  if (job.status !== 'ready') {
    failJson('worker job is not ready', { job });
  }

  const workerRun = await runReadonlyWorker(job.jobId, profile.profileId);
  const result = {
    ok: workerRun.status === 'passed',
    baseUrl,
    siteId,
    host,
    profileId: profile.profileId,
    planId: plan.planId,
    applyRunId: applyRun.runId,
    runnerSessionId: runner.sessionId,
    workerJobId: job.jobId,
    workerReportId: workerRun.reportId,
    status: workerRun.status,
    profileReadiness: {
      status: readiness.status,
      command: readiness.command,
      gateFailures: readiness.gateFailures
    },
    workerRun
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  die(error?.stack || error?.message || String(error));
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
      requestId: `oversea-readonly-profile-${runStamp}`
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
      requestId: `oversea-readonly-profile-readiness-${runStamp}`
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
      requestId: `oversea-readonly-plan-${runStamp}`
    }
  });
  return payload.plan;
}

async function applyPlan(planId) {
  const payload = await request(`/internal/v1/site-slots/plans/${encodeURIComponent(planId)}/apply`, {
    method: 'POST',
    body: {
      mode: 'manual',
      confirmApply: true,
      requestedBy: process.env.USER || 'manage.sh',
      requestId: `oversea-readonly-apply-${runStamp}`
    }
  });
  return payload.execution;
}

async function createRemoteRunner(runId) {
  const payload = await request(`/internal/v1/site-slots/executions/${encodeURIComponent(runId)}/runner-sessions`, {
    method: 'POST',
    body: {
      mode: 'remote-ssh',
      confirmRemoteExecution: true,
      requestedBy: process.env.USER || 'manage.sh',
      requestId: `oversea-readonly-runner-${runStamp}`
    }
  });
  return payload.session;
}

async function createWorkerJob(sessionId) {
  const start = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const end = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  const payload = await request(`/internal/v1/site-slots/runner-sessions/${encodeURIComponent(sessionId)}/worker-jobs`, {
    method: 'POST',
    body: {
      workerId: process.env.SITE_SLOT_WORKER_ID || `worker-${siteId}-readonly`,
      workerKind: 'oversea-site-agent',
      approvalId: process.env.SITE_SLOT_APPROVAL_ID || `approval-${siteId}-readonly-${runStamp}`,
      changeWindowStart: start,
      changeWindowEnd: end,
      retryLimit: 1,
      rollbackStrategy: 'readonly-probe-no-remote-mutation',
      requestedBy: process.env.USER || 'manage.sh',
      requestId: `oversea-readonly-worker-job-${runStamp}`
    }
  });
  return payload.job;
}

async function runReadonlyWorker(jobId, id) {
  const { stdout } = await execFileAsync(process.execPath, [
    resolve(serverRoot, 'scripts/site-slot-worker-run.mjs'),
    baseUrl,
    jobId,
    'remote-readonly-probe'
  ], {
    cwd: mxLauncherRoot,
    env: {
      ...process.env,
      MX_INTERNAL_BASE_URL: baseUrl,
      SITE_SLOT_SSH_PROFILE_ID: id,
      SITE_SLOT_WORKER_ID: process.env.SITE_SLOT_WORKER_ID || `worker-${siteId}-readonly`,
      SITE_SLOT_WORKER_MESSAGE: `oversea readonly probe ${siteId}`,
      SITE_SLOT_WORKER_REQUEST_ID: `oversea-readonly-worker-run-${runStamp}`
    },
    maxBuffer: 8 * 1024 * 1024
  });
  return parseJson(stdout);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : {};
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function failJson(message, details) {
  console.error(JSON.stringify({
    ok: false,
    message,
    ...details
  }, null, 2));
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
