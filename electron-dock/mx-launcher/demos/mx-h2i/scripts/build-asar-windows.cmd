@echo off
setlocal
if "%~1"=="--" shift /1
if "%~2"=="" (
  set "MX_ASAR_ARCH=x64"
) else (
  set "MX_ASAR_ARCH=%~2"
)
rem Reuse the generic build pipeline and its package.json version default.
rem CALL returns control here when pnpm resolves to a Windows .cmd shim.
if "%~1"=="" (
  call pnpm --dir "%~dp0.." run make:asar --platform win32 --arch "%MX_ASAR_ARCH%"
) else (
  call pnpm --dir "%~dp0.." run make:asar --platform win32 --arch "%MX_ASAR_ARCH%" --version "%~1"
)
exit /b %ERRORLEVEL%
