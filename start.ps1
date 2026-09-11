# winterm-web start/stop
#
# Layout: [session daemon 8771]  owns the PTY, rarely touched
#         [web server    8767]   free to restart (sessions survive)
#
# Usage: .\start.ps1            (re)start the web server; starts the daemon if it's down
#        .\start.ps1 -fg        run the web server in the foreground (watch logs)
#        .\start.ps1 -Stop      stop the web server only (sessions stay alive)
#        .\start.ps1 -StopAll   stop the daemon too  (WARNING: kills all open shells)
#        .\start.ps1 -Status    show current status
param([switch]$fg, [switch]$Stop, [switch]$StopAll, [switch]$Status)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# Honor the env vars - server.py and launcher.py already do. This file used to hardcode the
# ports and overwrite the env, which made the "change WEBTERM_PORT on a conflict" advice a lie.
$port = if ($env:WEBTERM_PORT) { [int]$env:WEBTERM_PORT } else { 8767 }
$daemonPort = if ($env:WEBTERM_DAEMON_PORT) { [int]$env:WEBTERM_DAEMON_PORT } else { 8771 }

function Get-Listener($p) {
    # Match ONLY the 127.0.0.1 binding. tailscale serve listens on the same port on 100.x / IPv6,
    # so killing the first listener by port alone can kill tailscaled (it happened once).
    # Our processes always bind loopback.
    Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq "127.0.0.1" } | Select-Object -First 1
}

function Find-Pythonw {
    # WindowsApps\pythonw.exe on PATH is a Store stub that dies instantly -> find the real install.
    $py = (Get-Command python -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike "*WindowsApps*" } | Select-Object -First 1).Source
    if (-not $py) { return $null }
    $pyw = Join-Path (Split-Path $py) "pythonw.exe"
    if (Test-Path $pyw) { return $pyw }
    return $py
}

function Show-Status {
    $d = Get-Listener $daemonPort
    $w = Get-Listener $port
    if ($d) { Write-Host "session daemon : running (PID $($d.OwningProcess), port $daemonPort)" -ForegroundColor Green }
    else    { Write-Host "session daemon : stopped" -ForegroundColor DarkGray }
    if ($w) { Write-Host "web server     : running (PID $($w.OwningProcess)) -> http://127.0.0.1:$port" -ForegroundColor Green }
    else    { Write-Host "web server     : stopped" -ForegroundColor DarkGray }
    if ($d -and $w) {
        try {
            $h = Invoke-RestMethod "http://127.0.0.1:$port/api/sessions" -TimeoutSec 5
            Write-Host "open sessions  : $($h.sessions.Count)" -ForegroundColor Cyan
            foreach ($s in $h.sessions) { Write-Host "            - $($s.name)  ($($s.cwd))" -ForegroundColor DarkCyan }
        } catch { Write-Host "open sessions  : query failed" -ForegroundColor Yellow }
    }
}

function Stop-Web {
    $w = Get-Listener $port
    if ($w) {
        Write-Host "stopping web server: PID $($w.OwningProcess)"
        Stop-Process -Id $w.OwningProcess -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 400
    }
}

if ($Status)  { Show-Status; return }

if ($StopAll) {
    Stop-Web
    $d = Get-Listener $daemonPort
    if ($d) {
        Write-Host "Stopping session daemon: PID $($d.OwningProcess) - all open shells will end" -ForegroundColor Yellow
        Stop-Process -Id $d.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Write-Host "winterm-web fully stopped"
    return
}

if ($Stop) {
    Stop-Web
    if (Get-Listener $daemonPort) { Write-Host "web server stopped (session daemon still running - sessions alive)" -ForegroundColor Cyan }
    else { Write-Host "web server stopped" }
    return
}

# -- start --------------------------------------------
$pyw = Find-Pythonw
if (-not $pyw) { Write-Host "Python not found" -ForegroundColor Red; return }

# 1) Start the daemon if it's down (never touch a running one - its sessions are alive).
if (-not (Get-Listener $daemonPort)) {
    Write-Host "starting session daemon..."
    # Don't launch daemon.py under pythonw directly - with no console, ConPTY creation panics.
    # spawn_daemon.py relaunches it with python.exe + CREATE_NO_WINDOW (console yes, window no).
    # The child (daemon) must use the same port.
    $env:WEBTERM_DAEMON_PORT = "$daemonPort"
    Start-Process -FilePath $pyw -ArgumentList "spawn_daemon.py" -WorkingDirectory $root -WindowStyle Hidden
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 400
        if (Get-Listener $daemonPort) { break }
    }
    if (Get-Listener $daemonPort) { Write-Host "session daemon started (port $daemonPort)" -ForegroundColor Green }
    else { Write-Host "session daemon failed to start - check daemon.log" -ForegroundColor Red; return }
} else {
    Write-Host "session daemon already running - kept (sessions preserved)" -ForegroundColor Cyan
}

# 2) The web server is always restarted fresh.
Stop-Web
$env:WEBTERM_PORT = "$port"
$env:WEBTERM_HOST = "127.0.0.1"

if ($fg) {
    Set-Location $root
    python server.py
} else {
    # pythonw = no console window (a scheduled-task console-flash incident is why we hide it).
    Start-Process -FilePath $pyw -ArgumentList "server.py" -WorkingDirectory $root -WindowStyle Hidden
    Start-Sleep -Seconds 2
    if (Get-Listener $port) {
        Write-Host "winterm-web started -> http://127.0.0.1:$port" -ForegroundColor Green
        # Don't hardcode the external (phone) address - it differs per machine and mustn't be
        # committed to a public repo. If tailscale is present, ask it for this machine's MagicDNS name.
        $ts = Get-Command tailscale.exe -ErrorAction SilentlyContinue
        if ($ts) {
            $dns = (& $ts.Source status --json 2>$null | ConvertFrom-Json).Self.DNSName
            if ($dns) {
                Write-Host "                  -> https://$($dns.TrimEnd('.')):$port (phone/remote)" -ForegroundColor DarkGreen
            }
        }
    } else {
        Write-Host "web server failed to start - check webterm.log" -ForegroundColor Red
    }
}
