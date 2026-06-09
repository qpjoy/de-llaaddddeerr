import { generateKeyPairSync } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  RuntimeConfig,
  SiteSlotKind,
  SiteSlotSshProfileBootstrapInput,
  SiteSlotSshProfileBootstrapResult,
  SiteSlotSshProfileInput
} from '../../types.js';

const execFileAsync = promisify(execFile);

export async function prepareSiteSlotSshProfileBootstrap(
  config: RuntimeConfig,
  input: SiteSlotSshProfileBootstrapInput
): Promise<{ profileInput: SiteSlotSshProfileInput; bootstrap: SiteSlotSshProfileBootstrapResult }> {
  const kind: SiteSlotKind = input.kind === 'domestic' ? 'domestic' : 'oversea';
  const siteId = input.siteId?.trim() || `${kind}-main`;
  const profileId = input.profileId?.trim() || `sshprof_${safeFilePart(siteId)}`;
  const host = input.host?.trim() || null;
  const sshUser = input.sshUser?.trim() || 'root';
  const sshPort = input.sshPort && input.sshPort > 0 ? Math.floor(input.sshPort) : 22;
  const hostKeyAlias = input.hostKeyAlias?.trim() || siteId;
  const keyRoot = resolve(config.siteSlotSshKeyRoot);
  const keyBase = safeFilePart(siteId);
  const identityFile = resolve(keyRoot, `${keyBase}_rsa`);
  const publicKeyFile = `${identityFile}.pub`;
  const knownHostsFile = resolve(keyRoot, `known_hosts.${keyBase}`);
  const rotateKey = input.rotateKey === true;
  const scanHostKey = input.scanHostKey !== false;
  const executeBootstrap = input.executeBootstrap === true;
  const confirmBootstrap = input.confirmBootstrap === true;
  const warnings: string[] = [];

  mkdirSync(keyRoot, { recursive: true, mode: 0o700 });
  chmodBestEffort(keyRoot, 0o700);

  const generated = ensureRsaKeyPair(identityFile, publicKeyFile, rotateKey);
  const knownHosts = scanHostKey && host
    ? await scanKnownHost(host, sshPort, knownHostsFile)
    : ensureKnownHostsFile(knownHostsFile, scanHostKey ? 'failed' : 'not-requested');

  const publicKey = readFileSync(publicKeyFile, 'utf8').trim();
  const installCommand = redactedInstallCommand(sshUser, host, sshPort, knownHostsFile, publicKey);
  const verifyCommand = verifySshCommand(sshUser, host, sshPort, identityFile, knownHostsFile);
  const envGate = {
    status: process.env.SITE_SLOT_SSH_PASSWORD_BOOTSTRAP_ENABLED === '1' ? 'passed' as const : 'blocked' as const,
    variable: 'SITE_SLOT_SSH_PASSWORD_BOOTSTRAP_ENABLED' as const
  };
  const requestGate = {
    status: confirmBootstrap && Boolean(input.password) ? 'passed' as const : 'blocked' as const,
    confirmBootstrap,
    hasPassword: Boolean(input.password)
  };
  let install: SiteSlotSshProfileBootstrapResult['install'] = {
    requested: executeBootstrap,
    command: installCommand,
    verifyCommand,
    status: executeBootstrap ? 'blocked' : 'not-requested',
    exitCode: null,
    stdout: null,
    stderr: null
  };

  if (!host) warnings.push('missing: host is required before password bootstrap can execute');
  if (knownHosts.status === 'failed') warnings.push('warning: known_hosts was not populated; rerun bootstrap when the host is reachable');

  if (executeBootstrap && (!host || envGate.status === 'blocked' || requestGate.status === 'blocked')) {
    install = {
      ...install,
      status: 'blocked',
      stderr: [
        !host ? 'host is required' : null,
        envGate.status === 'blocked' ? 'SITE_SLOT_SSH_PASSWORD_BOOTSTRAP_ENABLED=1 is required on Internal' : null,
        requestGate.status === 'blocked' ? 'confirmBootstrap=true and password are required' : null
      ].filter(Boolean).join('\n')
    };
  } else if (executeBootstrap && host && input.password) {
    install = await installPublicKey({
      sshUser,
      host,
      sshPort,
      knownHostsFile,
      publicKey,
      password: input.password,
      timeoutSeconds: input.connectTimeoutSeconds ?? 20,
      verifyCommand
    });
  }

  const status = executeBootstrap
    ? install.status === 'passed'
      ? 'passed'
      : install.status === 'failed'
        ? 'failed'
        : 'blocked'
    : 'planned';

  const bootstrap: SiteSlotSshProfileBootstrapResult = {
    status,
    execution: status === 'planned' ? 'not-started' : status === 'passed' ? 'completed' : status,
    boundary: 'ssh-password-bootstrap',
    profileId,
    siteId,
    kind,
    host,
    sshUser,
    sshPort,
    key: {
      rootDir: keyRoot,
      identityFile,
      publicKeyFile,
      generated,
      rotated: rotateKey
    },
    knownHosts,
    install,
    gates: {
      envGate,
      requestGate
    },
    warnings,
    nextActions: bootstrapNextActions(status, knownHosts.status)
  };

  return {
    profileInput: {
      profileId,
      siteId,
      kind,
      host,
      sshUser,
      sshPort,
      identityFile,
      knownHostsFile,
      hostKeyAlias,
      strictHostKeyChecking: 'yes',
      connectTimeoutSeconds: input.connectTimeoutSeconds ?? 10,
      batchMode: 'yes',
      status: 'active',
      requestedBy: input.requestedBy,
      requestId: input.requestId
    },
    bootstrap
  };
}

function ensureRsaKeyPair(identityFile: string, publicKeyFile: string, rotateKey: boolean): boolean {
  mkdirSync(dirname(identityFile), { recursive: true, mode: 0o700 });
  if (!rotateKey && existsSync(identityFile) && existsSync(publicKeyFile)) return false;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  writeFileSync(identityFile, privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
  writeFileSync(publicKeyFile, `${openSshRsaPublicKey(publicKey.export({ format: 'jwk' }))}\n`, { mode: 0o644 });
  chmodBestEffort(identityFile, 0o600);
  chmodBestEffort(publicKeyFile, 0o644);
  return true;
}

async function scanKnownHost(host: string, sshPort: number, knownHostsFile: string): Promise<SiteSlotSshProfileBootstrapResult['knownHosts']> {
  try {
    const { stdout } = await execFileAsync('ssh-keyscan', ['-p', String(sshPort), '-H', host], {
      timeout: 10_000,
      maxBuffer: 256 * 1024
    });
    const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length > 0) {
      writeFileSync(knownHostsFile, `${lines.join('\n')}\n`, { mode: 0o600 });
      chmodBestEffort(knownHostsFile, 0o600);
      return { file: knownHostsFile, scanned: true, status: 'passed', lineCount: lines.length };
    }
    return ensureKnownHostsFile(knownHostsFile, 'failed');
  } catch {
    return ensureKnownHostsFile(knownHostsFile, 'failed');
  }
}

function ensureKnownHostsFile(
  knownHostsFile: string,
  status: SiteSlotSshProfileBootstrapResult['knownHosts']['status']
): SiteSlotSshProfileBootstrapResult['knownHosts'] {
  if (!existsSync(knownHostsFile)) writeFileSync(knownHostsFile, '', { mode: 0o600 });
  chmodBestEffort(knownHostsFile, 0o600);
  const lineCount = readFileSync(knownHostsFile, 'utf8').split('\n').filter((line) => line.trim()).length;
  return { file: knownHostsFile, scanned: false, status, lineCount };
}

async function installPublicKey(input: {
  sshUser: string;
  host: string;
  sshPort: number;
  knownHostsFile: string;
  publicKey: string;
  password: string;
  timeoutSeconds: number;
  verifyCommand: string;
}): Promise<SiteSlotSshProfileBootstrapResult['install']> {
  const target = `${input.sshUser}@${input.host}`;
  const script = [
    'set -eu',
    'umask 077',
    'mkdir -p "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    `grep -qxF ${shellQuote(input.publicKey)} "$HOME/.ssh/authorized_keys" || printf "%s\\n" ${shellQuote(input.publicKey)} >> "$HOME/.ssh/authorized_keys"`,
    'chmod 700 "$HOME/.ssh"',
    'chmod 600 "$HOME/.ssh/authorized_keys"',
    'printf "mx-ssh-profile-bootstrap-installed\\n"'
  ].join('; ');
  try {
    const result = await execFileAsync('sshpass', [
      '-e',
      'ssh',
      '-p', String(input.sshPort),
      '-o', 'BatchMode=no',
      '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${input.knownHostsFile}`,
      target,
      script
    ], {
      env: { ...process.env, SSHPASS: input.password },
      timeout: Math.max(input.timeoutSeconds, 5) * 1000,
      maxBuffer: 512 * 1024
    });
    return {
      requested: true,
      command: redactedInstallCommand(input.sshUser, input.host, input.sshPort, input.knownHostsFile, input.publicKey),
      verifyCommand: input.verifyCommand,
      status: 'passed',
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    const details = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      requested: true,
      command: redactedInstallCommand(input.sshUser, input.host, input.sshPort, input.knownHostsFile, input.publicKey),
      verifyCommand: input.verifyCommand,
      status: 'failed',
      exitCode: typeof details.code === 'number' ? details.code : null,
      stdout: details.stdout ?? null,
      stderr: details.stderr || details.message || 'ssh password bootstrap failed'
    };
  }
}

function openSshRsaPublicKey(jwk: JsonWebKey): string {
  const keyType = Buffer.from('ssh-rsa');
  const exponent = mpint(base64UrlDecode(String(jwk.e ?? '')));
  const modulus = mpint(base64UrlDecode(String(jwk.n ?? '')));
  return `ssh-rsa ${Buffer.concat([sshString(keyType), exponent, modulus]).toString('base64')} mx-launcher`;
}

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

function mpint(value: Buffer): Buffer {
  let normalized = value;
  while (normalized.length > 1 && normalized[0] === 0) normalized = normalized.subarray(1);
  if (normalized[0] && (normalized[0] & 0x80) !== 0) normalized = Buffer.concat([Buffer.from([0]), normalized]);
  return sshString(normalized);
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function redactedInstallCommand(
  sshUser: string,
  host: string | null,
  sshPort: number,
  knownHostsFile: string,
  publicKey: string
): string {
  return `SSHPASS=*** sshpass -e ssh -p ${sshPort} -o BatchMode=no -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${shellQuote(knownHostsFile)} ${sshUser}@${host ?? '<host>'} ${shellQuote(`install public key ${publicKey.slice(0, 24)}...`)}`;
}

function verifySshCommand(
  sshUser: string,
  host: string | null,
  sshPort: number,
  identityFile: string,
  knownHostsFile: string
): string {
  return `ssh -i ${shellQuote(identityFile)} -p ${sshPort} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${shellQuote(knownHostsFile)} ${sshUser}@${host ?? '<host>'} 'whoami && hostname && df -h /'`;
}

function bootstrapNextActions(
  status: SiteSlotSshProfileBootstrapResult['status'],
  knownHostsStatus: SiteSlotSshProfileBootstrapResult['knownHosts']['status']
): string[] {
  if (status === 'passed') return ['run-ssh-profile-readiness', 'create-oversea-plan'];
  if (status === 'failed') return ['re-enter-username-password', 'check-firewall-or-ssh-port'];
  if (status === 'blocked') return ['enable-bootstrap-env-gate-or-run-planned-command', 're-enter-username-password-if-needed'];
  if (knownHostsStatus === 'failed') return ['rerun-bootstrap-with-host-reachable', 'check-ssh-profile-readiness'];
  return ['enable-password-bootstrap-if-key-is-not-installed', 'check-ssh-profile-readiness'];
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'site';
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function chmodBestEffort(path: string, mode: number) {
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort only; readiness gates still surface missing/unusable files.
  }
}
