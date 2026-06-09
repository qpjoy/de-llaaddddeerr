import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import type { RuntimeFeaturePolicy, SiteSlotSshProfile } from '../../types.js';

const execFileAsync = promisify(execFile);
export const SSH_READONLY_PROBE_FEATURE_KEY = 'site-slot.ssh-readonly-probe.execute';

export interface SshProfileReadinessInput {
  confirmReadOnlyProbe: boolean;
  executeReadOnlyProbe: boolean;
  requestedBy: string | null;
  requestId: string | null;
}

export async function buildSshProfileReadinessProbe(
  profile: SiteSlotSshProfile,
  input: SshProfileReadinessInput,
  runtimePolicy: RuntimeFeaturePolicy | null = null
) {
  const checkedAt = new Date().toISOString();
  const sshProfile = sshProfileEvidence(profile);
  const command = readOnlyProbeCommand(sshProfile);
  const argv = readOnlyProbeArgv(sshProfile);
  const envGate = envExecutionGate();
  const configGate = runtimePolicyGate(runtimePolicy, checkedAt);
  const requestGate = requestExecutionGate(input);
  const profileFailures = profileReadinessGateFailures(profile, sshProfile, input.confirmReadOnlyProbe);
  const executionGateFailures = input.executeReadOnlyProbe
    ? [
        ...envGate.failures,
        ...configGate.failures,
        ...requestGate.failures
      ]
    : [];
  const gateFailures = [...profileFailures, ...executionGateFailures];
  const executionAllowed = input.executeReadOnlyProbe
    && gateFailures.length === 0
    && envGate.status === 'passed'
    && configGate.status === 'passed'
    && requestGate.status === 'passed';
  const plannedStatus = gateFailures.length > 0 ? 'blocked' : 'ready';
  const execution = gateFailures.length > 0
    ? null
    : executionAllowed
      ? await executeReadOnlyProbe(argv, profile.connectTimeoutSeconds ?? 10)
      : null;
  const executionFailures = execution && execution.exitCode !== 0
    ? [`read-only SSH probe exited ${execution.exitCode}`]
    : [];
  const status = gateFailures.length > 0
    ? 'blocked'
    : executionFailures.length > 0
      ? 'failed'
      : execution
        ? 'passed'
        : plannedStatus;
  return {
    probeId: `ssh_profile_readiness_${profile.profileId}`,
    status,
    verdict: status === 'passed' || status === 'ready' ? 'passed' : status,
    mode: 'remote-readonly-probe',
    execution: execution ? 'completed' : 'not-started',
    boundary: 'ssh-profile-readiness-readonly',
    profileId: profile.profileId,
    siteId: profile.siteId,
    kind: profile.kind,
    requestedBy: input.requestedBy,
    requestId: input.requestId,
    checkedAt,
    command,
    argv,
    env: {
      SITE_SLOT_SSH_READONLY_PROBE_EXECUTE: process.env.SITE_SLOT_SSH_READONLY_PROBE_EXECUTE === '1' ? 'present' : 'missing'
    },
    gates: {
      envGate,
      configGate,
      requestGate
    },
    sshProfile,
    gateFailures,
    executionFailures,
    executionResult: execution,
    notes: [
      'This readiness probe is scoped to SSH Profile validation before creating or executing a site-slot worker job.',
      'Default mode returns a read-only SSH command and does not open SSH.',
      'Real execution requires the Internal env hard gate, Config Center runtime policy, and per-request confirmation.',
      'The remote script only reads identity, hostname, kernel, disk, and Docker version information.'
    ],
    nextActions: status === 'blocked'
      ? ['fix-ssh-profile-files-or-policy', 'rerun-profile-readiness']
      : status === 'failed'
        ? ['review-readonly-probe-output', 'fix-remote-access-or-permissions']
        : execution
          ? ['review-readiness-evidence', 'continue-to-site-slot-plan']
          : ['run-readonly-probe-from-internal', 'continue-to-plan-after-readiness']
  };
}

function profileReadinessGateFailures(
  profile: SiteSlotSshProfile,
  evidence: ReturnType<typeof sshProfileEvidence>,
  confirmReadOnlyProbe: boolean
): string[] {
  return [
    ...(profile.status === 'paused' ? [`SSH profile is paused: ${profile.profileId}`] : []),
    ...(!profile.host ? ['SSH profile host is required'] : []),
    ...(!profile.sshUser ? ['SSH profile user is required'] : []),
    ...(!profile.sshPort ? ['SSH profile port is required'] : []),
    ...(!profile.identityFile ? ['SSH identity file is required'] : []),
    ...(profile.identityFile && !evidence.identityFileExists ? [`SSH identity file does not exist: ${profile.identityFile}`] : []),
    ...(!profile.knownHostsFile ? ['SSH known_hosts file is required'] : []),
    ...(profile.knownHostsFile && !evidence.knownHostsFileExists ? [`SSH known_hosts file does not exist: ${profile.knownHostsFile}`] : []),
    ...(!profile.hostKeyAlias ? ['SSH host key alias is recommended before real probe'] : []),
    ...(profile.strictHostKeyChecking !== 'yes' ? ['StrictHostKeyChecking=yes is required for readiness'] : []),
    ...(profile.batchMode !== 'yes' ? ['BatchMode=yes is required for readiness'] : []),
    ...(!confirmReadOnlyProbe ? ['confirmReadOnlyProbe=true is required before returning readiness probe evidence'] : []),
    ...(profile.warnings ?? [])
  ];
}

function envExecutionGate() {
  const enabled = process.env.SITE_SLOT_SSH_READONLY_PROBE_EXECUTE === '1';
  return {
    gateId: 'env:SITE_SLOT_SSH_READONLY_PROBE_EXECUTE',
    status: enabled ? 'passed' : 'blocked',
    requiredForExecution: true,
    value: enabled ? 'present' : 'missing',
    failures: enabled ? [] : ['SITE_SLOT_SSH_READONLY_PROBE_EXECUTE=1 is required before real read-only SSH execution']
  };
}

function runtimePolicyGate(policy: RuntimeFeaturePolicy | null, checkedAt: string) {
  const expired = Boolean(policy?.expiresAt && policy.expiresAt <= checkedAt);
  const modeAllowsReadonly = policy?.mode === 'readonly-execute' || policy?.mode === 'remote-execute';
  const passed = Boolean(policy?.enabled && modeAllowsReadonly && !expired);
  const failures = [
    ...(policy ? [] : [`Config Center runtime policy is required: ${SSH_READONLY_PROBE_FEATURE_KEY}`]),
    ...(policy && !policy.enabled ? [`runtime feature policy is disabled: ${policy.policyId}`] : []),
    ...(policy && !modeAllowsReadonly ? [`runtime feature policy mode does not allow readonly execution: ${policy.mode}`] : []),
    ...(expired ? [`runtime feature policy expired at ${policy?.expiresAt}`] : [])
  ];
  return {
    gateId: 'config-center:runtime-feature-policy',
    status: passed ? 'passed' : 'blocked',
    requiredForExecution: true,
    featureKey: SSH_READONLY_PROBE_FEATURE_KEY,
    policy: policy ? {
      policyId: policy.policyId,
      scopeKind: policy.scopeKind,
      scopeId: policy.scopeId,
      enabled: policy.enabled,
      mode: policy.mode,
      expiresAt: policy.expiresAt,
      requiresApproval: policy.requiresApproval
    } : null,
    failures
  };
}

function requestExecutionGate(input: SshProfileReadinessInput) {
  const failures = [
    ...(!input.confirmReadOnlyProbe ? ['confirmReadOnlyProbe=true is required'] : []),
    ...(!input.executeReadOnlyProbe ? ['executeReadOnlyProbe=true is required for real read-only SSH execution'] : [])
  ];
  return {
    gateId: 'request:readonly-probe-confirmation',
    status: failures.length === 0 ? 'passed' : 'blocked',
    requiredForExecution: true,
    confirmReadOnlyProbe: input.confirmReadOnlyProbe,
    executeReadOnlyProbe: input.executeReadOnlyProbe,
    failures
  };
}

function sshProfileEvidence(profile: SiteSlotSshProfile) {
  return {
    profileId: profile.profileId,
    profileStatus: profile.status,
    profileWarnings: profile.warnings,
    siteId: profile.siteId,
    kind: profile.kind,
    host: profile.host,
    sshUser: profile.sshUser,
    sshPort: profile.sshPort,
    identityFile: profile.identityFile,
    identityFileExists: profile.identityFile ? existsSync(profile.identityFile) : false,
    knownHostsFile: profile.knownHostsFile,
    knownHostsFileExists: profile.knownHostsFile ? existsSync(profile.knownHostsFile) : false,
    hostKeyAlias: profile.hostKeyAlias,
    strictHostKeyChecking: profile.strictHostKeyChecking,
    connectTimeoutSeconds: profile.connectTimeoutSeconds,
    batchMode: profile.batchMode
  };
}

function readOnlyProbeCommand(profile: ReturnType<typeof sshProfileEvidence>): string {
  const host = profile.host ?? '<host>';
  const user = profile.sshUser ?? 'root';
  const port = profile.sshPort ?? 22;
  const options = sshOptionFragment(profile);
  return `ssh ${options} -p ${shellSingleQuote(String(port))} ${shellSingleQuote(`${user}@${host}`)} ${shellSingleQuote(readOnlyProbeScript())}`;
}

function readOnlyProbeArgv(profile: ReturnType<typeof sshProfileEvidence>): string[] {
  const host = profile.host ?? '<host>';
  const user = profile.sshUser ?? 'root';
  const args = [
    '-o', `BatchMode=${profile.batchMode ?? 'yes'}`,
    '-o', `ConnectTimeout=${profile.connectTimeoutSeconds ?? 10}`,
    '-o', `StrictHostKeyChecking=${profile.strictHostKeyChecking ?? 'yes'}`
  ];
  if (profile.identityFile) args.push('-i', profile.identityFile);
  if (profile.knownHostsFile) args.push('-o', `UserKnownHostsFile=${profile.knownHostsFile}`);
  if (profile.hostKeyAlias) args.push('-o', `HostKeyAlias=${profile.hostKeyAlias}`);
  args.push('-p', String(profile.sshPort ?? 22), `${user}@${host}`, readOnlyProbeScript());
  return args;
}

function readOnlyProbeScript(): string {
  return [
    'set -eu',
    'printf "mx-readonly-profile-readiness\\n"',
    'whoami',
    'hostname',
    'uname -a',
    'pwd',
    'df -h /',
    'if command -v docker >/dev/null 2>&1; then docker version --format "{{.Server.Version}}" 2>/dev/null || docker version; else echo "docker: missing"; fi'
  ].join('; ');
}

function sshOptionFragment(profile: ReturnType<typeof sshProfileEvidence>): string {
  const parts = [
    '-o', shellSingleQuote(`BatchMode=${profile.batchMode ?? 'yes'}`),
    '-o', shellSingleQuote(`ConnectTimeout=${profile.connectTimeoutSeconds ?? 10}`),
    '-o', shellSingleQuote(`StrictHostKeyChecking=${profile.strictHostKeyChecking ?? 'yes'}`)
  ];
  if (profile.identityFile) parts.push('-i', shellSingleQuote(profile.identityFile));
  if (profile.knownHostsFile) parts.push('-o', shellSingleQuote(`UserKnownHostsFile=${profile.knownHostsFile}`));
  if (profile.hostKeyAlias) parts.push('-o', shellSingleQuote(`HostKeyAlias=${profile.hostKeyAlias}`));
  return parts.join(' ');
}

async function executeReadOnlyProbe(args: string[], timeoutSeconds: number) {
  const startedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await execFileAsync('ssh', args, {
      timeout: Math.max(1, timeoutSeconds) * 1000,
      maxBuffer: 1024 * 1024
    });
    return {
      exitCode: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      stdout,
      stderr
    };
  } catch (error) {
    return {
      exitCode: typeof error === 'object' && error && 'code' in error && typeof error.code === 'number' ? error.code : 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      stdout: typeof error === 'object' && error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error === 'object' && error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : String(error)
    };
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
