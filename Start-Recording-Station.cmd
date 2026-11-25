@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Recording Station

set "NODE_EXE=%~dp0runtime\node\node.exe"
set "TSX_CLI=%~dp0node_modules\tsx\dist\cli.mjs"

if not exist "%NODE_EXE%" (
  echo [ERROR] Portable Node.js not found: %NODE_EXE%
  echo Please download the full Release package, not the source zip.
  echo Source builds need Node.js 18+, then run: npm ci, npm run build, npm start.
  pause
  exit /b 1
)
if not exist "%TSX_CLI%" (
  echo [ERROR] Runtime dependencies incomplete: %TSX_CLI%
  echo Please re-extract the full Release package.
  pause
  exit /b 1
)

rem ===== Check and auto-install Visual C++/UCRT runtime =====
call :ensure_vcredist

rem ===== Check and auto-install UsbDk =====
call :ensure_usbdk

rem ===== Media Foundation (Windows N editions only) =====
set "MISSING_MF="
for %%F in (mfplat.dll mf.dll) do (
  if not exist "%SystemRoot%\System32\%%F" set "MISSING_MF=1"
)
if defined MISSING_MF (
  echo [ERROR] Media Foundation is missing. Windows N editions need the Media Feature Pack.
  echo https://support.microsoft.com/en-us/topic/media-feature-pack-list-for-windows-n-editions-c1c6fffa-d052-8338-7a79-a4bb980a700a
  pause
  exit /b 1
)

"%NODE_EXE%" "%TSX_CLI%" "%~dp0src\index.ts"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Recording Station exited with code %EXIT_CODE%. Check the messages above.
  pause
)
exit /b %EXIT_CODE%

rem ============================================================
rem Check VC++ runtime; install silently if missing
rem ============================================================
:ensure_vcredist
  set "MISSING_VC="
  for %%F in (msvcp140.dll vcruntime140.dll vcruntime140_1.dll ucrtbase.dll) do (
    if not exist "%SystemRoot%\System32\%%F" set "MISSING_VC=1"
  )
  if not defined MISSING_VC goto :eof

  echo [CHECK] Visual C++/UCRT runtime missing, installing...
  if not exist "%~dp0redist\vc_redist*.exe" (
    echo [ERROR] VC++ redistributable installer not found in package.
    echo Download: https://aka.ms/vs/17/release/vc_redist.x64.exe
    pause
    exit /b 1
  )
  set "VC_REDIST="
  for %%F in ("%~dp0redist\vc_redist*.exe") do if not defined VC_REDIST set "VC_REDIST=%%~F"
  "%VC_REDIST%" /install /quiet /norestart
  echo [DONE] VC++ runtime installation finished, re-checking...

  set "MISSING_VC="
  for %%F in (msvcp140.dll vcruntime140.dll vcruntime140_1.dll ucrtbase.dll) do (
    if not exist "%SystemRoot%\System32\%%F" set "MISSING_VC=1"
  )
  if defined MISSING_VC (
    echo [WARN] Runtime still not detected after install. A reboot may be required.
    echo You can also run it manually: %VC_REDIST%
    pause
    exit /b 1
  )
  echo [OK] Visual C++/UCRT runtime ready.
  goto :eof

rem ============================================================
rem Check UsbDk; install silently if missing
rem ============================================================
:ensure_usbdk
  set "USBDK_OK="
  if exist "%SystemRoot%\System32\drivers\UsbDk.sys" (
    if exist "%SystemRoot%\System32\UsbDkHelper.dll" set "USBDK_OK=1"
    if exist "%ProgramFiles%\UsbDk Runtime Library\UsbDkHelper.dll" set "USBDK_OK=1"
  )
  if defined USBDK_OK goto :eof

  echo [CHECK] UsbDk not detected, installing...
  if not exist "%~dp0redist\UsbDk*.msi" (
    echo [INFO] UsbDk installer not found in package, skipping auto-install.
    echo Download: https://github.com/daynix/UsbDk/releases
    goto :eof
  )
  set "USBDK_MSI="
  for %%F in ("%~dp0redist\UsbDk*.msi") do if not defined USBDK_MSI set "USBDK_MSI=%%~F"
  msiexec /i "%USBDK_MSI%" /qn /norestart
  echo [DONE] UsbDk installation finished. Reboot if capture still fails.
  goto :eof
