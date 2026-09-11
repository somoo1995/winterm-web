@echo off
REM winterm-web installer - just double-click this file.
REM A .bat is used on purpose: it is NOT blocked by PowerShell ExecutionPolicy,
REM which is the most common first-run failure on a fresh Windows machine.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" %*
set RC=%errorlevel%
echo.
if not %RC%==0 echo [FAILED] See the message above.
pause
exit /b %RC%
