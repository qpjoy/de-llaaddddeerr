$ErrorActionPreference = 'Stop'
$platformRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $platformRoot
try {
    if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
        python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed' }
    }
    & '.\.venv\Scripts\python.exe' -m pip install -r requirements.lock.txt .
    if ($LASTEXITCODE -ne 0) { throw 'Python package installation failed' }
    & '.\.venv\Scripts\python.exe' -m mingxi_google_play.runtime --runtime-dir .runtime
    if ($LASTEXITCODE -ne 0) { throw 'Node backend installation failed' }
    & '.\.venv\Scripts\python.exe' main.py --help
    if ($LASTEXITCODE -ne 0) { throw 'CLI verification failed' }
} finally { Pop-Location }
