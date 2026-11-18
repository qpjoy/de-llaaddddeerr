'use strict';

// Only the protected service runs this script. Do not execute or read the
// user-writable WireGuard binary/profile named by the old SCM registration.
function legacyHdoCleanupScript(ownerSID) {
  if (!/^S-1-5-(?:\d+-)*\d+$/.test(ownerSID)) throw new Error('Invalid Windows account');
  return String.raw`
$ErrorActionPreference = 'Stop'
$serviceName = 'WireGuardTunnel$hdo-client'
$owner = 'MX HDO / QPJoy HDO hdo-client'
$mincave = 'MX-H2I / QPJoy MX-H2I mx-h2i'
$stage = 'verify'
try {
  $profile = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\${ownerSID}').ProfileImagePath
  if (-not $profile) { throw 'profile' }
  $root = Join-Path ([Environment]::ExpandEnvironmentVariables($profile)) 'AppData\Roaming\罗盘AI情报系统\plugin-data\qpjoy.electron-plugin-hdo'
  $exe = Join-Path $root 'bin\wireguard.exe'
  $config = Join-Path $root 'wireguard\hdo-client.conf'
  $expected = @(
    "$exe /tunnelservice $config"
    ('"{0}" /tunnelservice {1}' -f $exe, $config)
    ('{0} /tunnelservice "{1}"' -f $exe, $config)
    ('"{0}" /tunnelservice "{1}"' -f $exe, $config)
  )
  $registered = Get-CimInstance Win32_Service -Filter 'Name="WireGuardTunnel$hdo-client"'
  if (-not $registered) { [Console]::Write('no-conflict'); return }
  if ($expected -notcontains $registered.PathName) { throw 'registration' }

  $stage = 'lock'
  $mutex = [System.Threading.Mutex]::new($false, 'Global\QPJoy.MXLauncher.NRPT.v1')
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(8000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'mutex' }
    $mincaveService = 'WireGuardTunnel$mx-h2i'
    if ((Get-Service -Name $mincaveService -ErrorAction SilentlyContinue).Status -ne 'Running') {
      [Console]::Write('no-conflict')
      return
    }
    $stage = 'read-rules'
    $rules = @(Get-DnsClientNrptRule)
    $legacy = @($rules | Where-Object {
      $_.Comment -eq $owner -and $_.DisplayName -eq $owner -and (@($_.NameServers) -join ',') -eq '100.88.0.1'
    })
    $overlap = @('mxinfo-inc.cn', '.mxinfo-inc.cn')
    $conflict = @($legacy | Where-Object {
      $namespace = @($_.Namespace)
      $namespace.Count -eq 1 -and $overlap -contains $namespace[0] -and
        ($rules | Where-Object {
          $_.Comment -eq $mincave -and $_.DisplayName -eq $mincave -and
            @($_.Namespace) -contains $namespace[0] -and (@($_.NameServers) -join ',') -eq '10.88.0.1'
        })
    })
    if ($conflict.Count -eq 0) { [Console]::Write('no-conflict'); return }
    $stage = 'backup'
    $backup = Join-Path $env:TEMP ('legacy-hdo-nrpt-' + [Guid]::NewGuid() + '.xml')
    $legacy | Export-Clixml -LiteralPath $backup
    $stage = 'stop'
    $current = Get-CimInstance Win32_Service -Filter 'Name="WireGuardTunnel$hdo-client"'
    if (-not $current -or $expected -notcontains $current.PathName) { throw 'registration changed' }
    $service = Get-Service -Name $serviceName
    if ($service.Status -ne 'Stopped') { Stop-Service -InputObject $service }
    if ((Get-Service -Name $serviceName).Status -ne 'Stopped') { throw 'still running' }
    $stage = 'remove-rules'
    # Keep the overlapping rules until the end so a partial failure can
    # still be detected and retried from the repair dialog.
    foreach ($rule in ($legacy | Sort-Object -Property { [int]($overlap -contains @($_.Namespace)[0]) })) {
      Remove-DnsClientNrptRule -Name $rule.Name -Force
    }
    if ((Get-Service -Name $serviceName).Status -ne 'Stopped') { throw 'service restarted' }
    [Console]::Write('cleaned')
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
} catch {
  [Console]::Write('failed:' + $stage)
}
`;
}

module.exports = { legacyHdoCleanupScript };
