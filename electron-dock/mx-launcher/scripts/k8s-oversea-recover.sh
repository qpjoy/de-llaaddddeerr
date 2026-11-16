#!/usr/bin/env bash
# Use the already deployed Internal APIs; this does not deploy Launcher.
set +x
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bash scripts/k8s-oversea-recover.sh [inspect|apply] [site-id] [expected-host]
Defaults: inspect mx-oversea-us01 34.218.136.162

inspect reads the saved SSH profile/site and executes a fixed read-only SSH probe.
apply performs that inspection, then calls the existing Oversea Install / Sync API.
The saved SSH host must exactly match expected-host. apply also requires the
registered subscription host to match: this recovery is for a replacement at the
same address, not for switching users to a new address.

Uses the current kubectl context, namespace mx-internal-shadow, deployment
mx-launcher-internal, container internal-api. Namespace/deployment overrides:
  MX_OVERSEA_NAMESPACE, MX_OVERSEA_DEPLOYMENT
No automatic retries, kubectl apply, rollout, SSH bootstrap, or key rotation.
USAGE
}

mode="${1:-inspect}"
site="${2:-mx-oversea-us01}"
expected_host="${3:-34.218.136.162}"
namespace="${MX_OVERSEA_NAMESPACE:-mx-internal-shadow}"
deployment="${MX_OVERSEA_DEPLOYMENT:-mx-launcher-internal}"
case "$mode" in
  -h|--help|help) usage; exit 0 ;;
  inspect|apply) ;;
  *) usage >&2; exit 2 ;;
esac
[[ "$#" -le 3 ]] || { usage >&2; exit 2; }
[[ "$site" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$ ]] || { echo 'Invalid site ID' >&2; exit 2; }
[[ "$expected_host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ ]] || { echo 'Invalid expected host' >&2; exit 2; }
[[ "$namespace" =~ ^[a-z0-9][a-z0-9.-]*$ && "$deployment" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || { echo 'Invalid Kubernetes target' >&2; exit 2; }
command -v kubectl >/dev/null || { echo 'kubectl is required' >&2; exit 1; }

kubectl -n "$namespace" exec -i "deployment/$deployment" -c internal-api -- \
  node --input-type=module - "$mode" "$site" "$expected_host" <<'NODE'
import { request } from 'node:http';
import { execFile } from 'node:child_process';

const [mode, siteId, expectedHost] = process.argv.slice(2);
const token = process.env.MX_INTERNAL_OPS_TOKEN?.trim();
const base = 'http://127.0.0.1:18090';
const encodedSite = encodeURIComponent(siteId);
const requestId = 'k8s-oversea-recovery-' + siteId + '-' + Date.now();
let applying = false;

// Native HTTP avoids fetch's response-header timeout during the 15-minute worker.
function api(path, body, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = request(new URL(base + path), {
      method: data === null ? 'GET' : 'POST',
      headers: { 'x-mx-ops-token': token, ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) }
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) {
          req.destroy(new Error('API response exceeded the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', () => reject(new Error('API response interrupted')));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode + ' at ' + path));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Invalid JSON at ' + path)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('API request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', error => reject(new Error(error.code === 'ETIMEDOUT' ? 'API request timed out' : 'API connection failed')));
    req.end(data);
  });
}

function summary(value) { console.log(JSON.stringify(value, null, 2)); }
function fail(message) { throw new Error(message); }
function profileSnapshot(profile) {
  return JSON.stringify(['profileId', 'siteId', 'kind', 'status', 'host', 'sshUser', 'sshPort', 'identityFile',
    'knownHostsFile', 'sshConfigFile', 'hostKeyAlias', 'strictHostKeyChecking', 'batchMode', 'connectTimeoutSeconds',
    'serverPorts', 'exportPort', 'bandwidth', 'workerInternalBaseUrl', 'internalBaseUrl', 'overseaCallbackBaseUrl', 'updatedAt']
    .map(key => [key, profile?.[key] ?? null]));
}
function defaultAccountNames() {
  const prefix = siteId.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'account';
  const system = (prefix.slice(0, 50).replace(/[-.]+$/g, '') || 'oversea') + '-subscriptions';
  return [prefix + '-internal', prefix + '-domestic', system,
    ...Array.from({ length: 9 }, (_, index) => prefix + '-internal' + String(index + 1).padStart(2, '0'))];
}
function accountSet(accounts) {
  if (!Array.isArray(accounts)) fail('Current account material is missing');
  return JSON.stringify(accounts.filter(account => account.status === 'active')
    .map(account => {
      if (typeof account.username !== 'string' || !account.username || typeof account.authToken !== 'string' || !account.authToken.trim()) fail('Active account material is incomplete');
      return [account.username, account.authToken];
    }).sort((a, b) => a[0].localeCompare(b[0])));
}
function validateDefaults(accounts) {
  if (!Array.isArray(accounts)) fail('Current account material is missing');
  if (defaultAccountNames().some(name => !accounts.some(account => account.username === name && account.status === 'active' && typeof account.authToken === 'string' && account.authToken.trim()))) {
    fail('A default/system account is missing, paused or lacks a token; stop before legacy issueDefaults can create or reactivate it');
  }
  return accountSet(accounts);
}
function normalizedBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().replace(/\/+$/, '');
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    if (host.endsWith('.svc.cluster.local') || host.endsWith('.svc') || host.includes('.svc.')) return null;
  } catch { /* The legacy API retains nonempty non-Kubernetes values. */ }
  return normalized;
}
function validateFreshPlan(plan, profile, expectedAccounts, runtime) {
  if (!plan || plan.kind !== 'oversea' || plan.siteId !== siteId || plan.host !== expectedHost
    || plan.ssh?.profileId !== profile.profileId || plan.ssh?.user !== profile.sshUser || plan.ssh?.port !== profile.sshPort
    || plan.status === 'blocked') fail('Fresh plan does not match the exact saved SSH target');
  const deployed = plan.runtime?.oversea;
  if (!deployed || deployed.workerInternalBaseUrl !== runtime.workerInternalBaseUrl
    || (deployed.overseaCallbackBaseUrl ?? null) !== runtime.overseaCallbackBaseUrl
    || deployed.serverPorts !== String(profile.serverPorts ?? '51288').trim()
    || deployed.exportPort !== (profile.exportPort ?? 3434)) fail('Fresh plan runtime differs from the existing site');
  const commands = plan.deploymentPhases?.find(phase => phase.phaseId === 'configure-oversea-access')?.commands ?? [];
  const states = commands.flatMap(command => Array.from(String(command).matchAll(/printf "%s" ([A-Za-z0-9+/=]+) \| base64 -d > \/opt\/mx\/site-agent\/\.tunnel-state\.json\.tmp/g)));
  if (states.length !== 1) fail('Cannot verify the fresh plan account material; do not execute legacy ensure');
  let state;
  try { state = JSON.parse(Buffer.from(states[0][1], 'base64').toString('utf8')); }
  catch { fail('Fresh plan account material is malformed'); }
  if (state.node?.publicHost !== expectedHost || accountSet(state.accounts) !== expectedAccounts) fail('Fresh plan account tokens/users differ from the complete current active account set');
}
async function prepareFreshPlan(profile, registeredSite) {
  const accountPath = '/internal/v1/site-slots/' + encodedSite + '/access-accounts';
  const profilePath = '/internal/v1/config-center/site-slot-ssh-profiles/site/' + encodedSite;
  const { accounts } = await api(accountPath);
  const expectedAccounts = validateDefaults(accounts);
  const { profile: beforeCreate } = await api(profilePath);
  if (profileSnapshot(beforeCreate) !== profileSnapshot(profile)) fail('SSH profile changed during inspection; no plan was created');
  const runtime = {
    workerInternalBaseUrl: normalizedBase(profile.workerInternalBaseUrl) || normalizedBase(process.env.MX_INTERNAL_BASE_URL) || 'http://127.0.0.1:18090',
    overseaCallbackBaseUrl: normalizedBase(profile.overseaCallbackBaseUrl)
  };
  const { plan } = await api('/internal/v1/site-slots/plans', {
    siteId, kind: 'oversea', sshProfileId: profile.profileId, host: profile.host,
    sshUser: profile.sshUser, sshPort: profile.sshPort, rootAccess: profile.sshUser === 'root',
    hasDocker: true, hasOutboundInternet: true, serverPorts: profile.serverPorts,
    exportPort: profile.exportPort, bandwidth: profile.bandwidth, ...runtime,
    createdBy: 'k8s-oversea-recovery', requestId: requestId + '-fresh-plan'
  });
  validateFreshPlan(plan, profile, expectedAccounts, runtime);
  const { plans } = await api('/internal/v1/site-slots/plans');
  const candidates = (plans ?? []).filter(item => item.kind === 'oversea' && item.siteId === siteId
    && item.ssh?.profileId === profile.profileId && item.status !== 'blocked')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (candidates[0]?.planId !== plan.planId || candidates.some(item => item.planId !== plan.planId && item.createdAt === plan.createdAt)) fail('Another plan became the latest candidate; do not execute legacy ensure');
  const { accounts: latestAccounts } = await api(accountPath);
  if (validateDefaults(latestAccounts) !== expectedAccounts) fail('Current account material changed during plan preparation; stop before remote execution');
  const { profile: latestProfile } = await api(profilePath);
  const { site: latestSite } = await api('/internal/v1/launcher-network/mihomo/sites/' + encodedSite);
  if (profileSnapshot(latestProfile) !== profileSnapshot(profile)
    || latestSite?.status === 'archived' || latestSite?.publicHost !== registeredSite.publicHost
    || latestSite?.serverPorts !== registeredSite.serverPorts) fail('Profile/site changed during plan preparation; stop before remote execution');
  summary({ stage: 'fresh-plan', planId: plan.planId, currentAccountsMatch: true, profileUnchanged: true });
  return { planId: plan.planId, accountSnapshot: expectedAccounts, runtime };
}
async function verifyEffectiveSshHost(profile) {
  const config = profile.sshConfigFile?.trim()
    || process.env.MX_SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || process.env.SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || '/dev/null';
  const output = await new Promise((resolve, reject) => {
    execFile('ssh', ['-G', '-F', config, '-p', String(profile.sshPort ?? 22), (profile.sshUser ?? 'root') + '@' + profile.host],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => error ? reject(new Error('Unable to resolve the effective SSH destination')) : resolve(stdout));
  });
  const hostname = String(output).match(/^hostname\s+(.+)$/m)?.[1]?.trim();
  if (hostname !== expectedHost) fail('Effective SSH HostName does not match expected-host; fix the saved SSH config before executing remote commands');
  summary({ stage: 'ssh-config', effectiveHostMatches: true });
}
function inspectCommand(port) {
  // Fixed metadata-only command: no credentials, mutations, or fingerprint marker
  // that the existing terminal API would interpret as a site metadata update.
  return [
    'set -eu',
    'printf "MX_RECOVERY_USER=%s\\n" "$(id -un)"',
    'printf "MX_RECOVERY_HOSTNAME=%s\\n" "$(hostname)"',
    'if command -v docker >/dev/null 2>&1; then if docker info >/dev/null 2>&1; then echo MX_RECOVERY_DOCKER=ready; else echo MX_RECOVERY_DOCKER=daemon-unavailable; fi; else echo MX_RECOVERY_DOCKER=missing; fi',
    'if docker compose version >/dev/null 2>&1; then echo MX_RECOVERY_COMPOSE=ready; else echo MX_RECOVERY_COMPOSE=missing; fi',
    'if command -v rsync >/dev/null 2>&1; then echo MX_RECOVERY_RSYNC=ready; else echo MX_RECOVERY_RSYNC=missing; fi',
    'stack=/opt/mx/current/hysteria2-access-stack',
    'if test -d "$stack"; then echo MX_RECOVERY_STACK=present; else echo MX_RECOVERY_STACK=missing; fi',
    'state=/opt/mx/state/hysteria2-access-stack; test -d "$state" || state="$stack"',
    'if test -s "$state/config/hysteria/certs/server.crt"; then echo MX_RECOVERY_TLS_CERT=present; else echo MX_RECOVERY_TLS_CERT=missing; fi',
    'if test -s "$state/config/hysteria/certs/server.key"; then echo MX_RECOVERY_TLS_KEY=present; else echo MX_RECOVERY_TLS_KEY=missing; fi',
    'if command -v curl >/dev/null 2>&1; then code=$(curl -sS --max-time 8 -o /dev/null -w "%{http_code}" http://127.0.0.1:' + port + '/healthz 2>/dev/null) || true; printf "MX_RECOVERY_HEALTH_HTTP=%s\\n" "$code"; else echo MX_RECOVERY_HEALTH_HTTP=unavailable; fi',
    'echo MX_RECOVERY_COMPLETE=1'
  ].join('; ');
}

async function inspect(port, stage) {
  const { terminal } = await api('/internal/v1/admin/oversea/' + encodedSite + '/terminal', {
    command: inspectCommand(port), timeoutSeconds: 60,
    confirmRemoteExecution: true, confirmManualCommand: true,
    requestedBy: 'k8s-oversea-recovery', requestId: requestId + '-' + stage
  }, 90_000);
  const checks = {};
  for (const line of String(terminal?.stdout ?? '').split('\n')) {
    const match = line.match(/^MX_RECOVERY_(USER|HOSTNAME|DOCKER|COMPOSE|RSYNC|STACK|TLS_CERT|TLS_KEY|HEALTH_HTTP|COMPLETE)=([a-zA-Z0-9._-]{1,253})$/);
    if (match) checks[match[1].toLowerCase()] = match[2];
  }
  summary({ stage, status: terminal?.status ?? 'missing', exitCode: terminal?.exitCode ?? null, checks, blockedCount: Array.isArray(terminal?.gateFailures) ? terminal.gateFailures.length : 0 });
  if (terminal?.status !== 'passed' || terminal?.exitCode !== 0 || checks.complete !== '1'
    || ['docker', 'compose', 'rsync', 'stack', 'tls_cert', 'tls_key', 'health_http'].some(key => !checks[key])) fail('Read-only SSH inspection did not complete; use the existing Internal evidence/terminal view for diagnosis');
  return checks;
}
async function installMissingRsync() {
  const command = [
    'set -eu',
    'if command -v rsync >/dev/null 2>&1; then :; elif command -v apt-get >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y rsync; elif command -v dnf >/dev/null 2>&1; then dnf install -y rsync; elif command -v yum >/dev/null 2>&1; then yum install -y rsync; else echo "rsync installer: unsupported package manager" >&2; exit 1; fi',
    'command -v rsync >/dev/null',
    'echo MX_RECOVERY_RSYNC=ready',
    'echo MX_RECOVERY_COMPLETE=1'
  ].join('; ');
  const { terminal } = await api('/internal/v1/admin/oversea/' + encodedSite + '/terminal', {
    command, timeoutSeconds: 300, confirmRemoteExecution: true, confirmManualCommand: true,
    requestedBy: 'k8s-oversea-recovery', requestId: requestId + '-rsync'
  }, 6 * 60_000);
  const output = String(terminal?.stdout ?? '');
  if (terminal?.status !== 'passed' || terminal?.exitCode !== 0
    || !/^MX_RECOVERY_RSYNC=ready$/m.test(output) || !/^MX_RECOVERY_COMPLETE=1$/m.test(output)) fail('Missing rsync could not be installed; legacy ensure was not started');
  summary({ stage: 'rsync', status: 'ready' });
}

try {
  if (!token) fail('MX_INTERNAL_OPS_TOKEN is missing in internal-api');
  if (mode !== 'inspect' && mode !== 'apply') fail('Invalid recovery mode');
  const { profile } = await api('/internal/v1/config-center/site-slot-ssh-profiles/site/' + encodedSite);
  if (!profile || profile.siteId !== siteId || profile.kind !== 'oversea' || profile.status !== 'active') fail('An active Oversea SSH profile for this site is required');
  if (profile.host !== expectedHost) fail('Saved SSH host does not exactly match expected-host; no remote command was executed');
  if (mode === 'apply' && (profile.strictHostKeyChecking !== 'yes' || profile.batchMode !== 'yes')) fail('Recovery requires StrictHostKeyChecking=yes and BatchMode=yes in the saved profile');
  const { site } = await api('/internal/v1/launcher-network/mihomo/sites/' + encodedSite);
  if (!site || site.siteId !== siteId) fail('The existing registered Oversea site is required');
  if (site.status === 'archived') fail('The site is archived; this recovery does not unarchive sites');
  if (mode === 'apply' && site.publicHost !== profile.host) fail('Registered subscription host differs from the SSH host. This legacy API publishes the address before deployment; use a future Launcher recovery route with delayed publication instead');
  if (mode === 'apply' && String(profile.serverPorts ?? '51288').trim() !== String(site.serverPorts ?? '51288').trim()) fail('Saved HY2 ports differ from the registered site; review the existing configuration before recovery');
  const port = profile.exportPort ?? 3434;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Invalid saved health TCP port');
  summary({ stage: 'target', mode, siteId, host: profile.host, sshPort: profile.sshPort, registeredHost: site.publicHost, healthPort: port });
  await verifyEffectiveSshHost(profile);
  const checks = await inspect(port, 'inspect');
  if (mode === 'apply') {
    if (checks.docker !== 'missing' && checks.compose !== 'ready') fail('Docker is already installed but Compose is missing; stop to avoid an implicit Docker engine upgrade');
    const prepared = await prepareFreshPlan(profile, site);
    if (checks.rsync === 'missing') await installMissingRsync();
    const { accounts: beforeAccounts } = await api('/internal/v1/site-slots/' + encodedSite + '/access-accounts');
    if (validateDefaults(beforeAccounts) !== prepared.accountSnapshot) fail('Account material changed before execution; legacy ensure was not started');
    const { plans: beforePlans } = await api('/internal/v1/site-slots/plans');
    const latestPlans = (beforePlans ?? []).filter(plan => plan.kind === 'oversea' && plan.siteId === siteId
      && plan.ssh?.profileId === profile.profileId && plan.status !== 'blocked')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (latestPlans[0]?.planId !== prepared.planId || latestPlans.some(plan => plan.planId !== prepared.planId && plan.createdAt === latestPlans[0].createdAt)) fail('Latest plan changed before execution; legacy ensure was not started');
    validateFreshPlan(latestPlans[0], profile, prepared.accountSnapshot, prepared.runtime);
    const { site: beforeSite } = await api('/internal/v1/launcher-network/mihomo/sites/' + encodedSite);
    if (beforeSite?.status === 'archived' || beforeSite?.publicHost !== site.publicHost || beforeSite?.serverPorts !== site.serverPorts) fail('Published site changed before execution; legacy ensure was not started');
    const { profile: beforeExecution } = await api('/internal/v1/config-center/site-slot-ssh-profiles/site/' + encodedSite);
    if (profileSnapshot(beforeExecution) !== profileSnapshot(profile)) fail('SSH profile changed before execution; legacy ensure was not started');
    applying = true;
    summary({ stage: 'apply-started', siteId, requestId, note: 'Existing Install / Sync; no automatic retry. Docker installation is included in the worker.' });
    const { ensure } = await api('/internal/v1/admin/oversea/' + encodedSite + '/ensure', {
      executeRemote: true, confirmInstall: true, force: true,
      requestedBy: 'k8s-oversea-recovery', requestId
    }, 20 * 60_000);
    applying = false;
    summary({
      stage: 'ensure', siteId, status: ensure?.status ?? 'missing',
      planId: ensure?.planId ?? null, jobId: ensure?.jobId ?? null, reportId: ensure?.reportId ?? null,
      steps: Array.isArray(ensure?.steps) ? ensure.steps.map(step => ({ stepId: step.stepId, status: step.status, objectId: step.objectId })) : [],
      blockedCount: Array.isArray(ensure?.blockedReasons) ? ensure.blockedReasons.length : 0
    });
    if (ensure?.status !== 'installed' && ensure?.status !== 'passed') fail('Install / Sync did not pass; inspect the reported job before retrying');
    if (ensure?.planId !== prepared.planId) fail('Legacy ensure used a different plan; review the result before any retry');
    const verified = await inspect(port, 'verify');
    if (verified.docker !== 'ready' || verified.compose !== 'ready' || verified.stack !== 'present' || verified.health_http !== '200') fail('Worker reported success but runtime verification failed; do not retry automatically');
    summary({ stage: 'runtime-ready', siteId, note: 'Docker and the local health endpoint passed. A real Hysteria2 client/network test is still required.' });
  }
} catch (error) {
  console.error(error.message);
  if (applying) {
    summary({ stage: 'result-unknown', siteId, requestId });
    console.error('Do not rerun apply automatically: the remote worker may still be running. Read GET /internal/v1/site-slots/worker-reports (filter siteId locally), or GET /internal/v1/site-slots/worker-reports?jobId=<jobId> when known. Print only IDs/status; inspect Internal Evidence History for details.');
  }
  process.exitCode = 1;
}
NODE
