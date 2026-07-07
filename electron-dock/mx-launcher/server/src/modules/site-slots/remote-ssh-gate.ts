import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asRecord } from '../../lib/http.js';
import type { SiteSlotPlan, SiteSlotSshProfile, SiteSlotWorkerJob } from '../../types.js';

const REMOTE_EXECUTION_DISABLED_ENV_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

export function remoteExecutionEnvEnabledByDefault(envName: string) {
  const value = process.env[envName];
  if (!value) {
    return true;
  }
  return !REMOTE_EXECUTION_DISABLED_ENV_VALUES.has(value.trim().toLowerCase());
}

export interface SiteSlotRemoteSshGateInput {
  confirmRemoteExecution: boolean;
  requestedBy: string | null;
  requestId: string | null;
}

export function buildSiteSlotRemoteSshGate(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  input: SiteSlotRemoteSshGateInput
) {
  const checkedAt = new Date().toISOString();
  const jobGateFailures = remoteSshJobGateFailures(job, plan, sshProfile, input.confirmRemoteExecution);
  const stepGates = [...job.steps]
    .sort((left, right) => left.order - right.order)
    .map((step) => remoteSshStepGate(job, step, plan, sshProfile));
  const stepFailures = stepGates.flatMap((step) => step.gateFailures.map((failure) => `${step.stepId}: ${failure}`));
  const gateFailures = [...jobGateFailures, ...stepFailures];
  const verdict = gateFailures.length > 0 ? 'blocked' : 'passed';
  return {
    gateId: `remote_ssh_gate_${job.jobId}`,
    status: verdict,
    verdict,
    mode: 'artifact-push-remote-ssh',
    execution: 'not-executed',
    boundary: 'admin-remote-ssh-gate-only',
    jobId: job.jobId,
    sessionId: job.sessionId,
    runId: job.runId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    workerId: job.worker.workerId,
    requestedBy: input.requestedBy,
    requestId: input.requestId,
    checkedAt,
    confirmRemoteExecution: input.confirmRemoteExecution,
    environmentGates: {
      SITE_SLOT_WORKER_REMOTE_SSH: remoteExecutionEnvEnabledByDefault('SITE_SLOT_WORKER_REMOTE_SSH') ? 'present' : 'missing',
      SITE_SLOT_CONFIRM_REMOTE_EXECUTION: remoteExecutionEnvEnabledByDefault('SITE_SLOT_CONFIRM_REMOTE_EXECUTION') ? 'present' : 'missing'
    },
    sshProfile: siteSlotSshProfileEvidence(plan, sshProfile),
    summary: {
      totalSteps: stepGates.length,
      executableRemoteSteps: stepGates.filter((step) => step.executableRemoteCommand).length,
      artifactTransportSteps: stepGates.filter((step) => step.commandKind === 'artifact-transport').length,
      remoteShellSteps: stepGates.filter((step) => step.commandKind === 'remote-shell-intent').length,
      blockedSteps: stepGates.filter((step) => step.status === 'blocked').length,
      repositoryRootSynced: stepGates.some((step) => step.transport.repositoryRootSynced)
    },
    jobGateFailures,
    stepGates,
    gateFailures,
    nextActions: verdict === 'passed'
      ? ['run-artifact-push-remote-ssh-worker', 'stream-worker-report-evidence', 'prepare-rollback-window']
      : ['fix-remote-ssh-gates', 'refresh-artifact-dry-run', 'keep-remote-execution-disabled']
  };
}

export function buildSiteSlotRemoteSshWorkerHandoff(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  gate: ReturnType<typeof buildSiteSlotRemoteSshGate>,
  input: {
    internalBaseUrl?: string | null;
    workerInternalBaseUrl?: string | null;
    confirmWorkerHandoff: boolean;
  }
) {
  const workerInternalBaseUrl = workerInternalBaseUrlFromSources(
    input.workerInternalBaseUrl,
    input.internalBaseUrl,
    process.env.MX_INTERNAL_BASE_URL
  );
  const env = {
    MX_INTERNAL_BASE_URL: workerInternalBaseUrl,
    MX_WORKER_INTERNAL_BASE_URL: workerInternalBaseUrl,
    SITE_SLOT_WORKER_REMOTE_SSH: '1',
    SITE_SLOT_CONFIRM_REMOTE_EXECUTION: '1',
    SITE_SLOT_WORKER_MODE: 'artifact-push-remote-ssh',
    SITE_SLOT_SSH_PROFILE_ID: plan?.ssh.profileId ?? null
  };
  const blockedReasons = [
    ...(gate.verdict === 'passed' ? [] : gate.gateFailures),
    ...(!input.confirmWorkerHandoff ? ['confirmWorkerHandoff=true is required before returning a remote SSH worker command'] : [])
  ];
  const command = `bash scripts/manage.sh ops site-slot worker-run ${shellSingleQuote(job.jobId)} artifact-push-remote-ssh`;
  return {
    handoffId: `remote_ssh_worker_handoff_${job.jobId}`,
    status: blockedReasons.length > 0 ? 'blocked' : 'ready',
    execution: 'not-started',
    boundary: 'internal-worker-handoff-only',
    command,
    cwd: resolveMxLauncherRoot(),
    env,
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    blockedReasons,
    notes: [
      'Run this handoff only from Internal after the gate is passed and the change window is active.',
      'The Admin API does not open SSH or mutate Domestic/Oversea in this action.',
      'The worker script performs the final remote SSH gate before executing rsync/scp/ssh commands.'
    ],
    nextActions: blockedReasons.length > 0
      ? ['fix-remote-ssh-gates', 'rerun-remote-ssh-gate-check']
      : ['run-worker-handoff-from-internal', 'stream-worker-report-evidence']
  };
}

export function buildSiteSlotRemoteSshReadOnlyProbe(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  gate: ReturnType<typeof buildSiteSlotRemoteSshGate>,
  input: {
    confirmReadOnlyProbe: boolean;
  }
) {
  const sshEvidence = siteSlotSshProfileEvidence(plan, sshProfile);
  const blockedReasons = [
    ...(gate.verdict === 'passed' ? [] : gate.gateFailures),
    ...(!input.confirmReadOnlyProbe ? ['confirmReadOnlyProbe=true is required before returning a read-only SSH probe command'] : [])
  ];
  return {
    probeId: `remote_ssh_readonly_probe_${job.jobId}`,
    status: blockedReasons.length > 0 ? 'blocked' : 'ready',
    execution: 'not-started',
    boundary: 'readonly-ssh-probe-handoff-only',
    command: readOnlyProbeCommand(sshEvidence),
    cwd: resolveMxLauncherRoot(),
    env: {
      SITE_SLOT_WORKER_REMOTE_SSH: '1',
      SITE_SLOT_CONFIRM_REMOTE_EXECUTION: '1',
      SITE_SLOT_READONLY_PROBE: '1',
      SITE_SLOT_SSH_PROFILE_ID: plan?.ssh.profileId ?? null
    },
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    sshProfile: sshEvidence,
    blockedReasons,
    notes: [
      'This probe is read-only and is intended to run from Internal before artifact-push execution.',
      'The Admin API only returns the SSH command; it does not open SSH or mutate Domestic/Oversea.',
      'The command checks identity, host key policy, user, host, kernel, disk, and Docker availability.'
    ],
    nextActions: blockedReasons.length > 0
      ? ['fix-remote-ssh-gates', 'rerun-readonly-probe-after-gate']
      : ['run-readonly-probe-from-internal', 'review-probe-output-before-worker-handoff']
  };
}

function remoteSshStepGate(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null
) {
  const evidence = artifactPushDryRunEvidence(job, step, plan, sshProfile);
  const commandKind = siteSlotCommandKind(step.command);
  const executableRemoteCommand = executableRemoteCommandKind(commandKind);
  const gateFailures = [
    ...evidence.failures,
    ...(evidence.transport.repositoryRootSynced ? ['remote command appears to sync or pull the repository root'] : []),
    ...(executableRemoteCommand && !allowedRemoteShellCommand(step.command)
      ? [`remote command kind is not allowed for artifact-push-remote-ssh: ${commandKind}`]
      : [])
  ];
  return {
    stepId: step.stepId,
    sourceId: step.sourceId,
    phaseId: phaseIdFromSource(step.sourceId),
    order: step.order,
    target: step.target,
    requiresRoot: step.requiresRoot,
    commandKind,
    command: step.redactOutput ? '[redacted command]' : step.command,
    executableRemoteCommand,
    execution: executableRemoteCommand ? 'pending-remote-ssh' : 'skipped-non-shell-intent',
    status: gateFailures.length > 0 ? 'blocked' : 'passed',
    artifactReferences: evidence.artifactReferences,
    transport: evidence.transport,
    gateFailures
  };
}

function remoteSshJobGateFailures(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  confirmRemoteExecution: boolean
): string[] {
  const identityFileExists = sshProfile?.identityFile ? existsSync(sshProfile.identityFile) : null;
  const knownHostsFileExists = sshProfile?.knownHostsFile ? existsSync(sshProfile.knownHostsFile) : null;
  const sshConfigFileExists = sshProfile?.sshConfigFile ? existsSync(sshProfile.sshConfigFile) : null;
  return [
    ...(job.status !== 'ready' ? [`worker job is not ready: ${job.status}`] : []),
    ...(job.currentReportId ? [`worker job already has report: ${job.currentReportId}`] : []),
    ...(job.mode !== 'remote-ssh' ? [`worker job mode must be remote-ssh, got ${job.mode}`] : []),
    ...(job.approval.required && job.approval.status !== 'recorded' ? ['remote worker job approval is not recorded'] : []),
    ...(job.changeWindow.required && (!job.changeWindow.start || !job.changeWindow.end) ? ['remote worker job requires changeWindowStart and changeWindowEnd'] : []),
    ...(!confirmRemoteExecution ? ['confirmRemoteExecution=true is required for remote SSH gate review'] : []),
    ...(remoteExecutionEnvEnabledByDefault('SITE_SLOT_WORKER_REMOTE_SSH') ? [] : ['SITE_SLOT_WORKER_REMOTE_SSH=1 is required before artifact-push-remote-ssh can execute']),
    ...(remoteExecutionEnvEnabledByDefault('SITE_SLOT_CONFIRM_REMOTE_EXECUTION') ? [] : ['SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 is required after Admin approval and change-window review']),
    ...(plan ? [] : ['plan not found while building remote SSH gate']),
    ...(plan && !plan.host ? [`${plan.kind} host is required before remote SSH execution`] : []),
    ...(!plan?.ssh.profileId ? ['managed SSH profile is required before Admin remote SSH execution'] : []),
    ...(plan?.ssh.profileStatus === 'paused' || sshProfile?.status === 'paused' ? [`managed SSH profile is paused: ${plan?.ssh.profileId ?? sshProfile?.profileId ?? '<unknown>'}`] : []),
    ...(plan?.ssh.profileWarnings ?? []),
    ...(sshProfile?.identityFile ? [] : ['SSH identity file is required before artifact-push-remote-ssh can execute']),
    ...(sshProfile?.identityFile && identityFileExists === false ? [`SSH identity file does not exist: ${sshProfile.identityFile}`] : []),
    ...(sshProfile?.knownHostsFile ? [] : ['SSH known_hosts file is required before artifact-push-remote-ssh can verify host keys']),
    ...(sshProfile?.knownHostsFile && knownHostsFileExists === false ? [`SSH known_hosts file does not exist: ${sshProfile.knownHostsFile}`] : []),
    ...(sshProfile?.sshConfigFile && sshConfigFileExists === false ? [`SSH config file does not exist: ${sshProfile.sshConfigFile}`] : [])
  ];
}

function artifactPushDryRunEvidence(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null
) {
  const failures: string[] = [];
  const artifactBaseDir = resolveSiteSlotArtifactBaseDir();
  const artifactReferences = artifactReferenceValues(step.command).map((ref) => artifactReferenceEvidence(ref, artifactBaseDir, failures));
  return {
    dryRun: true,
    mode: 'artifact-push-dry-run',
    execution: 'not-executed',
    boundary: 'manifest-and-command-evidence-only',
    summaryLines: [
      'artifact-push dry-run: remote execution skipped',
      `target=${step.target}`,
      `requiresRoot=${step.requiresRoot ? 'yes' : 'no'}`,
      `timeoutSeconds=${step.timeoutSeconds}`
    ],
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    sourceId: step.sourceId,
    phaseId: phaseIdFromSource(step.sourceId),
    stepId: step.stepId,
    order: step.order,
    target: step.target,
    requiresRoot: step.requiresRoot,
    commandKind: siteSlotCommandKind(step.command),
    command: step.command,
    artifactBaseDir,
    artifactReferences,
    sshProfile: siteSlotSshProfileEvidence(plan, sshProfile),
    transport: siteSlotTransportEvidence(step.command),
    notes: [
      'This site-slot gate validates Internal-side artifacts and emits deployment evidence.',
      'It does not open SSH, run rsync/scp, mutate Domestic, or mutate Oversea.'
    ],
    failures
  };
}

function artifactReferenceEvidence(ref: string, artifactBaseDir: string, failures: string[]) {
  const resolvedPath = resolveArtifactReference(ref, artifactBaseDir);
  const exists = existsSync(resolvedPath);
  const kind = artifactKind(ref);
  const manifest = kind ? readArtifactManifest(kind, artifactBaseDir, failures) : null;
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
  if (exists && module?.status === 'template' && !manifestSelfReference) {
    failures.push(`artifact module is template-only and cannot be remotely applied before Internal injection: ${module.moduleId}`);
  }
  return {
    ref,
    path: resolvedPath,
    exists,
    bytes: exists ? statSync(resolvedPath).size : null,
    sha256,
    manifest: manifest ? {
      path: manifest.path,
      releaseRevision: manifest.releaseRevision,
      kind: manifest.kind,
      sha256: manifest.sha256,
      sha256Status: manifest.sha256Status
    } : null,
    module: module ? {
      moduleId: module.moduleId,
      status: module.status,
      targetPath: module.targetPath,
      manifestSha256: module.sha256,
      sha256Status: moduleMatch?.primary ? module.sha256 === sha256 ? 'passed' : 'failed' : 'module-file',
      bytes: module.bytes,
      metadata: module.metadata
    } : null
  };
}

function artifactModuleMatch(
  manifest: ReturnType<typeof readArtifactManifest> | null,
  resolvedPath: string,
  ref: string
) {
  const resolvedBasename = basename(resolvedPath);
  const refRelative = ref.replace(/^\.\/artifacts\/site-slots\/[^/]+\//, '');
  for (const module of manifest?.modules ?? []) {
    const primaryBasename = basename(stringValue(module.artifactPath) ?? stringValue(module.artifact) ?? '');
    if (primaryBasename === resolvedBasename) return { module, primary: true };
    if (module.files.some((file) => file === refRelative || basename(file) === resolvedBasename)) {
      return { module, primary: false };
    }
  }
  return null;
}

function readArtifactManifest(kind: string, artifactBaseDir: string, failures: string[]) {
  const manifestPath = resolve(artifactBaseDir, kind, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  const manifestText = readFileSync(manifestPath, 'utf8');
  const manifestRecord = parseJsonRecord(manifestText);
  if (!manifestRecord) {
    failures.push(`invalid artifact manifest: ${manifestPath}`);
    return null;
  }
  const modules = Array.isArray(manifestRecord.modules)
    ? manifestRecord.modules.map((item) => asRecord(item))
    : [];
  const actualSha = sha256Text(manifestText);
  const shaFilePath = `${manifestPath}.sha256`;
  const expectedSha = existsSync(shaFilePath)
    ? readFileSync(shaFilePath, 'utf8').trim().split(/\s+/)[0]
    : null;
  if (expectedSha && expectedSha !== actualSha) failures.push(`manifest sha256 mismatch: ${manifestPath}`);
  if (!expectedSha) failures.push(`missing manifest sha256 file: ${shaFilePath}`);
  return {
    path: manifestPath,
    releaseRevision: stringValue(manifestRecord.releaseRevision),
    kind: stringValue(manifestRecord.kind),
    sha256: actualSha,
    sha256Status: expectedSha ? expectedSha === actualSha ? 'passed' : 'failed' : 'missing-sha256-file',
    modules: modules.map((module) => ({
      moduleId: stringValue(module.moduleId),
      artifact: stringValue(module.artifact),
      artifactPath: stringValue(module.artifactPath),
      status: stringValue(module.status),
      targetPath: stringValue(module.targetPath),
      sha256: stringValue(module.sha256),
      bytes: typeof module.bytes === 'number' ? module.bytes : null,
      metadata: asRecord(module.metadata),
      files: Array.isArray(module.files)
        ? module.files.map((file) => stringValue(file)).filter((file): file is string => Boolean(file))
        : []
    }))
  };
}

function siteSlotSshProfileEvidence(plan: SiteSlotPlan | null, profile: SiteSlotSshProfile | null) {
  const identityFileExists = profile?.identityFile ? existsSync(profile.identityFile) : null;
  const knownHostsFileExists = profile?.knownHostsFile ? existsSync(profile.knownHostsFile) : null;
  const sshConfigFileExists = profile?.sshConfigFile ? existsSync(profile.sshConfigFile) : null;
  const gateWarnings = [
    ...(plan ? [] : ['plan not found while building dry-run SSH evidence']),
    ...(plan?.ssh.profileStatus === 'paused' || profile?.status === 'paused' ? ['managed SSH profile is paused'] : []),
    ...(profile?.identityFile && identityFileExists === false ? [`SSH identity file does not exist: ${profile.identityFile}`] : []),
    ...(profile?.knownHostsFile && knownHostsFileExists === false ? [`SSH known_hosts file does not exist: ${profile.knownHostsFile}`] : []),
    ...(profile?.sshConfigFile && sshConfigFileExists === false ? [`SSH config file does not exist: ${profile.sshConfigFile}`] : [])
  ];
  return {
    gate: 'dry-run-warning-only',
    source: plan?.ssh.profileSource ?? 'none',
    profileId: plan?.ssh.profileId ?? profile?.profileId ?? null,
    profileStatus: plan?.ssh.profileStatus ?? profile?.status ?? null,
    profileWarnings: plan?.ssh.profileWarnings ?? profile?.warnings ?? [],
    host: profile?.host ?? plan?.host ?? null,
    sshUser: profile?.sshUser ?? plan?.ssh.user ?? null,
    sshPort: profile?.sshPort ?? plan?.ssh.port ?? null,
    identityFile: profile?.identityFile ?? null,
    identityFileExists,
    knownHostsFile: profile?.knownHostsFile ?? null,
    knownHostsFileExists,
    sshConfigFile: profile?.sshConfigFile ?? null,
    sshConfigFileExists,
    hostKeyAlias: profile?.hostKeyAlias ?? null,
    strictHostKeyChecking: profile?.strictHostKeyChecking ?? null,
    connectTimeoutSeconds: profile?.connectTimeoutSeconds ?? null,
    batchMode: profile?.batchMode ?? null,
    gateWarnings
  };
}

function readOnlyProbeCommand(profile: ReturnType<typeof siteSlotSshProfileEvidence>): string {
  const host = profile.host ?? '<host>';
  const user = profile.sshUser ?? 'root';
  const port = profile.sshPort ?? 22;
  const options = sshOptionFragment(profile);
  const script = [
    'set -eu',
    'printf "mx-readonly-probe\\n"',
    'whoami',
    'hostname',
    'uname -a',
    'pwd',
    'df -h /',
    'if command -v docker >/dev/null 2>&1; then docker version --format "{{.Server.Version}}" 2>/dev/null || docker version; else echo "docker: missing"; fi'
  ].join('; ');
  return `ssh ${options} -p ${shellSingleQuote(String(port))} ${shellSingleQuote(`${user}@${host}`)} ${shellSingleQuote(script)}`;
}

function sshOptionFragment(profile: ReturnType<typeof siteSlotSshProfileEvidence>): string {
  const parts = [
    '-F', shellSingleQuote(internalSshConfigFile(profile)),
    '-o', shellSingleQuote(`BatchMode=${profile.batchMode ?? 'yes'}`),
    '-o', shellSingleQuote(`ConnectTimeout=${profile.connectTimeoutSeconds ?? 30}`),
    '-o', shellSingleQuote('ConnectionAttempts=2'),
    '-o', shellSingleQuote('AddressFamily=inet'),
    '-o', shellSingleQuote('IPQoS=none'),
    '-o', shellSingleQuote('ServerAliveInterval=5'),
    '-o', shellSingleQuote('ServerAliveCountMax=2'),
    '-o', shellSingleQuote(`StrictHostKeyChecking=${profile.strictHostKeyChecking ?? 'yes'}`)
  ];
  if (internalSshUsesDefaultIsolatedConfig(profile)) {
    parts.push('-o', shellSingleQuote('ProxyCommand=none'), '-o', shellSingleQuote('ProxyJump=none'));
  }
  if (profile.identityFile) parts.push('-i', shellSingleQuote(profile.identityFile));
  if (profile.knownHostsFile) parts.push('-o', shellSingleQuote(`UserKnownHostsFile=${profile.knownHostsFile}`));
  if (profile.hostKeyAlias) {
    parts.push('-o', shellSingleQuote(`HostKeyAlias=${profile.hostKeyAlias}`));
    parts.push('-o', shellSingleQuote('CheckHostIP=no'));
  }
  return parts.join(' ');
}

function internalSshConfigFile(profile?: { sshConfigFile?: string | null }): string {
  return profile?.sshConfigFile?.trim()
    || process.env.MX_SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || process.env.SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || '/dev/null';
}

function internalSshUsesDefaultIsolatedConfig(profile?: { sshConfigFile?: string | null }): boolean {
  return !profile?.sshConfigFile && !process.env.MX_SITE_SLOT_SSH_CONFIG_FILE && !process.env.SITE_SLOT_SSH_CONFIG_FILE;
}

function resolveSiteSlotArtifactBaseDir(): string {
  if (process.env.SITE_SLOT_ARTIFACT_BASE_DIR) return resolve(process.env.SITE_SLOT_ARTIFACT_BASE_DIR);
  return resolve(resolveMxLauncherRoot(), 'artifacts/site-slots');
}

function resolveMxLauncherRoot(): string {
  const controllerDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MX_LAUNCHER_ROOT,
    resolve(process.cwd(), 'electron-dock/mx-launcher'),
    resolve(controllerDir, '../../../..'),
    resolve(controllerDir, '../../../../..'),
    process.cwd()
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(resolve(candidate, 'server/package.json')) && existsSync(resolve(candidate, 'scripts/manage.sh')))
    ?? candidates.find((candidate) => existsSync(resolve(candidate, 'artifacts/site-slots')))
    ?? process.cwd();
}

function artifactReferenceValues(command: string): string[] {
  return Array.from(new Set((command.match(/\.\/artifacts\/site-slots\/[A-Za-z0-9._/-]+/g) ?? [])
    .map((value) => value.replace(/[;,'")]+$/g, ''))
    .filter((value) => basename(value).includes('.'))));
}

function resolveArtifactReference(ref: string, artifactBaseDir: string): string {
  const match = ref.match(/^\.\/artifacts\/site-slots\/([^/]+)\/(.+)$/);
  if (match) return resolve(artifactBaseDir, match[1], match[2]);
  return resolve(resolveMxLauncherRoot(), ref);
}

function artifactKind(ref: string): string | null {
  return ref.match(/^\.\/artifacts\/site-slots\/([^/]+)\//)?.[1] ?? null;
}

function phaseIdFromSource(sourceId: string): string {
  return sourceId.replace(/\.\d+$/, '');
}

function siteSlotCommandKind(command: string): string {
  if (command.startsWith('POST ')) return 'admin-api-intent';
  if (command.startsWith('Release Center ')) return 'artifact-materialize-intent';
  if (command.startsWith('If @qpjoy/tunnel-cli ')) return 'artifact-refresh-intent';
  if (command.includes('rsync ') || command.includes('scp ')) return 'artifact-transport';
  if (command.startsWith('ssh ')) return 'remote-shell-intent';
  if (command.startsWith('Check ')) return 'manual-smoke-intent';
  return 'planned-command';
}

function executableRemoteCommandKind(value: string): boolean {
  return value === 'artifact-transport' || value === 'remote-shell-intent';
}

function allowedRemoteShellCommand(command: string): boolean {
  if (command.includes('git pull') || command.includes('git clone')) return false;
  return command.startsWith('ssh ') || command.includes('rsync ') || command.includes('scp ');
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:18090';
}

function isK8sInternalServiceBaseUrl(value: string | null | undefined): boolean {
  const normalized = value ? normalizeBaseUrl(value) : '';
  if (!normalized) return false;
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return host.endsWith('.svc.cluster.local') || host.endsWith('.svc') || host.includes('.svc.');
  } catch {
    return false;
  }
}

function workerInternalBaseUrlFromSources(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (!value || isK8sInternalServiceBaseUrl(value)) continue;
    return normalizeBaseUrl(value);
  }
  return 'http://127.0.0.1:18090';
}

function siteSlotTransportEvidence(command: string) {
  return {
    usesRsync: command.includes('rsync '),
    usesScpFallback: command.includes('scp '),
    usesSsh: command.startsWith('ssh ') || command.includes(" -e 'ssh "),
    repositoryRootSynced: command.includes('git pull') || command.includes('git clone') || command.includes(' ./ ')
  };
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
