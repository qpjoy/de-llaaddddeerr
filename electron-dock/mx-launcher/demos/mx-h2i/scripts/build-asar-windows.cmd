@echo off
setlocal
if "%~1"=="--" shift /1
if "%~1"=="" (
  echo Usage: %~nx0 ^<target-version^> [x64^|arm64^|ia32]
  exit /b 2
)
if "%~2"=="" (
  set "MX_ASAR_ARCH=x64"
) else (
  set "MX_ASAR_ARCH=%~2"
)
node "%~dp0..\scripts\dev-mode.mjs" ensure
if errorlevel 1 exit /b %ERRORLEVEL%
pnpm --dir "%~dp0.." run check
if errorlevel 1 exit /b %ERRORLEVEL%
node "%~dp0..\scripts\build-asar-update.mjs" --version "%~1" --platform win32 --arch "%MX_ASAR_ARCH%"
exit /b %ERRORLEVEL%
