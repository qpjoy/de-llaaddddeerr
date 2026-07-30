@echo off
setlocal
if "%~1"=="" (
  echo Usage: %~nx0 ^<target-version^> [x64^|arm64^|ia32]
  exit /b 2
)
if "%~2"=="" (
  set "MX_ASAR_ARCH=x64"
) else (
  set "MX_ASAR_ARCH=%~2"
)
pnpm --dir "%~dp0.." run make:asar -- --version "%~1" --platform win32 --arch "%MX_ASAR_ARCH%"
exit /b %ERRORLEVEL%
