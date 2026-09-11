<#
  Logon autostart entry point (Startup-folder method).

  A scheduled task lets the OS handle the delay and hidden window, but a normal user
  CANNOT register one (Register-ScheduledTask -> Access is denied). This path needs no
  admin. The delay is applied here directly.
#>
$ErrorActionPreference = "SilentlyContinue"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# Right after logon the network and disk are busy; launching immediately tends to fail, so wait 30s.
Start-Sleep -Seconds 30

$port = if ($env:WEBTERM_PORT) { [int]$env:WEBTERM_PORT } else { 8767 }
# Match ONLY the 127.0.0.1 binding - tailscale serve listens on the same port on 100.x too.
$live = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq "127.0.0.1" } | Select-Object -First 1
if (-not $live) { & (Join-Path $ROOT "start.ps1") | Out-Null }
