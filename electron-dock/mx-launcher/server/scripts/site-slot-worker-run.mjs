#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const [baseArg, jobId, modeArg = 'simulate'] = process.argv.slice(2);
const baseUrl = (baseArg || process.env.MX_INTERNAL_BASE_URL || 'http://127.0.0.1:18090').replace(/\/+$/, '');
const mode = modeArg || 'simulate';
const allowedModes = new Set(['simulate', 'artifact-push-dry-run', 'artifact-push-remote-ssh-plan', 'remote-readonly-probe', 'artifact-push-remote-ssh', 'artifact-push-fake-transport', 'local-exec']);

if (!jobId) {
  die('Usage: node server/scripts/site-slot-worker-run.mjs <base-url> <job-id> [simulate|artifact-push-dry-run|artifact-push-remote-ssh-plan|remote-readonly-probe|artifact-push-remote-ssh|artifact-push-fake-transport|local-exec]');
}

if (!allowedModes.has(mode)) {
  die(`Unknown worker-run mode: ${mode}. Expected simulate, artifact-push-dry-run, artifact-push-remote-ssh-plan, remote-readonly-probe, artifact-push-remote-ssh, artifact-push-fake-transport, or local-exec.`);
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

const commandCwd = process.env.SITE_SLOT_WORKER_CWD || process.cwd();
const artifactBaseDir = resolve(process.env.SITE_SLOT_ARTIFACT_BASE_DIR || resolve(commandCwd, 'artifacts/site-slots'));
const manifestCache = new Map();
const maxBuffer = positiveInt(process.env.SITE_SLOT_WORKER_MAX_BUFFER_BYTES, 1024 * 1024);
const attempt = positiveInt(process.env.SITE_SLOT_WORKER_ATTEMPT, 1);

try {
  const { job } = await request(`/internal/v1/site-slots/worker-jobs/${encodeURIComponent(jobId)}`);
  if (!job) die(`Site slot worker job not found: ${jobId}`);
  const managedSshProfile = mode === 'artifact-push-remote-ssh-plan' || mode === 'remote-readonly-probe' || mode === 'artifact-push-remote-ssh' || mode === 'artifact-push-fake-transport'
    ? await fetchManagedSshProfile(job)
    : null;

  const stepReports = [];
  let blockRemaining = false;
  const steps = [...(job.steps || [])].sort((left, right) => Number(left.order || 0) - Number(right.order || 0));

  for (const step of steps) {
    if (mode === 'remote-readonly-probe' && stepReports.length > 0) {
      stepReports.push(remoteReadonlyProbeSkippedStep(step, job));
      continue;
    }

    if (blockRemaining) {
      stepReports.push(blockedStepReport(step, 'blocked: previous step failed'));
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
    message: process.env.SITE_SLOT_WORKER_MESSAGE || `manage.sh worker-run ${mode} ${status}`,
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
  const evidence = artifactPushEvidence(step, job, {
    mode: 'artifact-push-dry-run',
    dryRun: true,
    execution: 'not-executed',
    boundary: 'manifest-and-command-evidence-only'
  });
  return {
    stepId: step.stepId,
    status: evidence.failures.length > 0 ? 'failed' : 'passed',
    exitCode: evidence.failures.length > 0 ? 1 : 0,
    stdout: JSON.stringify(redactEvidence(step, evidence), null, 2),
    stderr: evidence.failures.length > 0 ? evidence.failures.join('\n') : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    attempt
  };
}

function artifactPushRemoteSshPlanStep(step, job, managedSshProfile) {
  const startedAt = new Date().toISOString();
  const commandKindValue = commandKind(step.command);
  const sshProfile = buildSshProfile(job, managedSshProfile);
  const effectiveCommand = applySshProfile(step.command, sshProfile);
  const evidence = artifactPushEvidence(step, job, {
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
  const gateFailures = remoteSshGateFailures(job, step, evidence, commandKindValue, sshProfile);
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
      stdout: JSON.stringify(redactEvidence(step, blockedEvidence), null, 2),
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
      stdout: JSON.stringify(redactEvidence(step, skippedEvidence), null, 2),
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
    stdout: JSON.stringify(redactEvidence(step, plannedEvidence), null, 2),
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
    const result = await execAsync(command, {
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
          stderr: outputFor(step, error.stderr || error.message)
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
  const commandKindValue = commandKind(step.command);
  const sshProfile = buildSshProfile(job, managedSshProfile);
  const effectiveCommand = applySshProfile(step.command, sshProfile);
  const evidence = artifactPushEvidence(step, job, {
    mode: 'artifact-push-remote-ssh',
    dryRun: false,
    execution: executableRemoteCommandKind(commandKindValue) ? 'pending' : 'skipped',
    boundary: 'gated-ssh-rsync-scp-worker',
    effectiveCommand,
    sshProfile
  });
  const gateFailures = remoteSshGateFailures(job, step, evidence, commandKindValue, sshProfile);
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
      stdout: JSON.stringify(redactEvidence(step, blockedEvidence), null, 2),
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
      stdout: JSON.stringify(redactEvidence(step, skippedEvidence), null, 2),
      stderr: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
  try {
    const result = await execAsync(effectiveCommand, {
      cwd: commandCwd,
      timeout: positiveInt(step.timeoutSeconds, 60) * 1000,
      maxBuffer
    });
    const passedEvidence = {
      ...evidence,
      execution: 'executed',
      executionResult: {
        exitCode: 0,
        stdout: outputFor(step, result.stdout),
        stderr: outputFor(step, result.stderr)
      }
    };
    return {
      stepId: step.stepId,
      status: 'passed',
      exitCode: 0,
      stdout: JSON.stringify(redactEvidence(step, passedEvidence), null, 2),
      stderr: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  } catch (error) {
    const failedEvidence = {
      ...evidence,
      execution: 'failed',
      executionResult: {
        exitCode: typeof error.code === 'number' ? error.code : null,
        stdout: outputFor(step, error.stdout),
        stderr: outputFor(step, error.stderr || error.message)
      }
    };
    return {
      stepId: step.stepId,
      status: 'failed',
      exitCode: typeof error.code === 'number' ? error.code : null,
      stdout: JSON.stringify(redactEvidence(step, failedEvidence), null, 2),
      stderr: outputFor(step, error.stderr || error.message),
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt
    };
  }
}

function artifactPushFakeTransportStep(step, job, managedSshProfile) {
  const startedAt = new Date().toISOString();
  const commandKindValue = commandKind(step.command);
  const sshProfile = buildSshProfile(job, managedSshProfile);
  const effectiveCommand = applySshProfile(step.command, sshProfile);
  const evidence = artifactPushEvidence(step, job, {
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
  const gateFailures = remoteSshGateFailures(job, step, evidence, commandKindValue, sshProfile);
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
      stdout: JSON.stringify(redactEvidence(step, blockedEvidence), null, 2),
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
      stdout: JSON.stringify(redactEvidence(step, skippedEvidence), null, 2),
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
    stdout: JSON.stringify(redactEvidence(step, passedEvidence), null, 2),
    stderr: null,
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
    effectiveCommand: options.effectiveCommand,
    artifactBaseDir,
    artifactReferences: artifacts,
    sshProfile: options.sshProfile ? sshProfileEvidence(options.sshProfile) : undefined,
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
            : 'It does not open SSH, run rsync/scp, mutate Domestic, or mutate Oversea.'
    ],
    failures
  };
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
  if (sshProfile.strictHostKeyChecking !== 'yes') failures.push('StrictHostKeyChecking=yes is required before remote-readonly-probe');
  if (sshProfile.batchMode !== 'yes') failures.push('BatchMode=yes is required before remote-readonly-probe');
  return failures;
}

function artifactEvidence(ref, failures) {
  const resolvedPath = resolveArtifactReference(ref);
  const exists = existsSync(resolvedPath);
  const kind = artifactKind(ref);
  const manifest = kind ? readManifest(kind, failures) : null;
  const module = manifest?.modules?.find((item) => basename(item.artifactPath || item.artifact || '') === basename(resolvedPath)) ?? null;
  const manifestSelfReference = basename(resolvedPath) === 'manifest.json';
  const sha256 = exists ? sha256File(resolvedPath) : null;
  if (!exists) failures.push(`missing artifact: ${ref} -> ${resolvedPath}`);
  if (exists && !manifest) failures.push(`missing artifact manifest for ${ref}`);
  if (exists && manifest && !module && !manifestSelfReference) failures.push(`artifact not listed in manifest: ${ref}`);
  if (exists && module?.sha256 && sha256 !== module.sha256) {
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
      sha256Status: module.sha256 === sha256 ? 'passed' : 'failed',
      bytes: module.bytes ?? null,
      metadata: module.metadata ?? {}
    } : null
  };
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

function buildSshProfile(job, managedSshProfile) {
  const profileFilePath = configuredPath(process.env.SITE_SLOT_SSH_PROFILE_FILE);
  const profileFile = readSshProfileFile(profileFilePath);
  const raw = { ...(managedSshProfile ?? {}), ...profileFile.value };
  const identityFile = configuredPath(envOrProfile('SITE_SLOT_SSH_IDENTITY_FILE', raw.identityFile));
  const knownHostsFile = configuredPath(envOrProfile('SITE_SLOT_SSH_KNOWN_HOSTS_FILE', raw.knownHostsFile));
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
    hostKeyAlias: stringEnvOrProfile('SITE_SLOT_SSH_HOST_KEY_ALIAS', raw.hostKeyAlias, null),
    strictHostKeyChecking: strictHostKeyCheckingValue(
      stringEnvOrProfile('SITE_SLOT_SSH_STRICT_HOST_KEY_CHECKING', raw.strictHostKeyChecking, 'yes')
    ),
    connectTimeoutSeconds: positiveInt(
      stringEnvOrProfile('SITE_SLOT_SSH_CONNECT_TIMEOUT_SECONDS', raw.connectTimeoutSeconds, '10'),
      10
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

function sshOptionFragment(profile) {
  const parts = [
    '-o', shellQuote(`BatchMode=${profile.batchMode}`),
    '-o', shellQuote(`ConnectTimeout=${profile.connectTimeoutSeconds}`),
    '-o', shellQuote(`StrictHostKeyChecking=${profile.strictHostKeyChecking}`)
  ];
  if (profile.identityFile) parts.push('-i', shellQuote(profile.identityFile));
  if (profile.knownHostsFile) parts.push('-o', shellQuote(`UserKnownHostsFile=${profile.knownHostsFile}`));
  if (profile.hostKeyAlias) parts.push('-o', shellQuote(`HostKeyAlias=${profile.hostKeyAlias}`));
  return parts.join(' ');
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
    hostKeyAlias: profile.hostKeyAlias,
    strictHostKeyChecking: profile.strictHostKeyChecking,
    connectTimeoutSeconds: profile.connectTimeoutSeconds,
    batchMode: profile.batchMode
  };
}

function readOnlyProbeCommand(profile) {
  const script = [
    'set -eu',
    'printf "mx-readonly-worker-probe\\n"',
    'whoami',
    'hostname',
    'uname -a',
    'pwd',
    'df -h /',
    'if command -v docker >/dev/null 2>&1; then docker version --format "{{.Server.Version}}" 2>/dev/null || docker version; else echo "docker: missing"; fi'
  ].join('; ');
  return `ssh ${sshOptionFragment(profile)} -p ${shellQuote(profile.sshPort || 22)} ${shellQuote(`${profile.sshUser || 'root'}@${profile.host || '<host>'}`)} ${shellQuote(script)}`;
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
