@echo off
REM Starts the local Intune App Decommission server (reads config.json in this folder).
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" %*
)
pause
