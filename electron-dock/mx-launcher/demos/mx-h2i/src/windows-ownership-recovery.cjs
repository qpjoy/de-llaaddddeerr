const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { isIP } = require('node:net');

function recoveryCandidates(claims, currentOwnerId) {
  if (!currentOwnerId?.startsWith('mx-h2i:')) return [];
  return (Array.isArray(claims) ? claims : []).filter((claim) =>
    claim.productId === 'mx-h2i'
    && claim.ownerId !== currentOwnerId
    && claim.instanceId
    && claim.ownerId === `mx-h2i:${claim.instanceId}`
    && claim.metadata?.dataPlaneOwner === true
    && isIP(claim.leaseIp || '') === 4
  );
}

function windowsOwnershipProofScript(claims, processId = process.pid, exePath = process.execPath) {
  const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
  const ips = [...new Set(claims.map((claim) => claim.leaseIp).filter((ip) => isIP(ip || '') === 4))];
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('Invalid process id');
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ownerProcessId = ${processId}
$oldIps = @(${ips.map(quote).join(',')})
$allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$ownedIds = @($ownerProcessId)
do {
  $children = @($allProcesses | Where-Object { $ownedIds -contains [int]$_.ParentProcessId -and $ownedIds -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId })
  $ownedIds += $children
} while ($children.Count -gt 0)
$others = @($allProcesses | Where-Object {
  ($_.Name -ieq 'mx-h2i.exe' -or $_.Name -ieq ${quote(path.win32.basename(exePath))}) -and $ownedIds -notcontains [int]$_.ProcessId
} | ForEach-Object { [int]$_.ProcessId })
$services = @(Get-CimInstance Win32_Service -ErrorAction Stop | Where-Object { $_.Name -eq 'WireGuardTunnel$mx-h2i' })
$adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object { $_.Name -eq 'mx-h2i' })
$addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
  $_.InterfaceAlias -eq 'mx-h2i' -or $oldIps -contains $_.IPAddress
} | ForEach-Object { $_.IPAddress })
[pscustomobject]@{
  observed = $true
  currentProcessFound = @($allProcesses | Where-Object { [int]$_.ProcessId -eq $ownerProcessId }).Count -eq 1
  otherProcessIds = $others
  serviceStates = @($services | ForEach-Object { $_.State })
  adapterNames = @($adapters | ForEach-Object { $_.Name })
  addresses = $addresses
} | ConvertTo-Json -Depth 5 -Compress
`;
}

function probeWindowsOwnershipInactive(claims) {
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = windowsOwnershipProofScript(claims);
  const output = execFileSync(powershell, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(output.replace(/^\uFEFF/, '').trim());
}

function inactiveProofBlocker(proof) {
  if (proof?.observed !== true || proof?.currentProcessFound !== true
    || !['otherProcessIds', 'serviceStates', 'adapterNames', 'addresses'].every((key) => Array.isArray(proof[key]))) {
    return 'probe-failed';
  }
  if (proof.otherProcessIds.length) return 'other-instance-running';
  if (proof.serviceStates.some((state) => state !== 'Stopped')) return 'tunnel-active';
  if (proof.adapterNames.length || proof.addresses.length) return 'interface-present';
  return null;
}

const messages = {
  unsupported: '此项残留声明恢复仅适用于 Windows。',
  'no-candidates': '没有发现其他 MX-H2I 身份留下的网络声明。',
  'connection-active': '当前连接仍在使用，已保留网络；如需清理，请先正常断开连接。',
  'operation-in-flight': '网络操作正在进行，请等待完成后再清理。',
  'other-instance-running': '检测到另一个 MX-H2I 主实例，请先退出另一个实例。',
  'tunnel-active': 'WireGuard 服务尚未停止，请先正常断开连接。',
  'interface-present': '仍检测到 MX-H2I 网卡或旧租约地址，请先正常断开连接。',
  'probe-failed': '无法确认进程或网卡状态，本次没有清理网络声明。',
  'claim-snapshot-changed': '网络声明已被其他进程更新，本次没有清理，请重新诊断。',
  'inactive-proof-lost': '复核时网络状态已变化，本次没有清理。',
  'base-update-required': '当前安装基座不支持安全清理，请安装新版 Windows 全量包。',
  'repair-failed': '残留声明清理未完成，请查看诊断详情。',
  eligible: '发现已停止隧道留下的 MX-H2I 网络声明，可以安全清理并保留登录。',
  repaired: '已备份并清理残留网络声明，登录信息已保留；请使用原员工身份连接。'
};

// Synchronous probes and mutation keep the local event loop from starting a
// new connection midway through cleanup. The SDK rechecks under its file lock.
function inspectOrRepairWindowsOwnership(input) {
  const result = (status, extra = {}) => ({
    status, message: messages[status] || messages['repair-failed'],
    repaired: false, candidateOwnerIds: [], removedOwnerIds: [], ...extra
  });
  if (input.platform !== 'win32') return result('unsupported');
  if (input.busy) return result('operation-in-flight');
  if (input.connected) return result('connection-active');
  const candidates = recoveryCandidates(input.claims, input.currentOwnerId);
  if (!candidates.length) return result('no-candidates');
  const details = { candidateOwnerIds: candidates.map((claim) => claim.ownerId) };
  const probe = input.probe || probeWindowsOwnershipInactive;
  try {
    const proof = probe(candidates);
    details.proof = proof;
    const blocked = inactiveProofBlocker(proof);
    if (blocked) return result(blocked, details);
    if (!input.repair) return result('eligible', details);
    if (typeof input.prune !== 'function') return result('base-update-required', details);
    const repair = input.prune({
      productId: 'mx-h2i', currentOwnerId: input.currentOwnerId,
      expectedClaims: candidates,
      verifyInactive: () => {
        details.proof = probe(candidates);
        return inactiveProofBlocker(details.proof) === null;
      }
    });
    if (!repair.repaired) return result(repair.reason, details);
    return result('repaired', {
      ...details, repaired: true, removedOwnerIds: repair.removedOwnerIds, backupPath: repair.backupPath
    });
  } catch (error) {
    return result(input.repair ? 'repair-failed' : 'probe-failed', {
      ...details, error: String(error.message || error)
    });
  }
}

module.exports = {
  inspectOrRepairWindowsOwnership, recoveryCandidates,
  windowsOwnershipProofScript, inactiveProofBlocker, probeWindowsOwnershipInactive
};
