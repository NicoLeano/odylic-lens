@echo off
REM Thin Windows shim for the `lens` CLI. Installed into
REM %USERPROFILE%\.local\bin by install.ps1; that folder is added to the
REM user PATH so PowerShell + cmd can call `lens start`, `lens status`, etc.
REM
REM The real logic lives in scripts\lens.ps1 inside the install dir, which
REM we locate via ODYLIC_LENS_DIR (set by the installer) or fall back to
REM %USERPROFILE%\odylic-lens.
setlocal
set "LENS_DIR=%ODYLIC_LENS_DIR%"
if "%LENS_DIR%"=="" set "LENS_DIR=%USERPROFILE%\odylic-lens"
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%LENS_DIR%\scripts\lens.ps1" %*
endlocal
