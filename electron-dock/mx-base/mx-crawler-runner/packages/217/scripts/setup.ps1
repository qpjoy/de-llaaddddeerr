$ErrorActionPreference = 'Stop'
$platformRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $platformRoot
try {
    if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
        python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Virtual environment creation failed' }
    }
    & '.\.venv\Scripts\python.exe' -m pip install -r requirements.lock.txt .
    if ($LASTEXITCODE -ne 0) { throw 'Platform installation failed' }
    & '.\.venv\Scripts\python.exe' main.py --help
    if ($LASTEXITCODE -ne 0) { throw 'CLI check failed' }
} finally { Pop-Location }
