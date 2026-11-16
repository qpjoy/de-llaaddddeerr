import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import type { SiteSlotAccessAccount, SiteSlotSshProfile } from '../../types.js';

const execFileAsync = promisify(execFile);

export interface OverseaRecoveryLive {
  checkedAt: string;
  ssh: boolean;
  dockerInstalled: boolean;
  docker: boolean;
  compose: boolean;
  stack: boolean;
  hysteria: boolean;
  outlet: boolean;
  health: boolean;
  advertisedHost: string | null;
  tlsFingerprint: string | null;
  tlsMatchesRuntime: boolean;
  accountsMatch: boolean;
  portsMatch: boolean;
  healthy: boolean;
  category?: 'profile' | 'ssh-config-target' | 'host-key' | 'auth' | 'connection' | 'probe';
}

type ExecuteSsh = (args: string[], timeout: number) => Promise<{ stdout: string; stderr: string }>;

/** Fixed read-only inspection; never sources .env or invokes the mutating manage.sh status. */
export async function probeOverseaRecovery(
  profile: SiteSlotSshProfile,
  accounts: SiteSlotAccessAccount[],
  execute: ExecuteSsh = async (args, timeout) => execFileAsync('ssh', args, { timeout, maxBuffer: 128 * 1024 })
): Promise<OverseaRecoveryLive> {
  const live: OverseaRecoveryLive = {
    checkedAt: new Date().toISOString(), ssh: false, dockerInstalled: false, docker: false,
    compose: false, stack: false, hysteria: false, outlet: false, health: false,
    advertisedHost: null, tlsFingerprint: null, tlsMatchesRuntime: false,
    accountsMatch: false, portsMatch: false, healthy: false
  };
  if (profile.kind !== 'oversea' || profile.status !== 'active' || !profile.host
    || !/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(profile.host)
    || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(profile.sshUser)
    || !Number.isInteger(profile.sshPort) || profile.sshPort < 1 || profile.sshPort > 65535
    || !profile.identityFile || !existsSync(profile.identityFile)
    || !profile.knownHostsFile || !existsSync(profile.knownHostsFile)
    || (profile.sshConfigFile && !existsSync(profile.sshConfigFile))
    || profile.strictHostKeyChecking !== 'yes' || profile.batchMode !== 'yes') {
    return { ...live, category: 'profile' };
  }
  const exportPort = profile.exportPort ?? 3434;
  if (!Number.isInteger(exportPort) || exportPort < 1 || exportPort > 65535) return { ...live, category: 'profile' };
  const options = recoverySshOptions(profile);
  const destination = `${profile.sshUser}@${profile.host}`;
  try {
    // The existing worker uses the saved config. Refuse a custom/stale HostName
    // override before allowing recovery to use that worker at a different machine.
    const config = await execute(['-G', ...options, destination], 5_000);
    const effectiveHost = /^hostname\s+(.+)$/m.exec(config.stdout)?.[1]?.trim();
    if (effectiveHost?.toLowerCase() !== profile.host.toLowerCase()) {
      return { ...live, category: 'ssh-config-target' };
    }
    const { stdout } = await execute([
      ...options, '-o', `HostName=${profile.host}`, destination, recoveryProbeScript(exportPort)
    ], 60_000);
    const fields = new Map(stdout.split('\n').flatMap((line) => {
      const match = /^mx-recovery ([a-z-]+)=(.*)$/.exec(line.trim());
      return match ? [[match[1], match[2]] as const] : [];
    }));
    if (fields.get('ssh') !== 'ok' || fields.get('complete') !== 'yes') return { ...live, category: 'probe' };
    for (const field of ['docker', 'compose', 'stack', 'hysteria', 'outlet', 'health'] as const) live[field] = fields.get(field) === 'yes';
    live.ssh = true;
    live.dockerInstalled = fields.get('docker-installed') === 'yes';
    const host = unquote(fields.get('advertised-host') ?? '');
    live.advertisedHost = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(host) ? host : null;
    live.tlsFingerprint = fingerprint(fields.get('tls'));
    live.tlsMatchesRuntime = Boolean(live.tlsFingerprint
      && live.tlsFingerprint === fingerprint(fields.get('mounted-tls'))
      && live.tlsFingerprint === fingerprint(fields.get('applied-tls')));
    const active = accounts.filter((account) => account.status === 'active');
    const expectedAccounts = createHash('sha256').update(
      active.map((account) => `${account.username},${account.authToken}`).sort().join('\n') + '\n'
    ).digest('hex');
    live.accountsMatch = active.length > 0
      && fields.get('accounts') === expectedAccounts
      && fields.get('mounted-accounts') === expectedAccounts;
    live.portsMatch = unquote(fields.get('server-ports') ?? '') === (profile.serverPorts || '51288')
      && publishedUdpPortsMatch(profile.serverPorts || '51288', fields.get('udp-bindings'));
    live.healthy = live.docker && live.compose && live.stack && live.hysteria && live.outlet
      && live.health && live.tlsMatchesRuntime && live.accountsMatch && live.portsMatch
      && live.advertisedHost?.toLowerCase() === profile.host.toLowerCase();
    return live;
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const message = `${failure.stderr ?? ''} ${failure.message ?? ''}`.toLowerCase();
    return {
      ...live,
      category: /host key|host identification/.test(message) ? 'host-key'
        : message.includes('permission denied') ? 'auth' : 'connection'
    };
  }
}

function recoverySshOptions(profile: SiteSlotSshProfile): string[] {
  const configFile = profile.sshConfigFile?.trim()
    || process.env.MX_SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || process.env.SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || '/dev/null';
  const args = [
    '-F', configFile, '-i', profile.identityFile!, '-p', String(profile.sshPort),
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${profile.knownHostsFile}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'UpdateHostKeys=no',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=15',
    '-o', 'ConnectionAttempts=1', '-o', 'AddressFamily=inet', '-o', 'IPQoS=none',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'
  ];
  if (configFile === '/dev/null') args.push('-o', 'ProxyCommand=none', '-o', 'ProxyJump=none');
  if (profile.hostKeyAlias) args.push('-o', `HostKeyAlias=${profile.hostKeyAlias}`, '-o', 'CheckHostIP=no');
  return args;
}

function recoveryProbeScript(exportPort: number): string {
  return [
    'set -u',
    'stack=/opt/mx/current/hysteria2-access-stack',
    'printf "mx-recovery ssh=ok\\n"',
    'if command -v docker >/dev/null 2>&1; then echo "mx-recovery docker-installed=yes"; fi',
    'if docker info >/dev/null 2>&1; then echo "mx-recovery docker=yes"; fi',
    'if docker compose version >/dev/null 2>&1; then echo "mx-recovery compose=yes"; fi',
    'if test -f "$stack/manage.sh" && test -f "$stack/docker-compose.yml" && test -f "$stack/.env"; then echo "mx-recovery stack=yes"; fi',
    'for pair in "hysteria:mx-oversea-hysteria2" "outlet:mx-oversea-hysteria2-health"; do label=${pair%%:*}; name=${pair#*:}; state=$(docker inspect -f \'{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\' "$name" 2>/dev/null || true); case "$state" in "true|healthy"|"true|none") printf "mx-recovery %s=yes\\n" "$label";; esac; done',
    `if curl -fsS --max-time 5 http://127.0.0.1:${exportPort}/healthz >/dev/null 2>&1; then echo "mx-recovery health=yes"; fi`,
    'for pair in "advertised-host:HY2_SERVER_HOST" "server-ports:HY2_SERVER_PORTS"; do label=${pair%%:*}; key=${pair#*:}; value=$(awk -v key="$key" -F= \'$1 == key { sub("^[^=]*=", ""); print; exit }\' "$stack/.env" 2>/dev/null || true); printf "mx-recovery %s=%s\\n" "$label" "$value"; done',
    'tls=$(openssl x509 -in "$stack/config/hysteria/certs/server.crt" -noout -sha256 -fingerprint 2>/dev/null | cut -d= -f2); printf "mx-recovery tls=%s\\n" "$tls"',
    'tls=$(docker exec mx-oversea-hysteria2 cat /etc/hysteria/certs/server.crt 2>/dev/null | openssl x509 -noout -sha256 -fingerprint 2>/dev/null | cut -d= -f2); printf "mx-recovery mounted-tls=%s\\n" "$tls"',
    'tls=$(docker inspect -f \'{{index .Config.Labels "com.mx.hysteria2.tls-fingerprint"}}\' mx-oversea-hysteria2 2>/dev/null || true); printf "mx-recovery applied-tls=%s\\n" "$tls"',
    'bindings=$(docker inspect -f \'{{json .NetworkSettings.Ports}}\' mx-oversea-hysteria2 2>/dev/null || true); printf "mx-recovery udp-bindings=%s\\n" "$bindings"',
    'digest=$(awk -F, \'NR > 1 && $1 != "" { print $1 "," $2 }\' "$stack/data/hysteria/users.csv" 2>/dev/null | LC_ALL=C sort | sha256sum | awk \'{print $1}\'); printf "mx-recovery accounts=%s\\n" "$digest"',
    'digest=$(docker exec mx-oversea-hysteria2 cat /var/lib/hysteria/users.csv 2>/dev/null | awk -F, \'NR > 1 && $1 != "" { print $1 "," $2 }\' | LC_ALL=C sort | sha256sum | awk \'{print $1}\'); printf "mx-recovery mounted-accounts=%s\\n" "$digest"',
    'printf "mx-recovery complete=yes\\n"'
  ].join('; ');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function fingerprint(value: string | undefined): string | null {
  return value && /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(value.trim()) ? value.trim().toUpperCase() : null;
}

function publishedUdpPortsMatch(spec: string, json: string | undefined): boolean {
  try {
    const bindings = JSON.parse(json ?? 'null') as Record<string, Array<{ HostPort?: string; HostIp?: string }> | null> | null;
    if (!bindings) return false;
    for (const part of spec.split(',')) {
      const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
      if (!match) return false;
      const start = Number(match[1]);
      const end = Number(match[2] || match[1]);
      if (start < 1 || end > 65535 || end < start) return false;
      for (let port = start; port <= end; port += 1) {
        if (!bindings[`${port}/udp`]?.some((binding) => binding.HostPort === String(port)
          && binding.HostIp && !binding.HostIp.startsWith('127.') && binding.HostIp !== '::1')) return false;
      }
    }
    return true;
  } catch { return false; }
}
