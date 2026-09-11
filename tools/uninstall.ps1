<#
  winterm-web uninstall - clear autostart + stop the server.

  It does NOT delete the source folder or Python packages. Delete the folder to remove
  everything; this script first cleans up the scheduled task, shortcuts, and running processes.
#>
param([switch]$KeepRunning)

$ErrorActionPreference = "Continue"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ROOT

Write-Host ""
Write-Host "  winterm-web cleanup" -ForegroundColor White

# 1. Scheduled-task autostart
Write-Host ""
Write-Host "[1] Scheduled-task autostart" -ForegroundColor Cyan
# Do NOT delete by name alone: a task with the same name may point at a DIFFERENT install,
# and removing it would silently kill someone else's (or another folder's) autostart.
# This bug nearly wiped a different install's task during development (2026-09-11).
# -> Only remove a task that points at THIS folder.
$t = Get-ScheduledTask -TaskName "WebtermServer" -ErrorAction SilentlyContinue
if (-not $t) {
    Write-Host "  not registered" -ForegroundColor DarkGray
} else {
    $paths = @($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" })
    $mine = $paths | Where-Object { $_ -like "*$ROOT*" }
    if (-not $mine) {
        Write-Host "  skipped - the registered task points at another folder:" -ForegroundColor Yellow
        $paths | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Write-Host "    (this folder: $ROOT)" -ForegroundColor DarkGray
        Write-Host "    To remove anyway: Unregister-ScheduledTask WebtermServer -Confirm:`$false" -ForegroundColor DarkGray
    } else {
        try {
            Unregister-ScheduledTask -TaskName "WebtermServer" -Confirm:$false -ErrorAction Stop
            Write-Host "  removed scheduled task WebtermServer" -ForegroundColor Green
        } catch {
            # Reporting a failure as success would let the user believe it's gone. That's worse.
            Write-Host "  removal failed: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "  Retry from an elevated PowerShell:" -ForegroundColor Yellow
            Write-Host "    Unregister-ScheduledTask WebtermServer -Confirm:`$false" -ForegroundColor DarkGray
        }
    }
}

# 1.2 Startup-folder autostart (the fallback used when a task can't be registered)
Write-Host ""
Write-Host "[1.2] Startup-folder autostart" -ForegroundColor Cyan
$sl = Join-Path ([Environment]::GetFolderPath("Startup")) "winterm-web.lnk"
if (Test-Path $sl) {
    $args0 = ""
    try { $args0 = (New-Object -ComObject WScript.Shell).CreateShortcut($sl).Arguments } catch {}
    if ($args0 -like "*$ROOT*") {
        Remove-Item $sl -Force
        Write-Host "  removed" -ForegroundColor Green
    } else {
        Write-Host "  skipped - points at another install" -ForegroundColor Yellow
    }
} else {
    Write-Host "  none" -ForegroundColor DarkGray
}

# 1.5 Desktop shortcut - only the one pointing at this install
Write-Host ""
Write-Host "[1.5] Desktop shortcut" -ForegroundColor Cyan
$lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "winterm-web.lnk"
if (Test-Path $lnk) {
    $tgt = ""
    try { $tgt = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).Arguments } catch {}
    if ($tgt -like "*$ROOT*") {
        Remove-Item $lnk -Force
        Write-Host "  removed" -ForegroundColor Green
    } else {
        Write-Host "  skipped - points at another install" -ForegroundColor Yellow
    }
} else {
    Write-Host "  none" -ForegroundColor DarkGray
}

# 2. Stop the server
Write-Host ""
Write-Host "[2] Stopping the server" -ForegroundColor Cyan
if ($KeepRunning) {
    Write-Host "  -KeepRunning, leaving it alone" -ForegroundColor DarkGray
} else {
    # Match ONLY the 127.0.0.1 binding. tailscale serve listens on the same port on 100.x / IPv6,
    # so killing the first listener by port alone can kill tailscaled (this has happened).
    $port = if ($env:WEBTERM_PORT) { [int]$env:WEBTERM_PORT } else { 8767 }
    $dport = if ($env:WEBTERM_DAEMON_PORT) { [int]$env:WEBTERM_DAEMON_PORT } else { 8771 }
    foreach ($p in $port, $dport) {
        $l = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
             Where-Object { $_.LocalAddress -eq "127.0.0.1" } | Select-Object -First 1
        if ($l) {
            $name = (Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue).ProcessName
            Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue
            $what = if ($p -eq $dport) { "session daemon" } else { "web server" }
            Write-Host "  stopped $what (port $p, PID $($l.OwningProcess) $name)" -ForegroundColor Green
        } else {
            Write-Host "  port $p : not running" -ForegroundColor DarkGray
        }
    }
    Write-Host "  Note: killing the daemon also ended any open shells" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Cleanup done. To remove completely, delete this folder:" -ForegroundColor Green
Write-Host "    $ROOT" -ForegroundColor DarkGray
Write-Host ""
