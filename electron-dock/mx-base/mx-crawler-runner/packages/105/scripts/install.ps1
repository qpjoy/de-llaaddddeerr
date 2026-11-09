param([string]$Venv = '.venv')
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    python -m venv $Venv
    if ($LASTEXITCODE -ne 0) { throw 'Environment creation failed' }
    $pythonPath = Join-Path $Venv 'Scripts/python.exe'
    & $pythonPath -m pip install -r requirements.lock.txt
    if ($LASTEXITCODE -ne 0) { throw 'Locked dependency installation failed' }
    & $pythonPath -m pip install --no-deps .
    if ($LASTEXITCODE -ne 0) { throw 'Project installation failed' }
    & $pythonPath -m pip install --no-deps 'upstream/NHagar__substack_api'
    if ($LASTEXITCODE -ne 0) { throw 'Upstream installation failed; preserve Git metadata when required' }
} finally { Pop-Location }
