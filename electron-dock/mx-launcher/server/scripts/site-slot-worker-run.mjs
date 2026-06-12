#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const [baseArg, jobId, modeArg = 'simulate'] = process.argv.slice(2);
const baseUrl = (baseArg || process.env.MX_INTERNAL_BASE_URL || 'http://127.0.0.1:18090').replace(/\/+$/, '');
const mode = modeArg || 'simulate';
const allowedModes = new Set(['simulate', 'artifact-push-dry-run', 'artifact-push-remote-ssh-plan', 'remote-readonly-probe', 'artifact-push-remote-ssh', 'artifact-push-fake-transport', 'awx-shadow', 'awx-credential-sync', 'awx-object-sync', 'awx-launch', 'local-exec']);

if (!jobId) {
  die('Usage: node server/scripts/site-slot-worker-run.mjs <base-url> <job-id> [simulate|artifact-push-dry-run|artifact-push-remote-ssh-plan|remote-readonly-probe|artifact-push-remote-ssh|artifact-push-fake-transport|awx-shadow|awx-credential-sync|awx-object-sync|awx-launch|local-exec]');
}

if (!allowedModes.has(mode)) {
  die(`Unknown worker-run mode: ${mode}. Expected simulate, artifact-push-dry-run, artifact-push-remote-ssh-plan, remote-readonly-probe, artifact-push-remote-ssh, artifact-push-fake-transport, awx-shadow, awx-credential-sync, awx-object-sync, awx-launch, or local-exec.`);
}

if (mode === 'local-exec' && process.env.SITE_SLOT_WORKER_EXECUTE_LOCAL !== '1') {
  die('local-exec requires SITE_SLOT_WORKER_EXECUTE_LOCAL=1 because it executes job commands on this host.');
}

if (mode === 'artifact-push-remote-ssh' && process.env.SITE_SLOT_WORKER_REMOTE_SSH !== '1') {
  die('artifact-push-remote-ssh requires SITE_SLOT_WORKER_REMOTE_SSH=1 because it executes remote SSH/rsync/scp commands.');
}

if (mode === 'artifact-push-remote-ssh' && process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION !== '1') {
  die('artifact-push-remote-ssh requires SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 after Admin approval and change-window review.');
}

if (mode === 'artifact-push-remote-ssh-plan' && process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION !== '1') {
  die('artifact-push-remote-ssh-plan requires SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 because it records remote SSH execution intent.');
}

if (mode === 'artifact-push-fake-transport' && process.env.SITE_SLOT_WORKER_FAKE_TRANSPORT !== '1') {
  die('artifact-push-fake-transport requires SITE_SLOT_WORKER_FAKE_TRANSPORT=1 because it records fake transport evidence for harnesses only.');
}

if (mode === 'artifact-push-fake-transport' && process.env.SITE_SLOT_WORKER_REMOTE_SSH !== '1') {
  die('artifact-push-fake-transport requires SITE_SLOT_WORKER_REMOTE_SSH=1 so it exercises the same remote SSH gate as real handoff.');
}

if (mode === 'artifact-push-fake-transport' && process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION !== '1') {
  die('artifact-push-fake-transport requires SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 after Admin approval and change-window review.');
}

if (mode === 'awx-launch' && process.env.SITE_SLOT_CONFIRM_AWX_LAUNCH !== '1') {
  die('awx-launch requires SITE_SLOT_CONFIRM_AWX_LAUNCH=1 because it asks Internal to call AWX and may mutate the selected slot host.');
}

if (mode === 'awx-object-sync' && process.env.SITE_SLOT_CONFIRM_AWX_SYNC !== '1') {
  die('awx-object-sync requires SITE_SLOT_CONFIRM_AWX_SYNC=1 because it asks Internal to create or update AWX objects.');
}

if (mode === 'awx-credential-sync' && process.env.SITE_SLOT_CONFIRM_AWX_CREDENTIAL_SYNC !== '1') {
  die('awx-credential-sync requires SITE_SLOT_CONFIRM_AWX_CREDENTIAL_SYNC=1 because it asks Internal to write an SSH private key into AWX.');
}

const commandCwd = process.env.SITE_SLOT_WORKER_CWD || process.cwd();
const artifactBaseDir = resolve(process.env.SITE_SLOT_ARTIFACT_BASE_DIR || resolve(commandCwd, 'artifacts/site-slots'));
const manifestCache = new Map();
const maxBuffer = positiveInt(process.env.SITE_SLOT_WORKER_MAX_BUFFER_BYTES, 1024 * 1024);
const attempt = positiveInt(process.env.SITE_SLOT_WORKER_ATTEMPT, 1);

try {
  if (mode === 'awx-credential-sync') {
    await runAwxCredentialSyncAction(jobId);
    process.exit(process.exitCode ?? 0);
  }
  if (mode === 'awx-object-sync') {
    await runAwxObjectSyncAction(jobId);
    process.exit(process.exitCode ?? 0);
  }
  if (mode === 'awx-launch') {
    await runAwxLaunchAction(jobId);
    process.exit(process.exitCode ?? 0);
  }
  const { job } = await request(`/internal/v1/site-slots/worker-jobs/${encodeURIComponent(jobId)}`);
  if (!job) die(`Site slot worker job not found: ${jobId}`);
  const managedSshProfile = mode === 'artifact-push-remote-ssh-plan' || mode === 'remote-readonly-probe' || mode === 'artifact-push-remote-ssh' || mode === 'artifact-push-fake-transport' || mode === 'awx-shadow'
    ? await fetchManagedSshProfile(job)
    : null;

  const stepReports = [];
  let blockRemaining = false;
  let blockedAfterFailureCount = 0;
  const steps = [...(job.steps || [])].sort((left, right) => Number(left.order || 0) - Number(right.order || 0));

  for (const step of steps) {
    if (mode === 'remote-readonly-probe' && stepReports.length > 0) {
      stepReports.push(remoteReadonlyProbeSkippedStep(step, job));
      continue;
    }

    if (blockRemaining) {
      blockedAfterFailureCount += 1;
      stepReports.push(blockedStepReport(step, 'not executed: stopped after previous step failed'));
      continue;
    }

    const report = await workerStepReport(mode, step, job, managedSshProfile);
    stepReports.push(report);

    if (report.status === 'failed' && step.stopOnFailure !== false) {
      blockRemaining = true;
    }
  }

  const status = overallStatus(stepReports);
  const reportBody = {
    workerId: process.env.SITE_SLOT_WORKER_ID || job.worker?.workerId || 'worker-manage-shadow',
    status,
    message: process.env.SITE_SLOT_WORKER_MESSAGE || `manage.sh worker-run ${mode} ${status}${blockedAfterFailureCount ? `; stopped before ${blockedAfterFailureCount} remaining steps` : ''}`,
    stepReports,
    requestId: process.env.SITE_SLOT_WORKER_REQUEST_ID || `manage-site-slot-worker-run-${mode}`
  };

  const { report } = await request(`/internal/v1/site-slots/worker-jobs/${encodeURIComponent(jobId)}/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reportBody)
  });

  console.log(JSON.stringify({
    jobId: job.jobId,
    sessionId: job.sessionId,
    runId: job.runId,
    planId: job.planId,
    siteId: job.siteId,
    mode,
    workerId: report.workerId,
    reportId: report.reportId,
    status: report.status,
    message: report.message,
    rollbackPlan: report.rollbackPlan,
    nextActions: report.nextActions,
    stepReports: report.stepReports.map((step) => ({
      order: step.order,
      stepId: step.stepId,
      sourceId: step.sourceId,
      status: step.status,
      exitCode: step.exitCode,
      stdout: step.stdout,
      stderr: step.stderr,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      attempt: step.attempt
    }))
  }, null, 2));

  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
} catch (error) {
  die(errorMessage(error));
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  const payload = text ? parseJson(text) : {};
  if (!response.ok) {
    throw new Error(typeof payload === 'object' ? JSON.stringify(payload) : text);
  }
  return payload;
}

async function runAwxCredentialSyncAction(id) {
  const body = {
    actionId: 'site-slot.worker-run.awx-credential-sync',
    path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(id)}/run-awx-credential-sync`,
    body: {
      awxProviderId: process.env.SITE_SLOT_AWX_PROVIDER_ID || process.env.AWX_PROVIDER_ID || null,
      awxToken: process.env.SITE_SLOT_AWX_TOKEN || null,
      confirmAwxCredentialSync: true,
      timeoutSeconds: positiveInt(process.env.SITE_SLOT_AWX_TIMEOUT_SECONDS, 120),
      workerId: process.env.SITE_SLOT_WORKER_ID || 'worker-awx-api',
      message: process.env.SITE_SLOT_WORKER_MESSAGE || 'manage.sh AWX credential sync',
      requestedBy: process.env.USER || 'manage.sh',
      requestId: process.env.SITE_SLOT_WORKER_REQUEST_ID || 'manage-site-slot-worker-run-awx-credential-sync'
    }
  };
  if (!body.body.awxProviderId) delete body.body.awxProviderId;
  if (!body.body.awxToken) delete body.body.awxToken;
  const payload = await request('/internal/v1/admin/actions/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  console.log(JSON.stringify({
    mode,
    actionResult: payload.actionResult,
    awxCredentialSync: payload.awxCredentialSync
  }, null, 2));
  if (payload.awxCredentialSync?.status === 'failed' || payload.awxCredentialSync?.status === 'blocked') {
    process.exitCode = 1;
  }
}

async function runAwxObjectSyncAction(id) {
  const body = {
    actionId: 'site-slot.worker-run.awx-object-sync',
    path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(id)}/run-awx-object-sync`,
    body: {
      awxProviderId: process.env.SITE_SLOT_AWX_PROVIDER_ID || process.env.AWX_PROVIDER_ID || null,
      awxToken: process.env.SITE_SLOT_AWX_TOKEN || null,
      confirmAwxSync: true,
      timeoutSeconds: positiveInt(process.env.SITE_SLOT_AWX_TIMEOUT_SECONDS, 120),
      workerId: process.env.SITE_SLOT_WORKER_ID || 'worker-awx-api',
      message: process.env.SITE_SLOT_WORKER_MESSAGE || 'manage.sh AWX object sync',
      requestedBy: process.env.USER || 'manage.sh',
      requestId: process.env.SITE_SLOT_WORKER_REQUEST_ID || 'manage-site-slot-worker-run-awx-object-sync'
    }
  };
  if (!body.body.awxProviderId) delete body.body.awxProviderId;
  if (!body.body.awxToken) delete body.body.awxToken;
  const payload = await request('/internal/v1/admin/actions/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  console.log(JSON.stringify({
    mode,
    actionResult: payload.actionResult,
    awxObjectSync: payload.awxObjectSync
  }, null, 2));
  if (payload.awxObjectSync?.status === 'failed' || payload.awxObjectSync?.status === 'blocked') {
    process.exitCode = 1;
  }
}

async function runAwxLaunchAction(id) {
  const body = {
    actionId: 'site-slot.worker-run.awx-launch',
    path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(id)}/run-awx-launch`,
    body: {
      awxProviderId: process.env.SITE_SLOT_AWX_PROVIDER_ID || process.env.AWX_PROVIDER_ID || null,
      awxToken: process.env.SITE_SLOT_AWX_TOKEN || null,
      confirmAwxLaunch: true,
      waitForCompletion: process.env.SITE_SLOT_AWX_WAIT !== '0',
      timeoutSeconds: positiveInt(process.env.SITE_SLOT_AWX_TIMEOUT_SECONDS, 180),
      pollIntervalMs: positiveInt(process.env.SITE_SLOT_AWX_POLL_INTERVAL_MS, 2000),
      workerId: process.env.SITE_SLOT_WORKER_ID || 'worker-awx-api',
      message: process.env.SITE_SLOT_WORKER_MESSAGE || 'manage.sh AWX API launch',
      requestedBy: process.env.USER || 'manage.sh',
      requestId: process.env.SITE_SLOT_WORKER_REQUEST_ID || 'manage-site-slot-worker-run-awx-launch'
    }
  };
  if (!body.body.awxProviderId) delete body.body.awxProviderId;
  if (!body.body.awxToken) delete body.body.awxToken;
  const payload = await request('/internal/v1/admin/actions/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const stepReports = Array.isArray(payload.report?.stepReports) ? payload.report.stepReports : [];
  console.log(JSON.stringify({
    mode,
    actionResult: payload.actionResult,
    awxLaunch: payload.awxLaunch,
    report: payload.report ? {
      reportId: payload.report.reportId,
      jobId: payload.report.jobId,
      workerId: payload.report.workerId,
      status: payload.report.status,
      message: payload.report.message,
      rollbackPlan: payload.report.rollbackPlan,
      nextActions: payload.report.nextActions,
      stepReports: stepReports.map((step) => ({
        order: step.order,
        stepId: step.stepId,
        sourceId: step.sourceId,
        status: step.status,
        exitCode: step.exitCode,
        stderr: step.stderr
      }))
    } : null
  }, null, 2));
  if (payload.report?.status && payload.report.status !== 'passed') {
    process.exitCode = 1;
  }
  if (payload.awxLaunch?.status === 'failed' || payload.awxLaunch?.status === 'blocked') {
    process.exitCode = 1;
  }
}

async function fetchManagedSshProfile(job) {
  const profileId = process.env.SITE_SLOT_SSH_PROFILE_ID;
  const path = profileId
    ? `/internal/v1/config-center/site-slot-ssh-profiles/${encodeURIComponent(profileId)}`
    : `/internal/v1/config-center/site-slot-ssh-profiles/site/${encodeURIComponent(job.siteId)}`;
  try {
    const payload = await request(path);
    return payload.profile ?? null;
  } catch (error) {
    if (errorMessage(error).includes('not found')) return null;
    throw error;
  }
}

async function workerStepReport(mode, step, job, managedSshProfile) {
  if (mode === 'simulate') return simulateStep(step);
  if (mode === 'artifact-push-dry-run') return artifactPushDryRunStep(step, job);
  if (mode === 'artifact-push-remote-ssh-plan') return artifactPushRemoteSshPlanStep(step, job, managedSshProfile);
  if (mode === 'remote-readonly-probe') return remoteReadonlyProbeStep(step, job, managedSshProfile);
  if (mode === 'artifact-push-remote-ssh') return artifactPushRemoteSshStep(step, job, managedSshProfile);
  if (mode === 'artifact-push-fake-transport') return artifactPushFakeTransportStep(step, job, managedSshProfile);
  if (mode === 'awx-shadow') return awxShadowStep(step, job, managedSshProfile);
  return executeStep(step);
}

function simulateStep(step) {
  const now = new Date().toISOString();
  return {
    stepId: step.stepId,
    status: 'passed',
    exitCode: 0,
    stdout: step.redactOutput ? '[redacted simulated output]' : `simulated command: ${step.command}`,
    stderr: null,
    startedAt: now,
    finishedAt: now,
    attempt
  };
}

function artifactPushDryRunStep(step, job) {
  const startedAt = new Date().toISOString();
  const workerStep = normalizeRemoteWorkerStep(step, job);
  const evidence = artifactPushEvidence(workerStep, job, {
    mode: 'artifact-push-dry-run',
    dryRun: true,
    execution: 'not-executed',
    boundary: 'manifest-and-command-evidence-only'
  });
  return {
    stepId: step.stepId,
    status: evidence.failures.length > 0 ? 'failed' : 'passed',
    exitCode: evidence.failures.length > 0 ? 1 : 0,
    stdout: JSON.stringify(redactEvidence(workerStep, evidence), null, 2),
    stderr: evidence.failures.length > 0 ? evidence.failures.join('\n') : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    attempt
  };
}

function artifactPushRemoteSshPlanStep(step, job, managedSshProfile) {
  const startedAt = new Date().toISOString();
  const workerStep = normalizeRemoteWorkerStep(step, job);
  const commandKindValue = commandKind(workerStep.command);
  const sshProfile = buildSshProfile(job, managedSshProfile);
  const effectiveCommand = applySshProfile(workerStep.command, sshProfile);
  const evidence = artifactPushEvidence(workerStep, job, {
    mode: 'artifact-push-remote-ssh-plan',
    dryRun: true,
    execution: executableRemoteCommandKind(commandKindValue) ? 'planned' : 'skipped',
    boundary: 'remote-ssh-plan-only',
    effectiveCommand,
    sshProfile,
    planOnly: {
      enabled: true,
      commandExecuted: false,
      remoteMutation: false,
      reason: 'Plan-only mode records the final SSH/rsync/scp command after gates and SSH profile expansion.'
    }
  });
  const gateFailures = remoteSshGateFailures(job, workerStep, evidence, commandKindValue, sshProfile);
  if (gateFailures.length > 0) {
    const blockedEvidence = {
      ...evidence,
      execution: 'blocked',
      gateFailures
    };
    return {
      stepId: step.stepId,
      status: 'blocked',
      exitCode: null,
      stdout: JSON.stringify(redactEvidence(workerStep, blockedEvidence), null, 2),
      stderr: gateFailures.join('\n'),
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
  if (!executableRemoteCommandKind(commandKindValue)) {
    const skippedEvidence = {
      ...evidence,
      execution: 'skipped',
      skipReason: 'Non-shell deployment intent is recorded as evidence and is not executable by the SSH worker.'
    };
    return {
      stepId: step.stepId,
      status: 'passed',
      exitCode: 0,
      stdout: JSON.stringify(redactEvidence(workerStep, skippedEvidence), null, 2),
      stderr: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
  const plannedEvidence = {
    ...evidence,
    execution: 'planned',
    executionResult: {
      exitCode: 0,
      stdout: `plan-only recorded ${commandKindValue}: remote command was not executed`,
      stderr: ''
    }
  };
  return {
    stepId: step.stepId,
    status: 'passed',
    exitCode: 0,
    stdout: JSON.stringify(redactEvidence(workerStep, plannedEvidence), null, 2),
    stderr: null,
    startedAt,
    finishedAt: new Date().toISOString(),
    attempt
  };
}

async function remoteReadonlyProbeStep(step, job, managedSshProfile) {
  const startedAt = new Date().toISOString();
  const sshProfile = buildSshProfile(job, managedSshProfile);
  const command = readOnlyProbeCommand(sshProfile);
  const evidence = {
    dryRun: false,
    mode: 'remote-readonly-probe',
    execution: 'pending',
    boundary: 'readonly-ssh-worker',
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    sourceId: step.sourceId,
    phaseId: phaseIdFromSource(step.sourceId),
    stepId: step.stepId,
    order: step.order,
    target: step.target,
    command,
    sshProfile: sshProfileEvidence(sshProfile),
    readOnlyProbe: {
      commandExecuted: true,
      remoteMutation: false,
      checks: ['whoami', 'hostname', 'uname -a', 'pwd', 'df -h /', 'docker version']
    },
    notes: [
      'This worker mode opens SSH only for read-only host validation.',
      'It does not copy artifacts, modify files, restart services, or run docker compose.',
      'Use this before artifact-push-remote-ssh on the first real Oversea slot.'
    ],
    gateFailures: []
  };
  const gateFailures = remoteReadonlyProbeGateFailures(job, sshProfile);
  if (gateFailures.length > 0) {
    return {
      stepId: step.stepId,
      status: 'blocked',
      exitCode: null,
      stdout: JSON.stringify({ ...evidence, execution: 'blocked', gateFailures }, null, 2),
      stderr: gateFailures.join('\n'),
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
  try {
    const result = await execFileAsync('ssh', sshArgv(sshProfile, probeScript()), {
      cwd: commandCwd,
      timeout: (sshProfile.connectTimeoutSeconds + 20) * 1000,
      maxBuffer
    });
    return {
      stepId: step.stepId,
      status: 'passed',
      exitCode: 0,
      stdout: JSON.stringify({
        ...evidence,
        execution: 'executed',
        executionResult: {
          exitCode: 0,
          stdout: outputFor(step, result.stdout),
          stderr: outputFor(step, result.stderr)
        }
      }, null, 2),
      stderr: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  } catch (error) {
    const diagnosis = sshFailureDiagnosis(error.stderr || error.message, error.code);
    diagnosis.tcpProbe = await tcpConnectProbe(sshProfile.host, sshProfile.sshPort, sshProfile.connectTimeoutSeconds);
    return {
      stepId: step.stepId,
      status: 'failed',
      exitCode: typeof error.code === 'number' ? error.code : null,
      stdout: JSON.stringify({
        ...evidence,
        execution: 'failed',
        executionResult: {
          exitCode: typeof error.code === 'number' ? error.code : null,
          stdout: outputFor(step, error.stdout),
          stderr: outputFor(step, error.stderr || error.message),
          diagnosis
        }
      }, null, 2),
      stderr: outputFor(step, error.stderr || error.message),
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
}

function remoteReadonlyProbeSkippedStep(step, job) {
  const now = new Date().toISOString();
  return {
    stepId: step.stepId,
    status: 'passed',
    exitCode: 0,
    stdout: JSON.stringify({
      dryRun: false,
      mode: 'remote-readonly-probe',
      execution: 'skipped',
      boundary: 'readonly-ssh-worker',
      jobId: job.jobId,
      planId: job.planId,
      siteId: job.siteId,
      kind: job.kind,
      sourceId: step.sourceId,
      phaseId: phaseIdFromSource(step.sourceId),
      stepId: step.stepId,
      order: step.order,
      target: step.target,
      readOnlyProbe: {
        commandExecuted: false,
        remoteMutation: false,
        reason: 'Read-only SSH probe already completed once for this worker job.'
      }
    }, null, 2),
    stderr: null,
    startedAt: now,
    finishedAt: now,
    attempt
  };
}

async function artifactPushRemoteSshStep(step, job, managedSshProfile) {
  const startedAt = new Date().toISOString();
  const workerStep = normalizeRemoteWorkerStep(step, job);
  const commandKindValue = commandKind(workerStep.command);
  const sshProfile = buildSshProfile(job, managedSshProfile);
  const effectiveCommand = applySshProfile(workerStep.command, sshProfile);
  const evidence = artifactPushEvidence(workerStep, job, {
    mode: 'artifact-push-remote-ssh',
    dryRun: false,
    execution: executableRemoteCommandKind(commandKindValue) ? 'pending' : 'skipped',
    boundary: 'gated-ssh-rsync-scp-worker',
    effectiveCommand,
    sshProfile
  });
  const gateFailures = remoteSshGateFailures(job, workerStep, evidence, commandKindValue, sshProfile);
  if (gateFailures.length > 0) {
    const blockedEvidence = {
      ...evidence,
      execution: 'blocked',
      gateFailures
    };
    return {
      stepId: step.stepId,
      status: 'blocked',
      exitCode: null,
      stdout: JSON.stringify(redactEvidence(workerStep, blockedEvidence), null, 2),
      stderr: gateFailures.join('\n'),
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
  if (!executableRemoteCommandKind(commandKindValue)) {
    const skippedEvidence = {
      ...evidence,
      execution: 'skipped',
      skipReason: 'Non-shell deployment intent is recorded as evidence and is not executed by the SSH worker.'
    };
    return {
      stepId: step.stepId,
      status: 'passed',
      exitCode: 0,
      stdout: JSON.stringify(redactEvidence(workerStep, skippedEvidence), null, 2),
      stderr: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
  try {
    const result = await executeRemoteWorkerCommand(workerStep, sshProfile, effectiveCommand);
    const passedEvidence = {
      ...evidence,
      execution: 'executed',
      executionResult: {
        exitCode: 0,
        stdout: outputFor(workerStep, result.stdout),
        stderr: outputFor(workerStep, result.stderr)
      }
    };
    return {
      stepId: step.stepId,
      status: 'passed',
      exitCode: 0,
      stdout: JSON.stringify(redactEvidence(workerStep, passedEvidence), null, 2),
      stderr: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  } catch (error) {
    const diagnosis = sshFailureDiagnosis(error.stderr || error.message, error.code);
    diagnosis.tcpProbe = await tcpConnectProbe(sshProfile.host, sshProfile.sshPort, sshProfile.connectTimeoutSeconds);
    const failedEvidence = {
      ...evidence,
      execution: 'failed',
      executionResult: {
        exitCode: typeof error.code === 'number' ? error.code : null,
        stdout: outputFor(workerStep, error.stdout),
        stderr: outputFor(workerStep, error.stderr || error.message),
        diagnosis
      }
    };
    return {
      stepId: step.stepId,
      status: 'failed',
      exitCode: typeof error.code === 'number' ? error.code : null,
      stdout: JSON.stringify(redactEvidence(workerStep, failedEvidence), null, 2),
      stderr: outputFor(workerStep, error.stderr || error.message),
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
}

function artifactPushFakeTransportStep(step, job, managedSshProfile) {
  const startedAt = new Date().toISOString();
  const workerStep = normalizeRemoteWorkerStep(step, job);
  const commandKindValue = commandKind(workerStep.command);
  const sshProfile = buildSshProfile(job, managedSshProfile);
  const effectiveCommand = applySshProfile(workerStep.command, sshProfile);
  const evidence = artifactPushEvidence(workerStep, job, {
    mode: 'artifact-push-fake-transport',
    dryRun: false,
    execution: executableRemoteCommandKind(commandKindValue) ? 'pending' : 'skipped',
    boundary: 'fake-transport-no-remote-mutation',
    effectiveCommand,
    sshProfile,
    fakeTransport: {
      enabled: true,
      commandExecuted: false,
      remoteMutation: false,
      reason: 'HTTP smoke harness records worker report evidence without opening SSH/rsync/scp.'
    }
  });
  const gateFailures = remoteSshGateFailures(job, workerStep, evidence, commandKindValue, sshProfile);
  if (gateFailures.length > 0) {
    const blockedEvidence = {
      ...evidence,
      execution: 'blocked',
      gateFailures
    };
    return {
      stepId: step.stepId,
      status: 'blocked',
      exitCode: null,
      stdout: JSON.stringify(redactEvidence(workerStep, blockedEvidence), null, 2),
      stderr: gateFailures.join('\n'),
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
  if (!executableRemoteCommandKind(commandKindValue)) {
    const skippedEvidence = {
      ...evidence,
      execution: 'skipped',
      skipReason: 'Non-shell deployment intent is recorded as evidence and is not executed by the fake transport harness.'
    };
    return {
      stepId: step.stepId,
      status: 'passed',
      exitCode: 0,
      stdout: JSON.stringify(redactEvidence(workerStep, skippedEvidence), null, 2),
      stderr: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
  const passedEvidence = {
    ...evidence,
    execution: 'fake-executed',
    executionResult: {
      exitCode: 0,
      stdout: `fake transport recorded ${commandKindValue}: remote command was not executed`,
      stderr: ''
    }
  };
  return {
    stepId: step.stepId,
    status: 'passed',
    exitCode: 0,
    stdout: JSON.stringify(redactEvidence(workerStep, passedEvidence), null, 2),
    stderr: null,
    startedAt,
    finishedAt: new Date().toISOString(),
    attempt
  };
}

function awxShadowStep(step, job, managedSshProfile) {
  const startedAt = new Date().toISOString();
  const workerStep = normalizeRemoteWorkerStep(step, job);
  const sshProfile = buildSshProfile(job, managedSshProfile);
  const commandKindValue = commandKind(workerStep.command);
  const evidence = artifactPushEvidence(workerStep, job, {
    mode: 'awx-shadow',
    dryRun: true,
    execution: 'shadow-planned',
    boundary: 'awx-api-shadow-no-remote-mutation',
    sshProfile,
    awx: awxShadowEvidence(workerStep, job, sshProfile, commandKindValue)
  });
  const failed = evidence.failures.length > 0;
  const shadowEvidence = {
    ...evidence,
    awx: awxShadowEvidence(workerStep, job, sshProfile, commandKindValue),
    executionResult: {
      exitCode: failed ? 1 : 0,
      stdout: failed
        ? 'awx shadow validation failed before job-template planning'
        : `awx shadow planned ${awxJobTemplate(job)} for ${job.siteId}`,
      stderr: failed ? evidence.failures.join('\n') : ''
    }
  };
  return {
    stepId: step.stepId,
    status: failed ? 'failed' : 'passed',
    exitCode: failed ? 1 : 0,
    stdout: JSON.stringify(redactEvidence(workerStep, shadowEvidence), null, 2),
    stderr: failed ? evidence.failures.join('\n') : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    attempt
  };
}

async function executeStep(step) {
  const startedAt = new Date().toISOString();
  try {
    const result = await execAsync(step.command, {
      cwd: commandCwd,
      timeout: positiveInt(step.timeoutSeconds, 60) * 1000,
      maxBuffer
    });
    return {
      stepId: step.stepId,
      status: 'passed',
      exitCode: 0,
      stdout: outputFor(step, result.stdout),
      stderr: outputFor(step, result.stderr),
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  } catch (error) {
    return {
      stepId: step.stepId,
      status: 'failed',
      exitCode: typeof error.code === 'number' ? error.code : null,
      stdout: outputFor(step, error.stdout),
      stderr: outputFor(step, error.stderr || error.message),
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
}

function normalizeRemoteWorkerStep(step, job) {
  const { command, normalizations } = normalizeRemoteWorkerCommand(step.command, step, job);
  if (command === step.command) return step;
  return {
    ...step,
    command,
    originalCommand: step.command,
    normalization: {
      id: normalizations.map((item) => item.id).join('+'),
      reason: normalizations.map((item) => item.reason).join(' ')
    }
  };
}

function normalizeRemoteWorkerCommand(command, step, job) {
  let nextCommand = command;
  const normalizations = [];
  const releaseNormalizedCommand = normalizeReleaseRevisionPlaceholders(nextCommand, job);
  if (releaseNormalizedCommand !== nextCommand) {
    nextCommand = releaseNormalizedCommand;
    normalizations.push({
      id: 'release-revision-placeholder-v1',
      reason: 'The worker resolves release revision placeholders from the materialized artifact manifest before opening SSH.'
    });
  }
  if (job.kind !== 'oversea') return { command: nextCommand, normalizations };
  const phaseId = phaseIdFromSource(step.sourceId || '');
  if (phaseId === 'remote-preflight') {
    if (nextCommand.includes('id -u && uname -a && docker version && docker compose version')) {
      normalizations.push(dockerBootstrapNormalization());
      return {
        command: nextCommand.replace(
          /id -u && uname -a && docker version && docker compose version/g,
          `id -u && uname -a && df -h / && ${dockerReadonlyProbeScript()}`
        ),
        normalizations
      };
    }
    const dockerProbeCommand = nextCommand.replace(
      /docker compose version/g,
      'test -d /opt/mx/current/hysteria2-access-stack || test -d /opt/mx/releases/oversea-access-stack || echo "oversea access stack: missing before install"'
    );
    if (dockerProbeCommand !== nextCommand) normalizations.push(dockerBootstrapNormalization());
    return { command: dockerProbeCommand, normalizations };
  }
  if (phaseId === 'configure-oversea-access' && nextCommand.includes('curl -fsSL https://get.docker.com | sh')) {
    normalizations.push(dockerBootstrapNormalization());
    return {
      command: nextCommand.replace(
        /if ! command -v docker >\/dev\/null 2>&1; then curl -fsSL https:\/\/get\.docker\.com \| sh; fi; docker version && docker compose version/g,
        dockerInstallScript()
      ),
      normalizations
    };
  }
  return { command: nextCommand, normalizations };
}

function normalizeReleaseRevisionPlaceholders(command, job) {
  if (!command.includes('<release-revision>') && !command.includes('__release_revision__')) return command;
  return command.replace(/<release-revision>|__release_revision__/g, releaseRevisionForJob(job));
}

function releaseRevisionForJob(job) {
  const manifest = readManifest(job.kind, []);
  return safeReleaseRevision(process.env.SITE_SLOT_RELEASE_REVISION || manifest?.releaseRevision || 'latest');
}

function safeReleaseRevision(value) {
  const normalized = String(value || 'latest')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'latest';
}

function dockerBootstrapNormalization() {
  return {
    id: 'oversea-docker-bootstrap-compat-v1',
    reason: 'Existing Oversea plans may still treat Docker as a pre-installed preflight dependency. The worker converts those steps into fresh-Ubuntu compatible probes/installers at execution time.'
  };
}

function dockerReadonlyProbeScript() {
  return 'if command -v docker >/dev/null 2>&1; then docker version --format "{{.Server.Version}}" 2>/dev/null || docker version; else echo "docker: missing"; fi; if docker compose version >/dev/null 2>&1; then docker compose version; else echo "docker compose: missing"; fi';
}

function dockerInstallScript() {
  return [
    'set -eu',
    'printf "mx-docker-bootstrap\\n"',
    '. /etc/os-release 2>/dev/null || true',
    'echo "os=${ID:-unknown} version=${VERSION_ID:-unknown}"',
    'if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then echo "docker: present"; else if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y ca-certificates curl gnupg lsb-release; curl -fsSL https://get.docker.com | sh; elif command -v dnf >/dev/null 2>&1; then dnf install -y ca-certificates curl; curl -fsSL https://get.docker.com | sh; elif command -v yum >/dev/null 2>&1; then yum install -y ca-certificates curl; curl -fsSL https://get.docker.com | sh; elif command -v apk >/dev/null 2>&1; then apk add --no-cache docker docker-cli-compose; elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install docker docker-compose || curl -fsSL https://get.docker.com | sh; else curl -fsSL https://get.docker.com | sh; fi; fi',
    'if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker || true; elif command -v service >/dev/null 2>&1; then service docker start || true; elif command -v rc-update >/dev/null 2>&1; then rc-update add docker default || true; service docker start || true; fi',
    'docker version',
    'docker compose version || docker-compose version'
  ].join('; ');
}

function artifactPushEvidence(step, job, options) {
  const phaseId = phaseIdFromSource(step.sourceId);
  const artifactRefs = artifactReferences(step.command);
  const failures = [];
  const artifacts = artifactRefs.map((ref) => artifactEvidence(ref, failures));
  return {
    dryRun: options.dryRun,
    mode: options.mode,
    execution: options.execution,
    boundary: options.boundary,
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    sourceId: step.sourceId,
    phaseId,
    stepId: step.stepId,
    order: step.order,
    target: step.target,
    requiresRoot: step.requiresRoot,
    commandKind: commandKind(step.command),
    command: step.command,
    originalCommand: step.originalCommand,
    normalization: step.normalization,
    effectiveCommand: options.effectiveCommand,
    artifactBaseDir,
    artifactReferences: artifacts,
    sshProfile: options.sshProfile ? sshProfileEvidence(options.sshProfile) : undefined,
    awx: options.awx,
    fakeTransport: options.fakeTransport,
    planOnly: options.planOnly,
    transport: transportEvidence(step.command),
    notes: [
      'This worker mode validates Internal-side artifacts and emits deployment evidence.',
      options.mode === 'artifact-push-remote-ssh'
        ? 'Remote SSH mode executes only gated shell transport/remote-shell steps and records non-shell intents as skipped evidence.'
        : options.mode === 'artifact-push-remote-ssh-plan'
          ? 'Remote SSH plan mode expands the SSH profile and records final commands without opening SSH/rsync/scp.'
          : options.mode === 'artifact-push-fake-transport'
            ? 'Fake transport mode exercises remote SSH gates and records report evidence without opening SSH/rsync/scp.'
            : options.mode === 'awx-shadow'
              ? 'AWX shadow mode maps worker steps to inventory, credential, job template, and task event evidence without calling AWX.'
              : 'It does not open SSH, run rsync/scp, mutate Domestic, or mutate Oversea.'
    ],
    failures
  };
}

function awxShadowEvidence(step, job, sshProfile, commandKindValue) {
  return {
    provider: 'awx-shadow',
    organization: process.env.AWX_ORGANIZATION || 'MX Internal',
    baseUrl: process.env.AWX_BASE_URL || null,
    inventory: awxInventory(job),
    inventoryHost: job.siteId,
    credential: sshProfile.managedProfileId || `${job.kind}-${job.siteId}-machine`,
    project: process.env.AWX_PROJECT || 'mx-launcher-site-slots',
    jobTemplate: awxJobTemplate(job),
    launchMode: 'shadow-only',
    request: {
      extraVars: {
        mx_plan_id: job.planId,
        mx_job_id: job.jobId,
        mx_site_id: job.siteId,
        mx_site_kind: job.kind,
        mx_step_id: step.stepId,
        mx_source_id: step.sourceId,
        mx_command_kind: commandKindValue
      },
      limit: job.siteId,
      diffMode: true,
      checkMode: true
    },
    event: {
      counter: step.order,
      event: 'runner_on_ok',
      task: step.sourceId,
      host: job.siteId,
      stdout: `awx shadow recorded ${commandKindValue}; no AWX job was launched`
    }
  };
}

function awxInventory(job) {
  return `mx-${job.environment}-${job.kind}`;
}

function awxJobTemplate(job) {
  return `mx-site-slot-${job.kind}-worker-v1`;
}

function remoteSshGateFailures(job, step, evidence, commandKindValue, sshProfile) {
  const failures = [...evidence.failures];
  if (job.status !== 'ready') failures.push(`worker job is not ready: ${job.status}`);
  if (job.currentReportId) failures.push(`worker job already has report: ${job.currentReportId}`);
  if (job.mode !== 'remote-ssh') failures.push(`worker job mode must be remote-ssh, got ${job.mode}`);
  if (job.approval?.required && job.approval.status !== 'recorded') failures.push('remote worker job approval is not recorded');
  if (job.changeWindow?.required && (!job.changeWindow.start || !job.changeWindow.end)) {
    failures.push('remote worker job requires changeWindowStart and changeWindowEnd');
  }
  if (evidence.transport.repositoryRootSynced) failures.push('remote command appears to sync or pull the repository root');
  if (executableRemoteCommandKind(commandKindValue) && !allowedRemoteShellCommand(step.command)) {
    failures.push(`remote command kind is not allowed for artifact-push-remote-ssh: ${commandKindValue}`);
  }
  if (sshProfile.profileFilePath && !sshProfile.profileFileExists) failures.push(`SSH profile file does not exist: ${sshProfile.profileFilePath}`);
  if (sshProfile.profileFileError) failures.push(`SSH profile file is invalid: ${sshProfile.profileFileError}`);
  if (sshProfile.managedProfileStatus === 'paused') failures.push(`managed SSH profile is paused: ${sshProfile.managedProfileId}`);
  if (sshProfile.identityFile && !existsSync(sshProfile.identityFile)) failures.push(`SSH identity file does not exist: ${sshProfile.identityFile}`);
  if (sshProfile.knownHostsFile && !existsSync(sshProfile.knownHostsFile)) failures.push(`SSH known_hosts file does not exist: ${sshProfile.knownHostsFile}`);
  if (sshProfile.sshConfigFile && !existsSync(sshProfile.sshConfigFile)) failures.push(`SSH config file does not exist: ${sshProfile.sshConfigFile}`);
  return failures;
}

function remoteReadonlyProbeGateFailures(job, sshProfile) {
  const failures = [];
  if (job.status !== 'ready') failures.push(`worker job is not ready: ${job.status}`);
  if (job.currentReportId) failures.push(`worker job already has report: ${job.currentReportId}`);
  if (job.mode !== 'remote-ssh') failures.push(`worker job mode must be remote-ssh, got ${job.mode}`);
  if (job.approval?.required && job.approval.status !== 'recorded') failures.push('remote worker job approval is not recorded');
  if (job.changeWindow?.required && (!job.changeWindow.start || !job.changeWindow.end)) {
    failures.push('remote worker job requires changeWindowStart and changeWindowEnd');
  }
  if (!sshProfile.host) failures.push('SSH host is required before remote-readonly-probe can execute');
  if (!sshProfile.sshUser) failures.push('SSH user is required before remote-readonly-probe can execute');
  if (!sshProfile.sshPort) failures.push('SSH port is required before remote-readonly-probe can execute');
  if (sshProfile.profileFilePath && !sshProfile.profileFileExists) failures.push(`SSH profile file does not exist: ${sshProfile.profileFilePath}`);
  if (sshProfile.profileFileError) failures.push(`SSH profile file is invalid: ${sshProfile.profileFileError}`);
  if (sshProfile.managedProfileStatus === 'paused') failures.push(`managed SSH profile is paused: ${sshProfile.managedProfileId}`);
  if (!sshProfile.identityFile) failures.push('SSH identity file is required before remote-readonly-probe can execute');
  if (sshProfile.identityFile && !existsSync(sshProfile.identityFile)) failures.push(`SSH identity file does not exist: ${sshProfile.identityFile}`);
  if (!sshProfile.knownHostsFile) failures.push('SSH known_hosts file is required before remote-readonly-probe can verify host keys');
  if (sshProfile.knownHostsFile && !existsSync(sshProfile.knownHostsFile)) failures.push(`SSH known_hosts file does not exist: ${sshProfile.knownHostsFile}`);
  if (sshProfile.sshConfigFile && !existsSync(sshProfile.sshConfigFile)) failures.push(`SSH config file does not exist: ${sshProfile.sshConfigFile}`);
  if (sshProfile.strictHostKeyChecking !== 'yes') failures.push('StrictHostKeyChecking=yes is required before remote-readonly-probe');
  if (sshProfile.batchMode !== 'yes') failures.push('BatchMode=yes is required before remote-readonly-probe');
  return failures;
}

function artifactEvidence(ref, failures) {
  const resolvedPath = resolveArtifactReference(ref);
  const exists = existsSync(resolvedPath);
  const kind = artifactKind(ref);
  const manifest = kind ? readManifest(kind, failures) : null;
  const moduleMatch = artifactModuleMatch(manifest, resolvedPath, ref);
  const module = moduleMatch?.module ?? null;
  const manifestSelfReference = basename(resolvedPath) === 'manifest.json';
  const sha256 = exists ? sha256File(resolvedPath) : null;
  if (!exists) failures.push(`missing artifact: ${ref} -> ${resolvedPath}`);
  if (exists && !manifest) failures.push(`missing artifact manifest for ${ref}`);
  if (exists && manifest && !module && !manifestSelfReference) failures.push(`artifact not listed in manifest: ${ref}`);
  if (exists && moduleMatch?.primary && module?.sha256 && sha256 !== module.sha256) {
    failures.push(`artifact sha256 mismatch for ${ref}: expected ${module.sha256}, got ${sha256}`);
  }
  return {
    ref,
    path: resolvedPath,
    exists,
    bytes: exists ? statSync(resolvedPath).size : null,
    sha256,
    manifest: manifest ? {
      path: manifest.path,
      releaseRevision: manifest.releaseRevision ?? null,
      kind: manifest.kind ?? null,
      sha256: manifest.sha256,
      sha256Status: manifest.sha256Status
    } : null,
    module: module ? {
      moduleId: module.moduleId,
      status: module.status,
      targetPath: module.targetPath,
      manifestSha256: module.sha256,
      sha256Status: moduleMatch?.primary ? module.sha256 === sha256 ? 'passed' : 'failed' : 'module-file',
      bytes: module.bytes ?? null,
      metadata: module.metadata ?? {}
    } : null
  };
}

function artifactModuleMatch(manifest, resolvedPath, ref) {
  const modules = Array.isArray(manifest?.modules) ? manifest.modules : [];
  const resolvedBasename = basename(resolvedPath);
  const refRelative = ref.replace(/^\.\/artifacts\/site-slots\/[^/]+\//, '');
  for (const module of modules) {
    const primaryBasename = basename(module.artifactPath || module.artifact || '');
    if (primaryBasename === resolvedBasename) return { module, primary: true };
    const files = Array.isArray(module.files) ? module.files : [];
    if (files.some((file) => file === refRelative || basename(String(file)) === resolvedBasename)) {
      return { module, primary: false };
    }
  }
  return null;
}

function readManifest(kind, failures) {
  if (manifestCache.has(kind)) return manifestCache.get(kind);
  const manifestPath = resolve(artifactBaseDir, kind, 'manifest.json');
  if (!existsSync(manifestPath)) {
    manifestCache.set(kind, null);
    return null;
  }
  const manifestText = readFileSync(manifestPath, 'utf8');
  const manifest = parseJson(manifestText);
  if (!manifest || typeof manifest !== 'object') {
    failures.push(`invalid artifact manifest: ${manifestPath}`);
    manifestCache.set(kind, null);
    return null;
  }
  const actualSha = sha256Text(manifestText);
  const shaFilePath = `${manifestPath}.sha256`;
  const expectedSha = existsSync(shaFilePath)
    ? readFileSync(shaFilePath, 'utf8').trim().split(/\s+/)[0]
    : null;
  const result = {
    ...manifest,
    path: manifestPath,
    sha256: actualSha,
    sha256Status: expectedSha ? expectedSha === actualSha ? 'passed' : 'failed' : 'missing-sha256-file'
  };
  if (expectedSha && expectedSha !== actualSha) failures.push(`manifest sha256 mismatch: ${manifestPath}`);
  if (!expectedSha) failures.push(`missing manifest sha256 file: ${shaFilePath}`);
  manifestCache.set(kind, result);
  return result;
}

function artifactReferences(command) {
  return Array.from(new Set((command.match(/\.\/artifacts\/site-slots\/[A-Za-z0-9._/-]+/g) ?? [])
    .map((value) => value.replace(/[;,'")]+$/g, ''))
    .filter((value) => basename(value).includes('.'))));
}

function resolveArtifactReference(ref) {
  const match = ref.match(/^\.\/artifacts\/site-slots\/([^/]+)\/(.+)$/);
  if (match) return resolve(artifactBaseDir, match[1], match[2]);
  return resolve(commandCwd, ref);
}

function artifactKind(ref) {
  return ref.match(/^\.\/artifacts\/site-slots\/([^/]+)\//)?.[1] ?? null;
}

function phaseIdFromSource(sourceId) {
  return sourceId.replace(/\.\d+$/, '');
}

function commandKind(command) {
  if (command.startsWith('POST ')) return 'admin-api-intent';
  if (command.startsWith('Release Center ')) return 'artifact-materialize-intent';
  if (command.startsWith('If @qpjoy/tunnel-cli ')) return 'artifact-refresh-intent';
  if (command.includes('rsync ') || command.includes('scp ')) return 'artifact-transport';
  if (command.startsWith('ssh ')) return 'remote-shell-intent';
  if (command.startsWith('Check ')) return 'manual-smoke-intent';
  return 'planned-command';
}

function executableRemoteCommandKind(value) {
  return value === 'artifact-transport' || value === 'remote-shell-intent';
}

function allowedRemoteShellCommand(command) {
  if (command.includes('git pull') || command.includes('git clone')) return false;
  return command.startsWith('ssh ') || command.includes('rsync ') || command.includes('scp ');
}

async function executeRemoteWorkerCommand(step, sshProfile, effectiveCommand) {
  const remoteShell = remoteShellCommandFromPlan(step.command);
  if (remoteShell) {
    return execFileAsync('ssh', sshArgv(sshProfile, remoteShell.remoteCommand), {
      cwd: commandCwd,
      timeout: positiveInt(step.timeoutSeconds, 60) * 1000,
      maxBuffer
    });
  }
  return execAsync(effectiveCommand, {
    cwd: commandCwd,
    timeout: positiveInt(step.timeoutSeconds, 60) * 1000,
    maxBuffer
  });
}

function remoteShellCommandFromPlan(command) {
  const match = String(command || '').trim().match(/^ssh\s+-p\s+([0-9]+)\s+\S+\s+'([\s\S]*)'$/);
  if (!match) return null;
  return {
    port: Number(match[1]),
    remoteCommand: unescapePlanSingleQuoted(match[2])
  };
}

function unescapePlanSingleQuoted(value) {
  return String(value).replace(/'\\''/g, "'");
}

function buildSshProfile(job, managedSshProfile) {
  const profileFilePath = configuredPath(process.env.SITE_SLOT_SSH_PROFILE_FILE);
  const profileFile = readSshProfileFile(profileFilePath);
  const raw = { ...(managedSshProfile ?? {}), ...profileFile.value };
  const identityFile = configuredPath(envOrProfile('SITE_SLOT_SSH_IDENTITY_FILE', raw.identityFile));
  const knownHostsFile = configuredPath(envOrProfile('SITE_SLOT_SSH_KNOWN_HOSTS_FILE', raw.knownHostsFile));
  const sshConfigFileValue = configuredPath(envOrProfile('SITE_SLOT_SSH_CONFIG_FILE', raw.sshConfigFile));
  return {
    source: managedSshProfile ? 'config-center' : profileFilePath ? 'profile-file' : 'env-or-default',
    managedProfileId: managedSshProfile?.profileId ?? null,
    managedProfileStatus: managedSshProfile?.status ?? null,
    managedProfileWarnings: managedSshProfile?.warnings ?? [],
    name: stringEnvOrProfile('SITE_SLOT_SSH_PROFILE_NAME', raw.name, `${job.kind}-${job.siteId}`),
    profileFilePath,
    profileFileExists: profileFile.exists,
    profileFileError: profileFile.error,
    host: stringEnvOrProfile('SITE_SLOT_SSH_HOST', raw.host, null),
    sshUser: stringEnvOrProfile('SITE_SLOT_SSH_USER', raw.sshUser, 'root'),
    sshPort: positiveInt(stringEnvOrProfile('SITE_SLOT_SSH_PORT', raw.sshPort, '22'), 22),
    identityFile,
    knownHostsFile,
    sshConfigFile: sshConfigFileValue,
    hostKeyAlias: stringEnvOrProfile('SITE_SLOT_SSH_HOST_KEY_ALIAS', raw.hostKeyAlias, null),
    strictHostKeyChecking: strictHostKeyCheckingValue(
      stringEnvOrProfile('SITE_SLOT_SSH_STRICT_HOST_KEY_CHECKING', raw.strictHostKeyChecking, 'yes')
    ),
    connectTimeoutSeconds: Math.max(
      30,
      positiveInt(stringEnvOrProfile('SITE_SLOT_SSH_CONNECT_TIMEOUT_SECONDS', raw.connectTimeoutSeconds, '30'), 30)
    ),
    batchMode: yesNoValue(stringEnvOrProfile('SITE_SLOT_SSH_BATCH_MODE', raw.batchMode, 'yes'))
  };
}

function readSshProfileFile(profileFilePath) {
  if (!profileFilePath) return { exists: false, error: null, value: {} };
  if (!existsSync(profileFilePath)) return { exists: false, error: null, value: {} };
  try {
    const parsed = parseJson(readFileSync(profileFilePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { exists: true, error: 'expected JSON object', value: {} };
    return { exists: true, error: null, value: parsed };
  } catch (error) {
    return { exists: true, error: errorMessage(error), value: {} };
  }
}

function applySshProfile(command, profile) {
  const options = sshOptionFragment(profile);
  if (!options) return command;
  let next = command.replace(/-e 'ssh -p ([0-9]+)'/g, (_match, port) => `-e ${shellQuote(`ssh ${options} -p ${port}`)}`);
  next = next.replace(/\bscp (-r )?-P ([0-9]+)/g, (_match, recursive = '', port) => `scp ${recursive}${options} -P ${port}`);
  let replacedSshPort = false;
  next = next.replace(/\bssh -p ([0-9]+)/g, (_match, port) => {
    replacedSshPort = true;
    return `ssh ${options} -p ${port}`;
  });
  if (!replacedSshPort && next.startsWith('ssh ')) {
    next = next.replace(/^ssh\b/, `ssh ${options}`);
  }
  return next;
}

function sshArgv(profile, remoteCommand) {
  return [
    ...sshOptionArgs(profile),
    '-p',
    String(profile.sshPort || 22),
    `${profile.sshUser || 'root'}@${profile.host || '<host>'}`,
    remoteCommand
  ];
}

function sshOptionArgs(profile) {
  const configFile = sshConfigFile(profile);
  const args = [
    '-F', configFile,
    '-o', `BatchMode=${profile.batchMode}`,
    '-o', `ConnectTimeout=${profile.connectTimeoutSeconds}`,
    '-o', 'ConnectionAttempts=2',
    '-o', 'AddressFamily=inet',
    '-o', 'IPQoS=none',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', `StrictHostKeyChecking=${profile.strictHostKeyChecking}`
  ];
  if (sshUsesDefaultIsolatedConfig(profile)) {
    args.push('-o', 'ProxyCommand=none', '-o', 'ProxyJump=none');
  }
  if (profile.identityFile) args.push('-i', profile.identityFile);
  if (profile.knownHostsFile) args.push('-o', `UserKnownHostsFile=${profile.knownHostsFile}`);
  if (profile.hostKeyAlias) {
    args.push('-o', `HostKeyAlias=${profile.hostKeyAlias}`);
    args.push('-o', 'CheckHostIP=no');
  }
  return args;
}

function sshConfigFile(profile) {
  return profile?.sshConfigFile
    || configuredPath(process.env.MX_SITE_SLOT_SSH_CONFIG_FILE || process.env.SITE_SLOT_SSH_CONFIG_FILE || '/dev/null');
}

function sshUsesDefaultIsolatedConfig(profile) {
  return !profile?.sshConfigFile && !process.env.MX_SITE_SLOT_SSH_CONFIG_FILE && !process.env.SITE_SLOT_SSH_CONFIG_FILE;
}

function sshOptionFragment(profile) {
  return sshOptionArgs(profile).map(shellQuote).join(' ');
}

function sshProfileEvidence(profile) {
  return {
    source: profile.source,
    managedProfileId: profile.managedProfileId,
    managedProfileStatus: profile.managedProfileStatus,
    managedProfileWarnings: profile.managedProfileWarnings,
    name: profile.name,
    profileFilePath: profile.profileFilePath,
    profileFileExists: profile.profileFilePath ? profile.profileFileExists : null,
    host: profile.host,
    sshUser: profile.sshUser,
    sshPort: profile.sshPort,
    identityFile: profile.identityFile,
    identityFileExists: profile.identityFile ? existsSync(profile.identityFile) : null,
    knownHostsFile: profile.knownHostsFile,
    knownHostsFileExists: profile.knownHostsFile ? existsSync(profile.knownHostsFile) : null,
    sshConfigFile: profile.sshConfigFile,
    sshConfigFileExists: profile.sshConfigFile ? existsSync(profile.sshConfigFile) : null,
    hostKeyAlias: profile.hostKeyAlias,
    strictHostKeyChecking: profile.strictHostKeyChecking,
    connectTimeoutSeconds: profile.connectTimeoutSeconds,
    batchMode: profile.batchMode
  };
}

function readOnlyProbeCommand(profile) {
  return `ssh ${sshOptionFragment(profile)} -p ${shellQuote(profile.sshPort || 22)} ${shellQuote(`${profile.sshUser || 'root'}@${profile.host || '<host>'}`)} ${shellQuote(probeScript())}`;
}

function probeScript() {
  return [
    'set -eu',
    'printf "mx-readonly-worker-probe\\n"',
    'whoami',
    'hostname',
    'uname -a',
    'pwd',
    'df -h /',
    'if command -v docker >/dev/null 2>&1; then docker version --format "{{.Server.Version}}" 2>/dev/null || docker version; else echo "docker: missing"; fi'
  ].join('; ');
}

function configuredPath(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const expanded = raw.startsWith('~/') && process.env.HOME ? `${process.env.HOME}${raw.slice(1)}` : raw;
  return resolve(commandCwd, expanded);
}

function envOrProfile(envName, profileValue) {
  return process.env[envName] ?? profileValue ?? null;
}

function stringEnvOrProfile(envName, profileValue, fallback) {
  const value = envOrProfile(envName, profileValue);
  if (value === null || value === undefined || value === '') return fallback;
  return String(value).trim();
}

function strictHostKeyCheckingValue(value) {
  return ['yes', 'no', 'ask', 'accept-new'].includes(value) ? value : 'yes';
}

function yesNoValue(value) {
  return value === 'no' ? 'no' : 'yes';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sshFailureDiagnosis(stderr, exitCode) {
  const text = String(stderr || '');
  const lower = text.toLowerCase();
  let category = 'unknown';
  let summary = 'SSH command failed';
  const nextActions = ['open-remote-terminal-inspect', 'check-ssh-profile-and-host-firewall'];
  if (lower.includes('connection timed out during banner exchange')) {
    category = 'ssh-banner-timeout';
    summary = 'TCP may be reachable, but SSH did not complete banner exchange before timeout';
    nextActions.push('verify-server-sshd-and-proxy-tun-path');
  } else if (lower.includes('connection timed out') || lower.includes('operation timed out')) {
    category = 'tcp-timeout';
    summary = 'TCP connection to SSH port timed out';
    nextActions.push('verify-port-22-firewall-security-group-or-local-tun-route');
  } else if (lower.includes('no route to host') || lower.includes('network is unreachable')) {
    category = 'network-unreachable';
    summary = 'Internal runner cannot route to the SSH host';
    nextActions.push('check-clash-tun-routing-or-k8s-node-egress');
  } else if (lower.includes('host key verification failed') || lower.includes('no ed25519 host key is known')) {
    category = 'host-key';
    summary = 'Host key verification failed';
    nextActions.push('rerun-bootstrap-key-or-refresh-known-hosts');
  } else if (lower.includes('permission denied')) {
    category = 'auth';
    summary = 'SSH authentication failed';
    nextActions.push('rotate-or-bootstrap-internal-managed-key');
  } else if (typeof exitCode === 'number' && exitCode !== 255) {
    category = 'remote-command';
    summary = 'SSH connected, but the remote command failed';
    nextActions.push('inspect-step-command-output');
  }
  return {
    category,
    summary,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    stderr: text.trim().slice(0, 1000),
    nextActions: Array.from(new Set(nextActions))
  };
}

function tcpConnectProbe(host, port, timeoutSeconds) {
  return new Promise((resolveProbe) => {
    if (!host || host === '<host>') {
      resolveProbe({
        status: 'blocked',
        host: host || null,
        port: port || null,
        durationMs: 0,
        message: 'SSH host is not configured'
      });
      return;
    }
    const started = Date.now();
    const socket = netConnect({ host, port: Number(port || 22) });
    let settled = false;
    const finish = (status, message = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe({
        status,
        host,
        port: Number(port || 22),
        durationMs: Date.now() - started,
        message
      });
    };
    socket.setTimeout(Math.max(1000, Math.min(Number(timeoutSeconds || 10) * 1000, 30000)));
    socket.once('connect', () => finish('passed'));
    socket.once('timeout', () => finish('timeout', 'TCP connect timed out'));
    socket.once('error', (error) => finish('failed', error.message));
  });
}

function transportEvidence(command) {
  return {
    usesRsync: command.includes('rsync '),
    usesScpFallback: command.includes('scp '),
    usesSsh: command.startsWith('ssh ') || command.includes(" -e 'ssh "),
    repositoryRootSynced: command.includes('git pull') || command.includes('git clone') || command.includes(' ./ ')
  };
}

function redactEvidence(step, evidence) {
  if (!step.redactOutput) return evidence;
  return {
    ...evidence,
    command: '[redacted command]',
    effectiveCommand: evidence.effectiveCommand ? '[redacted effective command]' : undefined,
    notes: [...evidence.notes, 'Command was redacted by worker step policy.']
  };
}

function blockedStepReport(step, stderr) {
  const now = new Date().toISOString();
  return {
    stepId: step.stepId,
    status: 'blocked',
    exitCode: null,
    stdout: null,
    stderr,
    startedAt: now,
    finishedAt: now,
    attempt
  };
}

function outputFor(step, value) {
  if (!value) return null;
  return step.redactOutput ? '[redacted output]' : String(value).trimEnd();
}

function overallStatus(stepReports) {
  if (stepReports.some((step) => step.status === 'failed')) return 'failed';
  if (stepReports.some((step) => step.status === 'blocked')) return 'blocked';
  return 'passed';
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function die(message) {
  console.error(message);
  process.exit(1);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
