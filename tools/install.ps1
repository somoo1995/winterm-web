<#
  winterm-web installer

  install.bat calls this file with ExecutionPolicy Bypass.
  Why go through a .bat: a fresh Windows defaults to the Restricted policy, which won't run
  a .ps1 directly. That's the #1 first-run failure, so the user never has to touch the policy.

  What it does
    1) Find Python -> install 3.12 via winget if missing (located directly, no PATH refresh)
    2) Install dependencies (python -m pip)
    3) Ask whether to enable autostart (default: no)
    4) Start the server + open the browser

  Options
    -Autostart     enable autostart without asking
    -NoAutostart   skip without asking
    -NoStart       install only, don't launch
    -NoBrowser     don't open the browser
    -NoShortcut    don't create the Desktop shortcut
#>
param([switch]$Autostart, [switch]$NoAutostart, [switch]$NoStart, [switch]$NoBrowser, [switch]$NoShortcut)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ROOT

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }
function Step($n, $msg) { Write-Host ""; Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host ""; Write-Host "X $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  winterm-web installer" -ForegroundColor White
Write-Host "  $ROOT" -ForegroundColor DarkGray

# -- 1. Python -----------------------------------------------------------------
Step 1 "Checking Python"

function Find-Python {
    # WindowsApps\python.exe on PATH is a Microsoft Store stub - running it just opens the Store.
    $c = Get-Command python -All -ErrorAction SilentlyContinue |
         Where-Object { $_.Source -and $_.Source -notlike "*WindowsApps*" } |
         Select-Object -First 1
    if ($c) { return $c.Source }
    # Just installed via winget? PATH isn't refreshed in this session yet -> look where it landed.
    foreach ($base in "$env:LOCALAPPDATA\Programs\Python", "$env:ProgramFiles\Python") {
        if (Test-Path $base) {
            $p = Get-ChildItem $base -Filter "Python3*" -Directory -ErrorAction SilentlyContinue |
                 Sort-Object Name -Descending |
                 ForEach-Object { Join-Path $_.FullName "python.exe" } |
                 Where-Object { Test-Path $_ } | Select-Object -First 1
            if ($p) { return $p }
        }
    }
    return $null
}

$py = Find-Python
if ($py) {
    $ver = & $py --version 2>&1
    Say "  found: $py  ($ver)" "Green"
} else {
    Say "  No Python found. Installing 3.12 via winget." "Yellow"
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Die "winget is unavailable, so auto-install isn't possible. Install 3.12 from https://www.python.org/downloads/windows/ (check 'Add to PATH') and run again."
    }
    winget install --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
    $py = Find-Python
    if (-not $py) {
        winget install --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
        $py = Find-Python
    }
    if (-not $py) { Die "Installed, but python.exe still not found. Open a new PowerShell window and run again." }
    Say "  installed: $py" "Green"
}

# -- 2. Dependencies -----------------------------------------------------------
Step 2 "Installing dependencies (may take 1-3 min)"
# pip reads requirements.txt with the LOCALE encoding, not UTF-8 (cp949 on Korean Windows).
# Non-ASCII in the file crashes it with UnicodeDecodeError (measured 2026-09-11 on a Korean
# laptop). We keep requirements.txt ASCII, and also turn on UTF-8 mode as a safety net.
$env:PYTHONUTF8 = "1"
& $py -m pip install --disable-pip-version-check -q -r (Join-Path $ROOT "requirements.txt")
if ($LASTEXITCODE -ne 0) {
    Die "pip install failed. Behind a corporate proxy you may need proxy settings (see README, Troubleshooting)."
}
Say "  done" "Green"

# -- 3. Autostart --------------------------------------------------------------
Step 3 "Autostart"
$TASK = "WebtermServer"
$want = $false
if ($Autostart) { $want = $true }
elseif ($NoAutostart) { $want = $false }
else {
    Write-Host "  Start automatically on logon?" -ForegroundColor White
    Write-Host "  (This is an unauthenticated shell server - say no if you won't use it often.)" -ForegroundColor DarkGray
    $want = (Read-Host "  Enable? [y/N]") -match "^(y|Y)"
}

if ($want) {
    # Autostart is optional. A failure here must NOT kill the whole install.
    # (Measured 2026-09-11: Register-ScheduledTask threw Access denied and, with
    #  $ErrorActionPreference="Stop", it aborted the entire installer.)
    $done = $false

    # (a) Scheduled task - the OS handles the delay and hidden window. Usually needs admin, though.
    try {
        $exe = Join-Path $ROOT "webterm.exe"
        if (Test-Path $exe) {
            $action = New-ScheduledTaskAction -Execute $exe -Argument "--no-browser" -WorkingDirectory $ROOT
        } else {
            $ps1 = Join-Path $ROOT "start.ps1"
            $action = New-ScheduledTaskAction -Execute "powershell.exe" `
                      -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps1`"" `
                      -WorkingDirectory $ROOT
        }
        $trig = New-ScheduledTaskTrigger -AtLogOn
        $trig.Delay = "PT30S"
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew

        $prev = Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
        if ($prev) {
            $where = @($prev.Actions | ForEach-Object { "$($_.Execute) $($_.WorkingDirectory)" })
            if (-not ($where | Where-Object { $_ -like "*$ROOT*" })) {
                Say "  note: an existing $TASK task points elsewhere - overwriting" "Yellow"
                $where | ForEach-Object { Say "    $_" "DarkGray" }
            }
            Unregister-ScheduledTask -TaskName $TASK -Confirm:$false -ErrorAction SilentlyContinue
        }
        Register-ScheduledTask -TaskName $TASK -Action $action -Trigger $trig -Settings $set `
            -Description "winterm-web autostart (30s after logon, windowless)" -ErrorAction Stop | Out-Null
        Say "  scheduled task registered (30s after logon)" "Green"
        $done = $true
    } catch {
        Say "  scheduled task not available ($($_.Exception.Message.Trim())) - falling back to Startup folder" "DarkYellow"
    }

    # (b) Startup folder - no admin needed. autostart.ps1 supplies the delay itself.
    if (-not $done) {
        try {
            $startup = [Environment]::GetFolderPath("Startup")
            $lnk = Join-Path $startup "winterm-web.lnk"
            $auto = Join-Path $ROOT "tools\autostart.ps1"
            $ws = New-Object -ComObject WScript.Shell
            $sc = $ws.CreateShortcut($lnk)
            $sc.TargetPath = "powershell.exe"
            $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$auto`""
            $sc.WorkingDirectory = $ROOT
            $ico = Join-Path $ROOT "assets\webterm.ico"
            if (Test-Path $ico) { $sc.IconLocation = $ico }
            $sc.Description = "winterm-web autostart"
            $sc.Save()
            Say "  added to Startup folder (no admin needed)" "Green"
            Say "    $lnk" "DarkGray"
            $done = $true
        } catch {
            Say "  autostart registration failed: $($_.Exception.Message)" "Red"
            Say "  Continuing the install. You can retry later with install.bat -Autostart." "DarkGray"
        }
    }
} else {
    Say "  skipped (run install.bat -Autostart later if you want it)" "DarkGray"
}

# -- 3.5 Shortcut --------------------------------------------------------------
# Without autostart there's no way to open it, so drop a Desktop shortcut.
# It runs start.ps1 first (so it works even when the server is down) and opens the browser.
if (-not $NoShortcut) {
    Step "3.5" "Desktop shortcut"
    try {
        $lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "winterm-web.lnk"
        $open = Join-Path $ROOT "tools\open.ps1"
        $ws = New-Object -ComObject WScript.Shell
        $sc = $ws.CreateShortcut($lnk)
        $sc.TargetPath = "powershell.exe"
        $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$open`""
        $sc.WorkingDirectory = $ROOT
        $ico = Join-Path $ROOT "assets\webterm.ico"
        if (Test-Path $ico) { $sc.IconLocation = $ico }
        $sc.Description = "Open winterm-web"
        $sc.Save()
        Say "  created winterm-web shortcut on the Desktop" "Green"
    } catch {
        Say "  shortcut creation failed (safe to ignore): $($_.Exception.Message)" "DarkGray"
    }
}

# -- 4. Launch -----------------------------------------------------------------
if ($NoStart) {
    Step 4 "Skipping launch (-NoStart)"
    Write-Host ""; Say "Install done. Run start.ps1 to launch." "Green"
    exit 0
}

Step 4 "Launching"
$port = if ($env:WEBTERM_PORT) { $env:WEBTERM_PORT } else { "8767" }
& (Join-Path $ROOT "start.ps1")

$url = "http://127.0.0.1:$port"
$ok = $false
foreach ($i in 1..15) {
    Start-Sleep -Milliseconds 700
    try { if ((Invoke-RestMethod "$url/api/health" -TimeoutSec 3).ok) { $ok = $true; break } } catch {}
}

Write-Host ""
if ($ok) {
    Say "  done -> $url" "Green"
    if (-not $NoBrowser) { Start-Process $url }
    Write-Host ""
    Write-Host "  Note: no authentication. Use 127.0.0.1 only and don't change WEBTERM_HOST." -ForegroundColor Yellow
    Write-Host "  To reach it from elsewhere, expose it only over a private network like Tailscale." -ForegroundColor Yellow
} else {
    Say "  Could not confirm startup. Check webterm.log:" "Red"
    Write-Host "    Get-Content `"$ROOT\webterm.log`" -Tail 30"
    exit 1
}
