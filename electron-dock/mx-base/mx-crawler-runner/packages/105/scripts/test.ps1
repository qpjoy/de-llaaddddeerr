param([string]$Python = '.venv/Scripts/python.exe')
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & $Python -m unittest discover -s tests -p test_adapter.py -v
    if ($LASTEXITCODE -ne 0) { throw 'Adapter tests failed' }
} finally { Pop-Location }
