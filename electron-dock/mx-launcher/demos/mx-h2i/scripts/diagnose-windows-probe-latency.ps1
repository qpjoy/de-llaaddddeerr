<#
.SYNOPSIS
  Measures how long the system queries MX-H2I depends on actually take on this
  machine.

.DESCRIPTION
  MX-H2I decides whether the WireGuard tunnel is up by spawning powershell.exe
  and reading the tunnel service state. That spawn has a timeout. When the
  machine is slow enough to blow through it, the timed-out probe used to be
  reported as "tunnel is down", which downgraded a healthy connection and, at
  startup, tore a live tunnel down.

  This script re-runs the exact probes, as separate powershell.exe / reg.exe
  child processes just like the app does, and reports min/median/max latency so
  an intermittent stall shows up. It reads state only -- it never changes the
  tunnel, NRPT, routes, or proxy settings, and it does not need admin.

.PARAMETER TunnelName
  WireGuard tunnel/interface name. Default: mx-h2i.

.PARAMETER Iterations
  How many times to run each probe. Default: 5. Raise it (e.g. 20) to catch a
  stall that only happens occasionally.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\diagnose-windows-probe-latency.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\diagnose-windows-probe-latency.ps1 -Iterations 20
#>
[CmdletBinding()]
param(
  [string]$TunnelName = 'mx-h2i',
  [int]$Iterations = 5
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# Timeouts the app enforces on each of these child processes. A probe whose
# max latency crosses its budget is a probe the app will report as a failure.
$Budgets = @{
  'sc.exe query (tunnel service)'  = 8000
  'powershell startup (baseline)'  = 5000
  'Get-Service (tunnel service)'   = 8000
  'Get-NetAdapter -IncludeHidden'  = 12000
  'Get-NetRoute (tunnel adapter)'  = 12000
  'combined service+adapter+route' = 5000
  'Get-DnsClientNrptRule'          = 8000
  'reg query AutoConfigURL'        = 6000
  'reg query Internet Settings'    = 6000
  'WinINet InternetSetOption'      = 12000
}

$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $PowerShellExe)) { $PowerShellExe = 'powershell.exe' }
$RegExe = Join-Path $env:SystemRoot 'System32\reg.exe'
if (-not (Test-Path $RegExe)) { $RegExe = 'reg.exe' }

$ServiceName = "WireGuardTunnel`$$TunnelName"
$ProxyKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

function Invoke-TimedNative {
  param(
    [string]$Label,
    [string]$FilePath,
    [string[]]$Arguments
  )
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  # stderr goes to null: a missing registry value makes reg.exe print an error
  # and exit non-zero, which is a normal reading here, not a failure.
  $output = & $FilePath @Arguments 2>$null
  $sw.Stop()
  $exitCode = $LASTEXITCODE
  [pscustomobject]@{
    Label    = $Label
    Ms       = [int]$sw.Elapsed.TotalMilliseconds
    ExitCode = $exitCode
    Output   = (($output | Out-String).Trim())
  }
}

function Invoke-TimedPowerShell {
  param([string]$Label, [string]$Script)
  Invoke-TimedNative -Label $Label -FilePath $PowerShellExe -Arguments @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', $Script
  )
}

# --- the probes, written to match what the app actually spawns -------------

$ServiceScript = @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
`$svc = Get-Service -Name '$ServiceName' -ErrorAction SilentlyContinue
if (`$null -eq `$svc) { 'NOT_FOUND' } else { ([string]`$svc.Status).ToUpperInvariant() }
"@

$AdapterScript = @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
@(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object { [string]`$_.Name -eq '$TunnelName' }) |
  ForEach-Object { ([string]`$_.Name) + '|if=' + [string]`$_.InterfaceIndex + '|status=' + [string]`$_.Status }
"@

$RouteScript = @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
`$adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object { [string]`$_.Name -eq '$TunnelName' })
@(`$adapters | ForEach-Object {
  `$index = [int]`$_.InterfaceIndex
  Get-NetRoute -InterfaceIndex `$index -ErrorAction Stop |
    ForEach-Object { ([string]`$_.DestinationPrefix) + '|if=' + [string]`$_.InterfaceIndex }
})
"@

# The single script the old build ran under one 5000 ms budget. If this one is
# slow while Get-Service alone is fast, the split in the fix is the answer.
$CombinedScript = @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
`$svc = Get-Service -Name '$ServiceName' -ErrorAction SilentlyContinue
`$adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object { [string]`$_.Name -eq '$TunnelName' })
`$routes = @(`$adapters | ForEach-Object {
  `$index = [int]`$_.InterfaceIndex
  Get-NetRoute -InterfaceIndex `$index -ErrorAction Stop | ForEach-Object { ([string]`$_.DestinationPrefix) }
})
[pscustomobject]@{
  serviceState = if (`$null -eq `$svc) { 'NOT_FOUND' } else { ([string]`$svc.Status).ToUpperInvariant() }
  adapters = @(`$adapters | ForEach-Object { [string]`$_.Name })
  routes = `$routes
} | ConvertTo-Json -Depth 5 -Compress
"@

# Measures the Add-Type/wininet compile the app performs whenever it applies or
# restores the system PAC -- the call that failed seven times in the field log.
# The DllImport quotes are assembled from [char]34 so no literal double quote
# has to survive being passed on a command line.
# The NRPT probe the app runs after every connect and on each split-DNS check.
# Its budget is small and PowerShell startup eats most of it on a slow machine.
$NrptScript = @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
`$global = Get-DnsClientNrptGlobal -ErrorAction Stop
`$rules = @(Get-DnsClientNrptRule -ErrorAction Stop)
'rules=' + `$rules.Count
"@

$NotifyScript = @"
`$q = [char]34
`$sig = '[DllImport(' + `$q + 'wininet.dll' + `$q + ', SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);'
`$type = Add-Type -MemberDefinition `$sig -Name WinInetProbe -Namespace QPJoyProbe -PassThru
if (`$null -eq `$type) { 'add-type-failed' } else { 'add-type-ok' }
"@

Write-Host ''
Write-Host '=== MX-H2I Windows probe latency ===' -ForegroundColor Cyan
Write-Host ("host          : {0}" -f $env:COMPUTERNAME)
Write-Host ("user          : {0}" -f $env:USERNAME)
Write-Host ("os            : {0}" -f (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Version)
Write-Host ("powershell    : {0}" -f $PSVersionTable.PSVersion)
Write-Host ("tunnel        : {0}  (service {1})" -f $TunnelName, $ServiceName)
Write-Host ("iterations    : {0}" -f $Iterations)
Write-Host ''

$samples = @{}
$lastOutput = @{}

for ($i = 1; $i -le $Iterations; $i++) {
  Write-Host ("run {0}/{1} ..." -f $i, $Iterations) -ForegroundColor DarkGray
  $results = @(
    # sc.exe is the path the fixed build takes for tunnel liveness. It is a
    # native exe, so it never pays the PowerShell/.NET startup tax -- this row
    # is the one that says whether the fix helps on this machine.
    (Invoke-TimedNative -Label 'sc.exe query (tunnel service)' -FilePath 'sc.exe' -Arguments @('query', $ServiceName)),
    (Invoke-TimedPowerShell -Label 'powershell startup (baseline)' -Script '1'),
    (Invoke-TimedPowerShell -Label 'Get-Service (tunnel service)'  -Script $ServiceScript),
    (Invoke-TimedPowerShell -Label 'Get-NetAdapter -IncludeHidden' -Script $AdapterScript),
    (Invoke-TimedPowerShell -Label 'Get-NetRoute (tunnel adapter)' -Script $RouteScript),
    (Invoke-TimedPowerShell -Label 'combined service+adapter+route' -Script $CombinedScript),
    (Invoke-TimedPowerShell -Label 'Get-DnsClientNrptRule' -Script $NrptScript),
    (Invoke-TimedNative -Label 'reg query AutoConfigURL' -FilePath $RegExe -Arguments @('query', $ProxyKey, '/v', 'AutoConfigURL')),
    (Invoke-TimedNative -Label 'reg query Internet Settings' -FilePath $RegExe -Arguments @('query', $ProxyKey)),
    (Invoke-TimedPowerShell -Label 'WinINet InternetSetOption' -Script $NotifyScript)
  )
  foreach ($r in $results) {
    if (-not $samples.ContainsKey($r.Label)) { $samples[$r.Label] = @() }
    $samples[$r.Label] += $r.Ms
    $lastOutput[$r.Label] = $r
  }
}

Write-Host ''
Write-Host '=== latency (ms) ===' -ForegroundColor Cyan

$rows = @()
foreach ($label in $Budgets.Keys) {
  if (-not $samples.ContainsKey($label)) { continue }
  $values = @($samples[$label] | Sort-Object)
  $budget = $Budgets[$label]
  $max = $values[$values.Count - 1]
  $median = $values[[int][math]::Floor($values.Count / 2)]
  $verdict = 'ok'
  if ($max -ge $budget) { $verdict = 'OVER BUDGET' }
  elseif ($max -ge ($budget * 0.6)) { $verdict = 'close to budget' }
  $rows += [pscustomobject]@{
    Probe   = $label
    Min     = $values[0]
    Median  = $median
    Max     = $max
    Budget  = $budget
    Verdict = $verdict
  }
}
$rows | Sort-Object -Property Max -Descending | Format-Table -AutoSize

foreach ($label in @('Get-Service (tunnel service)', 'WinINet InternetSetOption')) {
  if ($lastOutput.ContainsKey($label)) {
    Write-Host ("last {0} -> {1}" -f $label, $lastOutput[$label].Output) -ForegroundColor DarkGray
  }
}
Write-Host ''

$over = @($rows | Where-Object { $_.Verdict -ne 'ok' })

Write-Host '=== current machine state ===' -ForegroundColor Cyan
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $svc) {
  Write-Host ("service {0}: NOT_FOUND (tunnel is not installed/running)" -f $ServiceName) -ForegroundColor Yellow
} else {
  Write-Host ("service {0}: {1}" -f $ServiceName, $svc.Status)
}

$allAdapters = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue)
Write-Host ("adapters (incl. hidden): {0} total" -f $allAdapters.Count)
$tunnelAdapter = @($allAdapters | Where-Object { [string]$_.Name -eq $TunnelName })
if ($tunnelAdapter.Count -gt 0) {
  foreach ($a in $tunnelAdapter) {
    Write-Host ("  {0}: if={1} status={2}" -f $a.Name, $a.InterfaceIndex, $a.Status)
  }
} else {
  Write-Host ("  no adapter named {0}" -f $TunnelName) -ForegroundColor Yellow
}

$nrpt = @(Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Where-Object { [string]$_.Comment -like '*MX-H2I*' })
Write-Host ("NRPT rules owned by MX-H2I: {0}" -f $nrpt.Count)
$hdoNrpt = @(Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Where-Object { [string]$_.Comment -like '*HDO*' })
if ($hdoNrpt.Count -gt 0) {
  Write-Host ("NRPT rules owned by HDO (V1 also installed): {0}" -f $hdoNrpt.Count) -ForegroundColor Yellow
}

$defender = $null
try { $defender = Get-MpComputerStatus -ErrorAction Stop } catch { $defender = $null }
if ($null -ne $defender) {
  Write-Host ("Defender real-time protection: {0}" -f $defender.RealTimeProtectionEnabled)
}
$av = @()
try {
  $av = @(Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop |
    ForEach-Object { [string]$_.displayName })
} catch { $av = @() }
if ($av.Count -gt 0) { Write-Host ("antivirus products: {0}" -f ($av -join ', ')) }

Write-Host ''
Write-Host '=== reading ===' -ForegroundColor Cyan
if ($over.Count -eq 0) {
  Write-Host 'All probes finished inside their budgets on this run.' -ForegroundColor Green
  Write-Host 'If MX-H2I still reports disconnects, run again with -Iterations 20 while the'
  Write-Host 'machine is busy (the stall is intermittent and load-driven).'
} else {
  Write-Host 'These probes are at or over the budget the app enforces:' -ForegroundColor Yellow
  foreach ($row in $over) {
    Write-Host ("  {0}: max {1} ms vs budget {2} ms  [{3}]" -f $row.Probe, $row.Max, $row.Budget, $row.Verdict)
  }
  Write-Host ''
  $svcRow = @($rows | Where-Object { $_.Probe -eq 'Get-Service (tunnel service)' })
  $combinedRow = @($rows | Where-Object { $_.Probe -eq 'combined service+adapter+route' })
  if ($svcRow.Count -gt 0 -and $combinedRow.Count -gt 0 -and $svcRow[0].Max -lt 2000 -and $combinedRow[0].Max -ge 4000) {
    Write-Host 'Get-Service alone is fast while the combined probe is slow: the adapter/route' -ForegroundColor Yellow
    Write-Host 'enumeration is what blows the budget. That is exactly the case the split probe'
    Write-Host 'in the fix addresses -- the tunnel service answer no longer dies with it.'
  }
}

# The most useful signal is the gap between a native exe and PowerShell. Both
# pay the same process-creation cost, so if reg.exe/sc.exe are milliseconds
# while an empty powershell.exe is seconds, the tax is on the PowerShell/.NET
# engine itself (assembly load, AV scanning of managed images), not on spawning
# processes in general -- and the fix's sc.exe path sidesteps it entirely.
Write-Host ''
Write-Host '=== native exe vs PowerShell ===' -ForegroundColor Cyan
$nativeRow = @($rows | Where-Object { $_.Probe -eq 'reg query Internet Settings' })
$scRow = @($rows | Where-Object { $_.Probe -eq 'sc.exe query (tunnel service)' })
$psRow = @($rows | Where-Object { $_.Probe -eq 'powershell startup (baseline)' })
if ($nativeRow.Count -gt 0 -and $psRow.Count -gt 0) {
  Write-Host ("native exe (reg.exe)      median {0,6} ms" -f $nativeRow[0].Median)
  if ($scRow.Count -gt 0) {
    Write-Host ("native exe (sc.exe query) median {0,6} ms   <- what the fixed build uses" -f $scRow[0].Median)
  }
  Write-Host ("empty powershell.exe      median {0,6} ms" -f $psRow[0].Median)
  if ($psRow[0].Median -ge 500 -and $nativeRow[0].Median -lt 200) {
    $ratio = [math]::Round($psRow[0].Median / [math]::Max(1, $nativeRow[0].Median), 1)
    Write-Host ''
    Write-Host ("PowerShell startup costs {0}x a native exe here. Process creation itself is fine;" -f $ratio) -ForegroundColor Yellow
    Write-Host 'the PowerShell/.NET engine is what is being taxed. Every PowerShell-based probe'
    Write-Host 'pays that before doing any work, which is what pushed them past their budgets.'
    Write-Host 'Add an antivirus exclusion for the MX-H2I install directory and for'
    Write-Host 'powershell.exe launched from it, then re-run this script to confirm.'
  }
  if ($scRow.Count -gt 0 -and $psRow.Count -gt 0 -and $scRow[0].Max -lt 500 -and $psRow[0].Median -ge 500) {
    Write-Host ''
    Write-Host 'sc.exe answers the tunnel-liveness question in a fraction of the PowerShell cost.' -ForegroundColor Green
    Write-Host 'The fixed build reads the service state this way first, so the decisive probe no'
    Write-Host 'longer depends on a PowerShell spawn completing in time.'
  }
}
Write-Host ''
Write-Host 'Nothing was modified by this script.' -ForegroundColor DarkGray
