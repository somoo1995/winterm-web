@echo off
REM ===========================================================================
REM  winterm-web one-click setup
REM
REM  Download this single file and double-click it. Nothing else is needed.
REM  It downloads the source, installs Python if missing, installs the
REM  dependencies, and starts the server.
REM
REM  Why .bat and not .msi/.exe:
REM    - .bat is not blocked by PowerShell ExecutionPolicy (the #1 first-run
REM      failure on a fresh Windows).
REM    - An unsigned .exe/.msi trips SmartScreen 'unknown publisher'.
REM    - No admin rights required; everything installs per-user.
REM ===========================================================================
chcp 65001 >nul
setlocal

set "REPO=https://github.com/somoo1995/winterm-web"
REM  Override the install location with:  set WINTERM_DEST=D:\apps\winterm-web
if defined WINTERM_DEST (set "DEST=%WINTERM_DEST%") else (set "DEST=%LOCALAPPDATA%\winterm-web")
set "TMPZIP=%TEMP%\winterm-web-main.zip"
set "TMPDIR=%TEMP%\winterm-web-unpack"

echo.
echo   winterm-web setup
echo   -^> %DEST%
echo.

REM --- 1. download -----------------------------------------------------------
echo [1/4] Downloading...
if exist "%TMPZIP%" del /q "%TMPZIP%"
curl.exe -fsSL -o "%TMPZIP%" "%REPO%/archive/refs/heads/main.zip"
if errorlevel 1 (
  echo   [FAILED] Download failed. Check your network or proxy.
  pause & exit /b 1
)

REM --- 2. extract ------------------------------------------------------------
echo [2/4] Extracting...
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
mkdir "%TMPDIR%"
tar.exe -xf "%TMPZIP%" -C "%TMPDIR%"
if errorlevel 1 (
  echo   [FAILED] Extract failed.
  pause & exit /b 1
)

REM --- 3. place --------------------------------------------------------------
echo [3/4] Installing files...
if not exist "%DEST%" mkdir "%DEST%"
robocopy "%TMPDIR%\winterm-web-main" "%DEST%" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 (
  echo   [FAILED] Could not copy files.
  pause & exit /b 1
)
del /q "%TMPZIP%" 2>nul
rmdir /s /q "%TMPDIR%" 2>nul

REM --- 4. run the real installer ---------------------------------------------
echo [4/4] Running installer...
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\tools\install.ps1" %*
set RC=%errorlevel%

echo.
if not %RC%==0 (
  echo   [FAILED] Installer reported an error. See the message above.
) else (
  echo   Done. Installed to %DEST%
  echo   To uninstall: run uninstall.bat in that folder.
)
pause
exit /b %RC%
