# Oversea 换机与地址变更：SSH_OK 后恢复 Docker / Hysteria2

适用于 `mx-oversea-us01`、`34.218.136.162`：Internal 已能用原 SSH 私钥返回 `SSH_OK`，
下一步是把已有 Oversea 配置和账户重新部署到替换服务器。无需再次复制 SSH 公钥或 Bootstrap。
本文脚本调用已经存在的 Internal API，不要求先发布新后端；本轮代码仅在本机完成，未部署、未执行生产恢复。
旧 API CLI 仅允许相同 IP/地址恢复；地址变更的 Launcher 流程见末尾。

## 使用现有 API 恢复

在持有生产 kubeconfig 的控制机、仓库根目录执行：

```bash
kubectl config current-context
bash electron-dock/mx-launcher/scripts/k8s-oversea-recover.sh inspect mx-oversea-us01 34.218.136.162
bash electron-dock/mx-launcher/scripts/k8s-oversea-recover.sh apply mx-oversea-us01 34.218.136.162
```

无参数时默认 `inspect mx-oversea-us01 34.218.136.162`。脚本使用当前 context、
`mx-internal-shadow` 的 `deployment/mx-launcher-internal`、`internal-api` 容器；
可用 `MX_OVERSEA_NAMESPACE`、`MX_OVERSEA_DEPLOYMENT` 覆盖集群对象，不会切换 context。

`inspect` 读取已保存的 Profile 和注册站点，并通过已有 terminal API 执行固定只读命令。
它核对 `ssh -G` 实际解析的 HostName，避免 Profile 地址正确但旧 SSH config 指向另一台机器。
输出仅包含 Docker、Compose v2、目录、证书文件存在性和本机 health HTTP 状态，不输出私钥、
token、完整 SSH config 或用户账户文件。它不提交安装计划，也不写入 TLS 指纹。

`apply` 仅支持相同地址恢复：Profile 必须 active/oversea，站点必须已注册且未归档；
Profile 的 StrictHostKeyChecking 和 BatchMode 必须均为 `yes`。
Profile host、有效 SSH HostName 和显式 expected-host 必须一致，已发布的 publicHost 和
HY2 UDP 端口也必须与 Profile 一致。地址变化时停止，避免旧 ensure 接口在部署完成前
发布新地址；改 IP 的迁移需使用后续 Launcher 的延迟发布恢复流程，并以实际已发布版本为准。

通过检查后，脚本调用现有：

```text
POST /internal/v1/admin/oversea/mx-oversea-us01/ensure
{"executeRemote":true,"confirmInstall":true,"force":true,"requestedBy":"k8s-oversea-recovery","requestId":"本次唯一ID"}
```

`force:true` 防止把换机前的 installed 报告当成本机已安装。其余运行字段省略，沿用 Profile，
不手填/覆盖账户、带宽、回调或服务端口。但旧版 `force` 不会淘汰旧计划，脚本会先读取本站
账户，要求所有默认/system 账户已经 active 且有 token，再通过已有 plans API 创建新计划。
它核对新计划的精确 SSH 目标和完整当前 active 账户 token 集合，阻止旧 token、遗漏用户或
已删除用户被重放，并确认该计划仍是最新候选。提交执行前再次核对 Profile、账户、站点和计划，
不打印账户内容。现有 worker 会安装缺失的 Docker、推送产物、部署
Hysteria2 和 health 服务、写入既有 Internal 账户材料并回报证据，因此无需另行安装 Docker。
若已有 Docker 却没有 `docker compose` v2，脚本停止，避免旧安装器隐式升级已有 engine；
`docker-compose` v1 不能绕过此检查。
旧 worker 可能要求远端先有 rsync；只读检查明确缺失时，脚本仅在 `apply` 中通过固定
terminal 命令用 apt/dnf/yum 安装 rsync，完成后重新核对上述快照再运行 ensure。

安装动作会改变本站远端服务和本站执行记录；不会通过此脚本执行 Launcher rollout、SSO
配置更新、Domestic WG key sync 或其他站点部署。现有账户 authToken 会复用；缺失、暂停或
无 token 的默认/system 账户会使脚本停止，防止旧 issueDefaults 隐式创建或复活它们。
脚本不会轮换 SSH 或 Domestic WireGuard key。旧 API 的多次请求不能形成原子事务，
恢复期间不要并发编辑本站 Profile/账户/计划或进行部署。

## SSH 持久化与 Hysteria TLS

- SSH key 位于 PVC `mx-launcher-internal-ssh` 的 `/app/artifacts/ssh`。普通 Pod 重建保留
  PVC 内容；该清单的 PV 使用宿主 `hostPath /var/lib/mx-launcher/k8s/internal-ssh`，
  更换 Kubernetes 宿主机时必须备份迁移该目录，不能把 PVC 名称相同当作数据已迁移。
- Oversea 的持久运行态是 `/opt/mx/state/hysteria2-access-stack/{.env,config,data}`。
  恢复旧状态可保留 TLS 证书及其他运行材料；旧版本真实 current 目录的状态也会由现有
  worker 迁入 stable state。
- 空白替换机没有原 `config/hysteria/certs/server.crt` / `server.key` 时，现有安装器会生成
  新的 Hysteria TLS 证书/私钥。EIP 不变也不代表 TLS 指纹不变；worker 会回报新指纹，使用
  缓存指纹的客户端需要刷新订阅。若必须保持原 TLS 身份，应先恢复旧证书与私钥备份再 apply。

## 尚未同步脚本：直接 kubectl 执行

以下使用旧版已有 API，不安装新版 Launcher。它明确执行本站安装；会先核对目标和现有
Docker 状态，再提交 ensure。长请求用 Node 内置 HTTP，等待预算 20 分钟，token 仅在
Pod 进程内读取。不能将程序改成输出整个 API 响应，响应可能含账户材料和执行命令。

```bash
kubectl -n mx-internal-shadow exec -i deployment/mx-launcher-internal -c internal-api -- node --input-type=module - apply mx-oversea-us01 34.218.136.162 <<'NODE'
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
```

## 超时后的只读查询

ensure 是同步请求，客户端断开不代表远端 worker 已停止。不要自动重跑 `force:true`。
已有 jobId 时优先查 `/internal/v1/site-slots/worker-reports?jobId=<jobId>`；未知时可按站点过滤：

```bash
kubectl -n mx-internal-shadow exec -i deployment/mx-launcher-internal -c internal-api -- node --input-type=module - <<'NODE'
const token = process.env.MX_INTERNAL_OPS_TOKEN;
if (!token) throw new Error('Internal ops token is missing');
const response = await fetch('http://127.0.0.1:18090/internal/v1/site-slots/worker-reports', {
  headers: { 'x-mx-ops-token': token }, signal: AbortSignal.timeout(30_000)
});
if (!response.ok) throw new Error('HTTP ' + response.status);
const { reports } = await response.json();
console.log(JSON.stringify((reports ?? []).filter(x => x.siteId === 'mx-oversea-us01')
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10)
  .map(x => ({ reportId: x.reportId, jobId: x.jobId, status: x.status, createdAt: x.createdAt })), null, 2));
NODE
```

没有新报告时仍可能在执行；到 Internal 的 Evidence History 核对对应 job，不读取/粘贴完整
worker command、账户列表或 raw stdout。脚本不会自动重试，也不会为超时重启 Internal。

## 验收范围

`apply` 返回 worker 成功后会再次读远端状态，要求 Docker/Compose v2 就绪、stack 目录存在、
本机 health 返回 200。这只能证明部署和本机服务活性，不证明公网 UDP 51288 或真实
Hysteria2 客户端全链路正常。还需核对实际 Profile 端口的安全组/防火墙，并用现有 MX-H2I
账号刷新订阅、验证登录及联网；需要保留旧 TLS 指纹的场景先恢复原证书材料。

默认 deployment 的 remote-runner、remote-SSH、confirm-remote 三个 env gate 已开启；密码
Bootstrap 和独立只读 probe gate 的关闭不影响这里的现有 admin terminal/ensure 调用。
现场若 gate 被显式关闭，先核对当前运维配置，不为恢复本站盲目滚动登录服务。

本地测试使用 fake kubectl 和 HTTP/SSH 模拟器，无生产连接。覆盖错站/错地址/旧 HostName、
归档站点、完整探测证据、已有 Docker 保护、端口一致性、当前账户与新计划校验、rsync 补装、
超时不重试、日志凭据保护及安装后活性检查。

## 后续部署后的 Launcher 恢复

部署含恢复入口的 Launcher 后，在原 Edit Profile 中保存目标 IP；需要更换 SSH 主机身份或
补公钥时仍用原 Refresh Host Key / Bootstrap Key，已经 `SSH_OK` 无需重复。再执行只读检查
或“检查并恢复”。即使 IP 没变也会实际检查替换 VM；服务健康时不重装，恢复验证通过后才
发布本站 host 和 ports。

新恢复流程不签发账户、不改 SSO 或 Domestic WG。失败时保留原发布地址/端口，但远端安装
不是事务回滚；缺少旧 TLS 基线或材料时无法保证旧客户端立即恢复。运行锁限单个 Internal
进程，恢复期间避免部署、重启和并发编辑本站；最终仍需真实客户端验收。
